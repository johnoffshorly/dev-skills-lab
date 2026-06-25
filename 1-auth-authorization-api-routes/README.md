# Authentication & Authorization for Protected API Routes
## Start Simple, Improve Step by Step

This tutorial builds proper auth from scratch. You will see exactly what breaks when auth is absent, why authentication alone is not enough, and why long-lived tokens are dangerous — by running and breaking each stage yourself.

## Final Learning Goal

- Understand the difference between **authentication** (who are you?) and **authorization** (what can you do?)
- Know why plaintext passwords, missing token checks, and missing role guards each cause distinct classes of vulnerabilities
- Implement JWT-based auth with RBAC and token lifecycle management (refresh + revocation)
- Recognize what each layer protects — and what it still leaves open

---

## 1. Setup

```bash
cd 1-auth-authorization-api-routes/node-example
npm install
```

Optional — set signing secrets before running steps 1–3 (otherwise each step warns and uses a demo default):

```bash
export JWT_SECRET='your-local-dev-secret'     # steps 1–2
export ACCESS_SECRET='your-access-signing-key' # step 3 (access JWT only)
```

| File | Port | What it demonstrates |
|------|------|----------------------|
| `step0-naive.js` | 3000 | No auth — every route public, passwords in plaintext |
| `step1-authentication.js` | 3001 | JWT authentication — identity verified, but no role checks |
| `step2-authorization.js` | 3002 | RBAC — roles enforced, ownership checks added |
| `step3-token-lifecycle.js` | 3003 | Short-lived tokens, refresh rotation, logout revocation |

**Credentials available across all steps:**

| Username | Password | Role |
|----------|----------|------|
| alice | secret123 | admin |
| bob | password456 | user |
| carol | mypass789 | user |

---

# STEP 0 — Naive Baseline

No authentication. No authorization. All routes are public.

## 2. Run Step 0

```bash
node step0-naive.js
```

**Problems intentionally present:**
- Passwords stored and returned in plaintext
- Any anonymous client can read all user data
- Any anonymous client can create users with any role
- Any anonymous client can delete any user
- Admin-only routes are fully public
- No ownership enforcement on posts

---

## 3. Demo 1: Read Plaintext Passwords

### How to trigger it

```bash
curl -s http://localhost:3000/users | jq .
```

### What happens

```json
[
  { "id": 1, "username": "alice", "password": "secret123", "role": "admin", ... },
  { "id": 2, "username": "bob",   "password": "password456", "role": "user",  ... }
]
```

### Why it happens

`GET /users` (step0-naive.js line ~27) returns the raw `users` array, which includes the `password` field. One database breach exposes every credential in cleartext.

The same leak exists on the admin stats route:

```bash
curl -s http://localhost:3000/admin/stats | jq .
```

Expected (includes a dedicated `allPasswords` array):

```json
{
  "totalUsers": 3,
  "allEmails": ["alice@example.com", "bob@example.com", "carol@example.com"],
  "allPasswords": [
    { "id": 1, "password": "secret123" },
    { "id": 2, "password": "password456" }
  ]
}
```

`GET /admin/stats` (step0-naive.js line ~44) was meant to be “internal admin” data but has no auth gate — another path to the same catastrophe.

---

## 4. Demo 2: Create an Admin User Without Any Credentials

### How to trigger it

```bash
curl -s -X POST http://localhost:3000/admin/users \
  -H "Content-Type: application/json" \
  -d '{"username":"hacker","password":"pwned","role":"admin","email":"h@evil.com"}' | jq .
```

### What happens

```json
{ "id": 4, "username": "hacker", "password": "pwned", "role": "admin", "email": "h@evil.com" }
```

### Why it happens

`POST /admin/users` (step0-naive.js line ~32) accepts any body and pushes it directly into the users array. No identity check, no role restriction.

---

## 5. Demo 3: Delete Any User Anonymously

### How to trigger it

```bash
# Delete alice (id=1) without any credentials
curl -s -X DELETE http://localhost:3000/users/1 | jq .
```

### What happens

```json
{ "deleted": { "id": 1, "username": "alice", "password": "secret123", ... } }
```

### Why it happens

`DELETE /users/:id` (step0-naive.js line ~38) has no authentication middleware. Any request succeeds. The deleted object is returned including the plaintext password.

---

# STEP 1 — Authentication (JWT)

Passwords are now hashed with bcrypt. A `/auth/login` endpoint issues signed JWTs. All routes require a valid token.

**What this step does NOT fix:** any authenticated user — including `bob` with role `user` — can still call `/admin/stats`, `/admin/users`, and delete other users. `POST /admin/users` still uses `...req.body` (mass assignment) to show missing input validation.

## 6. Run Step 1

