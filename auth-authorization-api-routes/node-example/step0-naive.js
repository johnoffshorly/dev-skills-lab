// STEP 0: No authentication or authorization at all.
// Problems: all routes public, passwords stored and returned in plaintext, anyone can read/modify/delete any data.
// Still missing: identity verification, role checks, token management.

const express = require('express');
const app = express();
app.use(express.json());

// In-memory "database" — passwords stored in plaintext (catastrophic)
const users = [
  { id: 1, username: 'alice', password: 'secret123', role: 'admin', email: 'alice@example.com' },
  { id: 2, username: 'bob',   password: 'password456', role: 'user',  email: 'bob@example.com' },
  { id: 3, username: 'carol', password: 'mypass789',   role: 'user',  email: 'carol@example.com' },
];

const posts = [
  { id: 1, userId: 1, title: 'Admin Notes',  content: 'Internal: keys rotate on Fridays.' },
  { id: 2, userId: 2, title: 'My Post',       content: 'Hello world!' },
];

console.log('[Step 0] No-auth server on http://localhost:3000');
console.log('All routes are public — no authentication or authorization.');

// PROBLEM: returns full user objects including plaintext passwords
app.get('/users', (req, res) => {
  res.json(users);
});

// PROBLEM: anyone can create an admin-role user
app.post('/admin/users', (req, res) => {
  const newUser = { id: users.length + 1, ...req.body };
  users.push(newUser);
  res.status(201).json(newUser);
});

// PROBLEM: anyone can delete any user
app.delete('/users/:id', (req, res) => {
  const idx = users.findIndex(u => u.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  res.json({ deleted: users.splice(idx, 1)[0] });
});

// PROBLEM: sensitive admin data fully public
app.get('/admin/stats', (req, res) => {
  res.json({
    totalUsers: users.length,
    allEmails: users.map(u => u.email),
    allPasswords: users.map(u => ({ id: u.id, password: u.password })),
  });
});

app.get('/posts', (req, res) => res.json(posts));

// PROBLEM: anyone can edit any post regardless of ownership
app.put('/posts/:id', (req, res) => {
  const post = posts.find(p => p.id === parseInt(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  Object.assign(post, req.body);
  res.json(post);
});

app.listen(3000);
