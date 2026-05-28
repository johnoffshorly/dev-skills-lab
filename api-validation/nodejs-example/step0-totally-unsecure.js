'use strict';

// STEP 0: Totally insecure API.
// Training only. Do not deploy.

const express = require('express');
const app = express();

// Problems:
// - Large body limit.
// - Accepts any JSON shape.
// - No schema validation.
// - Saves req.body directly.
// - Reflects raw HTML.
app.use(express.json({ limit: '10mb' }));

const users = new Map();
users.set('victim@example.com', {
  id: 'usr_victim_001',
  email: 'victim@example.com',
  displayName: 'Victim User',
  password: 'demo-password',
  role: 'user',
  isAdmin: false,
  accountBalance: 1000,
  accountStatus: 'active'
});

app.patch('/users/:email', (req, res) => {
  const existing = users.get(req.params.email);
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  const updated = { ...existing, ...req.body };
  users.set(req.params.email, updated);
  return res.json(updated);
});

function insecureMatch(actualValue, suppliedValue) {
  if (suppliedValue && typeof suppliedValue === 'object') {
    if ('$ne' in suppliedValue) return actualValue !== suppliedValue.$ne;
  }
  return actualValue === suppliedValue;
}

app.post('/login', (req, res) => {
  const user = [...users.values()].find(candidate => (
    insecureMatch(candidate.email, req.body.email) &&
    insecureMatch(candidate.password, req.body.password)
  ));

  if (!user) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  return res.json({ message: 'Logged in through insecure matching', user });
});

app.post('/comments', (req, res) => {
  return res.type('html').send(`<h1>Comment</h1><div>${req.body.comment}</div>`);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`STEP 0 totally insecure API running on :${port}`));
