# SQL Database Schema Design — Start Simple, Improve Step by Step

Most tutorials show you the "right" schema. This one starts with the wrong one and breaks it in front of you — then fixes it one layer at a time. By the end, you'll recognize and fix the 7 most commonly missed schema problems before they hit production.

**Stack:** Node.js built-in `node:sqlite` / `DatabaseSync` (Node 26+; `node:sqlite` is RC)

## Final Learning Goal

- Understand **why** normalization matters, not just what it is
- Recognize missing constraints that silently corrupt data
- Know the standard audit trail pattern (`created_at`, `updated_at`, `created_by`) and exact-money pattern (integer cents)
- Implement soft deletes correctly — and know when to use them
- Write an idempotent migration runner from scratch
- Read `EXPLAIN QUERY PLAN` output and know when you need an index

---

## 1. Setup

```bash
cd sql-database-schema-design/nodejs-example
node step0-naive.js
```

No `npm install` needed.

| File | What it teaches |
|------|----------------|
| `step0-naive.js` | All 7 problems in one flat table — baseline |
| `step1-normalization.js` | Normalized tables + FK + CHECK/NOT NULL/UNIQUE constraints |
| `step2-audit-softdelete.js` | Audit trail columns + triggers + soft delete pattern |
| `step3-migrations-indexes.js` | Migration versioning + indexes + EXPLAIN QUERY PLAN |

Each file is **standalone** — no shared state, no imports between steps. Run any step independently.

Requires Node 26+ for the built-in `node:sqlite` module (`DatabaseSync`).

---

# STEP 0 — Naive Flat Table

One `orders` table holds everything: customer name, email, city, product name, SKU, price — all repeated in every row. No constraints, no timestamps, hard deletes only.

## 2. Run Step 0

```bash
node step0-naive.js
```

**Problems intentionally present:**
- Customer data duplicated in every order row
- No constraints: NULL emails, negative prices, duplicate SKUs all accepted
- Hard deletes destroy records permanently
- No timestamp columns — no audit trail
- No migration tracking — schema changes unversioned

---

## 3. Demo 1: Data Duplication

### How to trigger it
```bash
node step0-naive.js
```

### What happens
```
DEMO 1: Data Duplication
Alice has 3 orders — 2 different emails on file:
  order 1: Alice Smith <alice@example.com>
  order 2: Alice Smith <alice@example.com>
  order 3: Alice Smith <alice.smith@example.com>   ← typo on row 3
PROBLEM: fixing Alice's email requires UPDATE on every row she appears in.
```

### Why it happens
```sql
CREATE TABLE orders (
  customer_name  TEXT,
  customer_email TEXT,   -- no UNIQUE, no FK
  ...
);
```
No separate `customers` table — customer data is embedded in every order row. One typo in one INSERT creates a split record with no automatic repair.

---

## 4. Demo 2: No Constraints

### How to trigger it
```bash
node step0-naive.js
```

### What happens
```
DEMO 2: No Constraints
Invalid rows SQLite accepted:
  id=5 name=null email=null price=5
  id=6 name=Bob email=bob@example.com price=-99.99
Same SKU "WGT-A" has multiple prices:
  sku=WGT-A price=9.99
  sku=WGT-A price=999
PROBLEM: garbage in, garbage out — no DB-level enforcement.
```

### Why it happens
```sql
CREATE TABLE orders (
  unit_price REAL,    -- no CHECK (unit_price > 0)
  product_sku TEXT    -- no products table to own canonical SKU/price
  ...
);
```
Without `CHECK`, `NOT NULL`, and `UNIQUE`, SQLite accepts any value. Application-level validation is not enough — a bug, a migration script, or a direct DB connection bypasses it.

---

## 5. Demo 3: Hard Deletes Destroy History

### How to trigger it
```bash
node step0-naive.js
```

### What happens
```
DEMO 3: Hard Deletes Destroy History
Created order id=9 for Eve
After DELETE: SELECT returns → undefined
PROBLEM: order gone forever. No audit trail, no way to recover,
         no record that Eve ever placed this order.
```

### Why it happens
```sql
DELETE FROM orders WHERE id = ?;
-- Row is gone. No deleted_at, no recovery, no history.
```
No `deleted_at` column means every delete is permanent. Regulators, support tickets, and charge disputes all require knowing what existed.

