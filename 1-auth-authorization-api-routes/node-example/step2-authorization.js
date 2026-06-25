// STEP 2: Add role-based authorization (RBAC) and resource ownership checks.
// Improved: admin routes require admin role; users can only modify their own resources.
// Still missing: tokens are long-lived (7 days), no refresh token, no logout/revocation.

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-do-not-use-in-prod';
if (!process.env.JWT_SECRET) {
  console.warn('[WARN] JWT_SECRET not set — using insecure demo default');
}
// STILL BAD: 7-day tokens with no way to revoke a compromised token
const JWT_EXPIRES_IN = '7d';

const users = [
  { id: 1, username: 'alice', passwordHash: bcrypt.hashSync('secret123',  10), role: 'admin', email: 'alice@example.com', roleVersion: 1 },
  { id: 2, username: 'bob',   passwordHash: bcrypt.hashSync('password456', 10), role: 'user',  email: 'bob@example.com', roleVersion: 1 },
  { id: 3, username: 'carol', passwordHash: bcrypt.hashSync('mypass789',   10), role: 'user',  email: 'carol@example.com', roleVersion: 1 },
];

const ALLOWED_ROLES = ['admin', 'user'];

function parseCreateUserBody(body) {
  const { username, password, role, email } = body;
  if (!username || !password || !email) {
    return { error: 'username, password, and email are required' };
  }
  if (!ALLOWED_ROLES.includes(role)) {
    return { error: 'role must be admin or user' };
  }
  return { username, password, role, email };
}

const posts = [
  { id: 1, userId: 1, title: 'Admin Notes', content: 'Internal: keys rotate on Fridays.' },
  { id: 2, userId: 2, title: 'My Post',     content: 'Hello world!' },
];

console.log('[Step 2] RBAC Authorization server on http://localhost:3002');
console.log('Roles enforced. Still missing: token expiry strategy, refresh, revocation.');

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, roleVersion: user.roleVersion },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  res.json({ token });
});

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

// IMPROVED: reusable role guard middleware factory
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Forbidden: requires role ${roles.join(' or ')}`,
      });
    }
    next();
  };
}

// IMPROVED: admin-only — bob gets 403
app.get('/users', authenticate, requireRole('admin'), (req, res) => {
  res.json(users.map(u => ({ id: u.id, username: u.username, email: u.email, role: u.role })));
});

// IMPROVED: admin-only + whitelisted fields (no mass assignment)
app.post('/admin/users', authenticate, requireRole('admin'), (req, res) => {
  const fields = parseCreateUserBody(req.body);
  if (fields.error) return res.status(400).json({ error: fields.error });
  const newUser = {
    id: users.length + 1,
    username: fields.username,
    email: fields.email,
    role: fields.role,
    roleVersion: 1,
    passwordHash: bcrypt.hashSync(fields.password, 10),
  };
  users.push(newUser);
  res.status(201).json({ id: newUser.id, username: newUser.username, role: newUser.role, email: newUser.email });
});

// IMPROVED: admin-only stats
app.get('/admin/stats', authenticate, requireRole('admin'), (req, res) => {
  res.json({ totalUsers: users.length, allEmails: users.map(u => u.email) });
});

// IMPROVED: ownership check — users can only delete their own account; admins can delete any
app.delete('/users/:id', authenticate, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (req.user.role !== 'admin' && req.user.id !== targetId) {
    return res.status(403).json({ error: 'Forbidden: can only delete your own account' });
  }
  const idx = users.findIndex(u => u.id === targetId);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const deleted = users.splice(idx, 1)[0];
  res.json({ deleted: { id: deleted.id, username: deleted.username } });
});

app.get('/posts', authenticate, (req, res) => res.json(posts));

// IMPROVED: ownership check — only post owner or admin can edit
app.put('/posts/:id', authenticate, (req, res) => {
  const post = posts.find(p => p.id === parseInt(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (req.user.role !== 'admin' && post.userId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden: not the post owner' });
  }
  Object.assign(post, req.body);
  res.json(post);
});

// User can only see their own profile
app.get('/profile', authenticate, (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  res.json({ id: user.id, username: user.username, email: user.email, role: user.role });
});

app.listen(3002);
