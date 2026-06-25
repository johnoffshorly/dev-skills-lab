// STEP 2: Audit trails + Soft deletes.
// Fixed:   no timestamps, no actor tracking, hard deletes destroying history.
// Still missing: migration versioning, indexes.

'use strict';
const Datastore = require('@seald-io/nedb');

const orders    = new Datastore();
const customers = new Datastore();
const products  = new Datastore();

const ORDER_STATUSES = ['pending', 'shipped', 'delivered', 'cancelled'];
const CURRENT_ORDER_SCHEMA_VERSION    = 1;
const CURRENT_CUSTOMER_SCHEMA_VERSION = 1;

// ─── VALIDATORS (from step 1) ─────────────────────────────────────────────────
function validateCustomer(doc) {
  const errors = [];
  if (!doc.name  || typeof doc.name  !== 'string') errors.push('name: required string');
  if (!doc.email || typeof doc.email !== 'string') errors.push('email: required string');
  if (!doc.city  || typeof doc.city  !== 'string') errors.push('city: required string');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(doc.email || '')) errors.push('email: invalid format');
  if (errors.length) throw new Error(`Customer validation failed: ${errors.join('; ')}`);
}

function validateProduct(doc) {
  const errors = [];
  if (!doc.name  || typeof doc.name  !== 'string') errors.push('name: required string');
  if (!doc.sku   || typeof doc.sku   !== 'string') errors.push('sku: required string');
  if (typeof doc.price !== 'number' || doc.price <= 0) errors.push('price: required positive number');
  if (errors.length) throw new Error(`Product validation failed: ${errors.join('; ')}`);
}

function validateOrder(doc) {
  const errors = [];
  if (!doc.customerId || typeof doc.customerId !== 'string') errors.push('customerId: required string');
  if (!Array.isArray(doc.items) || doc.items.length === 0) errors.push('items: required non-empty array');
  if (!ORDER_STATUSES.includes(doc.status)) errors.push(`status: must be one of ${ORDER_STATUSES.join(', ')}`);
  if (typeof doc.totalPrice !== 'number' || doc.totalPrice <= 0) errors.push('totalPrice: required positive number');
  (doc.items || []).forEach((item, i) => {
    if (!item.productId) errors.push(`items[${i}].productId: required`);
    if (typeof item.qty !== 'number' || item.qty < 1) errors.push(`items[${i}].qty: required positive integer`);
    if (typeof item.unitPrice !== 'number' || item.unitPrice <= 0) errors.push(`items[${i}].unitPrice: required positive number`);
  });
  if (errors.length) throw new Error(`Order validation failed: ${errors.join('; ')}`);
}

// ─── AUDIT HELPERS ────────────────────────────────────────────────────────────
// GOOD: every write injects audit fields automatically
// No caller needs to remember to set createdAt/updatedAt/actor

function auditStamp(actor = 'system') {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
    updatedBy: actor,
    deletedAt: null,   // null = active, timestamp = soft-deleted
  };
}

function updateStamp(actor = 'system') {
  return {
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  };
}

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
    _schemaVersion: CURRENT_ORDER_SCHEMA_VERSION,
    ...auditStamp(actor),
  });
}

async function updateOrderStatus(orderId, newStatus, actor = 'system') {
  if (!ORDER_STATUSES.includes(newStatus)) throw new Error(`Invalid status: ${newStatus}`);
  const result = await orders.updateAsync(
    { _id: orderId, deletedAt: null },
    { $set: { status: newStatus, ...updateStamp(actor) } },
    {}
  );
  if (result.numReplaced === 0) throw new Error('Order not found or already deleted');
  return result;
}

// GOOD: soft delete — sets deletedAt instead of removing the document
async function softDelete(datastore, id, actor = 'system') {
  const result = await datastore.updateAsync(
    { _id: id, deletedAt: null },
    { $set: { deletedAt: new Date().toISOString(), ...updateStamp(actor) } },
    {}
  );
  if (result.numReplaced === 0) throw new Error(`Document not found or already deleted: ${id}`);
  return result;
}

