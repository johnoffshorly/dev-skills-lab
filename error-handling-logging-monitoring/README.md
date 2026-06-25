# Error Handling, Logging, and Monitoring — Start Simple, Improve Step by Step

A Node.js order API (zero external deps) that starts with swallowed errors and plain `console.log`, then adds typed errors, structured JSON logs, and a live monitoring endpoint one layer at a time. Each step isolates one problem class so you can see exactly what each fix buys you.

**Learning goal:** Understand why error handling, logging, and monitoring are three separate concerns — and how fixing each independently produces a system you can actually diagnose in production.

## Final Learning Goal

- Why swallowed errors and undefined-returning validators create invisible failures
- How a typed `AppError` class prevents leaking stack traces to clients
- Why structured JSON logs (not plain strings) are required for any real log aggregator
- How a `requestId` threads a single request through all log lines
- Why log levels (`debug`/`info`/`warn`/`error`) matter for production noise reduction
- What a `/health` endpoint should expose and why error rate + duration are the key signals

---

## 1. Setup

No install required — uses Node.js stdlib only. Requires Node.js 14+.

```bash
cd nodejs-example
```

| File | What it shows |
|---|---|
| `step0-naive.js` | Silent failures, swallowed errors, stack traces to client, no log context |
| `step1-structured-errors.js` | AppError class, typed codes, never swallow, never leak internals |
| `step2-structured-logging.js` | JSON logs, log levels, requestId per request |
| `step3-monitoring.js` | /health, metrics counters, request duration, requestId in all responses |

---

# STEP 0 — Naive Baseline

## 2. Run Step 0

```bash
node step0-naive.js
```

**Intentional problems present:**
- Validation returns `undefined` on bad input — no error, no log
- `catch` blocks log `e.message` and continue — errors effectively swallowed
- Raw `e.stack` sent to HTTP clients — internal paths exposed
- All logs are plain strings — no level, no timestamp, no request ID
- `404` responses produce no log line — invisible in production
- No `unhandledRejection` handler — async crashes exit silently in Node 15+

---

## 3. Demo 1: Silent validation failure

### How to trigger it

```bash
# Missing "item" field — validation returns undefined silently
curl -s -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"quantity": 2}' | cat
```

### What happens

```
Invalid order
```

No log line appears on the server for the missing field — the failure is invisible. The client gets a vague string with no error code to act on.

### Why it happens

```js
function validateOrder(data) {
  if (!data.item) return;   // returns undefined — no throw, no log
  ...
}
if (!order) {
  res.end('Invalid order'); // vague, no field detail
}
```

`validateOrder` returns `undefined` instead of throwing — the caller has no way to know *which* field failed.

---

## 4. Demo 2: Stack trace exposed to client

### How to trigger it

```bash
# quantity * 9.99 = 10998.9 — exceeds the 10000 payment limit
curl -s -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"item": "laptop", "quantity": 1100}' | cat
```

### What happens

```json
{"error":"Error: Amount exceeds limit\n    at processPayment (/home/.../step0-naive.js:18:11)\n    at ..."}
```

The full stack trace — including absolute file paths on your server — is sent to the client.

### Why it happens

```js
} catch (e) {
  res.end(JSON.stringify({ error: e.stack })); // PROBLEM: stack trace to client
}
```

The catch block serializes `e.stack` directly into the response body.

---

## 5. Demo 3: 404 produces no log

### How to trigger it

```bash
# Two requests to a non-existent order — check the server terminal after each
curl -s http://localhost:3000/orders/deadbeef | cat
curl -s http://localhost:3000/orders/deadbeef | cat
```

### What happens

Client receives `Not found`. Server terminal shows **nothing** for either request — 404s are completely invisible.

### Why it happens

```js
if (!order) {
  res.writeHead(404);
  res.end('Not found'); // no console.log call — silent in logs
  return;
}
```

No log call before the `res.end`. In production you have no record that users are hitting missing resources.

---

# STEP 1 — Structured Errors

`AppError` class with HTTP status + machine-readable code. Validation throws instead of returning undefined. Clients never see stack traces. `unhandledRejection` / `uncaughtException` are handled.

**What this step adds:** typed `AppError`, `Errors` factory, `handleError` centralizes client response, process-level safety handlers.

**What it does NOT yet address:** logs are still plain `console.log` strings — no timestamp, no level, no requestId, no JSON structure. Monitoring not addressed.

## 6. Run Step 1

```bash
# Stop step 0 first (Ctrl+C), then:
node step1-structured-errors.js
```

