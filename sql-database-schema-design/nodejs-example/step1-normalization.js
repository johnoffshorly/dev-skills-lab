// STEP 1: Normalization + Constraints.
// Fixed:   data duplication, no FK, no referential integrity, no validation.
// Still missing: audit trails (created_at/updated_at), soft deletes,
//                migration versioning, indexes.

'use strict';
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(':memory:');

// Enable FK enforcement — SQLite has it OFF by default
db.exec('PRAGMA foreign_keys = ON');

// ─── SCHEMA ──────────────────────────────────────────────────────────────────
// GOOD: separate tables — one source of truth per entity
// GOOD: constraints enforce valid data at the DB level
db.exec(`
  CREATE TABLE customers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    email      TEXT    NOT NULL UNIQUE,   -- one account per email
    city       TEXT    NOT NULL
  );

  CREATE TABLE products (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    sku        TEXT    NOT NULL UNIQUE,   -- SKU is a natural unique key
    price_cents INTEGER NOT NULL CHECK (price_cents > 0)  -- exact money, stored as cents
  );

  CREATE TABLE orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    status      TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','shipped','delivered','cancelled'))
  );

  CREATE TABLE order_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity   INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0)
    -- unit_price_cents snapshot: if product price changes later, old orders stay accurate
  );
`);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function insertCustomer(name, email, city) {
  return db.prepare(`INSERT INTO customers (name, email, city) VALUES (?, ?, ?)`).run(name, email, city);
}

function insertProduct(name, sku, price) {
  return db.prepare(`INSERT INTO products (name, sku, price_cents) VALUES (?, ?, ?)`).run(name, sku, Math.round(price * 100));
}

function createOrder(customerId) {
  return db.prepare(`INSERT INTO orders (customer_id) VALUES (?)`).run(customerId);
}

function addItem(orderId, productId, qty, unitPrice) {
  return db.prepare(
    `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES (?, ?, ?, ?)`
  ).run(orderId, productId, qty, Math.round(unitPrice * 100));
}

// ─── SEED ─────────────────────────────────────────────────────────────────────
const alice = insertCustomer('Alice Smith', 'alice@example.com', 'New York');
const bob   = insertCustomer('Bob Jones',   'bob@example.com',   'LA');

const widgetA = insertProduct('Widget A', 'WGT-A', 9.99);
const widgetB = insertProduct('Widget B', 'WGT-B', 14.99);
const gadgetX = insertProduct('Gadget X', 'GDG-X', 49.99);

// ─── DEMO 1: Update Email In One Place ───────────────────────────────────────
function demoNormalization() {
  console.log('\n━━━ DEMO 1: Normalization — One Source of Truth ━━━');

  // Alice places 3 orders
  const o1 = createOrder(alice.lastInsertRowid);
  addItem(o1.lastInsertRowid, widgetA.lastInsertRowid, 2, 9.99);

  const o2 = createOrder(alice.lastInsertRowid);
  addItem(o2.lastInsertRowid, widgetB.lastInsertRowid, 1, 14.99);

  const o3 = createOrder(alice.lastInsertRowid);
  addItem(o3.lastInsertRowid, gadgetX.lastInsertRowid, 1, 49.99);

  console.log('Before email update:');
  const before = db.prepare(`
    SELECT o.id AS order_id, c.name, c.email
    FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE c.id = ?
  `).all(alice.lastInsertRowid);
  before.forEach(r => console.log(`  order ${r.order_id}: ${r.name} <${r.email}>`));

  // One UPDATE fixes all 3 orders simultaneously
  db.prepare(`UPDATE customers SET email = 'alice.updated@example.com' WHERE id = ?`)
    .run(alice.lastInsertRowid);

  console.log('\nAfter single UPDATE on customers:');
  const after = db.prepare(`
    SELECT o.id AS order_id, c.name, c.email
    FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE c.id = ?
  `).all(alice.lastInsertRowid);
  after.forEach(r => console.log(`  order ${r.order_id}: ${r.name} <${r.email}>`));
  console.log('FIX: one row updated, all 3 orders reflect new email immediately.');
}

