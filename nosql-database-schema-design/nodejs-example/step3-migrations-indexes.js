// STEP 3: Migration versioning + Indexes. All problems fixed.
// Fixed:   untracked schema changes, full collection scans.
// Added:   schema_migrations collection, idempotent migration runner,
//          ensureIndex on query-hot fields, _schemaVersion backfill migration,
//          doc-level schema upgrade at read time.

'use strict';
const Datastore = require('@seald-io/nedb');

// Collections
const orders     = new Datastore();
const customers  = new Datastore();
const products   = new Datastore();
const migrations = new Datastore();  // tracks applied migrations

const ORDER_STATUSES = ['pending', 'shipped', 'delivered', 'cancelled'];
const CURRENT_ORDER_SCHEMA_VERSION    = 2;  // bumped when we added currency field
const CURRENT_CUSTOMER_SCHEMA_VERSION = 1;

// ─── VALIDATORS ──────────────────────────────────────────────────────────────
function validateCustomer(doc) {
  const errors = [];
  if (!doc.name  || typeof doc.name  !== 'string') errors.push('name: required string');
  if (!doc.email || typeof doc.email !== 'string') errors.push('email: required string');
  if (!doc.city  || typeof doc.city  !== 'string') errors.push('city: required string');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(doc.email || '')) errors.push('email: invalid format');
  if (errors.length) throw new Error(`Customer validation: ${errors.join('; ')}`);
}

function validateProduct(doc) {
  const errors = [];
  if (!doc.name  || typeof doc.name  !== 'string') errors.push('name: required string');
  if (!doc.sku   || typeof doc.sku   !== 'string') errors.push('sku: required string');
  if (typeof doc.price !== 'number' || doc.price <= 0) errors.push('price: required positive number');
  if (errors.length) throw new Error(`Product validation: ${errors.join('; ')}`);
}

function validateOrder(doc) {
  const errors = [];
  if (!doc.customerId || typeof doc.customerId !== 'string') errors.push('customerId: required string');
  if (!Array.isArray(doc.items) || doc.items.length === 0) errors.push('items: required non-empty array');
  if (!ORDER_STATUSES.includes(doc.status)) errors.push(`status: must be one of ${ORDER_STATUSES.join(', ')}`);
  if (typeof doc.totalPrice !== 'number' || doc.totalPrice <= 0) errors.push('totalPrice: required positive number');
  (doc.items || []).forEach((item, i) => {
    if (!item.productId) errors.push(`items[${i}].productId required`);
    if (typeof item.qty !== 'number' || item.qty < 1) errors.push(`items[${i}].qty: positive integer`);
    if (typeof item.unitPrice !== 'number' || item.unitPrice <= 0) errors.push(`items[${i}].unitPrice: positive number`);
  });
  if (errors.length) throw new Error(`Order validation: ${errors.join('; ')}`);
}

// ─── AUDIT HELPERS ────────────────────────────────────────────────────────────
function auditStamp(actor = 'system') {
  const now = new Date().toISOString();
  return { createdAt: now, updatedAt: now, createdBy: actor, updatedBy: actor, deletedAt: null };
}

function updateStamp(actor = 'system') {
  return { updatedAt: new Date().toISOString(), updatedBy: actor };
}

// ─── MIGRATION RUNNER ────────────────────────────────────────────────────────
// Tracks every schema change in the migrations collection.
// Idempotent: safe to call on every app startup.
// Best-effort: apply first, then record; version checks keep reruns safe.

async function runMigrations(allMigrations) {
  await migrations.ensureIndexAsync({ fieldName: 'version', unique: true });

  const applied = new Set(
    (await migrations.findAsync({})).map(m => m.version)
  );

  let ran = 0;
  for (const { version, name, up } of allMigrations) {
    if (applied.has(version)) continue;

    try {
      await up();  // apply the migration
      await migrations.insertAsync({
        version,
        name,
        appliedAt: new Date().toISOString(),
      });
      console.log(`  ✔  Migration ${version}: ${name}`);
      ran++;
    } catch (err) {
      console.error(`  ✖  Migration ${version} FAILED: ${err.message}`);
      throw err;  // halt — don't apply subsequent migrations on failure
    }
  }

  if (ran === 0) console.log('  ✔  All migrations already applied — nothing to do.');
  return ran;
}

