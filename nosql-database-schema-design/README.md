# NoSQL Database Schema Design — Start Simple, Improve Step by Step

NoSQL databases accept anything — that's their strength and their trap. This tutorial starts with a document store that accepts any shape, then adds validation, audit trails, soft deletes, and migration versioning one layer at a time. Each step breaks something visibly, then fixes it.

**Stack:** Node.js + `@seald-io/nedb` (maintained NeDB fork — embedded, MongoDB-like, no server needed)

## Final Learning Goal

- Understand why schema-less ≠ no schema — you still need one, you just enforce it in code
- Choose correctly between embedding and referencing documents
- Add `_schemaVersion` to every document and upgrade old docs at read time
- Implement audit trails (`createdAt`, `updatedAt`, `createdBy`, `deletedAt`) without relying on the caller
- Soft-delete documents safely and query with `deletedAt: null` always
- Write an idempotent NoSQL migration runner that handles backfills
- Use `ensureIndex()` to avoid full collection scans

---

## 1. Setup

```bash
cd nosql-database-schema-design/nodejs-example
npm install
```

| File | What it teaches |
|------|----------------|
| `step0-naive.js` | All 10 NoSQL schema problems in raw NeDB — baseline |
| `step1-schema-validation.js` | Validators, required fields, `_schemaVersion`, embed vs reference |
| `step2-audit-softdelete.js` | Audit trail injection, soft delete, restore, active-record filter |
| `step3-migrations-indexes.js` | Migration runner, backfill migration, `ensureIndex`, unique indexes |

Each file is **standalone** — no shared state, no imports between steps. Run any step independently.

---

# STEP 0 — Naive Document Design

One NeDB collection. Documents have no consistent shape. No validation, no structure, no timestamps, no indexes.

## 2. Run Step 0

```bash
node step0-naive.js
```

**Problems intentionally present:**
- Any document shape accepted silently — missing fields, wrong types, invalid enums
- Full customer objects embedded in orders — stale copies after any update
- Arrays grow unboundedly inside documents — entire array loaded on every read
- Hard deletes destroy records permanently
- No `_schemaVersion` — can't detect old document format at read time
- No migration tracking — schema drift is invisible

---

## 3. Demo 1: Any Shape Accepted

### How to trigger it
```bash
node step0-naive.js
```

### What happens
```
DEMO 1: Any Shape Accepted
Inserted 4 documents with completely different shapes — no error.
Collection now contains docs with shapes:
  _id=...abc123 keys=[note]
  _id=...def456 keys=[customerId, items, status]
  _id=...ghi789 keys=[customerId, items, status, total]
  _id=...jkl012 keys=[type, number, lines]
PROBLEM: application expects { customerId, items, status, total }
         but any garbage shape is stored silently.
```

### Why it happens
```js
await orders.insertAsync({ note: 'incomplete order' });          // no error
await orders.insertAsync({ price: 'free', status: 'YOLO' });    // no error
await orders.insertAsync({ type: 'invoice', lines: [1,2,3] });  // no error
```
NeDB lacks built-in schema enforcement. MongoDB can also use collection validators, but application validation still keeps rules close to code. The database stores whatever you give it. An application bug, a manual insert, or a migration script can corrupt your data permanently without any error.

---

## 4. Demo 2: Denormalization Without a Sync Strategy

### How to trigger it
```bash
node step0-naive.js
```

### What happens
```
DEMO 2: Denormalization — Stale Embedded Data
Customer email now: alice@new.com
Order embedded customer emails (stale):
  alice@old.com  ← stale copy
  alice@old.com  ← stale copy
PROBLEM: embedded copies diverge the moment the source document changes.
```

### Why it happens
```js
// Embedded full customer object in every order
await orders.insertAsync({
  customer: { _id: 'cust-alice', email: 'alice@old.com', ... },
  ...
});
// Update customer — orders are NOT automatically updated
await customers.updateAsync({ _id: 'cust-alice' }, { $set: { email: 'alice@new.com' } }, {});
// Orders still contain alice@old.com
```
Embedding a full object instead of a reference ID means every copy must be updated manually when the source changes. Miss one document → corrupted data. There is no foreign key to cascade updates.

---

## 5. Demo 3: Unbounded Array Growth

### How to trigger it
```bash
node step0-naive.js
```

### What happens
```
DEMO 3: Unbounded Embedded Array Growth
Post document now embeds 20 comments in a single doc.
Every read of this post loads ALL comments — even if you only need the title.
PROBLEM: no natural stopping point. Real posts get hundreds of comments.
         Entire array loaded into memory on every find(). No pagination possible.
```

