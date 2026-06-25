// STEP 3: Migration versioning + Indexes.
// Fixed:   all problems from steps 0–2. Full production-ready patterns.
// Added:   schema_migrations table, idempotent migration runner,
//          indexes on FK + filter columns, EXPLAIN QUERY PLAN comparison.

'use strict';
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
// journal_mode=WAL applies only to file-backed DBs; in-memory DB stays in default mode.

// ─── MIGRATION RUNNER ────────────────────────────────────────────────────────
// Tracks every schema change in schema_migrations.
// Idempotent: safe to run the full list on every app startup.

function withTransaction(database, fn) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

function runMigrations(db, migrations) {
  // Bootstrap the migrations table if it doesn't exist yet
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  const applied = new Set(
    db.prepare(`SELECT version FROM schema_migrations`).all().map(r => r.version)
  );

  let ran = 0;
  for (const { version, name, up } of migrations) {
    if (applied.has(version)) continue;

    // Run migration + record it in a single transaction — all or nothing
    withTransaction(db, () => {
      up(db);
      db.prepare(`INSERT INTO schema_migrations (version, name) VALUES (?, ?)`).run(version, name);
    });

    console.log(`  ✔  Migration ${version}: ${name}`);
    ran++;
  }

  if (ran === 0) console.log('  ✔  All migrations already applied — nothing to do.');
  return ran;
}

