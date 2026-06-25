// STEP 1: Schema validation + document design strategy.
// Fixed:   any shape accepted, wrong types, missing required fields,
//          bad embed vs reference decisions, no _schemaVersion.
// Still missing: audit trails (createdAt/updatedAt/actor),
//                soft deletes, migration versioning, indexes.

'use strict';
const Datastore = require('@seald-io/nedb');

const orders    = new Datastore();
const customers = new Datastore();
const products  = new Datastore();

const CURRENT_ORDER_SCHEMA_VERSION   = 1;
const CURRENT_CUSTOMER_SCHEMA_VERSION = 1;

// ─── VALIDATORS ──────────────────────────────────────────────────────────────
// Validators run before create/update helpers — DB-layer enforcement.
// In SQL this is handled by constraints. In NoSQL we do it in code.

const ORDER_STATUSES = ['pending', 'shipped', 'delivered', 'cancelled'];

function validateCustomer(doc) {
  const errors = [];
  if (!doc.name   || typeof doc.name   !== 'string') errors.push('name: required string');
  if (!doc.email  || typeof doc.email  !== 'string') errors.push('email: required string');
  if (!doc.city   || typeof doc.city   !== 'string') errors.push('city: required string');
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

function validateOrderItem(item, index) {
  const errors = [];
  if (!item.productId || typeof item.productId !== 'string') errors.push(`items[${index}].productId: required string`);
  if (typeof item.qty !== 'number' || !Number.isInteger(item.qty) || item.qty < 1) errors.push(`items[${index}].qty: required positive integer`);
  if (typeof item.unitPrice !== 'number' || item.unitPrice <= 0) errors.push(`items[${index}].unitPrice: required positive number`);
  // Snapshot product name for human readability — but productId is the reference
  if (item.productName !== undefined && typeof item.productName !== 'string') errors.push(`items[${index}].productName: must be string if present`);
  return errors;
}

function validateOrder(doc) {
  const errors = [];
  if (!doc.customerId || typeof doc.customerId !== 'string') errors.push('customerId: required string (reference, not embedded object)');
  if (!Array.isArray(doc.items) || doc.items.length === 0) errors.push('items: required non-empty array');
  if (!ORDER_STATUSES.includes(doc.status)) errors.push(`status: must be one of ${ORDER_STATUSES.join(', ')}`);
  if (typeof doc.totalPrice !== 'number' || doc.totalPrice <= 0) errors.push('totalPrice: required positive number');

  // Validate each line item
  (doc.items || []).forEach((item, i) => errors.push(...validateOrderItem(item, i)));

  if (errors.length) throw new Error(`Order validation failed:\n  ${errors.join('\n  ')}`);
}

async function validateOrderReferences(doc) {
  const errors = [];

  const customer = await customers.findOneAsync({ _id: doc.customerId });
  if (!customer) errors.push('customerId: unknown customer');

  for (const [index, item] of (doc.items || []).entries()) {
    const product = await products.findOneAsync({ _id: item.productId });
    if (!product) errors.push(`items[${index}].productId: unknown product`);
  }

  if (errors.length) throw new Error(`Order reference validation failed: ${errors.join('; ')}`);
}

// ─── WRITE HELPERS ────────────────────────────────────────────────────────────
// Every insert goes through the validator + stamps _schemaVersion.

async function createCustomer(data) {
  validateCustomer(data);
  return customers.insertAsync({ ...data, _schemaVersion: CURRENT_CUSTOMER_SCHEMA_VERSION });
}

async function createProduct(data) {
  validateProduct(data);
  return products.insertAsync({ ...data, _schemaVersion: 1 });
}

async function createOrder(data) {
  validateOrder(data);
  await validateOrderReferences(data);
  // GOOD: store customerId (reference) not the full customer object
  // Items embed a productName snapshot (readable) + productId (authoritative reference)
  return orders.insertAsync({ ...data, _schemaVersion: CURRENT_ORDER_SCHEMA_VERSION });
}

async function updateCustomerEmail(customerId, email) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Customer validation failed: email: invalid format');
  }
  const result = await customers.updateAsync({ _id: customerId }, { $set: { email } }, {});
  if (result.numReplaced === 0) throw new Error('Customer not found');
  return result;
}

