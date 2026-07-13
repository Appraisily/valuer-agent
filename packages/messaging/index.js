'use strict';

const createRabbitAdapter = require('./lib/adapters/rabbitmq');
const createPubSubAdapter = require('./lib/adapters/pubsub');

function createBroker(options = {}) {
  const transport = (options.transport || process.env.MESSAGE_TRANSPORT || 'pubsub').toLowerCase();
  const logger = options.logger || console;
  if (transport === 'rabbitmq') {
    const rabbit = createRabbitAdapter({ logger });
    if (options.dualPublish || process.env.ENABLE_DUAL_PUBLISH === 'true') {
      return wrapDualPublisher(rabbit, createPubSubAdapter({ logger }), { logger });
    }
    return rabbit;
  }
  if (transport === 'pubsub') return createPubSubAdapter({ logger });
  throw new Error(`Unsupported messaging transport: ${transport}`);
}

function wrapDualPublisher(primary, secondary, { logger }) {
  return {
    async publish(message) {
      const result = await primary.publish(message);
      secondary.publish(message).catch((error) => logger.error('[dual-publish] secondary failed', error));
      return result;
    },
    subscribe: (options) => primary.subscribe(options),
    async close() {
      await primary.close();
      await secondary.close().catch(() => {});
    }
  };
}

module.exports = { createBroker, createRabbitAdapter, createPubSubAdapter };

