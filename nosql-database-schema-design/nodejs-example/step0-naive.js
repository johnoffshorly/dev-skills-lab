// STEP 0: Naive document design — no validation, no structure, no safeguards.
// Fixed:   nothing.
// Missing: schema validation, required fields, _schemaVersion,
//          embed-vs-reference strategy, audit trails (createdAt/updatedAt),
//          soft deletes, migration versioning, indexes.

'use strict';
const Datastore = require('@seald-io/nedb');

// In-memory datastores — no file persistence needed for demo
const orders    = new Datastore();
const customers = new Datastore();

// ─── DEMO 1: Any Shape Accepted — No Validation ───────────────────────────────
async function demoAnyShapeAccepted() {
  console.log('\n━━━ DEMO 1: Any Shape Accepted ━━━');

  // BAD: all of these insert without error, no consistency enforced
  const bad = [
    // Missing required fields — who placed this order? What is being ordered?
    { note: 'incomplete order' },

    // Wrong type for price — should be a number, string accepted silently
    { customerId: 'c1', items: [{ productId: 'p1', qty: 2, price: 'free' }], status: 'pending' },

    // Invalid status value — any string accepted
    { customerId: 'c2', items: [], status: 'YOLO', total: -50 },

    // Completely different shape — same collection, no complaints
    { type: 'invoice', number: 'INV-001', lines: [1, 2, 3] },
  ];

  const inserted = await Promise.all(bad.map(doc => orders.insertAsync(doc)));
  console.log(`Inserted ${inserted.length} documents with completely different shapes — no error.`);

  const all = await orders.findAsync({});
  console.log('Collection now contains docs with shapes:');
  all.forEach(d => console.log(`  _id=${d._id.slice(-6)} keys=[${Object.keys(d).filter(k => k !== '_id').join(', ')}]`));
  console.log('PROBLEM: application expects { customerId, items, status, total }');
  console.log('         but any garbage shape is stored silently.');
}

// ─── DEMO 2: Denormalization Inconsistency ─────────────────────────────────────
async function demoDenormalizationInconsistency() {
  console.log('\n━━━ DEMO 2: Denormalization — Stale Embedded Data ━━━');

  // BAD: embedding full customer object inside every order
  // When customer changes email, every embedded copy becomes stale
  const customerObj = { _id: 'cust-alice', name: 'Alice Smith', email: 'alice@old.com', city: 'New York' };
  await customers.insertAsync(customerObj);

  // Embed full customer in each order — looks convenient
  await orders.insertAsync({
    customer: { _id: 'cust-alice', name: 'Alice Smith', email: 'alice@old.com', city: 'New York' },
    items: [{ sku: 'WGT-A', qty: 2, price: 9.99 }],
    status: 'shipped',
    total: 19.98,
  });
  await orders.insertAsync({
    customer: { _id: 'cust-alice', name: 'Alice Smith', email: 'alice@old.com', city: 'New York' },
    items: [{ sku: 'WGT-B', qty: 1, price: 14.99 }],
    status: 'pending',
    total: 14.99,
  });

  // Alice updates her email — update the customers collection
  await customers.updateAsync({ _id: 'cust-alice' }, { $set: { email: 'alice@new.com' } }, {});

  // Orders still have the old email embedded — they were NOT updated
  const staleOrders = await orders.findAsync({ 'customer._id': 'cust-alice' });
  const updatedCustomer = await customers.findOneAsync({ _id: 'cust-alice' });
  console.log(`Customer email now: ${updatedCustomer.email}`);
  console.log('Order embedded customer emails (stale):');
  staleOrders.forEach(o => o.customer && console.log(`  ${o.customer.email}  ← stale copy`));
  console.log('PROBLEM: embedded copies diverge the moment the source document changes.');
  console.log('         Must UPDATE every order that embeds this customer — easy to miss one.');
}

