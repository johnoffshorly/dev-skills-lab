// STEP 0: Naive baseline — console.log everywhere, errors swallowed, no structure.
// Problems present:
//   1. Silent failures   — bad input returns undefined instead of an error
//   2. Swallowed errors  — catch blocks log e.message and continue as if nothing happened
//   3. No structure      — plain strings, no level, no timestamp, no request context
//   4. Leaking internals — raw Error objects (stack traces) sent to HTTP clients
//   5. No process safety — unhandled promise rejections crash silently
// Nothing fixed yet.

const http = require('http');
const { randomBytes } = require('crypto');

const PORT = 3000;

// In-memory order store
const orders = new Map();

// PROBLEM: "processing" a payment just simulates failure — error is caught and ignored
function processPayment(amount) {
  if (amount <= 0) {
    throw new Error('Invalid amount');
  }
  if (amount > 10000) {
    throw new Error('Amount exceeds limit');
  }
  return { transactionId: randomBytes(4).toString('hex'), amount };
}

// PROBLEM: validation returns undefined on bad input instead of throwing
function validateOrder(data) {
  if (!data) return;                           // PROBLEM: silent — caller gets undefined
  if (!data.item) return;                      // PROBLEM: silent — should throw
  if (typeof data.quantity !== 'number') return; // PROBLEM: silent
  return { item: data.item, quantity: data.quantity, amount: data.quantity * 9.99 };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    console.log('Request:', req.method, req.url); // PROBLEM: no timestamp, no level, no request ID

    // POST /orders
    if (req.method === 'POST' && req.url === '/orders') {
      let data;
      try {
        data = JSON.parse(body);
      } catch (e) {
        console.log('JSON parse error:', e.message); // PROBLEM: plain string log, no context
        res.writeHead(400);
        res.end('Bad JSON');
        return;
      }

      // PROBLEM: validateOrder returns undefined on bad input — no error thrown
      const order = validateOrder(data);
      if (!order) {
        res.writeHead(400);
        res.end('Invalid order');                  // PROBLEM: vague, no field-level detail
        return;
      }

      let payment;
      try {
        payment = processPayment(order.amount);
      } catch (e) {
        // PROBLEM: error swallowed — logs message but responds 500 with the raw Error string
        console.log('Payment failed:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.stack })); // PROBLEM: stack trace exposed to client
        return;
      }

      const id = randomBytes(4).toString('hex');
      orders.set(id, { id, ...order, payment, createdAt: new Date().toISOString() });
      console.log('Order created:', id);           // PROBLEM: no structured context

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
      return;
    }

    // GET /orders/:id
    const match = req.url.match(/^\/orders\/([a-f0-9]+)$/);
    if (req.method === 'GET' && match) {
      const order = orders.get(match[1]);
      if (!order) {
        // PROBLEM: no log here — 404s are invisible
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(order));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });
});

// PROBLEM: unhandled rejections crash the process with no log context
// (no handler registered — if any async code throws a rejected promise, Node prints
//  a deprecation warning and exits with code 1 in Node 15+)

server.listen(PORT, () => {
  console.log('Server running on port', PORT); // PROBLEM: no timestamp, no level
  console.log('[STEP 0] Naive baseline — all problems present');
});