// ─── MIGRATIONS ──────────────────────────────────────────────────────────────
const MIGRATIONS = [
  {
    version: 1,
    name: 'create_base_schema',
    up(db) {
      db.exec(`
        CREATE TABLE customers (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT    NOT NULL,
          email       TEXT    NOT NULL UNIQUE,
          city        TEXT    NOT NULL,
          created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          created_by  TEXT    NOT NULL DEFAULT 'system',
          updated_by  TEXT    NOT NULL DEFAULT 'system',
          deleted_at  TEXT    DEFAULT NULL
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

      // Triggers for updated_at
      for (const table of ['customers', 'products', 'orders', 'order_items']) {
        db.exec(`
          CREATE TRIGGER ${table}_updated_at
          AFTER UPDATE ON ${table}
          FOR EACH ROW
          WHEN NEW.updated_at = OLD.updated_at
          BEGIN
            UPDATE ${table}
              SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE id = NEW.id;
          END;
        `);
      }
    },
  },

  {
    version: 2,
    name: 'add_performance_indexes',
    up(db) {
      // Index every FK column — JOINs and WHERE filters on FK = full scan without this
      db.exec(`CREATE INDEX idx_orders_customer_id     ON orders(customer_id);`);
      db.exec(`CREATE INDEX idx_order_items_order_id   ON order_items(order_id);`);
      db.exec(`CREATE INDEX idx_order_items_product_id ON order_items(product_id);`);

      // Composite index for the most common query: active orders for a customer, sorted by date
      // Covers WHERE customer_id = ? AND deleted_at IS NULL ORDER BY created_at DESC
      db.exec(`CREATE INDEX idx_orders_customer_active ON orders(customer_id, deleted_at, created_at DESC);`);

      // Partial index — only index active (non-deleted) rows, smaller + faster
      db.exec(`CREATE INDEX idx_customers_active_email ON customers(email) WHERE deleted_at IS NULL;`);

      // Status filter is common in dashboards
      db.exec(`CREATE INDEX idx_orders_status ON orders(status) WHERE deleted_at IS NULL;`);
    },
  },

  {
    version: 3,
    name: 'add_phone_to_customers',
    up(db) {
      // Safe additive change: new nullable column, existing rows get NULL
      // NEVER do: ALTER TABLE customers DROP COLUMN or RENAME without a migration
      db.exec(`ALTER TABLE customers ADD COLUMN phone TEXT DEFAULT NULL;`);
    },
  },

  {
    version: 4,
    name: 'add_discount_to_order_items',
    up(db) {
      db.exec(`
        ALTER TABLE order_items ADD COLUMN discount_pct REAL NOT NULL DEFAULT 0
          CHECK (discount_pct >= 0 AND discount_pct < 100);
      `);
    },
  },
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function createCustomer(name, email, city, actor = 'system') {
  return db.prepare(`INSERT INTO customers (name, email, city, created_by, updated_by) VALUES (?, ?, ?, ?, ?)`).run(name, email, city, actor, actor);
}

function createProduct(name, sku, price, actor = 'system') {
  return db.prepare(`INSERT INTO products (name, sku, price_cents, created_by, updated_by) VALUES (?, ?, ?, ?, ?)`).run(name, sku, Math.round(price * 100), actor, actor);
}

function createOrder(customerId, actor = 'system') {
  return db.prepare(`INSERT INTO orders (customer_id, created_by, updated_by) VALUES (?, ?, ?)`).run(customerId, actor, actor);
}

function addItem(orderId, productId, qty, unitPrice, discountPct = 0) {
  return db.prepare(`INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents, discount_pct) VALUES (?, ?, ?, ?, ?)`).run(orderId, productId, qty, Math.round(unitPrice * 100), discountPct);
}

function softDelete(table, id, actor = 'system') {
  return db.prepare(`UPDATE ${table} SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = ? WHERE id = ? AND deleted_at IS NULL`).run(actor, id);
}

function restore(table, id, actor = 'system') {
  return db.prepare(`UPDATE ${table} SET deleted_at = NULL, updated_by = ? WHERE id = ? AND deleted_at IS NOT NULL`).run(actor, id);
}

// ─── DEMO 1: Migrations Are Idempotent ───────────────────────────────────────
function demoMigrationsIdempotent() {
  console.log('\n━━━ DEMO 1: Migration Runner — First Run ━━━');
  runMigrations(db, MIGRATIONS);

  console.log('\nApplied migrations in schema_migrations:');
  db.prepare(`SELECT version, name, applied_at FROM schema_migrations ORDER BY version`).all()
    .forEach(r => console.log(`  v${r.version}: ${r.name}  (${r.applied_at})`));

  console.log('\n━━━ DEMO 1b: Re-run Same Migrations (should be no-ops) ━━━');
  runMigrations(db, MIGRATIONS);  // should print "nothing to do"

  console.log('FIX: safe to call runMigrations() on every app startup.');
}

// ─── DEMO 2: EXPLAIN QUERY PLAN — Index vs No-Index ─────────────────────────
function demoIndexImpact() {
  console.log('\n━━━ DEMO 2: EXPLAIN QUERY PLAN — Index Impact ━━━');

  // Seed some data
  const alice = createCustomer('Alice', 'alice@example.com', 'New York');
  const widgetA = createProduct('Widget A', 'WGT-A', 9.99);
  for (let i = 0; i < 5; i++) {
    const o = createOrder(alice.lastInsertRowid);
    addItem(o.lastInsertRowid, widgetA.lastInsertRowid, i + 1, 9.99);
  }

  // This query uses idx_orders_customer_active
  console.log('\nQuery: active orders for customer, sorted by date');
  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM orders
    WHERE customer_id = ? AND deleted_at IS NULL
    ORDER BY created_at DESC
  `).all(alice.lastInsertRowid);
  plan.forEach(r => console.log(`  ${r.detail}`));

  console.log('\nQuery: order items for a specific order');
  const itemPlan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT oi.*, p.name AS product_name
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `).all(1);
  itemPlan.forEach(r => console.log(`  ${r.detail}`));

  console.log('\nQuery: orders by status (partial index)');
  const statusPlan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM orders WHERE status = 'pending' AND deleted_at IS NULL
  `).all();
  statusPlan.forEach(r => console.log(`  ${r.detail}`));

  console.log('\nFIX: SEARCH (index seek) instead of SCAN (full table scan).');
  console.log('     On 1M rows: index seek = ~microseconds, full scan = ~seconds.');
}

