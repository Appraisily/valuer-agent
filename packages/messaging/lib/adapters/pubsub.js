'use strict';

function createPubSubAdapter({ logger = console } = {}) {
  const { PubSub } = require('@google-cloud/pubsub');
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
  const client = new PubSub(projectId ? { projectId } : undefined);
  async function publish({ exchange, topic, payload, headers = {} }) {
    const topicName = topic || exchange;
    if (!topicName) throw new Error('publish requires topic (exchange when using Pub/Sub fallback)');
    const attributes = Object.fromEntries(Object.entries(headers)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]));
    return client.topic(topicName).publish(Buffer.from(JSON.stringify(payload ?? {})), attributes);
  }
  async function subscribe({ queue, topic, handler }) {
    if (!topic) throw new Error('subscribe requires topic when using Pub/Sub adapter');
    if (typeof handler !== 'function') throw new Error('subscribe requires handler');
    const subscriptionName = queue || `${topic}-auto`;
    const [subscription] = await client.topic(topic).createSubscription(subscriptionName, {
      enableMessageOrdering: false,
      ackDeadlineSeconds: 120
    }).catch(async (error) => {
      if (error.code === 6) return client.subscription(subscriptionName).get();
      throw error;
    });
    subscription.on('message', async (message) => {
      const helpers = { ack: () => message.ack(), nack: () => message.nack(), retry: () => message.nack(), moveToDlq: () => message.nack() };
      try {
        const payload = message.data.length ? JSON.parse(message.data) : null;
        await handler({ payload, headers: message.attributes || {}, raw: message }, helpers);
      } catch (error) {
        logger.error('[messaging] pubsub handler error', error);
        helpers.nack();
      }
    });
    subscription.on('error', (error) => logger.error('[messaging] pubsub subscription error', error));
    return () => subscription.removeAllListeners();
  }
  return { publish, subscribe, close: () => client.close() };
}

module.exports = createPubSubAdapter;