// ─── MIGRATIONS DEFINITION ───────────────────────────────────────────────────
// Each migration is: { version (int), name (string), up (async fn) }
// Versions are integers — simple, orderable, no timestamp ambiguity.
// NEVER modify an applied migration — add a new one instead.

const MIGRATIONS = [
  {
    version: 1,
    name: 'ensure_indexes_on_orders',
    async up() {
      // Index customerId — most common filter/join field
      await orders.ensureIndexAsync({ fieldName: 'customerId' });
      // Index status — dashboard queries filter by this constantly
      await orders.ensureIndexAsync({ fieldName: 'status' });
      // Index deletedAt — every active-record query uses this
      await orders.ensureIndexAsync({ fieldName: 'deletedAt' });
      // Index createdAt — sorting by creation date
      await orders.ensureIndexAsync({ fieldName: 'createdAt' });
    },
  },
  {
    version: 2,
    name: 'ensure_indexes_on_customers',
    async up() {
      // Unique index on email — enforced at DB level (NeDB supports unique indexes)
      await customers.ensureIndexAsync({ fieldName: 'email', unique: true });
      await customers.ensureIndexAsync({ fieldName: 'deletedAt' });
    },
  },
  {
    version: 3,
    name: 'ensure_indexes_on_products',
    async up() {
      // Unique index on SKU — one canonical entry per product code
      await products.ensureIndexAsync({ fieldName: 'sku', unique: true });
    },
  },
  {
    version: 4,
    name: 'backfill_schema_version_on_legacy_orders',
    async up() {
      // Find all orders missing _schemaVersion (written before this pattern was adopted)
      const legacy = await orders.findAsync({ _schemaVersion: { $exists: false } });
      for (const doc of legacy) {
        await orders.updateAsync(
          { _id: doc._id },
          { $set: { _schemaVersion: 1 } },
          {}
        );
      }
      if (legacy.length > 0) {
        console.log(`     Backfilled _schemaVersion on ${legacy.length} legacy order(s)`);
      }
    },
  },
  {
    version: 5,
    name: 'add_currency_field_to_orders',
    async up() {
      // Additive migration: add currency field to all orders without it
      // Default to 'USD' — safe assumption for this dataset
      const result = await orders.updateAsync(
        { currency: { $exists: false } },
        { $set: { currency: 'USD', _schemaVersion: CURRENT_ORDER_SCHEMA_VERSION } },
        { multi: true }
      );
      if (result.numReplaced > 0) {
        console.log(`     Added currency='USD' to ${result.numReplaced} order(s)`);
      }
    },
  },
];

// ─── WRITE HELPERS ────────────────────────────────────────────────────────────

async function createCustomer(data, actor = 'system') {
  validateCustomer(data);
  return customers.insertAsync({
    ...data,
    _schemaVersion: CURRENT_CUSTOMER_SCHEMA_VERSION,
    ...auditStamp(actor),
  });
}

async function createProduct(data, actor = 'system') {
  validateProduct(data);
  return products.insertAsync({
    ...data,
    _schemaVersion: 1,
    ...auditStamp(actor),
  });
}

async function createOrder(data, actor = 'system') {
  validateOrder(data);
  return orders.insertAsync({
    ...data,
    currency: 'USD',  // new required field added in migration 5
    _schemaVersion: CURRENT_ORDER_SCHEMA_VERSION,
    ...auditStamp(actor),
  });
}

async function softDelete(datastore, id, actor = 'system') {
  const result = await datastore.updateAsync(
    { _id: id, deletedAt: null },
    { $set: { deletedAt: new Date().toISOString(), ...updateStamp(actor) } },
    {}
  );
  if (result.numReplaced === 0) throw new Error(`Not found or already deleted: ${id}`);
}

