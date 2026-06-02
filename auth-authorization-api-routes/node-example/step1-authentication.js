// STEP 1: Add JWT authentication — verify identity before granting access.
// Improved: passwords hashed with bcrypt, protected routes require valid signed JWT.
// Still missing: no role checks — any authenticated user can hit /admin routes.

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-do-not-use-in-prod';
if (!process.env.JWT_SECRET) {
  console.warn('[WARN] JWT_SECRET not set — using insecure demo default');
}
// STILL BAD: 7-day expiry with no refresh/revocation strategy
const JWT_EXPIRES_IN = '7d';

const users = [
  { id: 1, username: 'alice', passwordHash: bcrypt.hashSync('secret123',  10), role: 'admin', email: 'alice@example.com', roleVersion: 1 },
  { id: 2, username: 'bob',   passwordHash: bcrypt.hashSync('password456', 10), role: 'user',  email: 'bob@example.com', roleVersion: 1 },
  { id: 3, username: 'carol', passwordHash: bcrypt.hashSync('mypass789',   10), role: 'user',  email: 'carol@example.com', roleVersion: 1 },
];

const posts = [
  { id: 1, userId: 1, title: 'Admin Notes', content: 'Internal: keys rotate on Fridays.' },
  { id: 2, userId: 2, title: 'My Post',     content: 'Hello world!' },
];

console.log('[Step 1] JWT Authentication server on http://localhost:3001');
console.log('Unauthenticated requests blocked. No role-based access control yet.');

// Login: verify credentials, return signed JWT
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  // Role is embedded in the JWT — fine for this step; step 3 re-checks against the DB
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, roleVersion: user.roleVersion },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  res.json({ token });
});

// IMPROVED: rejects requests missing or with invalid/expired token
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token', detail: err.message });
  }
}

// IMPROVED: requires valid token — no more anonymous access
app.get('/users', authenticate, (req, res) => {
  res.json(users.map(u => ({ id: u.id, username: u.username, email: u.email, role: u.role })));
});

// STILL MISSING AUTHZ: bob (role:user) can create admin users
// STILL MISSING INPUT VALIDATION: ...req.body allows mass assignment (extra fields stored on user)
app.post('/admin/users', authenticate, (req, res) => {
  const newUser = {
    id: users.length + 1,
    ...req.body,
    passwordHash: bcrypt.hashSync(req.body.password || 'changeme', 10),
  };
  delete newUser.password;
  users.push(newUser);
  res.status(201).json({ id: newUser.id, username: newUser.username, role: newUser.role });
});

// STILL MISSING AUTHZ: bob (role:user) can see all emails in admin stats
app.get('/admin/stats', authenticate, (req, res) => {
  res.json({ totalUsers: users.length, allEmails: users.map(u => u.email) });
});

// STILL MISSING AUTHZ: any authenticated user can delete any other user
app.delete('/users/:id', authenticate, (req, res) => {
  const idx = users.findIndex(u => u.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const deleted = users.splice(idx, 1)[0];
  res.json({ deleted: { id: deleted.id, username: deleted.username } });
});

app.get('/posts', authenticate, (req, res) => res.json(posts));

// STILL MISSING AUTHZ: bob can edit alice's posts
app.put('/posts/:id', authenticate, (req, res) => {
  const post = posts.find(p => p.id === parseInt(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  Object.assign(post, req.body);
  res.json(post);
});

app.listen(3001);
