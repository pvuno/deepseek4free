#!/usr/bin/env node
'use strict';

const config = require('./config');
const log = require('./logger');
const { createApp } = require('./app');

const app = createApp();

app.server.listen(config.port, config.host, () => {
  const t = app.tokens.status();
  log.info(`deepseek4free v${config.version} listening on http://${config.host}:${config.port}`);
  log.info(`  tokens: ${t.tokens} (healthy: ${t.healthy})   sessions: ${app.sessions.size}`);
  log.info(`  openai base url: http://${config.host}:${config.port}/v1`);
  if (!config.proxyApiKey && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    log.warn('  PROXY_API_KEY is empty — do not expose this port to the internet');
  }
});

app.server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log.error(`Port ${config.port} is already in use. Set PORT=... or stop the other proxy.`);
  } else {
    log.error(`Server error: ${e.message}`);
  }
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down...`);
  const force = setTimeout(() => process.exit(1), 8000);
  force.unref();
  try {
    await app.close();
  } catch (e) {
    log.warn(`shutdown: ${e.message}`);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) =>
  log.error('unhandledRejection:', (e && (e.stack || e.message)) || e)
);
process.on('uncaughtException', (e) =>
  log.error('uncaughtException:', (e && (e.stack || e.message)) || e)
);