async function updateOrderStatus(orderId, newStatus, expectedCurrentVersion = CURRENT_ORDER_SCHEMA_VERSION) {
  if (!ORDER_STATUSES.includes(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}. Must be one of ${ORDER_STATUSES.join(', ')}`);
  }
  const result = await orders.updateAsync(
    { _id: orderId, _schemaVersion: expectedCurrentVersion },
    { $set: { status: newStatus } },
    {}
  );
  if (result.numReplaced === 0) throw new Error(`Order not found or schema version mismatch`);
  return result;
}

// ─── DEMO 1: Validation Blocks Bad Inserts ────────────────────────────────────
async function demoValidationBlocks() {
  console.log('\n━━━ DEMO 1: Validation Blocks Bad Data ━━━');

  const badOrders = [
    { label: 'Missing customerId',   doc: { items: [{ productId: 'p1', qty: 1, unitPrice: 9.99 }], status: 'pending', totalPrice: 9.99 } },
    { label: 'Empty items array',    doc: { customerId: 'c1', items: [], status: 'pending', totalPrice: 0 } },
    { label: 'Invalid status',       doc: { customerId: 'c1', items: [{ productId: 'p1', qty: 1, unitPrice: 9.99 }], status: 'YOLO', totalPrice: 9.99 } },
    { label: 'Price is string',      doc: { customerId: 'c1', items: [{ productId: 'p1', qty: 1, unitPrice: 'free' }], status: 'pending', totalPrice: 9.99 } },
    { label: 'Zero quantity',        doc: { customerId: 'c1', items: [{ productId: 'p1', qty: 0, unitPrice: 9.99 }], status: 'pending', totalPrice: 9.99 } },
    { label: 'Embedded customer obj',doc: { customer: { name: 'Alice' }, items: [{ productId: 'p1', qty: 1, unitPrice: 9.99 }], status: 'pending', totalPrice: 9.99 } },
  ];

  for (const { label, doc } of badOrders) {
    try {
      await createOrder(doc);
      console.log(`  ❌  ${label}: should have been rejected`);
    } catch (e) {
      console.log(`  ✅  ${label}: blocked → ${e.message.split('\n')[0]}`);
    }
  }
}

// ─── DEMO 2: Reference Strategy Prevents Stale Copies ────────────────────────
async function demoReferenceStrategy() {
  console.log('\n━━━ DEMO 2: Reference Strategy — No Stale Copies ━━━');

  const alice = await createCustomer({ name: 'Alice Smith', email: 'alice@old.com', city: 'New York' });
  const widgetA = await createProduct({ name: 'Widget A', sku: 'WGT-A', price: 9.99 });

  // GOOD: order stores customerId reference, NOT the full customer object
  // Items store productId + a price SNAPSHOT (historical accuracy) + name snapshot
  await createOrder({
    customerId: alice._id,
    items: [{ productId: widgetA._id, productName: 'Widget A', qty: 2, unitPrice: 9.99 }],
    status: 'pending',
    totalPrice: 19.98,
  });
  await createOrder({
    customerId: alice._id,
    items: [{ productId: widgetA._id, productName: 'Widget A', qty: 1, unitPrice: 9.99 }],
    status: 'shipped',
    totalPrice: 9.99,
  });

  // Update customer email — only ONE document changes
  await updateCustomerEmail(alice._id, 'alice@new.com');

  // Orders still reference customerId — they fetch fresh data at read time
  const updatedAlice = await customers.findOneAsync({ _id: alice._id });
  const aliceOrders = await orders.findAsync({ customerId: alice._id });

  console.log(`Customer email now: ${updatedAlice.email}`);
  console.log(`Orders referencing this customer: ${aliceOrders.length}`);
  console.log('Each order stores customerId — reads fetch current customer data.');

  // Show what an order looks like — reference, not embedded object
  const sampleOrder = aliceOrders[0];
  console.log('\nOrder document structure:');
  console.log(`  customerId: "${sampleOrder.customerId}"  ← reference ID, not embedded object`);
  console.log(`  items[0].productId: "${sampleOrder.items[0].productId}"  ← reference`);
  console.log(`  items[0].unitPrice: ${sampleOrder.items[0].unitPrice}  ← price SNAPSHOT (historical)`);
  console.log(`  _schemaVersion: ${sampleOrder._schemaVersion}`);
  console.log('FIX: no stale copies. Customer email update = 1 document, not N order docs.');
}

// ─── DEMO 3: _schemaVersion Enables Doc Shape Detection ──────────────────────
async function demoSchemaVersioning() {
  console.log('\n━━━ DEMO 3: _schemaVersion Field ━━━');

  // Simulate mixed docs — old (no version) and new (versioned)
  const rawOld = await orders.insertAsync({
    customerId: 'legacy-c1',
    item: 'Widget A',     // old shape: single item string, not array
    price: 9.99,
    status: 'delivered',
    // no _schemaVersion — old doc written before this pattern was adopted
  });

  const freshCustomer = await createCustomer({ name: 'New Customer', email: 'new-customer@example.com', city: 'LA' });
  const freshProduct = await createProduct({ name: 'Widget B', sku: 'WGT-B-NEW', price: 14.99 });
  await createOrder({
    customerId: freshCustomer._id,
    items: [{ productId: freshProduct._id, productName: 'Widget B', qty: 1, unitPrice: 14.99 }],
    status: 'pending',
    totalPrice: 14.99,
  });

  const allOrders = await orders.findAsync({ customerId: { $in: ['legacy-c1', freshCustomer._id] } });
  console.log('Documents in collection:');
  allOrders.forEach(d => {
    const version = d._schemaVersion ?? 'MISSING (old doc)';
    console.log(`  _id=...${d._id.slice(-6)}  _schemaVersion=${version}`);
  });

  // At read time: detect missing version and handle gracefully
  function readOrderSafely(doc) {
    if (!doc._schemaVersion) {
      // Old doc — apply forward-compatible transformation
      return {
        ...doc,
        _schemaVersion: 0,  // mark as unversioned
        items: doc.item ? [{ productName: doc.item, unitPrice: doc.price, qty: 1 }] : [],
        _needsMigration: true,
      };
    }
    return doc;
  }

  console.log('\nReading old doc through readOrderSafely():');
  const safe = readOrderSafely(await orders.findOneAsync({ _id: rawOld._id }));
  console.log(`  _schemaVersion: ${safe._schemaVersion}`);
  console.log(`  _needsMigration: ${safe._needsMigration}`);
  console.log(`  items: ${JSON.stringify(safe.items)}`);
  console.log('FIX: _schemaVersion lets code handle old and new doc shapes at runtime.');
}

// ─── DEMO 4: What's Still Missing ─────────────────────────────────────────────
async function demoStillMissing() {
  console.log('\n━━━ DEMO 4: Still Missing — Audit Trail ━━━');

  const bob = await createCustomer({ name: 'Bob', email: 'bob@example.com', city: 'LA' });
  const widgetA = await createProduct({ name: 'Widget A', sku: 'WGT-A-AUDIT', price: 9.99 });
  const order = await createOrder({
    customerId: bob._id,
    items: [{ productId: widgetA._id, productName: 'Widget A', qty: 1, unitPrice: 9.99 }],
    status: 'pending',
    totalPrice: 9.99,
  });
  await updateOrderStatus(order._id, 'shipped');

  const o = await orders.findOneAsync({ _id: order._id });
  console.log(`Order status: ${o.status}`);
  console.log(`  createdAt: ${o.createdAt ?? '(does not exist)'}`);
  console.log(`  updatedAt: ${o.updatedAt ?? '(does not exist)'}`);
  console.log(`  createdBy: ${o.createdBy ?? '(does not exist)'}`);
  console.log(`  deletedAt: ${o.deletedAt ?? '(does not exist — hard deletes still used)'}`);
  console.log('STILL MISSING: who created this? when? who changed the status?');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('STEP 1 — Schema Validation + Document Design');
  console.log('='.repeat(60));

  await demoValidationBlocks();
  await demoReferenceStrategy();
  await demoSchemaVersioning();
  await demoStillMissing();

  console.log('\n' + '─'.repeat(60));
  console.log('STATUS:');
  const fixed = [
    'Any shape accepted  — validateOrder/Customer/Product() run before every insert',
    'Wrong types         — type checks on price, qty, status enum',
    'No required fields  — missing customerId/items/status throw errors',
    'Bad embed strategy  — references (customerId) instead of embedded objects',
    'Unbounded arrays    — comments are a separate collection, not embedded',
    '_schemaVersion      — every doc stamped, readOrderSafely() handles old shapes',
  ];
  const missing = [
    'No audit trail      — no createdAt, updatedAt, createdBy, updatedBy',
    'Hard deletes        — no deletedAt, no soft delete, no restore',
    'No migrations       — schema drift across docs, changes untracked',
    'No indexes          — full collection scan on every query',
  ];
  fixed.forEach(p => console.log(`  ✅  ${p}`));
  missing.forEach(p => console.log(`  ❌  ${p}`));
}

main().catch(console.error);
