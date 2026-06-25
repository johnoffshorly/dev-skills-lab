# Practical Code Quality — Start Simple, Improve Step by Step

A Node.js task-manager API (no frameworks, no external deps) that starts as a naive blob and improves one quality layer at a time. Each step breaks a different class of problem and proves the fix works before introducing the next improvement.

**Learning goal:** Understand *why* simplicity, reusability, and maintainability are separate concerns — and how addressing each one independently produces code that is easy to read, change, and extend.

## Final Learning Goal

- Why duplicated logic is a maintenance hazard, not just a style issue
- How separating HTTP from business logic makes both easier to test and change
- Why inconsistent response shapes create bugs in consumers
- How a single error type and a handler wrapper eliminate scattered `try/catch`
- What "easy to extend" concretely looks like in a route table

---

## 1. Setup

No install needed — uses Node.js stdlib only. Requires Node.js 14+.

```bash
cd 5-practical-code-quality/nodejs-example
```

| File | What it shows |
|---|---|
| `step0-naive.js` | Everything inline — duplicated logic, mixed concerns, inconsistent errors |
| `step1-extract-helpers.js` | Duplication eliminated via named helper functions |
| `step2-separate-concerns.js` | Business logic in `taskStore`, HTTP in handlers, config centralized |
| `step3-consistent-patterns.js` | Unified response shape, `AppError`, `handle()` wrapper, routes table |

---

# STEP 0 — Naive Baseline

## 2. Run Step 0

```bash
node step0-naive.js
```

**Intentional problems present:**
- ID parsing and task lookup copy-pasted into every handler (3 copies)
- Title validation duplicated across POST and PUT
- Business logic (task construction, mutation) mixed into HTTP handlers
- Error responses use different keys: `{ error }`, `{ message }`, or plain text
- `404` fallback returns plain text, not JSON
- No config object — port and seed data hard-coded inline

---

## 3. Demo 1: Inconsistent error responses

### How to trigger it

Run all three error scenarios and compare the response shapes:

```bash
# Missing title — uses "message" key
curl -s -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{}' | cat

# Task not found via GET — uses "error: Not found"
curl -s http://localhost:3000/tasks/999 | cat

# Task not found via DELETE — uses "message: No such task"
curl -s -X DELETE http://localhost:3000/tasks/999 | cat
```

### What happens

```
{"message":"Title is required"}
{"error":"Not found"}
{"message":"No such task"}
```

### Why it happens

Each handler was written independently. There is no shared `sendError` helper, so every author made a different choice. A frontend consumer cannot write one `if (!res.error)` check — it must handle three shapes.

---

## 4. Demo 2: Duplicated ID parsing and task lookup

### How to trigger it

Observe the code: search for the string `parseInt` in `step0-naive.js`:

```bash
grep -n "parseInt" step0-naive.js
```

### What happens

```
51:      const id = parseInt(getMatch[1]);
71:      const id = parseInt(putMatch[1]);
90:      const id = parseInt(delMatch[1]);
```

### Why it happens

No helper exists for parsing an ID, so every handler that needs one writes the same three lines. If the parsing rule changes (e.g., add `id <= 0` check), all three copies must be updated — and it's easy to miss one.

---

## 5. Demo 3: Bad JSON returns plain text

### How to trigger it

```bash
curl -s -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d 'not-json' | cat
```

### What happens

```
Bad JSON
```

### Why it happens

The `catch` block calls `res.end('Bad JSON')` — plain text, no `Content-Type: application/json`, no status body shape. Every other route returns JSON. A consumer that always calls `JSON.parse(response)` will crash here.

---

# STEP 1 — Extract Helpers

Duplication eliminated. Every piece of shared logic lives in one named function.

**What this step adds:** `parseId`, `findTask`, `parseBody`, `isValidTitle`, `sendJSON`, `sendError` — each called from handlers instead of copy-pasted.

**What it does NOT yet address:** Concerns still mixed (HTTP + business logic share handler functions), config still hard-coded, response shape not yet standardized.

## 6. Run Step 1

```bash
# Stop step 0 first (Ctrl+C), then:
node step1-extract-helpers.js
```

## 7. Test: Duplication is gone

```bash
grep -n "parseInt" step1-extract-helpers.js
```

