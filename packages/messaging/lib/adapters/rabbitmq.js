'use strict';

const connectionModule = require('../connection');

function createRabbitAdapter({ logger = console, getConnection = connectionModule.getConnection } = {}) {
  async function publish({ exchange, routingKey, payload, headers = {}, options = {} }) {
    if (!exchange) throw new Error('publish requires exchange');
    const connection = await getConnection({ logger });
    const channel = await connection.createChannel();
    try {
      await channel.assertExchange(exchange, 'topic', { durable: true });
      channel.publish(exchange, routingKey || '', Buffer.from(JSON.stringify(payload ?? {})), {
        contentType: 'application/json', persistent: true, headers, ...options
      });
    } finally {
      await channel.close().catch(() => {});
    }
  }

  async function subscribe({
    queue,
    exchange,
    routingKey = '#',
    handler,
    prefetch = Number(process.env.MESSAGE_BROKER_PREFETCH || 10),
    deadLetterExchange = null,
    deadLetterQueue = null,
  }) {
    if (!queue) throw new Error('subscribe requires queue');
    if (!exchange) throw new Error('subscribe requires exchange');
    if (typeof handler !== 'function') throw new Error('subscribe requires handler');
    const resubscribeDelayMs = Number(process.env.MESSAGE_BROKER_RESUBSCRIBE_DELAY_MS || 1000);
    const maxFailedRetries = Number(process.env.MESSAGE_BROKER_RESUBSCRIBE_MAX_ATTEMPTS || 5);
    let closed = false;
    let activeChannel = null;
    let subscribePromise = null;
    let restartTimer = null;
    let failedRetries = 0;

    const scheduleResubscribe = (reason) => {
      if (closed || restartTimer || subscribePromise || activeChannel) return;
      if (failedRetries >= maxFailedRetries) {
        logger.error('[messaging] consumer resubscribe retry budget exhausted', { queue, reason, retries: failedRetries });
        return;
      }
      failedRetries += 1;
      const delayMs = resubscribeDelayMs * Math.min(failedRetries, 5);
      logger.warn('[messaging] scheduling consumer resubscribe', { queue, reason, attempt: failedRetries, delayMs });
      restartTimer = setTimeout(() => {
        restartTimer = null;
        ensureSubscribed(`retry:${reason}`);
      }, delayMs);
      restartTimer.unref?.();
    };

    const startSubscription = async (reason = 'initial') => {
      const connection = await getConnection({ logger });
      if (closed) return;
      const channel = await connection.createChannel();
      let detached = false;
      channel.on('error', (error) => logger.error('[messaging] consumer channel error', error));
      channel.on('close', () => {
        if (detached) return;
        detached = true;
        if (activeChannel === channel) activeChannel = null;
        if (!closed) scheduleResubscribe('channel_closed');
      });
      await channel.assertExchange(exchange, 'topic', { durable: true });
      const queueArguments = {};
      if (deadLetterExchange) {
        await channel.assertExchange(deadLetterExchange, 'topic', { durable: true });
        queueArguments['x-dead-letter-exchange'] = deadLetterExchange;
        if (deadLetterQueue) {
          await channel.assertQueue(deadLetterQueue, { durable: true });
          await channel.bindQueue(deadLetterQueue, deadLetterExchange, '#');
        }
      }
      await channel.assertQueue(queue, {
        durable: true,
        ...(Object.keys(queueArguments).length ? { arguments: queueArguments } : {}),
      });
      await channel.bindQueue(queue, exchange, routingKey);
      channel.prefetch(prefetch);
      await channel.consume(queue, async (msg) => {
        if (!msg) return;
        const headers = msg.properties.headers || {};
        let settled = false;
        const settle = (operation) => {
          if (settled) return false;
          settled = true;
          operation();
          return true;
        };
        const helpers = {
          ack: () => settle(() => channel.ack(msg)),
          nack: ({ requeue = false } = {}) => settle(() => channel.nack(msg, false, requeue)),
          retry: ({ delayMs = 0 } = {}) => {
            if (settled) return false;
            const republish = () => settle(() => {
              channel.publish(exchange, msg.fields.routingKey || routingKey || '', msg.content, {
                ...msg.properties,
                contentType: msg.properties.contentType || 'application/json',
                persistent: true,
                headers: { ...headers, 'x-attempts': Number(headers['x-attempts'] || 0) + 1 }
              });
              channel.ack(msg);
            });
            if (delayMs > 0) {
              const timer = setTimeout(republish, delayMs);
              timer.unref?.();
              return true;
            }
            return republish();
          },
          moveToDlq: (reason) => {
            logger.error('[messaging] moving message to DLQ', { queue, reason });
            return settle(() => channel.nack(msg, false, false));
          }
        };
        let payload;
        try {
          payload = msg.content.length ? JSON.parse(msg.content.toString()) : null;
        } catch (error) {
          logger.error('[messaging] failed to parse JSON payload', error);
          helpers.nack({ requeue: false });
          return;
        }
        try {
          await handler({ payload, headers, raw: msg }, helpers);
        } catch (error) {
          logger.error('[messaging] handler threw error', error);
          helpers.nack({ requeue: true });
        }
      });
      if (closed) {
        detached = true;
        await channel.close().catch(() => {});
        return;
      }
      activeChannel = channel;
      failedRetries = 0;
      logger.info('[messaging] consumer subscribed', { queue, exchange, routingKey, prefetch, reason });
    };

    const ensureSubscribed = (reason) => {
      if (closed || subscribePromise || activeChannel) return;
      let failed = false;
      subscribePromise = startSubscription(reason)
        .catch((error) => {
          failed = true;
          logger.error('[messaging] consumer subscribe failed', error);
        })
        .finally(() => {
          subscribePromise = null;
          if (failed) scheduleResubscribe('subscribe_failed');
        });
    };
    await startSubscription();
    return async () => {
      closed = true;
      if (restartTimer) clearTimeout(restartTimer);
      const channel = activeChannel;
      activeChannel = null;
      if (channel) await channel.close().catch(() => {});
    };
  }

  return { publish, subscribe, close: connectionModule.closeConnection };
}

module.exports = createRabbitAdapter;

