/**
 * All configuration comes from the environment, which is what makes the same
 * image runnable as both the API and the worker (see docker-compose.yml).
 */
export const config = {
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'orders-api',
  serviceVersion: process.env.SERVICE_VERSION ?? '1.0.0',
  role: process.env.ROLE ?? 'api', // 'api' | 'worker' -- shows up as a resource attribute

  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',

  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://lab:lab@localhost:5433/ordersdb',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6380',
  paymentsUrl: process.env.PAYMENTS_URL ?? 'http://localhost:8081',

  // Stage 1 runs with OTEL_ENABLED=false: the app works fine with no telemetry,
  // which is the point -- you are about to see exactly what instrumentation adds.
  otelEnabled: process.env.OTEL_ENABLED === 'true',
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',

  logLevel: process.env.LOG_LEVEL ?? 'info',
  logPretty: process.env.LOG_PRETTY === 'true',

  queueKey: 'orders:queue',
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 60),
} as const;