---

# STEP 1 — Normalization + Constraints

Splits the flat table into `customers`, `products`, `orders`, `order_items`. Adds `REFERENCES` (FK), `NOT NULL`, `UNIQUE`, and `CHECK`. Enables `PRAGMA foreign_keys = ON` (SQLite has FK enforcement OFF by default).

## 6. Run Step 1

```bash
node step1-normalization.js
```

**What this fixes:** duplication, referential integrity, bad data acceptance
**Still missing:** audit trail, soft deletes, migration versioning, indexes

---

## 7. Test: Normalization Works — One Update, All Orders Fixed

```bash
node step1-normalization.js
```

Expected output:
```
DEMO 1: Normalization — One Source of Truth
Before email update:
  order 1: Alice Smith <alice@example.com>
  order 2: Alice Smith <alice@example.com>
  order 3: Alice Smith <alice@example.com>

After single UPDATE on customers:
  order 1: Alice Smith <alice.updated@example.com>
  order 2: Alice Smith <alice.updated@example.com>
  order 3: Alice Smith <alice.updated@example.com>
FIX: one row updated, all 3 orders reflect new email immediately.
```

---

## 8. Test: Constraints Block Invalid Data

```bash
node step1-normalization.js
```

Expected output:
```
DEMO 2: Constraints Block Bad Data
  ✅  Duplicate email: blocked → UNIQUE constraint failed: customers.email
  ✅  Negative product price: blocked → CHECK constraint failed: price_cents > 0
  ✅  Zero quantity in order: blocked → CHECK constraint failed: quantity > 0
  ✅  Invalid order status: blocked → CHECK constraint failed
  ✅  FK violation — order for non-existent customer: blocked → FOREIGN KEY constraint failed
```

---

## 9. Confirm: Audit Trail Still Missing

```bash
node step1-normalization.js
```

Expected output:
```
DEMO 4: Still Missing — Audit Trail
Order 4 status: shipped
  created_at: (column does not exist)
  updated_at: (column does not exist)
  deleted_at: (column does not exist — hard deletes still used)
STILL MISSING: when was this created? when updated? who did it?
```

---

# STEP 2 — Audit Trails + Soft Deletes

Adds `created_at`, `updated_at`, `created_by`, `updated_by`, and `deleted_at` to every mutable table, including `order_items`. Adds an `AFTER UPDATE` trigger to keep `updated_at` current automatically. Implements `softDelete()` and `restore()` helpers. All active-record queries use `WHERE deleted_at IS NULL`.

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
DEMO 1: Audit Trail
Customer created:
  name:       Alice Smith
  created_at: 2024-01-15T10:23:45.123Z
  updated_at: 2024-01-15T10:23:45.123Z
  created_by: admin-ui
  updated_by: admin-ui
  deleted_at: null

After city update by "migration-v2":
  city:       Brooklyn
  updated_at: 2024-01-15T10:23:45.201Z  (trigger fired)
  updated_by: migration-v2
  created_at: 2024-01-15T10:23:45.123Z  (unchanged)
FIX: full who/when audit with no manual timestamp management.
```

---

## 12. Test: Soft Delete Is Reversible

```bash
node step2-audit-softdelete.js
```

Expected output:
```
DEMO 2: Soft Delete + Restore
Active customers before delete:
  1: Alice Smith (deleted_at=null)

Active customers after soft-delete:
  (none)

Deleted customers (recoverable):
  1: Alice Smith  deleted_at=2024-01-15T10:23:45.300Z  deleted_by=admin-panel

Alice's orders still exist: 1 row(s) (history preserved)

After restore:
  Alice Smith  deleted_at=null
FIX: delete is reversible, history intact, no orphaned records.
```

---

## 13. Confirm: Queries Still Doing Full Scans

```bash
node step2-audit-softdelete.js
```

Expected output:
```
DEMO 4: Still Missing — Migrations + Indexes
EXPLAIN QUERY PLAN for "orders WHERE customer_id = 1":
  SCAN orders
PROBLEM: SCAN = full table scan. On 1M rows this is slow.
         Also: still no schema_migrations table — changes are untracked.
