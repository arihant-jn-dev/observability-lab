/**
 * OpenTelemetry bootstrap.
 *
 * ============================ READ THIS ============================
 * This module MUST be imported before anything else, including `fastify`,
 * `pg`, and `ioredis`. Auto-instrumentation works by monkey-patching those
 * libraries as they are require()'d. If `pg` is loaded before the SDK starts,
 * the SDK has nothing left to patch and you get zero database spans -- with no
 * error message at all. "My traces are empty" is almost always this.
 *
 * That is why index.ts and worker.ts both begin with `import './otel'` on
 * line 1: in CommonJS, imports execute top-to-bottom, so this runs first.
 * ===================================================================
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { config } from './config';

if (config.otelEnabled) {
  // Flip OTEL_DIAG=true when telemetry mysteriously stops. It prints exporter
  // errors that are otherwise swallowed on purpose -- a telemetry pipeline must
  // never crash the app it observes.
  if (process.env.OTEL_DIAG === 'true') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  /**
   * The Resource describes *who is emitting*, and is attached to every span and
   * metric this process produces. `service.name` is the single most important
   * field in the whole stack: it is what Tempo groups traces by, what the RED
   * dashboard filters on, and what makes `orders-api` and `payments-api`
   * distinguishable inside one trace.
   */
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    'service.role': config.role,
    'deployment.environment': 'lab',
  });

  const sdk = new NodeSDK({
    resource,

    traceExporter: new OTLPTraceExporter({
      url: `${config.otlpEndpoint}/v1/traces`,
    }),

    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${config.otlpEndpoint}/v1/metrics`,
      }),
      // 10s is aggressive for production but makes the lab feel responsive:
      // toggle a pathology and the graph moves within ~15 seconds. Remember
      // this number when a dashboard looks "stuck" -- you may simply be looking
      // at a time window shorter than the export interval.
      exportIntervalMillis: 10_000,
    }),

    instrumentations: [
      getNodeAutoInstrumentations({
        // These produce enormous span volume for near-zero insight. Turning
        // them off is the first thing you do on any real service.
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },

        // We do our own trace_id injection in logger.ts via a pino mixin,
        // precisely so you can SEE where correlation comes from instead of it
        // being magic. Leaving this on would inject the same fields twice.
        '@opentelemetry/instrumentation-pino': { enabled: false },

        '@opentelemetry/instrumentation-http': {
          // Health checks would otherwise dominate trace volume AND drag your
          // p50 down, flattering your latency numbers. Drop them at the source.
          ignoreIncomingRequestHook: (req) => {
            const url = req.url ?? '';
            return url.startsWith('/health') || url.startsWith('/metrics');
          },
        },

        '@opentelemetry/instrumentation-pg': {
          // Attaches the actual SQL text to each span. Essential for spotting
          // N+1 -- you will literally see the same statement 50 times in a row.
          enhancedDatabaseReporting: true,
        },

        // instrumentation-runtime-node IS enabled by default and is doing a lot
        // of quiet work for us: it emits event-loop lag, GC pause, and heap
        // metrics. Those are what separate "CPU is the problem" from
        // "a dependency is the problem" in the cpuBurn and memLeak exercises.
      }),

      /**
       * Fastify instrumentation is NOT part of getNodeAutoInstrumentations() --
       * you must add it yourself. Without it you still get HTTP spans, but they
       * are named `GET` with no `http.route` attribute, so every distinct URL
       * either collapses into one meaningless series or explodes into thousands
       * of them. This one line is the difference between a usable RED dashboard
       * and a useless one.
       *
       * Note this is `@fastify/otel`, not `@opentelemetry/instrumentation-
       * fastify` -- the latter is deprecated in favour of this one, which the
       * Fastify maintainers own. `registerOnInitialization` means it hooks
       * itself in when Fastify boots, so server.ts needs no plugin registration.
       */
      new FastifyOtelInstrumentation({ registerOnInitialization: true }),
    ],
  });

  sdk.start();

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: 'info',
      service: config.serviceName,
      msg: 'opentelemetry started',
      endpoint: config.otlpEndpoint,
    }),
  );

  const shutdown = async () => {
    try {
      // Flushes whatever is sitting in the batch queue. Without this you lose
      // the last few seconds of telemetry on every deploy -- which is exactly
      // the telemetry describing the shutdown you are trying to debug.
      await sdk.shutdown();
    } catch {
      /* never block shutdown on telemetry */
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} else {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: 'warn',
      service: config.serviceName,
      msg: 'opentelemetry DISABLED (set OTEL_ENABLED=true to turn it on)',
    }),
  );
}
