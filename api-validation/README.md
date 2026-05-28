# API Payload Validation Tutorial — Start Unsecure, Fix One by One

This tutorial teaches API payload validation by starting with a **totally unsecure Node.js API**, attacking it locally, then fixing one weakness at a time.

> Safety: this is a local training lab. Do not deploy the insecure steps publicly.

## Final Learning Goal

By the end, you will understand how to protect APIs from:

- mass assignment / privilege escalation
- NoSQL operator-style payloads
- wrong content types
- oversized JSON bodies
- unsafe HTML reflection / XSS risk
- leaking sensitive fields in responses

---

## 1. Setup

```bash
cd ~/Projects/OKR/api-validation/nodejs-example
npm install
```

Files used in this tutorial:

```text
step0-totally-unsecure.js   # no validation, intentionally dangerous
step1-request-gates.js      # fix content type + body size
step2-schema-validation.js  # fix payload shape/types/unknown fields
step3-safer-api.js          # fix safe mapping + HTML output encoding
```

Each step runs on port `3000` unless you set `PORT`.

---

# STEP 0 — Totally Unsecure API

## 2. Run Step 0

```bash
npm run step0
```

This API has multiple intentional problems:

- accepts large JSON bodies
- does not check `Content-Type`
- no runtime schema validation
- saves attacker-controlled fields
- accepts objects where strings are expected
- reflects raw HTML
- returns sensitive fields like password and admin flags

---

## 3. Attack 1: Mass Assignment

### Attack Request

```bash
curl -i -X PATCH http://localhost:3000/users/victim@example.com \
  -H 'Content-Type: application/json' \
  -d '{
    "displayName":"Owned Victim",
    "role":"admin",
    "isAdmin":true,
    "accountBalance":999999
  }'
```

### What Happens

The unsecure API accepts attacker fields:

```json
{
  "role": "admin",
  "isAdmin": true,
  "accountBalance": 999999
}
```

### Why It Happens

Bad code:

```js
const updated = { ...existing, ...req.body };
```

The server blindly trusts the request body.

---

## 4. Attack 2: NoSQL Operator-Style Login Bypass

### Attack Request

```bash
curl -i http://localhost:3000/login \
  -H 'Content-Type: application/json' \
  -d '{
    "email": {"$ne": null},
    "password": {"$ne": null}
  }'
```

### What Happens

The unsecure demo logs in because it accepts objects where strings should be required.

### Why It Happens

Bad idea:

```js
insecureMatch(candidate.email, req.body.email)
```

`req.body.email` can be an object, not only a string.

---

## 5. Attack 3: Unsafe HTML Reflection

### Attack Request

```bash
curl -i http://localhost:3000/comments \
  -H 'Content-Type: application/json' \
  -d '{"comment":"<script>alert(\"xss\")</script>"}'
```

### What Happens

The response contains raw script content:

```html
<script>alert("xss")</script>
```

### Why It Happens

Bad code:

```js
res.type('html').send(`<div>${req.body.comment}</div>`);
```

The API sends untrusted input as HTML without encoding.

Stop Step 0 with `Ctrl+C`.

---

# STEP 1 — Fix Request Gatekeeping

Step 1 adds:

- `Content-Type: application/json` enforcement
- `50kb` JSON body size limit
- strict JSON parsing
- safe malformed JSON / oversized body errors

It does **not** yet fix mass assignment or XSS.

## 6. Run Step 1

```bash
npm run step1
```

---

## 7. Test Wrong Content-Type Is Blocked

```bash
curl -i -X PATCH http://localhost:3000/users/victim@example.com \
  -H 'Content-Type: text/plain' \
  -d 'role=admin&isAdmin=true'
```

Expected:

```text
HTTP/1.1 415 Unsupported Media Type
```

---

## 8. Test Oversized Body Is Blocked

```bash
python3 - <<'PY' | curl -i -X PATCH http://localhost:3000/users/victim@example.com -H 'Content-Type: application/json' --data-binary @-
import json
print(json.dumps({"displayName":"A"*100000}))
PY
```

Expected:

```text
HTTP/1.1 413 Payload Too Large
```

---

## 9. Confirm Mass Assignment Still Works