### Why it happens
```js
// Comments embedded directly in post document
await orders.updateAsync({ _id: post._id }, { $push: { comments: newComment } }, {});
```
NeDB loads the full document on every `findAsync`. An embedded array with 1000 items means 1000 items are deserialized even when you only need `post.title`. There is no way to paginate embedded arrays — you must load all or none.

---

# STEP 1 — Schema Validation + Document Design

Adds `validateOrder()`, `validateCustomer()`, `validateProduct()` functions that run before every insert. Stamps `_schemaVersion` on every document. Switches from embedding full objects to storing reference IDs. Introduces `upgradeOrderDoc()` for read-time schema compatibility.

## 6. Run Step 1

```bash
node step1-schema-validation.js
```

**What this fixes:** any shape accepted, wrong types, missing required fields, stale embedded copies, no `_schemaVersion`
**Still missing:** audit trail, soft deletes, migration versioning, indexes

---

## 7. Test: Validation Blocks Invalid Inserts

```bash
node step1-schema-validation.js
```

Expected output:
```
DEMO 1: Validation Blocks Bad Data
  ✅  Missing customerId: blocked → Order validation failed: customerId: required string
  ✅  Empty items array: blocked → Order validation failed: items: required non-empty array
  ✅  Invalid status: blocked → Order validation failed: status: must be one of pending,shipped,...
  ✅  Price is string: blocked → Order validation failed: items[0].unitPrice: required positive number
  ✅  Zero quantity: blocked → Order validation failed: items[0].qty: required positive integer
  ✅  Embedded customer obj: blocked → Order validation failed: customerId: required string
```

---

## 8. Test: Reference Strategy Prevents Stale Copies

```bash
node step1-schema-validation.js
```

Expected output:
```
DEMO 2: Reference Strategy — No Stale Copies
Customer email now: alice@new.com
Orders referencing this customer: 2
Each order stores customerId — reads fetch current customer data.

Order document structure:
  customerId: "abc123..."   ← reference ID, not embedded object
  items[0].productId: "def456..."  ← reference
  items[0].unitPrice: 9.99  ← price SNAPSHOT (historical)
  _schemaVersion: 1
FIX: no stale copies. Customer email update = 1 document, not N order docs.
```

---

## 9. Confirm: Audit Trail Still Missing

```bash
node step1-schema-validation.js
```

Expected output:
```
DEMO 4: Still Missing — Audit Trail
Order status: shipped
  createdAt: (does not exist)
  updatedAt: (does not exist)
  createdBy: (does not exist)
  deletedAt: (does not exist — hard deletes still used)
STILL MISSING: who created this? when? who changed the status?
```

---

# STEP 2 — Audit Trails + Soft Deletes

Adds `auditStamp(actor)` and `updateStamp(actor)` helpers injected by every write function. Replaces `removeAsync` with `softDelete()`. Adds `restore()`. All active-record queries go through `findActiveOrders()` which always filters `deletedAt: null`.

## 10. Run Step 2

```bash
node step2-audit-softdelete.js
```

**What this fixes:** no timestamps, no actor tracking, permanent hard deletes
**Still missing:** migration versioning, indexes

---

## 11. Test: Audit Trail Auto-Populated

```bash
node step2-audit-softdelete.js
```

Expected output:
```
DEMO 1: Audit Trail Auto-Populated
Order created by checkout-service:
  _id:       ...a1b2c3d4
  status:    pending
  createdAt: 2024-01-15T10:23:45.123Z
  updatedAt: 2024-01-15T10:23:45.123Z
  createdBy: checkout-service
  updatedBy: checkout-service
  deletedAt: null

After status → shipped by fulfillment-service:
  status:    shipped
  updatedAt: 2024-01-15T10:23:45.201Z  (changed)
  updatedBy: fulfillment-service
  createdAt: 2024-01-15T10:23:45.123Z  (unchanged)
FIX: every change is traceable — who did it, when.
```

---

## 12. Test: Soft Delete Is Reversible

```bash
node step2-audit-softdelete.js
```

Expected output:
```
DEMO 2: Soft Delete + Restore
Active customers:
  Alice Smith (deletedAt=null)

After softDelete(alice):
Active customers:
  (none)

Deleted customers (recoverable):
  Alice Smith  deletedAt=2024-01-15T10:23:45.300Z  deletedBy=admin-panel

Alice's orders still in DB: 1  (history preserved)

After restore: deletedAt=null
FIX: reversible, actor-stamped, history intact.
```

