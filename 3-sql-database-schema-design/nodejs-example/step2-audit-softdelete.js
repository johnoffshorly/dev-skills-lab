// STEP 2: Audit trails + Soft deletes.
// Fixed:   no timestamps, no who-changed-it, hard deletes destroying history.
// Still missing: migration versioning, indexes.

'use strict';
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');

// ─── SCHEMA ──────────────────────────────────────────────────────────────────
// GOOD: created_at auto-set on insert
// GOOD: updated_at kept in sync via AFTER UPDATE trigger
// GOOD: deleted_at = soft delete marker (NULL means "alive")
// GOOD: created_by / updated_by for accountability
db.exec(`
  CREATE TABLE customers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    email       TEXT    NOT NULL UNIQUE,
    city        TEXT    NOT NULL,
    -- audit columns
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    created_by  TEXT    NOT NULL DEFAULT 'system',
    updated_by  TEXT    NOT NULL DEFAULT 'system',
    deleted_at  TEXT    DEFAULT NULL    -- NULL = active, timestamp = soft-deleted
  );

  CREATE TABLE products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    sku         TEXT    NOT NULL UNIQUE,
    price_cents INTEGER NOT NULL CHECK (price_cents > 0),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    created_by  TEXT    NOT NULL DEFAULT 'system',
    updated_by  TEXT    NOT NULL DEFAULT 'system',
    deleted_at  TEXT    DEFAULT NULL
  );

  CREATE TABLE orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    status      TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','shipped','delivered','cancelled')),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    created_by  TEXT    NOT NULL DEFAULT 'system',
    updated_by  TEXT    NOT NULL DEFAULT 'system',
    deleted_at  TEXT    DEFAULT NULL
  );

  CREATE TABLE order_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity    INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    created_by  TEXT    NOT NULL DEFAULT 'system',
    updated_by  TEXT    NOT NULL DEFAULT 'system',
    deleted_at  TEXT    DEFAULT NULL
  );
`);