// ─── DEMO 2: Constraints Block Invalid Data ───────────────────────────────────
function demoConstraints() {
  console.log('\n━━━ DEMO 2: Constraints Block Bad Data ━━━');

  const tests = [
    {
      label: 'Duplicate email',
      fn: () => insertCustomer('Alice Clone', 'alice.updated@example.com', 'NYC'),
    },
    {
      label: 'Negative product price',
      fn: () => insertProduct('Cheap Junk', 'JNK-1', -5.00),
    },
    {
      label: 'Zero quantity in order',
      fn: () => {
        const o = createOrder(bob.lastInsertRowid);
        addItem(o.lastInsertRowid, widgetA.lastInsertRowid, 0, 9.99);
      },
    },
    {
      label: 'Invalid order status',
      fn: () => db.prepare(`INSERT INTO orders (customer_id, status) VALUES (?, ?)`).run(bob.lastInsertRowid, 'LOST'),
    },
    {
      label: 'FK violation — order for non-existent customer',
      fn: () => db.prepare(`INSERT INTO orders (customer_id) VALUES (?)`).run(9999),
    },
  ];

  tests.forEach(({ label, fn }) => {
    try {
      fn();
      console.log(`  ❌  ${label}: SHOULD have been rejected but wasn't`);
    } catch (e) {
      console.log(`  ✅  ${label}: blocked → ${e.message}`);
    }
  });
}

// ─── DEMO 3: FK Cascade — Delete Order Removes Items ─────────────────────────
function demoFKCascade() {
  console.log('\n━━━ DEMO 3: FK Cascade Delete ━━━');

  const o = createOrder(bob.lastInsertRowid);
  addItem(o.lastInsertRowid, widgetA.lastInsertRowid, 1, 9.99);
  addItem(o.lastInsertRowid, widgetB.lastInsertRowid, 2, 14.99);

  const beforeItems = db.prepare(`SELECT * FROM order_items WHERE order_id = ?`).all(o.lastInsertRowid);
  console.log(`Order ${o.lastInsertRowid} has ${beforeItems.length} items before delete`);

  // ON DELETE CASCADE on order_items means items are removed with the order
  db.prepare(`DELETE FROM orders WHERE id = ?`).run(o.lastInsertRowid);

  const afterItems = db.prepare(`SELECT * FROM order_items WHERE order_id = ?`).all(o.lastInsertRowid);
  console.log(`Order ${o.lastInsertRowid} items after delete: ${afterItems.length}`);
  console.log('FIX: no orphaned order_items left behind.');
}

// ─── DEMO 4: What's Still Missing ─────────────────────────────────────────────
function demoStillMissing() {
  console.log('\n━━━ DEMO 4: Still Missing — Audit Trail ━━━');

  const o = createOrder(alice.lastInsertRowid);
  db.prepare(`UPDATE orders SET status = 'shipped' WHERE id = ?`).run(o.lastInsertRowid);

  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(o.lastInsertRowid);
  console.log(`Order ${order.id} status: ${order.status}`);
  console.log('  created_at: (column does not exist)');
  console.log('  updated_at: (column does not exist)');
  console.log('  deleted_at: (column does not exist — hard deletes still used)');
  console.log('STILL MISSING: when was this created? when updated? who did it?');
  console.log('               deleting a customer here would still lose history.');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
console.log('='.repeat(60));
console.log('STEP 1 — Normalization + Constraints');
console.log('='.repeat(60));

demoNormalization();
demoConstraints();
demoFKCascade();
demoStillMissing();

console.log('\n' + '─'.repeat(60));
console.log('STATUS:');
const fixed = [
  'Data duplication  — customers/products have one row each',
  'No FK             — REFERENCES + PRAGMA foreign_keys = ON enforced',
  'No validation     — CHECK, NOT NULL, UNIQUE all active',
];
const missing = [
  'No audit trail    — no created_at, updated_at, updated_by',
  'Hard deletes      — no deleted_at, no soft delete, no restore',
  'No migrations     — schema changes still untracked',
  'No indexes        — full table scans on every JOIN/filter',
];
fixed.forEach(p => console.log(`  ✅  ${p}`));
missing.forEach(p => console.log(`  ❌  ${p}`));