---

## 13. Confirm: Indexes Still Missing

```bash
node step2-audit-softdelete.js
```

Expected output:
```
DEMO 4: Still Missing — Migrations + Indexes
No schema_migrations collection exists — schema changes are untracked.
No ensureIndex() calls — every findAsync() is a full collection scan.

Simulating: find all pending orders (no index on "status"):
  orders.findAsync({ status: "pending", deletedAt: null })
  → NeDB scans EVERY document in the collection.
STILL MISSING: ensureIndex + migration runner.
```

---

# STEP 3 — Migrations + Indexes

Adds a `migrations` NeDB collection and `runMigrations()` function. Migrations are version-numbered, named, and idempotent. Adds a unique index on migration `version`, backfills `_schemaVersion` and `currency` into legacy docs, and calls `ensureIndex()` for every query-hot field. Introduces `upgradeOrderDoc()` for read-time schema compatibility.

## 14. Run Step 3

```bash
node step3-migrations-indexes.js
```

**What this fixes:** untracked schema changes, full collection scans, schema drift
**All prior fixes retained:** validation, `_schemaVersion`, audit, soft delete

---

## 15. Test: Migration Runner Is Idempotent

```bash
node step3-migrations-indexes.js
```

Expected output:
```
DEMO 1: Migration Runner — First Run
  ✔  Migration 1: ensure_indexes_on_orders
  ✔  Migration 2: ensure_indexes_on_customers
  ✔  Migration 3: ensure_indexes_on_products
  ✔  Migration 4: backfill_schema_version_on_legacy_orders
  ✔  Migration 5: add_currency_field_to_orders

DEMO 1b: Re-run (should be no-ops)
  ✔  All migrations already applied — nothing to do.
FIX: idempotent — safe to call on every app startup.
```

---

## 16. Test: Unique Index Blocks Duplicate Emails

```bash
node step3-migrations-indexes.js
```

Expected output:
```
DEMO 2: Unique Index Blocks Duplicate Emails
  ✅  Duplicate email blocked by unique index: It is forbidden to store 2 documents with the same value for field email
FIX: ensureIndex({ fieldName: "email", unique: true }) enforces uniqueness at DB level.
```

---

## 17. Test: Indexes Active on Common Queries

```bash
node step3-migrations-indexes.js
```

Expected output:
```
DEMO 4: Indexes Active — Common Query Patterns
Active orders for Alice: 5  (indexes: customerId, deletedAt)
Pending orders total:    3  (indexes: status, deletedAt)

Active indexes on orders collection:
  _id
  customerId
  status
  deletedAt
  createdAt

FIX: ensureIndex() turns O(n) full scans into O(log n) index seeks.
     NeDB uses binary search trees (AVL) for indexes.
```

---

# Code Review: What Changed Each Step

## Step 0 → Step 1: Validation + Document Design

| Before | After | Why |
|--------|-------|-----|
| `orders.insertAsync(anyDoc)` | `createOrder(data)` calls `validateOrder(data)` first | Reject bad shapes before they reach the DB |
| `customer: { name, email }` embedded | `customerId: alice._id` reference | One update, no stale copies |
| No `_schemaVersion` | `_schemaVersion: 1` on every doc | Detect old doc format at read time |
| Unbounded `comments: []` in post | `comments` as separate collection | Full post read doesn't load 1000 comments |
| Any status string | `CHECK (status IN (...))` via validator | Enum safety in application code |

## Step 1 → Step 2: Audit + Soft Delete

| Before | After | Why |
|--------|-------|-----|
| No timestamp fields | `auditStamp(actor)` injected on every insert | No caller needs to remember |
| No `updatedAt` update | `updateStamp(actor)` injected on every write | Tracks every change |
| `orders.removeAsync(...)` | `softDelete(orders, id, actor)` | Reversible, history preserved |
| No restore capability | `restore(orders, id, actor)` | Undo accidental deletes |
| `orders.findAsync({...})` | `findActiveOrders({...})` = `deletedAt: null` | Deleted docs never leak |
| No actor on deletes | `updatedBy = actor` on soft delete | Know who removed it |

## Step 2 → Step 3: Migrations + Indexes