Expected: one occurrence — inside `parseId`, not scattered across handlers.

```bash
grep -n "tasks.find" step1-extract-helpers.js
```

Expected: one occurrence — inside `findTask`.

## 8. Confirm: Inconsistent shapes still present

```bash
# Success response — returns raw task object
curl -s http://localhost:3000/tasks/1 | cat

# Error response — returns { error: "..." }
curl -s http://localhost:3000/tasks/999 | cat
```

Success returns a task object directly. Error returns `{ error }`. No shared wrapper. A consumer must still branch on whether a key exists rather than checking `res.ok`.

**Lesson:** Extracting helpers solves duplication but does not solve response consistency — that requires a different fix.

---

# STEP 2 — Separate Concerns

Business logic moves into `taskStore`. HTTP handlers translate HTTP ↔ store only.

**What this step adds:** `taskStore` object owns all task data and rules, `handlers` object owns HTTP translation, `CONFIG` owns all configuration.

**What it does NOT yet address:** `try/catch` blocks scattered across handlers that call the store, success and error responses still have no shared wrapper shape.

## 9. Run Step 2

```bash
node step2-separate-concerns.js
```

## 10. Test: Business logic is in the store, not the handler

Change the port — edit only `CONFIG.port`:

```bash
# In step2-separate-concerns.js, CONFIG.port is the single source of truth.
# Handlers, router, and listen() all reference it — nothing else to change.
grep -n "3000" step2-separate-concerns.js
```

Expected: `3000` appears only in `CONFIG.port`, nowhere else.

## 11. Test: taskStore has no HTTP knowledge

```bash
grep -n "res\." step2-separate-concerns.js | grep -v "handlers\|sendJSON\|sendError"
```

Expected: no `res.` calls inside `taskStore` — it throws plain `Error` objects, not HTTP responses.

## 12. Confirm: Scattered try/catch still present

```bash
grep -n "try {" step2-separate-concerns.js
```

Expected: multiple occurrences — one per handler that calls the store. Each handler still owns its own error-catching boilerplate.

**Lesson:** Separating concerns cleans up the data layer and HTTP layer independently, but does not eliminate the repetitive error-handling wiring between them.

---

# STEP 3 — Consistent Patterns

All responses share `{ ok, data }` / `{ ok: false, error: { code, message } }`. `AppError` centralizes error creation. `handle()` wrapper eliminates scattered `try/catch`. Routes table makes extension a one-liner.

## 13. Run Step 3

```bash
node step3-consistent-patterns.js
```

## 14. Test: Unified response shape

```bash
# Success
curl -s http://localhost:3000/tasks/1 | cat

# Error — task not found
curl -s http://localhost:3000/tasks/999 | cat

# Error — invalid JSON
curl -s -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d 'bad' | cat

# Error — missing title
curl -s -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{}' | cat
```

Every response has `ok` at the top level. Consumer code:

```js
const res = await fetch(...).then(r => r.json());
if (!res.ok) console.error(res.error.code, res.error.message);
else use(res.data);
```

## 15. Test: No scattered try/catch in handlers

```bash
grep -n "try {" step3-consistent-patterns.js
```

Expected: zero occurrences in handlers — `handle()` catches everything centrally.

## 16. Test: Adding a new route is one line

The routes table in `step3-consistent-patterns.js`:

```js
const routes = [
  ['GET',    /^\/tasks$/,        ...],
  ['POST',   /^\/tasks$/,        ...],
  ['GET',    /^\/tasks\/(\d+)$/, ...],
  ['PUT',    /^\/tasks\/(\d+)$/, ...],
  ['DELETE', /^\/tasks\/(\d+)$/, ...],
  // Add one line here for a new endpoint. Pattern is obvious.
];
```

In step 0, adding a route meant copying ~15 lines of boilerplate. Here it is one array entry.

---

# Code Review: What Changed Each Step

## Step 0 → Step 1: Extract helpers

| Problem | Naive (step 0) | Improved (step 1) |
|---|---|---|
| ID parsing | `parseInt(getMatch[1])` in 3 handlers | `parseId(idStr)` called once per handler |
| Task lookup | `tasks.find(t => t.id === id)` in 3 handlers | `findTask(id)` called once per handler |
| JSON parse | `try { JSON.parse(body) }` in 2 handlers | `parseBody(body)` returns `{ data, error }` |
| Title check | `!data.title \|\| typeof...` in 2 handlers | `isValidTitle(title)` returns boolean |
| Error send | `res.writeHead(...)` + `res.end(...)` inline | `sendError(res, status, msg)` |