```bash
node step1-authentication.js
```

## 7. Test: Unauthenticated Request Is Rejected

```bash
curl -s http://localhost:3001/users | jq .
```

Expected:
```json
{ "error": "Missing or malformed Authorization header" }
```

Now log in and retry:

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"password456"}' | jq -r .token)

curl -s http://localhost:3001/users \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Returns user list (no passwords — hashed values filtered out).

## 8. Confirm: Authorization Still Missing

Bob is a `user` but can still reach admin routes:

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"password456"}' | jq -r .token)

# Bob hits admin-only endpoint — should be forbidden, but isn't
curl -s http://localhost:3001/admin/stats \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Expected (wrong — bob should not see this):
```json
{ "totalUsers": 3, "allEmails": ["alice@example.com", "bob@example.com", "carol@example.com"] }
```

**Lesson:** authentication proves identity. It does not enforce what that identity is allowed to do.

---

# STEP 2 — Authorization (RBAC)

Role-based middleware added. Resource ownership enforced on delete and edit. `GET /users` and `POST /admin/users` are admin-only; new users accept only whitelisted fields (`username`, `password`, `role`, `email`).

**What this step does NOT fix:** tokens are valid for 7 days with no revocation. A stolen token stays valid until it expires. Role in the JWT is still trusted as-is until step 3 re-checks the database.

## 9. Run Step 2

```bash
node step2-authorization.js
```

## 10. Test: Role Guard Blocks Bob From Admin Routes

```bash
BOB=$(curl -s -X POST http://localhost:3002/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"password456"}' | jq -r .token)

curl -s http://localhost:3002/admin/stats \
  -H "Authorization: Bearer $BOB" | jq .
```

Expected:
```json
{ "error": "Forbidden: requires role admin" }
```

Alice (admin) can still access it:

```bash
ALICE=$(curl -s -X POST http://localhost:3002/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}' | jq -r .token)

curl -s http://localhost:3002/admin/stats \
  -H "Authorization: Bearer $ALICE" | jq .
```

Expected:
```json
{ "totalUsers": 3, "allEmails": [...] }
```

## 11. Test: User List Is Admin-Only

Bob can authenticate but cannot enumerate every account:

```bash
BOB=$(curl -s -X POST http://localhost:3002/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"password456"}' | jq -r .token)

curl -s http://localhost:3002/users \
  -H "Authorization: Bearer $BOB" | jq .
```

Expected:

```json
{ "error": "Forbidden: requires role admin" }
```

Use `/profile` (step 2+) for self-service data instead of `GET /users`.

## 12. Test: Ownership Check Blocks Cross-User Edits

```bash
BOB=$(curl -s -X POST http://localhost:3002/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"password456"}' | jq -r .token)

# Bob tries to edit post id=1 (owned by alice)
curl -s -X PUT http://localhost:3002/posts/1 \
  -H "Authorization: Bearer $BOB" \
  -H "Content-Type: application/json" \
  -d '{"title":"Hacked"}' | jq .
```

Expected:
```json
{ "error": "Forbidden: not the post owner" }
```

## 13. Confirm: Long-Lived Token Problem Remains

A token issued now is valid for 7 days. There is no logout endpoint that invalidates it.
If bob's token leaks, an attacker has 7 days of valid access with no way to stop it.

---

# STEP 3 — Token Lifecycle (Refresh + Revocation)

Access tokens now expire in 15 minutes. **Opaque** refresh tokens (random hex, stored server-side with a 7-day TTL) let clients mint new access JWTs without re-entering credentials. Logout blacklists the access token’s `jti` and deletes the refresh entry. Each request re-loads the user from memory so `role` / `roleVersion` in the JWT must still match the database.

## 14. Run Step 3

```bash
node step3-token-lifecycle.js
```

## 15. Test: Login Returns Access + Refresh Token

```bash
RESPONSE=$(curl -s -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"password456"}')

echo $RESPONSE | jq .
ACCESS=$(echo $RESPONSE | jq -r .accessToken)
REFRESH=$(echo $RESPONSE | jq -r .refreshToken)
```

Expected shape:
```json
{ "accessToken": "eyJ...", "refreshToken": "a3f9...", "expiresIn": 900 }
```

## 16. Test: Refresh Issues New Token Pair (Rotation)

```bash
NEW=$(curl -s -X POST http://localhost:3003/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"$REFRESH\"}")

echo $NEW | jq .
NEW_ACCESS=$(echo $NEW | jq -r .accessToken)
NEW_REFRESH=$(echo $NEW | jq -r .refreshToken)
```

Old refresh token is now invalid — reusing it returns 401:

```bash
curl -s -X POST http://localhost:3003/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"$REFRESH\"}" | jq .
```

