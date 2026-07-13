'use strict';

let cachedConnection = null;
let lastConnectPromise = null;

function describeBrokerUrl(raw) {
  try {
    const parsed = new URL(String(raw));
    return {
      protocol: parsed.protocol.replace(/:$/, ''),
      host: parsed.hostname || null,
      port: parsed.port || null,
      vhost: decodeURIComponent((parsed.pathname || '').replace(/^\/+/, '')) || '/'
    };
  } catch (_error) {
    return { configured: true, parseable: false };
  }
}

async function getConnection({ logger = console, reuse = true } = {}) {
  if (reuse && cachedConnection?.connection?.stream?.readable) return cachedConnection;
  if (reuse && lastConnectPromise) return lastConnectPromise;
  const url = process.env.MESSAGE_BROKER_URL;
  if (!url) throw new Error('MESSAGE_BROKER_URL is required when using RabbitMQ transport');
  const heartbeat = Number(process.env.MESSAGE_BROKER_HEARTBEAT || 60);
  const connect = async () => {
    const amqplib = require('amqplib');
    logger.info('[messaging] connecting to RabbitMQ', { broker: describeBrokerUrl(url), heartbeat });
    const connection = await amqplib.connect(url, { heartbeat });
    connection.on('error', (error) => logger.error('[messaging] connection error', error));
    connection.on('close', () => {
      logger.warn('[messaging] connection closed');
      if (cachedConnection === connection) cachedConnection = null;
      lastConnectPromise = null;
    });
    cachedConnection = connection;
    return connection;
  };
  const promise = connect().catch((error) => {
    if (lastConnectPromise === promise) lastConnectPromise = null;
    throw error;
  });
  if (reuse) lastConnectPromise = promise;
  return promise;
}

async function closeConnection() {
  const connection = cachedConnection;
  cachedConnection = null;
  lastConnectPromise = null;
  if (connection) await connection.close().catch(() => {});
}

module.exports = { getConnection, closeConnection, describeBrokerUrl };