// GOOD: restore reverses a soft delete
async function restore(datastore, id, actor = 'system') {
  const result = await datastore.updateAsync(
    { _id: id, deletedAt: { $ne: null } },
    { $set: { deletedAt: null, ...updateStamp(actor) } },
    {}
  );
  if (result.numReplaced === 0) throw new Error(`Document not found or not deleted: ${id}`);
  return result;
}

// GOOD: all active-record queries ALWAYS include deletedAt: null
async function findActiveOrders(query = {}) {
  return orders.findAsync({ ...query, deletedAt: null });
}

async function findActiveCustomers(query = {}) {
  return customers.findAsync({ ...query, deletedAt: null });
}

async function findDeletedCustomers() {
  return customers.findAsync({ deletedAt: { $ne: null } });
}

// ─── DEMO 1: Audit Trail Auto-Populated ──────────────────────────────────────
async function demoAuditTrail() {
  console.log('\n━━━ DEMO 1: Audit Trail Auto-Populated ━━━');

  const alice = await createCustomer(
    { name: 'Alice Smith', email: 'alice@example.com', city: 'New York' },
    'admin-ui'
  );
  const widgetA = await createProduct({ name: 'Widget A', sku: 'WGT-A', price: 9.99 }, 'seed-script');
  const order = await createOrder({
    customerId: alice._id,
    items: [{ productId: widgetA._id, productName: 'Widget A', qty: 2, unitPrice: 9.99 }],
    status: 'pending',
    totalPrice: 19.98,
  }, 'checkout-service');

  const doc = await orders.findOneAsync({ _id: order._id });
  console.log('Order created by checkout-service:');
  console.log(`  _id:       ...${doc._id.slice(-8)}`);
  console.log(`  status:    ${doc.status}`);
  console.log(`  createdAt: ${doc.createdAt}`);
  console.log(`  updatedAt: ${doc.updatedAt}`);
  console.log(`  createdBy: ${doc.createdBy}`);
  console.log(`  updatedBy: ${doc.updatedBy}`);
  console.log(`  deletedAt: ${doc.deletedAt}`);

  // Update status — updatedAt and updatedBy change, createdAt stays
  await updateOrderStatus(order._id, 'shipped', 'fulfillment-service');
  const updated = await orders.findOneAsync({ _id: order._id });
  console.log('\nAfter status → shipped by fulfillment-service:');
  console.log(`  status:    ${updated.status}`);
  console.log(`  updatedAt: ${updated.updatedAt}  (changed)`);
  console.log(`  updatedBy: ${updated.updatedBy}`);
  console.log(`  createdAt: ${updated.createdAt}  (unchanged)`);
  console.log('FIX: every change is traceable — who did it, when.');

  return { alice, widgetA };
}

// ─── DEMO 2: Soft Delete + Restore ───────────────────────────────────────────
async function demoSoftDelete({ alice, widgetA }) {
  console.log('\n━━━ DEMO 2: Soft Delete + Restore ━━━');

  const order = await createOrder({
    customerId: alice._id,
    items: [{ productId: widgetA._id, productName: 'Widget A', qty: 1, unitPrice: 9.99 }],
    status: 'delivered',
    totalPrice: 9.99,
  }, 'checkout-service');

  console.log('Active customers:');
  (await findActiveCustomers()).forEach(c => console.log(`  ${c.name} (deletedAt=${c.deletedAt})`));

  // Soft delete Alice
  await softDelete(customers, alice._id, 'admin-panel');

  console.log('\nAfter softDelete(alice):');
  console.log('Active customers:');
  const active = await findActiveCustomers();
  console.log(active.length === 0 ? '  (none)' : active.map(c => c.name).join(', '));

  console.log('\nDeleted customers (recoverable):');
  (await findDeletedCustomers()).forEach(c =>
    console.log(`  ${c.name}  deletedAt=${c.deletedAt}  deletedBy=${c.updatedBy}`)
  );

  // Alice's orders still exist — history preserved
  const aliceOrders = await orders.findAsync({ customerId: alice._id });
  console.log(`\nAlice's orders still in DB: ${aliceOrders.length}  (history preserved)`);

  // Restore
  await restore(customers, alice._id, 'admin-panel');
  const restored = await customers.findOneAsync({ _id: alice._id });
  console.log(`\nAfter restore: deletedAt=${restored.deletedAt}`);
  console.log('FIX: reversible, actor-stamped, history intact.');
}