Expected:
```json
{ "error": "Invalid or expired refresh token" }
```

## 17. Test: Logout Immediately Revokes Access Token

```bash
RESPONSE=$(curl -s -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"password456"}')
ACCESS=$(echo $RESPONSE | jq -r .accessToken)
REFRESH=$(echo $RESPONSE | jq -r .refreshToken)

# Logout
curl -s -X POST http://localhost:3003/auth/logout \
  -H "Authorization: Bearer $ACCESS" \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"$REFRESH\"}" | jq .

# Try to use the old access token — should be rejected immediately (not wait for expiry)
curl -s http://localhost:3003/profile \
  -H "Authorization: Bearer $ACCESS" | jq .
```

Expected:
```json
{ "error": "Token has been revoked" }
```

## 18. Test: Stale `roleVersion` Rejects an Otherwise Valid JWT

Steps 1–2 trust `role` (and `roleVersion`) embedded in the JWT. Step 3 re-loads the user on every request. If an admin changes bob’s role in the database, you **bump `roleVersion`** so every token issued before that change stops working — without waiting for expiry.

### 18a. Issue a token while bob is still at `roleVersion: 1`

With step 3 running:

```bash
STALE=$(curl -s -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"password456"}' | jq -r .accessToken)

curl -s http://localhost:3003/profile \
  -H "Authorization: Bearer $STALE" | jq .
```

Expected (works — claims match the in-memory user):

```json
{ "id": 2, "username": "bob", "email": "bob@example.com", "role": "user" }
```

### 18b. Simulate a role change in the database

Stop the server (`Ctrl+C`). In `step3-token-lifecycle.js`, find bob’s row in the `users` array and change **`roleVersion` from `1` to `2`** (you can also change `role` to show the same guard):

```javascript
{ id: 2, username: 'bob', ..., role: 'user', email: 'bob@example.com', roleVersion: 2 },
```

Restart:

```bash
node step3-token-lifecycle.js
```

In production this bump happens when you demote a user, revoke all sessions, or rotate permissions — not by editing a tutorial file.

### 18c. Reuse the old token — signature valid, claims stale

```bash
curl -s http://localhost:3003/profile \
  -H "Authorization: Bearer $STALE" | jq .
```

Expected:

```json
{ "error": "Token claims are stale — log in again" }
```

The JWT is still signed and not expired; `authenticate()` fails because `payload.roleVersion` (1) no longer matches bob’s record (2). Same response if you change bob’s `role` in the file but leave an old token that still says `"role":"user"`.

### 18d. Fresh login picks up the new version

```bash
FRESH=$(curl -s -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"password456"}' | jq -r .accessToken)

curl -s http://localhost:3003/profile \
  -H "Authorization: Bearer $FRESH" | jq .
```

Expected: profile succeeds again (new token carries `roleVersion: 2`).

**Restore for other demos:** set bob back to `roleVersion: 1` and restart step 3.

---

# Code Review: What Changed Each Step

## Step 0 → Step 1: Authentication

| Before (naive) | After (step1) | Why |
|---|---|---|
| Plaintext passwords in users array | `bcrypt.hashSync(password, 10)` | Breach exposes hashes, not cleartext |
| No login route | `POST /auth/login` returns signed JWT | Identity established via credentials |
| Hardcoded `JWT_SECRET` | `process.env.JWT_SECRET` with demo fallback + warning | Secrets belong in env, not source |
| No middleware | `authenticate()` middleware | Unsigned/expired tokens rejected |
| Passwords returned in responses | `.map(u => ({...}))` strips `passwordHash` | Prevent hash leakage |

## Step 1 → Step 2: Authorization

| Before (step1) | After (step2) | Why |
|---|---|---|
| Any authenticated user hits `/admin/*` | `requireRole('admin')` middleware | Role checked, not just identity |
| Any authenticated user lists all users | `GET /users` requires `admin` | Directory data not exposed to regular users |
| `POST /admin/users` spreads `...req.body` | Whitelist `username`, `password`, `role`, `email` | Blocks mass assignment of extra fields |
| Any user deletes any other user | `req.user.id !== targetId` ownership check | Users cannot delete others' accounts |
| Any user edits any post | `post.userId !== req.user.id` ownership check | Users can only modify their own resources |
| No `/profile` route | `GET /profile` returns `req.user` data | Safe self-service without exposing all users |

## Step 2 → Step 3: Token Lifecycle

