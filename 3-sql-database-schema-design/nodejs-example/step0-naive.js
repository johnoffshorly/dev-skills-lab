// STEP 0: Naive flat table — everything in one table, no safeguards.
// Fixed:   nothing.
// Missing: normalization, foreign keys, CHECK/NOT NULL constraints,
//          audit trails (created_at/updated_at), soft deletes,
//          migration versioning, indexes.

'use strict';
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(':memory:');

// ─── SCHEMA ──────────────────────────────────────────────────────────────────
// BAD: one table holds customer + product + order data
// BAD: TEXT for everything — no type enforcement
// BAD: no constraints at all
db.exec(`
  CREATE TABLE orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name  TEXT,
    customer_email TEXT,
    customer_city  TEXT,
    product_name   TEXT,
    product_sku    TEXT,
    unit_price     REAL,
    quantity       INTEGER,
    total_price    REAL,
    status         TEXT
  );
`);

// ─── DEMO 1: Data Duplication ─────────────────────────────────────────────────
function demoDataDuplication() {
  console.log('\n━━━ DEMO 1: Data Duplication ━━━');

  // Same customer repeated for every order — no single source of truth
  db.prepare(`INSERT INTO orders
    (customer_name, customer_email, customer_city, product_name, product_sku, unit_price, quantity, total_price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('Alice Smith', 'alice@example.com', 'New York', 'Widget A', 'WGT-A', 9.99, 2, 19.98, 'shipped');

  db.prepare(`INSERT INTO orders
    (customer_name, customer_email, customer_city, product_name, product_sku, unit_price, quantity, total_price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('Alice Smith', 'alice@example.com', 'New York', 'Widget B', 'WGT-B', 14.99, 1, 14.99, 'pending');

  // Oops — typo in email on third order. Now Alice has two different emails in the DB.
  db.prepare(`INSERT INTO orders
    (customer_name, customer_email, customer_city, product_name, product_sku, unit_price, quantity, total_price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('Alice Smith', 'alice.smith@example.com', 'New York', 'Gadget X', 'GDG-X', 49.99, 1, 49.99, 'pending');

  const rows = db.prepare('SELECT id, customer_name, customer_email FROM orders').all();
  console.log('Alice has 3 orders — 2 different emails on file:');
  rows.forEach(r => console.log(`  order ${r.id}: ${r.customer_name} <${r.customer_email}>`));
  console.log('PROBLEM: fixing Alice\'s email requires UPDATE on every row she appears in.');
  console.log('         Miss one row = corrupted data.');
}

// ─── DEMO 2: No Constraints — Garbage Data Accepted ──────────────────────────
function demoNoConstraints() {
  console.log('\n━━━ DEMO 2: No Constraints ━━━');

  const insert = db.prepare(`INSERT INTO orders
    (customer_name, customer_email, customer_city, product_name, product_sku, unit_price, quantity, total_price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  // NULL email — who owns this?
  insert.run(null, null, null, 'Mystery Item', 'MST-1', 5.00, 1, 5.00, null);

  // Negative price — accepted without complaint
  insert.run('Bob', 'bob@example.com', 'LA', 'Broken Widget', 'BRK-1', -99.99, 1, -99.99, 'shipped');

  // Same SKU, wildly different prices — which is the real price of WGT-A?
  insert.run('Carol', 'carol@example.com', 'Chicago', 'Widget A', 'WGT-A', 999.00, 1, 999.00, 'pending');

  // total_price doesn't match unit_price * quantity — math is wrong, DB doesn't care
  insert.run('Dan', 'dan@example.com', 'Boston', 'Widget B', 'WGT-B', 14.99, 3, 1.00, 'pending');

  const bad = db.prepare(`
    SELECT id, customer_name, customer_email, unit_price, total_price, product_sku
    FROM orders
    WHERE customer_name IS NULL OR unit_price < 0
  `).all();
  console.log('Invalid rows SQLite accepted:');
  bad.forEach(r => console.log(`  id=${r.id} name=${r.customer_name} email=${r.customer_email} price=${r.unit_price}`));

  const skuConflict = db.prepare(`SELECT product_sku, unit_price FROM orders WHERE product_sku='WGT-A'`).all();
  console.log('\nSame SKU "WGT-A" has multiple prices:');
  skuConflict.forEach(r => console.log(`  sku=${r.product_sku} price=${r.unit_price}`));

  console.log('PROBLEM: no CHECK, NOT NULL, or UNIQUE constraints — garbage in, garbage out.');
}

// ─── DEMO 3: Hard Deletes Destroy History ────────────────────────────────────
function demoHardDelete() {
  console.log('\n━━━ DEMO 3: Hard Deletes Destroy History ━━━');

  db.prepare(`INSERT INTO orders
    (customer_name, customer_email, customer_city, product_name, product_sku, unit_price, quantity, total_price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('Eve', 'eve@example.com', 'Denver', 'Rare Item', 'RARE-1', 299.99, 1, 299.99, 'delivered');

  const orderId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  console.log(`Created order id=${orderId} for Eve`);

  // DELETE — gone forever
  db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
  const result = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  console.log(`After DELETE: SELECT returns → ${result}`);
  console.log('PROBLEM: no record Eve ever placed this order.');
  console.log('         Can\'t audit, can\'t recover, can\'t answer "why was this removed?"');
}

// ─── DEMO 4: No Audit Trail ───────────────────────────────────────────────────
function demoNoAuditTrail() {
  console.log('\n━━━ DEMO 4: No Audit Trail ━━━');

  db.prepare(`INSERT INTO orders
    (customer_name, customer_email, customer_city, product_name, product_sku, unit_price, quantity, total_price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('Frank', 'frank@example.com', 'Seattle', 'Widget A', 'WGT-A', 9.99, 5, 49.95, 'pending');

  // Update status — but there is no record of when this happened or who did it
  db.prepare(`UPDATE orders SET status = 'shipped' WHERE customer_name = 'Frank'`).run();

  const order = db.prepare(`SELECT * FROM orders WHERE customer_name = 'Frank'`).get();
  console.log('Frank\'s order after status update:');
  console.log(`  status: ${order.status}`);
  console.log('  created_at: (column does not exist)');
  console.log('  updated_at: (column does not exist)');
  console.log('  updated_by: (column does not exist)');
  console.log('PROBLEM: no timestamp, no who-changed-it, no way to audit.');
}

// ─── DEMO 5: No Migration Tracking ───────────────────────────────────────────
function demoNoMigrations() {
  console.log('\n━━━ DEMO 5: No Migration Tracking ━━━');

  // Naive: just ALTER TABLE with no version record
  try {
    db.exec(`ALTER TABLE orders ADD COLUMN notes TEXT`);
    console.log('Added "notes" column — but:');
    console.log('  - No record of when this schema change happened');
    console.log('  - Run this script again and it crashes:');
    try {
      db.exec(`ALTER TABLE orders ADD COLUMN notes TEXT`);
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  } catch (e) {
    console.log(`Error: ${e.message}`);
  }
  console.log('PROBLEM: no schema_migrations table = no versioning, duplicate runs crash.');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
console.log('='.repeat(60));
console.log('STEP 0 — Naive Flat Table (All Problems Present)');
console.log('='.repeat(60));

demoDataDuplication();
demoNoConstraints();
demoHardDelete();
demoNoAuditTrail();
demoNoMigrations();

console.log('\n\n' + '─'.repeat(60));
console.log('PROBLEMS IN THIS STEP:');
const problems = [
  'Data duplication  — customer/product data repeated in every row',
  'No normalization  — no separate customers/products/orders tables',
  'No constraints    — NULL, negative prices, duplicate SKUs accepted',
  'No audit trail    — no created_at, updated_at, no who/when',
  'Hard deletes      — deleted records gone forever, no recovery',
  'No soft deletes   — no deleted_at column, no restore capability',
  'No migrations     — schema changes crash on re-run, no versioning',
  'No indexes        — full table scan on every query',
];
problems.forEach(p => console.log(`  ❌  ${p}`));