// ─── DEMO 3: Querying Deleted Docs Is Opt-In ─────────────────────────────────
async function demoQueryFiltering({ alice, widgetA }) {
  console.log('\n━━━ DEMO 3: Active-Record Filter Pattern ━━━');

  await createOrder({
    customerId: alice._id,
    items: [{ productId: widgetA._id, productName: 'Widget A', qty: 3, unitPrice: 9.99 }],
    status: 'pending',
    totalPrice: 29.97,
  }, 'checkout-service');

  const allOrders = await orders.findAsync({ customerId: alice._id });
  const activeOrders = await findActiveOrders({ customerId: alice._id });
  const deletedOrders = await orders.findAsync({ customerId: alice._id, deletedAt: { $ne: null } });

  // Soft-delete one order
  await softDelete(orders, allOrders[0]._id, 'support-agent');

  const afterActive = await findActiveOrders({ customerId: alice._id });
  const afterDeleted = await orders.findAsync({ customerId: alice._id, deletedAt: { $ne: null } });

  console.log(`Total orders (all):    ${allOrders.length}`);
  console.log(`Active before delete:  ${activeOrders.length}`);
  console.log(`Active after delete:   ${afterActive.length}   ← findActiveOrders() auto-filters`);
  console.log(`Deleted after delete:  ${afterDeleted.length}   ← explicitly query deletedAt != null`);
  console.log('FIX: active-record helper ensures deleted docs never leak into normal queries.');
}

// ─── DEMO 4: What's Still Missing ─────────────────────────────────────────────
async function demoStillMissing() {
  console.log('\n━━━ DEMO 4: Still Missing — Migrations + Indexes ━━━');
  console.log('No schema_migrations collection exists — schema changes are untracked.');
  console.log('No ensureIndex() calls — every findAsync() is a full collection scan.');
  console.log('\nSimulating: find all pending orders (no index on "status"):');
  console.log('  orders.findAsync({ status: "pending", deletedAt: null })');
  console.log('  → NeDB scans EVERY document in the collection.');
  console.log('  → On 100k docs: measurably slower. On 1M docs: very slow.');
  console.log('STILL MISSING: ensureIndex + migration runner.');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('STEP 2 — Audit Trails + Soft Deletes');
  console.log('='.repeat(60));

  const refs = await demoAuditTrail();
  await demoSoftDelete(refs);
  await demoQueryFiltering(refs);
  await demoStillMissing();

  console.log('\n' + '─'.repeat(60));
  console.log('STATUS:');
  const fixed = [
    'Any shape / bad types  — validators run before every insert',
    '_schemaVersion         — stamped on every doc',
    'Bad embed strategy     — reference IDs, not embedded objects',
    'No audit trail         — createdAt, updatedAt, createdBy, updatedBy injected',
    'Hard deletes           — softDelete() + restore() with actor stamp',
    'Deleted docs leak      — findActiveOrders() always filters deletedAt: null',
  ];
  const missing = [
    'No migrations          — schema drift untracked, no version history',
    'No indexes             — full collection scan on status, customerId queries',
  ];
  fixed.forEach(p => console.log(`  ✅  ${p}`));
  missing.forEach(p => console.log(`  ❌  ${p}`));
}

main().catch(console.error);