```bash
curl -i -X PATCH http://localhost:3000/users/victim@example.com \
  -H 'Content-Type: application/json' \
  -d '{"role":"admin","isAdmin":true}'
```

Expected: still vulnerable.

Lesson: request gates help, but they are not enough.

Stop Step 1 with `Ctrl+C`.

---

# STEP 2 — Fix Payload Shape with Schema Validation

Step 2 adds Zod validation:

- expected fields only
- correct field types
- max lengths
- email format
- rejects unknown fields like `role` and `isAdmin`
- rejects objects where strings are expected

It still intentionally leaves one issue: unsafe HTML reflection.

## 10. Run Step 2

```bash
npm run step2
```

---

## 11. Test Mass Assignment Is Blocked

```bash
curl -i -X PATCH http://localhost:3000/users/victim@example.com \
  -H 'Content-Type: application/json' \
  -d '{"role":"admin","isAdmin":true}'
```

Expected:

```text
HTTP/1.1 400 Bad Request
```

Reason: schema rejects unknown fields.

---

## 12. Test Safe Profile Update Works

```bash
curl -i -X PATCH http://localhost:3000/users/victim@example.com \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Alice Safe","bio":"Normal profile update"}'
```

Expected:

```text
HTTP/1.1 200 OK
```

---

## 13. Test NoSQL Operator Payload Is Blocked

```bash
curl -i http://localhost:3000/login \
  -H 'Content-Type: application/json' \
  -d '{
    "email": {"$ne": null},
    "password": {"$ne": null}
  }'
```

Expected:

```text
HTTP/1.1 400 Bad Request
```

Reason: `email` and `password` must be strings.

---

## 14. Confirm HTML Reflection Still Unsafe

```bash
curl -i http://localhost:3000/comments \
  -H 'Content-Type: application/json' \
  -d '{"comment":"<script>alert(\"xss\")</script>"}'
```

Expected: still returns raw script text.

Lesson: validation is not the same as output encoding.

Stop Step 2 with `Ctrl+C`.

---

# STEP 3 — Fix Safe Mapping and Output Encoding

Step 3 adds final safer patterns:

- explicit allow-list mapping
- no sensitive fields in response
- HTML output encoding
- Helmet security headers
- generic safe error handler

## 15. Run Step 3

```bash
npm run step3
```

`npm start` also runs Step 3.

---

## 16. Test Mass Assignment Remains Blocked

```bash
curl -i -X PATCH http://localhost:3000/users/victim@example.com \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Alice","role":"admin","isAdmin":true}'
```

Expected:

```text
HTTP/1.1 400 Bad Request
```

---

## 17. Test Safe Mapping

```bash
curl -i -X PATCH http://localhost:3000/users/victim@example.com \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Alice Final","bio":"Safe update"}'
```

Expected response includes safe fields only. It should not expose `password`, `isAdmin`, or `accountBalance`.

---

## 18. Test HTML Output Is Encoded

```bash
curl -i http://localhost:3000/comments \
  -H 'Content-Type: application/json' \
  -d '{"comment":"<script>alert(\"xss\")</script>"}'
```

Expected response contains encoded text:

```html
&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;
```

The browser sees text, not executable script.

---

# Code Review: What Changed Each Step

## Step 0: Bad Baseline

**Vulnerabilities:**
- Blind body merge — client controls any field
- No content-type check — accepts any request format
- No body size limit — open to large payload DoS
- `insecureMatch()` — accepts objects where strings expected (NoSQL operator bypass)
- Raw HTML reflection — XSS via unsanitized output
- Sensitive fields (`password`, `isAdmin`, `accountBalance`) returned in every response

```js
// Mass assignment — client overwrites any field including role, isAdmin
const updated = { ...existing, ...req.body };

// NoSQL operator bypass — object accepted instead of string
function insecureMatch(actualValue, suppliedValue) {
  if (suppliedValue && typeof suppliedValue === 'object') {
    if ('$ne' in suppliedValue) return actualValue !== suppliedValue.$ne;
  }
  return actualValue === suppliedValue;
}

// XSS — raw input injected into HTML
res.type('html').send(`<div>${req.body.comment}</div>`);
```