## 7. Test: No stack trace in error response

```bash
curl -s -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"item": "laptop", "quantity": 1100}' | cat
```

Expected — only safe fields, no paths:

```json
{"error":{"code":"AMOUNT_TOO_LARGE","message":"Order amount exceeds the 10000 limit"}}
```

## 8. Test: Validation throws with field detail

```bash
curl -s -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"quantity": 2}' | cat
```

Expected:

```json
{"error":{"code":"MISSING_ITEM","message":"Field \"item\" is required"}}
```

## 9. Confirm: Logs still unstructured

Make any request and observe the server terminal. Output looks like:

```
Request: POST /orders
[ERROR] MISSING_ITEM: Field "item" is required
```

Plain strings — no timestamp, no JSON, no requestId. Impossible to correlate across multiple concurrent requests or pipe to a log aggregator.

**Lesson:** Typed errors protect clients but do nothing for operators. Structured logs are a separate fix.

---

# STEP 2 — Structured Logging

Every log call emits a single-line JSON object. Each request gets a unique `requestId` threaded through all its log lines. Log level (`info`/`warn`/`error`) is explicit and filterable.

**What this step adds:** `logger` object, `requestId` per request, JSON log lines, `LOG_LEVEL` env var, requestId in error responses.

**What it does NOT yet address:** no `/health` endpoint, no request duration in logs, no error count metrics.

## 10. Run Step 2

```bash
node step2-structured-logging.js
```

## 11. Test: Logs are JSON with requestId

```bash
# In one terminal, run:
node step2-structured-logging.js

# In another terminal, trigger a 404:
curl -s http://localhost:3000/orders/deadbeef | cat
```

Server terminal now shows two JSON lines with the same `requestId`:

```json
{"ts":"2026-05-28T10:00:00.000Z","level":"info","msg":"Request received","requestId":"a1b2c3d4e5f6","method":"GET","url":"/orders/deadbeef"}
{"ts":"2026-05-28T10:00:00.001Z","level":"warn","msg":"Operational error","requestId":"a1b2c3d4e5f6","code":"NOT_FOUND","message":"Order deadbeef not found"}
```

Both lines share the same `requestId` — grep for it to get the full story of one request.

## 12. Test: Log level filtering

```bash
# Only show warnings and errors — suppress info noise
LOG_LEVEL=warn node step2-structured-logging.js
```

Make a successful order request — no `info` lines appear. Trigger a 404 — `warn` line appears.

## 13. Confirm: No duration, no metrics

Make 5 requests, then ask: "how long did each take? What's the error rate?" — impossible to answer from the logs. No duration field, no counters.

**Lesson:** Structured logs enable filtering and correlation, but they don't tell you *how your system is performing*. Metrics require a separate layer.

---

# STEP 3 — Monitoring

`/health` endpoint with live metrics. Every request logs its duration. In-memory counters track total requests, errors by code, slow requests, and p95 latency. `requestId` returned in all responses — not just errors.

## 14. Run Step 3

```bash
node step3-monitoring.js
```

## 15. Test: /health shows live metrics

```bash
# First, generate some traffic with mixed results:
curl -s -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"item": "book", "quantity": 3}'

curl -s -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"quantity": 2}'

curl -s http://localhost:3000/orders/deadbeef

# Now check health:
curl -s http://localhost:3000/health | cat
```

Expected (values will vary):

```json
{
  "ok": true,
  "status": "up",
  "uptimeSeconds": 12,
  "totalRequests": 4,
  "totalErrors": 2,
  "errorRate": "0.5000",
  "errorsByCode": { "MISSING_ITEM": 1, "NOT_FOUND": 1 },
  "slowRequests": 0,
  "p95Ms": 2
}
```

## 16. Test: Request duration in every log line

```bash
# Make a request, then look at server terminal
curl -s http://localhost:3000/orders/deadbeef > /dev/null
```

Server terminal shows:

```json
{"ts":"...","level":"info","msg":"Request completed","requestId":"...","status":404,"durationMs":1}
```

Every request — success or error — logs its duration. Now you can spot slow endpoints without a profiler.

## 17. Test: requestId in success responses too

```bash
curl -s -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"item": "pen", "quantity": 1}' | cat
```

Expected:

```json
{"ok":true,"data":{"id":"a1b2c3d4"},"requestId":"e5f6a7b8c9d0"}
```

Client can log the `requestId` and quote it to support — who can then grep the server logs to find every log line for that exact request.

---

# Code Review: What Changed Each Step

## Step 0 → Step 1: Structured errors