| Before | After | Why |
|--------|-------|-----|
| Schema changes untracked | `migrations` collection + `runMigrations()` | Every change versioned, ordered, applied once |
| Re-running changes crashes or double-applies | Check `applied.has(version)` before running | Idempotent — call on every startup |
| `orders.insertAsync` directly | `up()` + `migrations.insertAsync` in same logical unit | Apply and record together |
| No index on `customerId` | `ensureIndex({ fieldName: 'customerId' })` | FK join field was a full scan |
| No index on `status` | `ensureIndex({ fieldName: 'status' })` | Dashboard filter was a full scan |
| No unique index on `email` | `ensureIndex({ fieldName: 'email', unique: true })` | DB-level uniqueness enforcement |
| Old docs missing `currency` | Migration 5 backfill + `upgradeOrderDoc()` | Two-layer safety for schema drift |

---

# Summary: The Full Picture

| Problem | Step 0 | Step 1 | Step 2 | Step 3 |
|---------|--------|--------|--------|--------|
| Any document shape accepted | ❌ | ✅ | ✅ | ✅ |
| Missing required fields silently accepted | ❌ | ✅ | ✅ | ✅ |
| Wrong types silently accepted | ❌ | ✅ | ✅ | ✅ |
| Embedded objects → stale copies on update | ❌ | ✅ | ✅ | ✅ |
| Unbounded array growth in documents | ❌ | ✅ | ✅ | ✅ |
| No `_schemaVersion` — can't detect old shape | ❌ | ✅ | ✅ | ✅ |
| No audit trail (who/when) | ❌ | ❌ | ✅ | ✅ |
| Hard deletes destroy history | ❌ | ❌ | ✅ | ✅ |
| Deleted docs leak into active queries | ❌ | ❌ | ✅ | ✅ |
| Schema changes untracked (no migrations) | ❌ | ❌ | ❌ | ✅ |
| Full collection scan on every query | ❌ | ❌ | ❌ | ✅ |
| Schema drift across documents | ❌ | ❌ | ❌ | ✅ |

The fundamental insight: **NoSQL is not schema-free, it's schema-flexible.** That flexibility means you must implement every safeguard that a relational DB would give you for free — type enforcement, required fields, referential integrity, uniqueness, audit, and versioning — all in application code. The upside is that you control exactly how strict or lenient each rule is, and you can evolve the schema document-by-document rather than in a single blocking ALTER TABLE.

---

# Production Checklist

- [ ] **Never insert raw user input** — always validate through a schema-aware create function before calling `insertAsync`
- [ ] **Every document gets `_schemaVersion`** — stamp it on insert, check it on read, use it to route to the right reader
- [ ] **Use `upgradeDoc()` at read time** — lets you ship schema changes without a full backfill completing first
- [ ] **Reference by ID, not by embedding** — embed only immutable snapshots (price at time of order) or truly static data
- [ ] **Bound every embedded array** — if an array can grow past ~100 items, make it a separate collection
- [ ] **Soft delete by default** — `deletedAt: null` filter costs almost nothing; losing a row permanently is irreversible
- [ ] **All write helpers inject audit fields** — `createdAt`, `updatedAt`, `createdBy`, `updatedBy` must never be left to the caller
- [ ] **Every active-record query filters `deletedAt: null`** — wrap in a helper so it's impossible to forget
- [ ] **`ensureIndex()` on every field you query** — NeDB and MongoDB default to full scans; index every FK-like field, every filter field, every sort field
- [ ] **Unique indexes at DB level** — don't rely on application-level uniqueness checks; race conditions exist
- [ ] **All schema changes go in numbered migrations** — never `insertAsync`/`updateAsync` schema changes directly in app startup
- [ ] **Migration runner is idempotent** — check `applied.has(version)` before every migration
- [ ] **Write a backfill migration for new required fields** — `updateAsync({ field: { $exists: false } }, { $set: { field: default } }, { multi: true })`
- [ ] **Never delete a migration** — add a new corrective one instead; history is the point
- [ ] **Test `upgradeDoc()` covers every schema version** — write a test that passes a v0, v1, v2 doc and verifies the output

---

# References

- [@seald-io/nedb — maintained NeDB fork](https://github.com/seald-io/nedb) — API docs, index options, query operators
- [NeDB original README](https://github.com/louischatriot/nedb) — original design goals and embedded-DB rationale
- [MongoDB Schema Design Best Practices](https://www.mongodb.com/developer/products/mongodb/mongodb-schema-design-best-practices/) — embed vs reference decision guide
- [The 6 Rules of Thumb for MongoDB Schema Design](https://www.mongodb.com/blog/post/6-rules-of-thumb-for-mongodb-schema-design) — when to embed, when to reference
- [Evolutionary Database Design](https://martinfowler.com/articles/evodb.html) — Fowler's principles for schema migration in any DB
