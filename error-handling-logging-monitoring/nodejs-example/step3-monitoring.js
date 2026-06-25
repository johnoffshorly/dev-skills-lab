// STEP 3: Monitoring hooks — /health endpoint, in-memory metrics, request duration,
//   requestId in responses, process-level safety.
// Improved: every request logs its duration; /health reports uptime + error rate;
//   in-memory counters track total requests, errors by code, and slow requests;
//   requestId is returned in all responses (not just errors) so clients can correlate.
// All step 0 problems addressed.

const http = require('http');
const { randomBytes } = require('crypto');

const PORT       = 3000;
const START_TIME = Date.now();
const orders     = new Map();

// ─── Logger (carried forward from step 2) ─────────────────────────────────────

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL  = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

function log(level, message, context = {}) {
  if (LOG_LEVELS[level] < MIN_LEVEL) return;
  process.stdout.write(JSON.stringify({
    ts:    new Date().toISOString(),
    level,
    msg:   message,
    ...context,
  }) + '\n');
}

const logger = {
  debug: (msg, ctx) => log('debug', msg, ctx),
  info:  (msg, ctx) => log('info',  msg, ctx),
  warn:  (msg, ctx) => log('warn',  msg, ctx),
  error: (msg, ctx) => log('error', msg, ctx),
};

// ─── Metrics ──────────────────────────────────────────────────────────────────
// In-memory counters — in production you'd flush these to Prometheus/Datadog/StatsD.
// Kept in-memory here so the demo needs no external services.

const metrics = {
  totalRequests:  0,
  totalErrors:    0,
  errorsByCode:   {},   // { NOT_FOUND: 3, BAD_JSON: 1, ... }
  slowRequests:   0,    // requests that took > SLOW_THRESHOLD ms
  requestDurations: [], // last 100 durations for p95 estimation

  SLOW_THRESHOLD: 200,  // ms

  recordRequest(durationMs) {
    this.totalRequests++;
    this.requestDurations.push(durationMs);
    if (this.requestDurations.length > 100) this.requestDurations.shift();
    if (durationMs > this.SLOW_THRESHOLD) this.slowRequests++;
  },

  recordError(code) {
    this.totalErrors++;
    this.errorsByCode[code] = (this.errorsByCode[code] ?? 0) + 1;
  },

  // Rough p95 from the last ≤100 requests
  p95() {
    if (this.requestDurations.length === 0) return null;
    const sorted = [...this.requestDurations].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[idx] ?? sorted[sorted.length - 1];
  },

  summary(extraRequests = 0) {
    const totalRequests = this.totalRequests + extraRequests;
    return {
      uptimeSeconds:  Math.floor((Date.now() - START_TIME) / 1000),
      totalRequests,
      totalErrors:    this.totalErrors,
      errorRate:      totalRequests > 0
        ? (this.totalErrors / totalRequests).toFixed(4)
        : '0.0000',
      errorsByCode:   this.errorsByCode,
      slowRequests:   this.slowRequests,
      p95Ms:          this.p95(),
    };
  },
};

// ─── AppError ─────────────────────────────────────────────────────────────────

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name   = 'AppError';
    this.status = status;
    this.code   = code;
  }
}

const Errors = {
  badJson:        () => new AppError(400, 'BAD_JSON',         'Request body must be valid JSON'),
  missingItem:    () => new AppError(400, 'MISSING_ITEM',     'Field "item" is required'),
  missingQty:     () => new AppError(400, 'MISSING_QTY',      'Field "quantity" must be a positive number'),
  invalidAmount:  () => new AppError(400, 'INVALID_AMOUNT',   'Order amount must be greater than 0'),
  amountTooLarge: () => new AppError(400, 'AMOUNT_TOO_LARGE', 'Order amount exceeds the 10000 limit'),
  notFound:       (id) => new AppError(404, 'NOT_FOUND',      `Order ${id} not found`),
  notFoundRoute:  () => new AppError(404, 'NOT_FOUND_ROUTE',  'Route not found'),
};

// ─── Business logic ───────────────────────────────────────────────────────────

function validateOrder(data) {
  if (!data || !data.item)                       throw Errors.missingItem();
  if (typeof data.quantity !== 'number'
      || data.quantity <= 0)                     throw Errors.missingQty();
  return { item: data.item, quantity: data.quantity, amount: data.quantity * 9.99 };
}