// ─── DEMO 3: Unbounded Array Growth ───────────────────────────────────────────
async function demoUnboundedArrayGrowth() {
  console.log('\n━━━ DEMO 3: Unbounded Embedded Array Growth ━━━');

  // BAD: embedding comments directly in a post document
  // In NeDB (and MongoDB) documents have practical size limits
  // More importantly: the entire document is loaded on every read
  const post = await orders.insertAsync({
    type: 'post',
    title: 'My First Blog Post',
    body: 'Hello world',
    comments: [],  // grows unboundedly — will eventually contain thousands of items
  });

  // Simulate 20 comments being added over time
  for (let i = 0; i < 20; i++) {
    await orders.updateAsync(
      { _id: post._id },
      { $push: { comments: { author: `user${i}`, text: `Comment number ${i}`, ts: new Date().toISOString() } } },
      {}
    );
  }

  const grown = await orders.findOneAsync({ _id: post._id });
  console.log(`Post document now embeds ${grown.comments.length} comments in a single doc.`);
  console.log('Every read of this post loads ALL comments — even if you only need the title.');
  console.log('PROBLEM: no natural stopping point. Real posts get hundreds of comments.');
  console.log('         Entire array loaded into memory on every find(). No pagination possible.');
}

// ─── DEMO 4: Hard Delete Destroys History ─────────────────────────────────────
async function demoHardDelete() {
  console.log('\n━━━ DEMO 4: Hard Delete Destroys History ━━━');

  const order = await orders.insertAsync({
    customerId: 'cust-bob',
    items: [{ sku: 'RARE-1', qty: 1, price: 299.99 }],
    status: 'delivered',
    total: 299.99,
  });
  console.log(`Created order _id=${order._id.slice(-8)}`);

  await orders.removeAsync({ _id: order._id }, {});
  const result = await orders.findOneAsync({ _id: order._id });
  console.log(`After removeAsync: findOneAsync returns → ${result}`);
  console.log('PROBLEM: document gone forever — no createdAt, no deletedAt, no actor.');
  console.log('         Can\'t audit why it was removed or who did it.');
}

// ─── DEMO 5: No Migration Tracking ────────────────────────────────────────────
async function demoNoMigrations() {
  console.log('\n━━━ DEMO 5: No Migration / Schema Version Tracking ━━━');

  // Old doc — no schemaVersion field
  await orders.insertAsync({ customerId: 'c1', total: 10, status: 'pending' });

  // New doc — app added "currency" field
  await orders.insertAsync({ customerId: 'c2', total: 20, status: 'pending', currency: 'USD' });

  // New doc — app added "currency" + "region"
  await orders.insertAsync({ customerId: 'c3', total: 30, status: 'pending', currency: 'EUR', region: 'EU' });

  const all = await orders.findAsync({ customerId: { $in: ['c1', 'c2', 'c3'] } });
  console.log('Same "orders" collection, 3 different document shapes:');
  all.forEach(d => {
    const keys = Object.keys(d).filter(k => !['_id', 'customerId', 'status'].includes(k));
    console.log(`  customerId=${d.customerId}  fields=[${keys.join(', ')}]`);
  });
  console.log('PROBLEM: no _schemaVersion field — at read time, code cannot tell');
  console.log('         which shape a document has or whether it needs migration.');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('STEP 0 — Naive NoSQL Documents (All Problems Present)');
  console.log('='.repeat(60));

  await demoAnyShapeAccepted();
  await demoDenormalizationInconsistency();
  await demoUnboundedArrayGrowth();
  await demoHardDelete();
  await demoNoMigrations();

  console.log('\n' + '─'.repeat(60));
  console.log('PROBLEMS IN THIS STEP:');
  const problems = [
    'No validation       — any shape, any type, any value accepted',
    'No required fields  — missing customerId/items/total go undetected',
    'No _schemaVersion   — cannot detect doc shape at read time',
    'Bad embed strategy  — full objects embedded = stale copies on update',
    'Unbounded arrays    — embedded arrays grow forever, full load on every read',
    'No audit trail      — no createdAt, updatedAt, createdBy',
    'Hard deletes        — removed docs gone forever, no recovery',
    'No soft deletes     — no deletedAt, no restore capability',
    'No migrations       — schema drift across docs, untracked changes',
    'No indexes          — full collection scan on every query',
  ];
  problems.forEach(p => console.log(`  ❌  ${p}`));
}

main().catch(console.error);