## Step 1 → Step 2: Separate concerns

| Concern | Step 1 | Step 2 |
|---|---|---|
| Task creation logic | Inside `createTask` HTTP handler | Inside `taskStore.create()` |
| Task update logic | Inside `updateTask` HTTP handler | Inside `taskStore.update()` |
| Port number | `const PORT = 3000` at top | `CONFIG.port` |
| Seed data | Inline array at top | `CONFIG.defaultTasks` |
| HTTP translation | Mixed with business logic | `handlers` object only |

## Step 2 → Step 3: Consistent patterns

| Problem | Step 2 | Step 3 |
|---|---|---|
| Error creation | `new Error('...')` inline in store | `Errors.notFound()`, `Errors.invalidTitle()`, etc. |
| Error handling | `try/catch` in each handler | `handle(fn)` wrapper — one place |
| Success shape | Raw object (`task`, `tasks`, `{ deleted: true }`) | `{ ok: true, data: ... }` always |
| Error shape | `{ error: message }` | `{ ok: false, error: { code, message } }` always |
| Adding a route | Copy ~15 lines, adjust match/method | Add one entry to `routes` array |

---

# Summary: The Full Picture

| Problem | Step 0 | Step 1 | Step 2 | Step 3 |
|---|---|---|---|---|
| Duplicated ID parsing | ❌ | ✅ | ✅ | ✅ |
| Duplicated task lookup | ❌ | ✅ | ✅ | ✅ |
| Duplicated validation | ❌ | ✅ | ✅ | ✅ |
| Business logic in HTTP handlers | ❌ | ❌ | ✅ | ✅ |
| Hard-coded config | ❌ | ❌ | ✅ | ✅ |
| Scattered try/catch | ❌ | ❌ | ❌ | ✅ |
| Inconsistent error response shape | ❌ | ❌ | ❌ | ✅ |
| No shared success wrapper | ❌ | ❌ | ❌ | ✅ |
| Hard to add new routes | ❌ | ❌ | ❌ | ✅ |

**Key lesson:** Simplicity, reusability, and maintainability are not the same goal. Extracting helpers (step 1) solves reusability but not structure. Separating concerns (step 2) solves structure but not consistency. Consistent patterns (step 3) tie the other fixes together so the whole system is predictable. Each layer is independently valuable — but you need all three to write code that a new team member can confidently change.

---

# Production Checklist

- [ ] No duplicated logic — every operation done in one place, called everywhere else
- [ ] Business logic has zero HTTP imports or `req`/`res` references
- [ ] All config (ports, timeouts, limits) in one `CONFIG` or env-mapped object
- [ ] All responses share one outer shape (`ok`, `data`/`error`)
- [ ] All errors use a typed class (`AppError`) with machine-readable code + HTTP status
- [ ] Error handling centralized — no scattered `try/catch` blocks
- [ ] Route registration is data-driven (table/array), not a chain of if-else
- [ ] Helpers have single responsibility — each does exactly one thing
- [ ] Validation errors surface as typed errors, not string checks inline
- [ ] Separation between parsing (HTTP layer) and rules (business layer)
- [ ] No magic strings for status codes, error messages, or field names
- [ ] Adding a new endpoint touches exactly one place (route table + one handler)
- [ ] Error messages safe for consumers — no stack traces or internal paths exposed
- [ ] Input trimmed and normalized in one place (store), not repeated in handlers

---

# References

- [Node.js `http` module](https://nodejs.org/api/http.html)
- [Clean Code — Robert C. Martin (Chapter 3: Functions)](https://www.oreilly.com/library/view/clean-code-a/9780136083238/)
- [The Twelve-Factor App — Config](https://12factor.net/config)
- [HTTP API Design — Consistent error responses](https://www.rfc-editor.org/rfc/rfc9457) (RFC 9457: Problem Details for HTTP APIs)
- [SOLID Principles — Single Responsibility](https://en.wikipedia.org/wiki/Single-responsibility_principle)
