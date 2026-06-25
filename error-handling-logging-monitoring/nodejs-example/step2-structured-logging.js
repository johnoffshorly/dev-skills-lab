// STEP 2: Structured logging — JSON log lines with level, timestamp, requestId, context.
// Improved: every log call emits a single JSON object to stdout; each request generates
//   a unique requestId threaded through all log calls for that request; log levels
//   (debug/info/warn/error) allow filtering in production.
// Still missing: no /health endpoint, no metrics counters, no request duration tracking,
//   no alerting hooks for high error rates.

const http = require('http');
const { randomBytes } = require('crypto');

const PORT = 3000;
const orders = new Map();

// ─── Logger ───────────────────────────────────────────────────────────────────
// Emits one JSON object per line to stdout — compatible with any log aggregator
// (Datadog, CloudWatch, Loki, etc.) without extra configuration.

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL  = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

function log(level, message, context = {}) {
  if (LOG_LEVELS[level] < MIN_LEVEL) return;
  // Single-line JSON: machine-parseable, grep-friendly, easy to ship
  process.stdout.write(JSON.stringify({
    ts:    new Date().toISOString(),
    level,
    msg:   message,
    ...context,                 // requestId, orderId, error codes, etc. inline
  }) + '\n');
}

const logger = {
  debug: (msg, ctx) => log('debug', msg, ctx),
  info:  (msg, ctx) => log('info',  msg, ctx),
  warn:  (msg, ctx) => log('warn',  msg, ctx),
  error: (msg, ctx) => log('error', msg, ctx),
};

// ─── AppError (carried forward from step 1) ───────────────────────────────────

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
  if (!data || !data.item)                        throw Errors.missingItem();
  if (typeof data.quantity !== 'number'
      || data.quantity <= 0)                      throw Errors.missingQty();
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

// requestId is threaded into every log call and returned in error responses
// so clients can quote it in support tickets.
function handleError(res, err, requestId) {
  if (err instanceof AppError) {
    logger.warn('Operational error', { requestId, code: err.code, message: err.message });
    sendJSON(res, err.status, { error: { code: err.code, message: err.message, requestId } });
  } else {
    logger.error('Unexpected error', { requestId, message: err.message, stack: err.stack });
    sendJSON(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId } });
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
  const requestId = randomBytes(6).toString('hex'); // unique ID per request
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    logger.info('Request received', { requestId, method: req.method, url: req.url });
    // STILL MISSING: request duration not logged — no way to spot slow requests

    try {
      if (req.method === 'POST' && req.url === '/orders') {
        const result = createOrder(body, requestId);
        sendJSON(res, 201, result);
        return;
      }

      const match = req.url.match(/^\/orders\/([a-f0-9]+)$/);
      if (req.method === 'GET' && match) {
        const order = getOrder(match[1], requestId);
        sendJSON(res, 200, order);
        return;
      }

      throw Errors.notFoundRoute();
    } catch (err) {
      handleError(res, err, requestId);
    }
  });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { message: String(reason) });
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { message: err.message, stack: err.stack });
  process.exit(1);
});

server.listen(PORT, () => {
  logger.info('Server started', { port: PORT, step: 2 });
  console.error('[STEP 2] Structured logging — running on http://localhost:' + PORT);
  console.error('Fixed: JSON logs, log levels, requestId threaded per request');
  console.error('Still missing: /health endpoint, error counters, request duration');
});
