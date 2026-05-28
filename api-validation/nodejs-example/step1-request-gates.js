'use strict';

// STEP 1: Add basic request gatekeeping.
// Fixed: wrong content type and oversized bodies.
// Still vulnerable: mass assignment, weak login matching, unsafe HTML reflection.

const express = require('express');
const app = express();

app.use((req, res, next) => {
  const methodsWithBody = ['POST', 'PUT', 'PATCH'];
  if (methodsWithBody.includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'UNSUPPORTED_MEDIA_TYPE' });
  }
  return next();
});

app.use(express.json({ limit: '50kb', strict: true }));

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

  // Still bad: direct merge.
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

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'MALFORMED_JSON' });
  return next(err);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`STEP 1 content-type and size checks running on :${port}`));