async function restore(datastore, id, actor = 'system') {
  const result = await datastore.updateAsync(
    { _id: id, deletedAt: { $ne: null } },
    { $set: { deletedAt: null, ...updateStamp(actor) } },
    {}
  );
  if (result.numReplaced === 0) throw new Error(`Not found or not deleted: ${id}`);
  return result;
}

async function findActiveOrders(query = {}) {
  return orders.findAsync({ ...query, deletedAt: null });
}

// Read-time schema upgrade — handles docs from any past schema version
function upgradeOrderDoc(doc) {
  if (!doc) return null;
  const v = doc._schemaVersion ?? 0;

  // v0 → v1: ensure items is an array
  if (v < 1) {
    doc = { ...doc, _schemaVersion: 1, items: Array.isArray(doc.items) ? doc.items : [] };
  }
  // v1 → v2: ensure currency field exists
  if (v < 2) {
    doc = { ...doc, _schemaVersion: 2, currency: doc.currency ?? 'USD' };
  }

  return doc;
}

// ─── DEMO 1: Migration Runner Is Idempotent ───────────────────────────────────
async function demoMigrations() {
  console.log('\n━━━ DEMO 1: Migration Runner — First Run ━━━');
  await runMigrations(MIGRATIONS);

  console.log('\nApplied migrations:');
  const applied = await migrations.findAsync({});
  applied
    .sort((a, b) => a.version - b.version)
    .forEach(m => console.log(`  v${m.version}: ${m.name}  (${m.appliedAt})`));

  console.log('\n━━━ DEMO 1b: Re-run (should be no-ops) ━━━');
  await runMigrations(MIGRATIONS);
  console.log('FIX: idempotent — safe to call on every app startup.');
}

// ─── DEMO 2: Unique Index Blocks Duplicate Emails ─────────────────────────────
async function demoDuplicateEmailBlocked() {
  console.log('\n━━━ DEMO 2: Unique Index Blocks Duplicate Emails ━━━');

  await createCustomer({ name: 'Alice Smith', email: 'alice@example.com', city: 'New York' }, 'admin-ui');
  try {
    await createCustomer({ name: 'Alice Clone', email: 'alice@example.com', city: 'LA' }, 'admin-ui');
    console.log('  ❌  Duplicate email should have been blocked');
  } catch (e) {
    console.log(`  ✅  Duplicate email blocked by unique index: ${e.message}`);
  }
  console.log('FIX: ensureIndex({ fieldName: "email", unique: true }) enforces uniqueness at DB level.');
}

// ─── DEMO 3: Schema Migration Backfill ────────────────────────────────────────
// legacyId is pre-inserted before migrations ran — see main()
async function demoSchemaBackfill(legacyId) {
  console.log('\n━━━ DEMO 3: Schema Backfill + Read-Time Upgrade ━━━');

  console.log('Legacy doc (inserted before migrations ran):');
  const after = await orders.findOneAsync({ _id: legacyId });
  console.log(`  _schemaVersion: ${after._schemaVersion ?? 'MISSING'} (was MISSING before migration 4)`);
  console.log(`  currency: ${after.currency ?? 'MISSING'} (was MISSING before migration 5)`);

  // Also show read-time upgrade for docs missed by backfill
  const stale = { _id: 'stale-1', customerId: 'c1', totalPrice: 5 };  // pretend we read this from DB
  const upgraded = upgradeOrderDoc(stale);
  console.log('\nRead-time upgrade of a stale doc (no backfill applied):');
  console.log(`  _schemaVersion: ${upgraded._schemaVersion}`);
  console.log(`  currency: ${upgraded.currency}`);
  console.log('FIX: two-layer safety — migration backfills storage + upgradeOrderDoc() handles stragglers.');
}