```

---

# STEP 3 — Migrations + Indexes

Adds a `schema_migrations` table and an idempotent `runMigrations()` runner. Migrations are numbered, named, and recorded once. Adds FK indexes, a composite index, and partial indexes. Shows `EXPLAIN QUERY PLAN` going from `SCAN` to `SEARCH`.

## 14. Run Step 3

```bash
node step3-migrations-indexes.js
```

**What this fixes:** untracked schema changes, full table scans
**All prior fixes retained:** normalization, constraints, audit, soft delete

---

## 15. Test: Migration Runner Is Idempotent

```bash
node step3-migrations-indexes.js
```

Expected output:
```
DEMO 1: Migration Runner — First Run
  ✔  Migration 1: create_base_schema
  ✔  Migration 2: add_performance_indexes
  ✔  Migration 3: add_phone_to_customers
  ✔  Migration 4: add_discount_to_order_items

Applied migrations in schema_migrations:
  v1: create_base_schema          (2024-01-15T10:23:45.000Z)
  v2: add_performance_indexes     (2024-01-15T10:23:45.001Z)
  v3: add_phone_to_customers      (2024-01-15T10:23:45.002Z)
  v4: add_discount_to_order_items (2024-01-15T10:23:45.003Z)

DEMO 1b: Re-run Same Migrations (should be no-ops)
  ✔  All migrations already applied — nothing to do.
```

---

## 16. Test: Indexes Eliminate Full Table Scans

```bash
node step3-migrations-indexes.js
```

Expected output:
```
DEMO 2: EXPLAIN QUERY PLAN — Index Impact
Query: active orders for customer, sorted by date
  SEARCH orders USING INDEX idx_orders_customer_active (customer_id=?)

Query: order items for a specific order
  SEARCH order_items USING INDEX idx_order_items_order_id (order_id=?)
  SEARCH products USING INTEGER PRIMARY KEY (rowid=?)

Query: orders by status (partial index)
  SEARCH orders USING INDEX idx_orders_status (status=?)

FIX: SEARCH (index seek) instead of SCAN (full table scan).
     On 1M rows: index seek = ~microseconds, full scan = ~seconds.
```

---

## 17. Test: New Columns Added Safely via Migration

```bash
node step3-migrations-indexes.js
```

Expected output:
```
DEMO 3: Safe Schema Evolution
customers columns: id, name, email, city, created_at, updated_at, created_by, updated_by, deleted_at, phone
order_items columns: id, order_id, product_id, quantity, unit_price_cents, created_at, updated_at, created_by, updated_by, deleted_at, discount_pct

Alice.phone before update: null  (NULL is safe for old rows)
Alice.phone after update: +1-555-0100  updated_by=profile-service

Order item: qty=2 price_cents=1499 discount=10%
FIX: additive migrations (ADD COLUMN) are zero-downtime safe.
     Every change is recorded, ordered, and applied exactly once.