| Before (step2) | After (step3) | Why |
|---|---|---|
| Single 7-day JWT | Access JWT 15m + opaque refresh token | Limits stolen access-token window to 15 minutes |
| No refresh endpoint | `POST /auth/refresh` with rotation | Clients get new tokens; old refresh invalidated |
| Refresh tokens never expire server-side | `expiresAt` on each refresh entry + purge | Stolen refresh tokens eventually die |
| No logout | `POST /auth/logout` blacklists JTI | Immediate revocation before natural expiry |
| No JTI in token | `jti: crypto.randomUUID()` in claims | Enables targeted per-token revocation |
| Role taken only from JWT | `resolveUserFromTokenClaims()` vs DB | Demotion/promotion invalidates stale tokens when `roleVersion` bumps |
| Signed refresh JWT (N/A here) | Opaque hex in server store | Refresh is looked up, not verified with a second JWT secret |

---

# Summary: The Full Picture

| Problem | Step 0 | Step 1 | Step 2 | Step 3 |
|---------|--------|--------|--------|--------|
| Anonymous access to protected routes | ❌ | ✅ | ✅ | ✅ |
| Plaintext passwords stored/returned | ❌ | ✅ | ✅ | ✅ |
| Regular users hitting admin routes | ❌ | ❌ | ✅ | ✅ |
| Regular users listing all accounts (`GET /users`) | ❌ | ❌ | ✅ | ✅ |
| Mass assignment on user creation | ❌ | ❌ | ✅ | ✅ |
| Cross-user resource modification | ❌ | ❌ | ✅ | ✅ |
| Stale role in JWT after DB role change | ❌ | ❌ | ❌ | ✅ |
| Long-lived unrevocable tokens | ❌ | ❌ | ❌ | ✅ |
| No logout / session termination | ❌ | ❌ | ❌ | ✅ |
| Compromised token stays valid until expiry | ❌ | ❌ | ❌ | ✅ |

Authentication stops anonymous attackers. Authorization stops authenticated attackers from exceeding their privilege. Token lifecycle limits blast radius when credentials are compromised — the most realistic real-world threat.

---

# Demo Limitations (Not Bugs — Simplifications)

These servers run in memory on localhost. They deliberately stop short of production completeness:

| Topic | What the demo does | What production does |
|-------|-------------------|----------------------|
| Secrets | Env vars with insecure fallbacks + console warnings | Required secrets from a vault; no defaults |
| Refresh tokens | Opaque random hex in a `Map` with `expiresAt` | Redis (or DB) with TTL; survives restarts |
| Access revocation | In-memory `Set` of JTIs | Redis/DB blacklist with TTL ≥ max access token life |
| Process restart | Refresh store and JTI blacklist are wiped | Persistent stores keep sessions consistent |
| Role in JWT | Step 1–2 trust claims; step 3 checks `role` + `roleVersion` against DB | Always authorize from DB; bump `roleVersion` on role change |
| Refresh signing | No `REFRESH_SECRET` — refresh is not a JWT | Either opaque server-side tokens (this tutorial) or signed refresh JWTs with their own key rotation |

---

# Production Checklist

- [ ] Store `JWT_SECRET` / `ACCESS_SECRET` in environment variables, never in source code
- [ ] Use asymmetric key pairs (RS256/ES256) for JWTs so services can verify without knowing the signing key
- [ ] Set access token expiry to 15 minutes or less
- [ ] Implement refresh token rotation — each use issues a new refresh token and invalidates the old one
- [ ] Store opaque refresh tokens server-side (Redis with TTL) or use signed refresh JWTs with a dedicated rotation policy
- [ ] Re-check roles (and a `roleVersion` or session version) from the database on each request — do not trust JWT role claims alone
- [ ] Implement `/auth/logout` that blacklists the token JTI and deletes the refresh token
- [ ] Hash passwords with bcrypt (cost factor ≥ 10) or argon2id — never store or log plaintext
- [ ] Never return `passwordHash` (or any credential) in API responses
- [ ] Add rate limiting to `/auth/login` and `/auth/refresh` to resist brute force
- [ ] Use HTTPS only — tokens in Authorization headers are plaintext over HTTP
- [ ] Validate and sanitize all input on auth endpoints (username/password length, type)
- [ ] Log auth events (login, logout, failed attempts) for audit and anomaly detection — never log the token itself
- [ ] For admin routes, consider IP allowlisting or MFA in addition to role checks
- [ ] Rotate JWT signing keys periodically; support multiple valid keys during rotation windows
- [ ] In a microservice architecture, verify tokens at the API gateway — never forward raw tokens between internal services

---

# References

- [JWT RFC 7519](https://datatracker.ietf.org/doc/html/rfc7519) — JWT specification including registered claims (`jti`, `exp`, `iss`)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- [jsonwebtoken npm docs](https://github.com/auth0/node-jsonwebtoken#readme)
- [bcryptjs npm docs](https://github.com/dcodeIO/bcrypt.js#readme)