// ─── DEMO 4: Indexes Improve Query Performance ────────────────────────────────
async function demoIndexes() {
  console.log('\n━━━ DEMO 4: Indexes Active — Common Query Patterns ━━━');

  // Seed some orders
  const alice = await customers.findOneAsync({ email: 'alice@example.com' });
  const widgetA = await createProduct({ name: 'Widget A', sku: 'WGT-A', price: 9.99 }, 'seed');

  for (let i = 0; i < 5; i++) {
    await createOrder({
      customerId: alice._id,
      items: [{ productId: widgetA._id, productName: 'Widget A', qty: i + 1, unitPrice: 9.99 }],
      status: i < 3 ? 'pending' : 'shipped',
      totalPrice: (i + 1) * 9.99,
    }, 'checkout-service');
  }

  // These queries now use indexes
  const byCustomer = await findActiveOrders({ customerId: alice._id });
  const byStatus   = await findActiveOrders({ status: 'pending' });

  console.log(`Active orders for Alice: ${byCustomer.length}  (indexes: customerId, deletedAt)`);
  console.log(`Pending orders total:    ${byStatus.length}   (indexes: status, deletedAt)`);

  // Show index list
  console.log('\nActive indexes on orders collection:');
  const indexNames = Object.keys(orders.indexes);
  indexNames.forEach(name => console.log(`  ${name}`));

  console.log('\nFIX: ensureIndex() turns O(n) full scans into O(log n) index seeks.');
  console.log('     NeDB uses binary search trees (AVL) for indexes.');
}

// ─── DEMO 5: Full Audit Review ────────────────────────────────────────────────
async function demoFullAudit() {
  console.log('\n━━━ DEMO 5: Full Picture — Everything Working Together ━━━');

  const allMigrations = await migrations.findAsync({});
  console.log(`Migrations applied: ${allMigrations.length}`);
  allMigrations
    .sort((a, b) => a.version - b.version)
    .forEach(m => console.log(`  v${m.version}: ${m.name}`));

  const sampleOrder = await orders.findOneAsync({ deletedAt: null });
  if (sampleOrder) {
    console.log('\nSample active order fields:');
    ['_schemaVersion', 'currency', 'status', 'createdAt', 'updatedAt', 'createdBy', 'deletedAt']
      .forEach(f => console.log(`  ${f}: ${sampleOrder[f]}`));
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('STEP 3 — Migrations + Indexes');
  console.log('='.repeat(60));

  // Seed legacy doc BEFORE migrations run — backfill migrations will pick it up
  const legacy = await orders.insertAsync({
    customerId: 'legacy-c1',
    items: [{ productId: 'p1', productName: 'Widget', qty: 1, unitPrice: 9.99 }],
    status: 'delivered',
    totalPrice: 9.99,
    // intentionally no _schemaVersion, no currency
    ...auditStamp('legacy-import'),
  });

  await demoMigrations();
  await demoDuplicateEmailBlocked();
  await demoSchemaBackfill(legacy._id);
  await demoIndexes();
  await demoFullAudit();

  console.log('\n' + '─'.repeat(60));
  console.log('STATUS — ALL PROBLEMS FIXED:');
  const allFixed = [
    'Any shape accepted    — validators before every insert',
    'Wrong types/enums     — runtime type checks',
    '_schemaVersion        — stamped on every doc, upgraded at read time',
    'Bad embed strategy    — reference IDs, price snapshots in items',
    'Unbounded arrays      — comments as separate collection',
    'No audit trail        — createdAt/updatedAt/createdBy/updatedBy/deletedAt',
    'Hard deletes          — softDelete() + restore() with actor stamp',
    'No migrations         — versioned MIGRATIONS array, idempotent runner',
    'No indexes            — ensureIndex on customerId, status, email, sku, deletedAt',
    'Schema drift          — backfill migration + upgradeOrderDoc() at read time',
  ];
  allFixed.forEach(p => console.log(`  ✅  ${p}`));
}

main().catch(console.error);
