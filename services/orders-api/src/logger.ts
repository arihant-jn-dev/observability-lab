import pino from 'pino';
import { context, trace } from '@opentelemetry/api';
import { config } from './config';

/**
 * Structured logging with trace correlation.
 *
 * The `mixin` is the entire correlation mechanism, and it is worth
 * understanding that there is no magic here: on every log call we look up the
 * *currently active span* from OpenTelemetry's context and copy its ids into
 * the log line. That is why a log emitted inside a request carries the same
 * trace_id as the trace -- and why a log emitted from a stray setTimeout, or
 * after the response is sent, carries nothing.
 *
 * Grafana's Loki datasource is configured to turn the `trace_id` field into a
 * clickable link to Tempo. That link only works because of these four lines.
 */
export const logger = pino({
  level: config.logLevel,

  // Resource-ish fields on every line. `service` is what Loki labels on.
  base: {
    service: config.serviceName,
    role: config.role,
  },

  // Loki/Grafana expect `level` as a string, not pino's default numeric code.
  formatters: {
    level(label) {
      return { level: label };
    },
  },

  timestamp: pino.stdTimeFunctions.isoTime,

  mixin() {
    const span = trace.getSpan(context.active());
    if (!span) return {};
    const sc = span.spanContext();
    if (!sc.traceId) return {};
    return { trace_id: sc.traceId, span_id: sc.spanId };
  },

  // Pretty output is for humans reading `docker compose logs`. In the lab we
  // keep it OFF so the log shipper receives real JSON.
  transport: config.logPretty
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});