// ─── TRIGGERS — auto-update updated_at on every UPDATE ───────────────────────
// Without triggers, updated_at never changes unless you remember to set it manually.
for (const table of ['customers', 'products', 'orders', 'order_items']) {
  db.exec(`
    CREATE TRIGGER ${table}_updated_at
    AFTER UPDATE ON ${table}
    FOR EACH ROW
    WHEN NEW.updated_at = OLD.updated_at   -- only fire if caller didn't set it manually
    BEGIN
      UPDATE ${table}
        SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = NEW.id;
    END;
  `);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
// All write helpers accept an optional `actor` so created_by/updated_by is tracked.

function createCustomer(name, email, city, actor = 'system') {
  return db.prepare(`
    INSERT INTO customers (name, email, city, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, email, city, actor, actor);
}

function createProduct(name, sku, price, actor = 'system') {
  return db.prepare(`
    INSERT INTO products (name, sku, price_cents, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, sku, Math.round(price * 100), actor, actor);
}

function createOrder(customerId, actor = 'system') {
  return db.prepare(`
    INSERT INTO orders (customer_id, created_by, updated_by)
    VALUES (?, ?, ?)
  `).run(customerId, actor, actor);
}

function addItem(orderId, productId, qty, unitPrice) {
  return db.prepare(`
    INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
    VALUES (?, ?, ?, ?)
  `).run(orderId, productId, qty, Math.round(unitPrice * 100));
}

function updateOrderStatus(orderId, status, actor = 'system') {
  return db.prepare(`
    UPDATE orders SET status = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL
  `).run(status, actor, orderId);
}

// Soft delete — sets deleted_at instead of removing the row
function softDelete(table, id, actor = 'system') {
  return db.prepare(`
    UPDATE ${table}
    SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = ?
    WHERE id = ? AND deleted_at IS NULL
  `).run(actor, id);
}

// Restore a soft-deleted record
function restore(table, id, actor = 'system') {
  return db.prepare(`
    UPDATE ${table}
    SET deleted_at = NULL, updated_by = ?
    WHERE id = ? AND deleted_at IS NOT NULL
  `).run(actor, id);
}

// Standard queries always filter soft-deleted rows
function getActiveCustomers() {
  return db.prepare(`SELECT * FROM customers WHERE deleted_at IS NULL`).all();
}

function getDeletedCustomers() {
  return db.prepare(`SELECT * FROM customers WHERE deleted_at IS NOT NULL`).all();
}

function getOrdersByCustomer(customerId) {
  return db.prepare(`
    SELECT * FROM orders
    WHERE customer_id = ? AND deleted_at IS NULL
    ORDER BY created_at DESC
  `).all(customerId);
}

// ─── DEMO 1: Audit Trail Populated Automatically ─────────────────────────────
function demoAuditTrail() {
  console.log('\n━━━ DEMO 1: Audit Trail ━━━');

  const res = createCustomer('Alice Smith', 'alice@example.com', 'New York', 'admin-ui');
  const alice = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(res.lastInsertRowid);

  console.log('Customer created:');
  console.log(`  name:       ${alice.name}`);
  console.log(`  created_at: ${alice.created_at}`);
  console.log(`  updated_at: ${alice.updated_at}`);
  console.log(`  created_by: ${alice.created_by}`);
  console.log(`  updated_by: ${alice.updated_by}`);
  console.log(`  deleted_at: ${alice.deleted_at}`);

  // Simulate a small delay, then update
  db.prepare(`UPDATE customers SET city = 'Brooklyn', updated_by = 'migration-v2' WHERE id = ?`).run(alice.id);

  const updated = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(alice.id);
  console.log('\nAfter city update by "migration-v2":');
  console.log(`  city:       ${updated.city}`);
  console.log(`  updated_at: ${updated.updated_at}  (trigger fired)`);
  console.log(`  updated_by: ${updated.updated_by}`);
  console.log(`  created_at: ${updated.created_at}  (unchanged)`);
  console.log('FIX: full who/when audit with no manual timestamp management.');

  return res.lastInsertRowid;
}

// ─── DEMO 2: Soft Delete + Restore ───────────────────────────────────────────
function demoSoftDelete(aliceId) {
  console.log('\n━━━ DEMO 2: Soft Delete + Restore ━━━');

  const widgetA = createProduct('Widget A', 'WGT-A', 9.99, 'seed');
  const o = createOrder(aliceId, 'alice-ui');
  addItem(o.lastInsertRowid, widgetA.lastInsertRowid, 2, 9.99);

  console.log('Active customers before delete:');
  getActiveCustomers().forEach(c => console.log(`  ${c.id}: ${c.name} (deleted_at=${c.deleted_at})`));

  // Soft-delete Alice — order history stays intact
  softDelete('customers', aliceId, 'admin-panel');

  console.log('\nActive customers after soft-delete:');
  const active = getActiveCustomers();
  console.log(active.length === 0 ? '  (none)' : active.map(c => c.name).join(', '));

  console.log('\nDeleted customers (recoverable):');
  getDeletedCustomers().forEach(c =>
    console.log(`  ${c.id}: ${c.name}  deleted_at=${c.deleted_at}  deleted_by=${c.updated_by}`)
  );

  // Verify: Alice's orders are still in the DB
  const orders = db.prepare(`SELECT * FROM orders WHERE customer_id = ?`).all(aliceId);
  console.log(`\nAlice's orders still exist: ${orders.length} row(s) (history preserved)`);

  // Restore Alice
  restore('customers', aliceId, 'admin-panel');
  console.log('\nAfter restore:');
  const restored = db.prepare(`SELECT id, name, deleted_at FROM customers WHERE id = ?`).get(aliceId);
  console.log(`  ${restored.name}  deleted_at=${restored.deleted_at}`);
  console.log('FIX: delete is reversible, history intact, no orphaned records.');
}

// ─── DEMO 3: Status Change Audit on Orders ───────────────────────────────────
function demoOrderAudit(aliceId) {
  console.log('\n━━━ DEMO 3: Order Status Change Audit ━━━');

  const o = createOrder(aliceId, 'checkout-service');
  console.log(`Order ${o.lastInsertRowid} created`);

  let order = db.prepare(`SELECT id, status, created_at, updated_at, created_by, updated_by FROM orders WHERE id = ?`)
    .get(o.lastInsertRowid);
  console.log(`  status=${order.status}  created_by=${order.created_by}  updated_at=${order.updated_at}`);

  updateOrderStatus(o.lastInsertRowid, 'shipped', 'fulfillment-service');
  order = db.prepare(`SELECT id, status, created_at, updated_at, created_by, updated_by FROM orders WHERE id = ?`)
    .get(o.lastInsertRowid);
  console.log(`  status=${order.status}  updated_by=${order.updated_by}  updated_at=${order.updated_at}`);

  updateOrderStatus(o.lastInsertRowid, 'delivered', 'delivery-webhook');
  order = db.prepare(`SELECT id, status, created_at, updated_at, created_by, updated_by FROM orders WHERE id = ?`)
    .get(o.lastInsertRowid);
  console.log(`  status=${order.status}  updated_by=${order.updated_by}  updated_at=${order.updated_at}`);

  console.log('FIX: each service stamps its name — full lineage without a separate events table.');
}

// ─── DEMO 4: What's Still Missing ─────────────────────────────────────────────
function demoStillMissing() {
  console.log('\n━━━ DEMO 4: Still Missing — Migrations + Indexes ━━━');

  // Run a query that would be slow on large data — no index exists
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM orders WHERE customer_id = 1`).all();
  console.log('EXPLAIN QUERY PLAN for "orders WHERE customer_id = 1":');
  plan.forEach(row => console.log(`  ${row.detail}`));
  console.log('PROBLEM: SCAN = full table scan. On 1M rows this is slow.');
  console.log('         Also: still no schema_migrations table — changes are untracked.');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
console.log('='.repeat(60));
console.log('STEP 2 — Audit Trails + Soft Deletes');
console.log('='.repeat(60));

const aliceId = demoAuditTrail();
demoSoftDelete(aliceId);
demoOrderAudit(aliceId);
demoStillMissing();

console.log('\n' + '─'.repeat(60));
console.log('STATUS:');
const fixed = [
  'Data duplication  — normalized tables',
  'No FK / constraints — enforced',
  'No audit trail    — created_at, updated_at (trigger), created_by, updated_by',
  'Hard deletes      — deleted_at soft-delete + restore() helper',
];
const missing = [
  'No migrations     — schema changes still untracked',
  'No indexes        — full table scans on FK columns and filters',
];
fixed.forEach(p => console.log(`  ✅  ${p}`));
missing.forEach(p => console.log(`  ❌  ${p}`));