// ─── DEMO 3: Safe Schema Evolution via Migrations ────────────────────────────
function demoSafeSchemaEvolution() {
  console.log('\n━━━ DEMO 3: Safe Schema Evolution ━━━');

  // Verify new columns from migrations 3 and 4 exist
  const customerCols = db.prepare(`PRAGMA table_info(customers)`).all().map(c => c.name);
  const itemCols = db.prepare(`PRAGMA table_info(order_items)`).all().map(c => c.name);

  console.log('customers columns:', customerCols.join(', '));
  console.log('order_items columns:', itemCols.join(', '));

  // Migration 3: phone column added safely (nullable, existing rows = NULL)
  const alice = db.prepare(`SELECT id, name, phone FROM customers LIMIT 1`).get();
  console.log(`\nAlice.phone before update: ${alice.phone}  (NULL is safe for old rows)`);

  db.prepare(`UPDATE customers SET phone = '+1-555-0100', updated_by = 'profile-service' WHERE id = ?`).run(alice.id);
  const updated = db.prepare(`SELECT name, phone, updated_by FROM customers WHERE id = ?`).get(alice.id);
  console.log(`Alice.phone after update: ${updated.phone}  updated_by=${updated.updated_by}`);

  // Migration 4: discount_pct works in new inserts
  const alice2 = db.prepare(`SELECT id FROM customers LIMIT 1`).get();
  const widgetB = createProduct('Widget B', 'WGT-B', 14.99);
  const o = createOrder(alice2.id);
  addItem(o.lastInsertRowid, widgetB.lastInsertRowid, 2, 14.99, 10.0);
  const item = db.prepare(`SELECT quantity, unit_price_cents, discount_pct FROM order_items WHERE order_id = ?`).get(o.lastInsertRowid);
  console.log(`\nOrder item: qty=${item.quantity} price_cents=${item.unit_price_cents} discount=${item.discount_pct}%`);
  console.log('FIX: additive migrations (ADD COLUMN) are zero-downtime safe.');
  console.log('     Every change is recorded, ordered, and applied exactly once.');
}

// ─── DEMO 4: Full Audit Review ────────────────────────────────────────────────
function demoFullAudit() {
  console.log('\n━━━ DEMO 4: Full Picture — Everything Working Together ━━━');

  const migrations = db.prepare(`SELECT version, name, applied_at FROM schema_migrations ORDER BY version`).all();
  console.log('Schema version history:');
  migrations.forEach(m => console.log(`  v${m.version}: ${m.name}`));

  const indexes = db.prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name`).all();
  console.log('\nIndexes:');
  indexes.forEach(i => console.log(`  ${i.tbl_name}.${i.name}`));

  const triggers = db.prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type='trigger'`).all();
  console.log('\nTriggers:');
  triggers.forEach(t => console.log(`  ${t.tbl_name}: ${t.name}`));
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
function main() {
  console.log('='.repeat(60));
  console.log('STEP 3 — Migrations + Indexes');
  console.log('='.repeat(60));

  demoMigrationsIdempotent();
  demoIndexImpact();
  demoSafeSchemaEvolution();
  demoFullAudit();

  console.log('\n' + '─'.repeat(60));
  console.log('STATUS — ALL PROBLEMS FIXED:');
  const allFixed = [
    'Data duplication  — normalized tables (step 1)',
    'No FK / constraints — enforced (step 1)',
    'No audit trail    — created_at, updated_at trigger, created_by (step 2)',
    'Hard deletes      — soft delete with deleted_at (step 2)',
    'No migrations     — schema_migrations table, idempotent runner',
    'No indexes        — FK indexes, composite index, partial index',
  ];
  allFixed.forEach(p => console.log(`  ✅  ${p}`));

  console.log('\nDONE — You now have a full progression from bad schema to production-ready design.');
}

main();
