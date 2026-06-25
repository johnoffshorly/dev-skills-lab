// STEP 1: Structured errors — AppError class, never swallow, never leak internals.
// Improved: all errors are typed (AppError with status + code), validation throws instead
//   of returning undefined, catch blocks always respond or re-throw, client never
//   receives a stack trace.
// Still missing: logs are still plain console.log strings — no level, no timestamp,
//   no request ID, no JSON structure. Monitoring not addressed.

const http = require('http');
const { randomBytes } = require('crypto');

const PORT = 3000;
const orders = new Map();

// ─── Typed error ──────────────────────────────────────────────────────────────
// AppError carries HTTP status + machine-readable code.
// Operational errors (bad input, not found) use AppError.
// Programmer errors (unexpected throws) remain plain Error — treated as 500.

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
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
// Throws AppError on bad input — never returns undefined silently.

function validateOrder(data) {
  if (!data || !data.item)                      throw Errors.missingItem();
  if (typeof data.quantity !== 'number'
      || data.quantity <= 0)                    throw Errors.missingQty();
  return { item: data.item, quantity: data.quantity, amount: data.quantity * 9.99 };
}

function processPayment(amount) {
  if (amount <= 0)     throw Errors.invalidAmount();
  if (amount > 10000)  throw Errors.amountTooLarge();
  return { transactionId: randomBytes(4).toString('hex'), amount };
}

// ─── HTTP utilities ───────────────────────────────────────────────────────────
// Client only ever receives { error: { code, message } } — no stack traces.

function sendJSON(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function handleError(res, err) {
  if (err instanceof AppError) {
    // Operational error — known, safe to surface code + message
    // STILL MISSING: this log is a plain string with no timestamp or request context
    console.log(`[ERROR] ${err.code}: ${err.message}`);
    sendJSON(res, err.status, { error: { code: err.code, message: err.message } });
  } else {
    // Programmer error — unknown cause, never expose internals
    // STILL MISSING: we log err.message but lose the stack in production logs
    console.log('[ERROR] Unexpected error:', err.message);
    sendJSON(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function createOrder(body) {
  let data;
  try { data = JSON.parse(body); }
  catch { throw Errors.badJson(); }

  const order = validateOrder(data);
  const payment = processPayment(order.amount);
  const id = randomBytes(4).toString('hex');
  orders.set(id, { id, ...order, payment, createdAt: new Date().toISOString() });

  // STILL MISSING: console.log with no level, no timestamp, no requestId
  console.log('Order created:', id);
  return { id };
}

function getOrder(id) {
  const order = orders.get(id);
  if (!order) throw Errors.notFound(id);
  return order;
}

// ─── Router ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    // STILL MISSING: no timestamp, no level, no request ID in this log
    console.log('Request:', req.method, req.url);

    try {
      if (req.method === 'POST' && req.url === '/orders') {
        const result = createOrder(body);
        sendJSON(res, 201, result);
        return;
      }

      const match = req.url.match(/^\/orders\/([a-f0-9]+)$/);
      if (req.method === 'GET' && match) {
        const order = getOrder(match[1]);
        sendJSON(res, 200, order);
        return;
      }

      throw Errors.notFoundRoute();
    } catch (err) {
      handleError(res, err);
    }
  });
});

// Process-level safety: unhandled rejections are now logged, not silent.
// STILL MISSING: log is a plain string with no structure or alert context.
process.on('unhandledRejection', (reason) => {
  console.log('[FATAL] Unhandled rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.log('[FATAL] Uncaught exception:', err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`[STEP 1] Structured errors — running on http://localhost:${PORT}`);
  console.log('Fixed: AppError, typed codes, no swallowed errors, no stack traces to client');
  console.log('Still missing: structured JSON logs, no timestamp/level/requestId, no monitoring');
});
