// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - CommonJS module without types
import messagingModule from '../../../../_shared/messaging/index.js';

type Broker = {
  publish: (opts: {
    exchange: string;
    routingKey: string;
    payload: unknown;
    headers?: Record<string, string>;
    options?: Record<string, unknown>;
  }) => Promise<void>;
  close?: () => Promise<void>;
};

const { createBroker } = messagingModule as { createBroker: (options: { transport: string; logger?: Console }) => Broker };

const transport = (process.env.MESSAGE_TRANSPORT ?? 'rabbitmq').toLowerCase();
const exchange = process.env.MESSAGE_EXCHANGE ?? 'valuer.events';

const disabledTransports = new Set(['', 'none', 'disabled', 'off', 'false']);
export const messagingEnabled = !disabledTransports.has(transport);

let brokerPromise: Promise<Broker> | null = null;

async function getBroker(): Promise<Broker> {
  if (!brokerPromise) {
    brokerPromise = Promise.resolve(createBroker({ transport, logger: console }));
  }
  return brokerPromise;
}

export async function publishEvent(
  routingKey: string,
  payload: unknown,
  headers: Record<string, string> = {}
): Promise<void> {
  if (!messagingEnabled) return;
  if (!routingKey) throw new Error('routingKey is required');
  const broker = await getBroker();
  await broker.publish({
    exchange,
    routingKey,
    payload,
    headers,
    options: {}
  });
}

export async function closeBroker(): Promise<void> {
  if (!brokerPromise) return;
  try {
    const broker = await brokerPromise;
    if (typeof broker.close === 'function') {
      await broker.close();
    }
  } finally {
    brokerPromise = null;
  }
}
