// ⚠️  MUST BE THE FIRST IMPORT. See the header comment in otel.ts.
// If you move this line below any other import, auto-instrumentation silently
// stops working for whatever loaded first.
import './otel';

import { config } from './config';
import { logger } from './logger';
import { waitForDb } from './db';
import { waitForRedis } from './cache';
import { buildServer } from './server';
// Importing metrics.ts registers the observable gauges' callbacks.
import './metrics';

async function main() {
  await waitForDb();
  await waitForRedis();

  const app = buildServer();
  await app.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port, otel: config.otelEnabled }, 'orders-api listening');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