```

---

# Code Review: What Changed Each Step

## Step 0 → Step 1: Normalization + Constraints

| Before | After | Why |
|--------|-------|-----|
| `customer_name TEXT` in `orders` | Separate `customers` table + FK | One source of truth |
| No `PRAGMA foreign_keys` | `db.exec('PRAGMA foreign_keys = ON')` | SQLite FK is OFF by default |
| No `CHECK` on price | `price_cents INTEGER NOT NULL CHECK (price_cents > 0)` | DB rejects negative prices with exact money |
| No `UNIQUE` on email | `email TEXT NOT NULL UNIQUE` | One account per email address |
| No `CHECK` on status | `CHECK (status IN (...))` | Only valid enum values accepted |

## Step 1 → Step 2: Audit + Soft Delete

| Before | After | Why |
|--------|-------|-----|
| No timestamp columns | `created_at`, `updated_at` with DEFAULT | Auto-set on insert |
| `updated_at` never changes | `AFTER UPDATE` trigger | No manual timestamp management |
| No actor tracking | `created_by`, `updated_by TEXT NOT NULL` | Know who made each change |
| `DELETE FROM table WHERE id = ?` | `SET deleted_at = now() WHERE id = ?` | Reversible, history preserved |
| No restore capability | `restore(table, id)` helper | Undo accidental deletes |
| `SELECT * FROM table` | `SELECT * FROM table WHERE deleted_at IS NULL` | Deleted rows excluded by default |

## Step 2 → Step 3: Migrations + Indexes

| Before | After | Why |
|--------|-------|-----|
| `db.exec(CREATE TABLE ...)` inline | `runMigrations(db, MIGRATIONS)` | Versioned, idempotent, transactional |
| No `schema_migrations` table | `schema_migrations (version, name, applied_at)` | Track what's applied and when |
| No indexes on FK columns | `CREATE INDEX idx_orders_customer_id ON orders(customer_id)` | FK JOINs were full scans |
| Composite index | `CREATE INDEX idx_orders_customer_active ON orders(customer_id, deleted_at, created_at DESC)` | Helps common active-order query |
| No partial index | `CREATE INDEX ... WHERE deleted_at IS NULL` | Smaller index, active rows only |
| Migrations could run twice | `applied = new Set(...)` check | Skip already-applied versions |
| Schema changes crash on re-run | version check + per-migration transaction | Safe rerun, record once |

---

# Summary: The Full Picture

| Problem | Step 0 | Step 1 | Step 2 | Step 3 |
|---------|--------|--------|--------|--------|
| Data duplication (no normalization) | ❌ | ✅ | ✅ | ✅ |
| No referential integrity (FK) | ❌ | ✅ | ✅ | ✅ |
| No validation (CHECK/NOT NULL/UNIQUE) | ❌ | ✅ | ✅ | ✅ |
| No audit trail (who/when) | ❌ | ❌ | ✅ | ✅ |
| Hard deletes destroy history | ❌ | ❌ | ✅ | ✅ |
| No soft delete / restore | ❌ | ❌ | ✅ | ✅ |
| Schema changes untracked (no migrations) | ❌ | ❌ | ❌ | ✅ |
| Slow queries (no indexes) | ❌ | ❌ | ❌ | ✅ |

Each layer builds on the last. Step 1 is meaningless without constraints. Audit trails (step 2) only make sense on a normalized schema. Migrations (step 3) only matter when you have a schema worth protecting. The order is not arbitrary — it mirrors how real production systems accumulate technical debt: skipping step 1 makes step 2 impossible to do right; skipping step 2 means step 3 migrations carry no history of who changed what.

---

# Production Checklist

- [ ] **Enable FK enforcement** — `PRAGMA foreign_keys = ON` on every connection (SQLite default is OFF)
- [ ] **Every table has a surrogate PK** — `INTEGER PRIMARY KEY AUTOINCREMENT` or UUID
- [ ] **Every FK column is indexed** — unindexed FK = full table scan on every JOIN
- [ ] **Audit columns on every mutable table** — `created_at`, `updated_at`, `created_by`, `updated_by`
- [ ] **`updated_at` maintained by trigger** — never rely on application code to set it
- [ ] **Soft delete on tables that matter** — `deleted_at` + filter every active-record query with `WHERE deleted_at IS NULL`
- [ ] **All schema changes go through migrations** — never ALTER outside of a numbered, named migration
- [ ] **Migrations are idempotent** — check `schema_migrations` before applying; record version once

- [ ] **Additive-only schema changes** — ADD COLUMN (nullable or with DEFAULT) is safe; DROP/RENAME requires a multi-step migration
- [ ] **`CHECK` constraints on every enum column** — `status`, `type`, `role`, `state` should all have `CHECK (col IN (...))`
- [ ] **`NOT NULL` by default** — opt into nullable explicitly; don't rely on application defaults
- [ ] **Composite indexes match query patterns** — index columns in the order they appear in `WHERE` + `ORDER BY`
- [ ] **Partial indexes for filtered queries** — `WHERE deleted_at IS NULL` indexes only active rows
- [ ] **`EXPLAIN QUERY PLAN` before shipping** — confirm `SEARCH` not `SCAN` on your most common queries

---

# References

- [SQLite Foreign Key Support](https://www.sqlite.org/foreignkeys.html) — why `PRAGMA foreign_keys = ON` is required
- [SQLite CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html) — trigger syntax for `updated_at` automation
- [SQLite EXPLAIN QUERY PLAN](https://www.sqlite.org/eqp.html) — how to read index usage output
- [Node.js `node:sqlite` docs](https://nodejs.org/api/sqlite.html) — synchronous built-in SQLite driver
- [Database Normalization (1NF–3NF)](https://en.wikipedia.org/wiki/Database_normalization) — conceptual reference for normalization forms