---

## Step 1: Request Gates

**Added:**
- Content-type enforcement — reject non-`application/json` on POST/PUT/PATCH
- 50kb body size limit — reject oversized payloads with `413`
- Strict JSON parsing — reject malformed JSON with `400`
- Safe error handler for parser errors

**Still vulnerable:** mass assignment, NoSQL operator bypass, XSS

```js
// Enforce Content-Type: application/json
app.use((req, res, next) => {
  const methodsWithBody = ['POST', 'PUT', 'PATCH'];
  if (methodsWithBody.includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'UNSUPPORTED_MEDIA_TYPE' });
  }
  return next();
});

// Limit body size, strict JSON only
app.use(express.json({ limit: '50kb', strict: true }));

// Handle parser errors safely
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'MALFORMED_JSON' });
  return next(err);
});
```

---

## Step 2: Schema Validation

**Added:**
- Zod schemas for every endpoint
- `.strict()` — rejects unknown fields (blocks `role`, `isAdmin`, etc.)
- Type enforcement — `email` and `password` must be strings (blocks NoSQL operator objects)
- Field constraints — max lengths, email format, trimming
- Reusable `validate(schema)` middleware — attaches `req.validatedBody`
- Login now uses strict string equality instead of `insecureMatch()`

**Still vulnerable:** XSS (validation ≠ output encoding), sensitive fields still leak in response

```js
// Schema rejects unknown fields and enforces types
const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  bio: z.string().trim().max(500).optional()
}).strict();

const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform(v => v.toLowerCase()),
  password: z.string().min(1).max(128)
}).strict();

const commentSchema = z.object({
  comment: z.string().min(1).max(500)
}).strict();

// Reusable validation middleware
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'VALIDATION_FAILED',
        details: result.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      });
    }
    req.validatedBody = result.data;
    return next();
  };
}

// Login uses strict string equality — no more insecureMatch()
const { email, password } = req.validatedBody;
const user = [...users.values()].find(candidate => (
  candidate.email === email && candidate.password === password
));
```

---

## Step 3: Safe Mapping + Output Encoding

**Added:**
- Explicit allow-list field mapping — only `displayName` and `bio` can be written, even if schema passes
- Sensitive fields stripped from response — no `password`, `isAdmin`, `accountBalance`
- `escapeHtml()` — HTML entities encoded before output, blocks XSS
- `helmet()` — security headers (`CSP`, `X-Frame-Options`, `HSTS`, `X-Content-Type-Options`, etc.)
- Generic fallback error handler — no stack traces leaked to client

```js
// Helmet adds security headers automatically
app.use(helmet());

// Explicit allow-list mapping — validated body spread is NOT enough
const safeUpdate = {};
if (req.validatedBody.displayName !== undefined) safeUpdate.displayName = req.validatedBody.displayName;
if (req.validatedBody.bio !== undefined) safeUpdate.bio = req.validatedBody.bio;

// Response strips sensitive fields — never return what client shouldn't see
return res.json({
  id: updated.id,
  email: updated.email,
  displayName: updated.displayName,
  bio: updated.bio,
  role: updated.role,
  accountStatus: updated.accountStatus
});

// HTML output encoding — browser sees text, not executable script
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const safeComment = escapeHtml(req.validatedBody.comment);
res.type('html').send(`<h1>Comment</h1><div>${safeComment}</div>`);

// Generic fallback error handler — no internal details exposed
app.use((err, req, res, next) => {
  console.error(err);
  return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
});
```

---

# Final Production Checklist

For every API endpoint:

- accept only expected content type
- set body size limit
- validate runtime schema
- reject unknown fields by default
- enforce strings, numbers, booleans, dates, arrays exactly
- set string lengths and number ranges
- do semantic/business validation
- manually map allowed fields
- never save `req.body` directly
- never trust client-submitted authorization fields
- encode output for HTML
- use parameterized database queries
- log validation failures safely
- return safe, consistent errors

---

# References

- OWASP Input Validation Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
- OWASP REST Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html
- OWASP Mass Assignment Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html
- Zod documentation: https://zod.dev/
- Express JSON parser docs: https://expressjs.com/en/api.html#express.json