| Problem | Step 0 | Step 1 |
|---|---|---|
| Validation failure | Returns `undefined`, no throw | Throws `AppError` with field-level code |
| Stack trace to client | `{ error: e.stack }` | `{ error: { code, message } }` — no internals |
| Swallowed catch | `console.log(e.message)` + continue | `handleError` always responds with typed error |
| Process crashes | No handlers | `unhandledRejection` + `uncaughtException` both log + exit |

## Step 1 → Step 2: Structured logging

| Problem | Step 1 | Step 2 |
|---|---|---|
| Log format | `console.log('Request:', method, url)` | `logger.info('Request received', { requestId, method, url })` |
| Request correlation | No ID — can't link logs | `requestId` generated per request, in every log line |
| Log level | No levels — everything is equal noise | `debug`/`info`/`warn`/`error` + `LOG_LEVEL` env filter |
| Error response | `{ error: { code, message } }` | Same + `requestId` so client can correlate |

## Step 2 → Step 3: Monitoring

| Problem | Step 2 | Step 3 |
|---|---|---|
| Request duration | Not logged | `durationMs` in every `Request completed` line |
| Slow request detection | None | `warn` log when `durationMs > SLOW_THRESHOLD` |
| Error rate | Invisible | `metrics.errorRate` on `/health` |
| Error breakdown | Invisible | `metrics.errorsByCode` on `/health` |
| requestId in success | Errors only | All responses include `requestId` |
| Graceful shutdown | Process dies immediately | `SIGTERM` logs final metrics, closes server cleanly |

---

# Summary: The Full Picture

| Problem | Step 0 | Step 1 | Step 2 | Step 3 |
|---|---|---|---|---|
| Silent validation (returns undefined) | ❌ | ✅ | ✅ | ✅ |
| Stack traces exposed to client | ❌ | ✅ | ✅ | ✅ |
| Swallowed errors | ❌ | ✅ | ✅ | ✅ |
| Unhandled rejection crashes | ❌ | ✅ | ✅ | ✅ |
| Structured JSON logs | ❌ | ❌ | ✅ | ✅ |
| Log levels + filtering | ❌ | ❌ | ✅ | ✅ |
| requestId per request | ❌ | ❌ | ✅ | ✅ |
| Request duration logging | ❌ | ❌ | ❌ | ✅ |
| Error rate metrics | ❌ | ❌ | ❌ | ✅ |
| /health endpoint | ❌ | ❌ | ❌ | ✅ |
| requestId in success responses | ❌ | ❌ | ❌ | ✅ |
| Graceful shutdown | ❌ | ❌ | ❌ | ✅ |

**Key lesson:** Error handling, logging, and monitoring solve different problems for different audiences. Error handling protects *clients* from seeing internals. Structured logging helps *developers* diagnose a specific failure. Monitoring helps *operators* see the health of the system before individual failures are reported. Each layer is independently valuable — but in production you need all three.

---

# Production Checklist

- [ ] All validation throws a typed error — nothing returns `undefined` on bad input
- [ ] Client responses never include `e.stack`, file paths, or internal identifiers
- [ ] Every error has a machine-readable `code` field (not just a human message)
- [ ] `catch` blocks never swallow — always re-throw or call `handleError`
- [ ] `unhandledRejection` and `uncaughtException` are both handled with log + exit
- [ ] All logs emit single-line JSON to stdout (not stderr, not multi-line)
- [ ] Log lines include: `ts`, `level`, `msg`, `requestId`, and relevant context fields
- [ ] Log level is runtime-configurable via env var (`LOG_LEVEL=warn node app.js`)
- [ ] `requestId` is generated per request and included in all responses (success + error)
- [ ] Request duration is logged on every response path
- [ ] Slow requests trigger a `warn` log with threshold context
- [ ] `/health` returns uptime, error rate, and p95 latency — no auth required
- [ ] Error counters are broken down by code — not just a total
- [ ] `SIGTERM` handler logs final metrics snapshot before graceful shutdown
- [ ] Sensitive fields (passwords, tokens, PII) are never logged — redact at the logger level

---

# References

- [Node.js `process` events — unhandledRejection, uncaughtException](https://nodejs.org/api/process.html#event-unhandledrejection)
- [The Twelve-Factor App — Logs](https://12factor.net/logs)
- [Google SRE Book — Chapter 6: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)
- [RFC 9457 — Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457) (typed error responses)
- [OpenTelemetry — Trace Context propagation](https://opentelemetry.io/docs/concepts/context-propagation/) (requestId is a simplified trace ID)