function processPayment(amount) {
  if (amount <= 0)    throw Errors.invalidAmount();
  if (amount > 10000) throw Errors.amountTooLarge();
  return { transactionId: randomBytes(4).toString('hex'), amount };
}

// ─── HTTP utilities ───────────────────────────────────────────────────────────

function sendJSON(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function handleError(res, err, requestId) {
  if (err instanceof AppError) {
    metrics.recordError(err.code);
    logger.warn('Operational error', { requestId, code: err.code, message: err.message });
    sendJSON(res, err.status, { ok: false, error: { code: err.code, message: err.message }, requestId });
  } else {
    metrics.recordError('INTERNAL_ERROR');
    logger.error('Unexpected error', { requestId, message: err.message, stack: err.stack });
    sendJSON(res, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }, requestId });
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function createOrder(body, requestId) {
  let data;
  try { data = JSON.parse(body); }
  catch { throw Errors.badJson(); }

  const order   = validateOrder(data);
  const payment = processPayment(order.amount);
  const id      = randomBytes(4).toString('hex');
  orders.set(id, { id, ...order, payment, createdAt: new Date().toISOString() });

  logger.info('Order created', { requestId, orderId: id, amount: order.amount });
  return { id };
}

function getOrder(id, requestId) {
  const order = orders.get(id);
  if (!order) throw Errors.notFound(id);
  logger.debug('Order fetched', { requestId, orderId: id });
  return order;
}

// ─── Router ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const requestId = randomBytes(6).toString('hex');
  const startMs   = Date.now();

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    logger.info('Request received', { requestId, method: req.method, url: req.url });

    // Instrument duration on every response path
    const finish = (status) => {
      const durationMs = Date.now() - startMs;
      metrics.recordRequest(durationMs);
      logger.info('Request completed', { requestId, status, durationMs });
      if (durationMs > metrics.SLOW_THRESHOLD) {
        logger.warn('Slow request', { requestId, durationMs, threshold: metrics.SLOW_THRESHOLD });
      }
    };

    // GET /health — no auth, returns live metrics snapshot
    if (req.method === 'GET' && req.url === '/health') {
      const snap = metrics.summary(1);
      logger.debug('Health check', { requestId, ...snap });
      sendJSON(res, 200, { ok: true, status: 'up', requestId, ...snap });
      finish(200);
      return;
    }

    try {
      if (req.method === 'POST' && req.url === '/orders') {
        const result = createOrder(body, requestId);
        // requestId in success responses too — client can correlate logs without an error
        sendJSON(res, 201, { ok: true, data: result, requestId });
        finish(201);
        return;
      }

      const match = req.url.match(/^\/orders\/([a-f0-9]+)$/);
      if (req.method === 'GET' && match) {
        const order = getOrder(match[1], requestId);
        sendJSON(res, 200, { ok: true, data: order, requestId });
        finish(200);
        return;
      }

      throw Errors.notFoundRoute();
    } catch (err) {
      handleError(res, err, requestId);
      finish(err instanceof AppError ? err.status : 500);
    }
  });
});

// ─── Process-level safety ────────────────────────────────────────────────────

function normalizeReason(reason) {
  if (reason instanceof Error) {
    return { name: reason.name, message: reason.message, stack: reason.stack };
  }
  if (reason && typeof reason === 'object') {
    let message;
    try {
      message = typeof reason.message === 'string' ? reason.message : JSON.stringify(reason);
    } catch {
      message = '[unserializable rejection reason]';
    }
    const normalized = { name: 'NonErrorRejection', message };
    if (typeof reason.stack === 'string') normalized.stack = reason.stack;
    return normalized;
  }
  return { name: 'NonErrorRejection', message: String(reason) };
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', normalizeReason(reason));
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { message: err.message, stack: err.stack });
  process.exit(1);
});

// Graceful shutdown — log final metrics summary before exit
process.on('SIGTERM', () => {
  logger.info('Shutdown signal received', metrics.summary());
  server.close(() => {
    logger.info('Server closed gracefully');
    process.exit(0);
  });
});

server.listen(PORT, () => {
  logger.info('Server started', { port: PORT, step: 3, note: 'JSON logs on stdout' });
});
