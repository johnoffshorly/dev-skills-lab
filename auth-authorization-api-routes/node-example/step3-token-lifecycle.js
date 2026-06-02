// STEP 3: Short-lived access tokens + refresh token rotation + logout revocation.
// Improved: 15-min access JWTs, opaque server-stored refresh tokens with TTL, logout blacklists JTI.
// Improved: re-load user from DB on each request so role/roleVersion changes invalidate old tokens.
// Production gaps remaining: use Redis for token stores, asymmetric JWT keys, no in-memory blacklist growth.

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const ACCESS_SECRET = process.env.ACCESS_SECRET || 'access-secret-change-in-prod';
if (!process.env.ACCESS_SECRET) {
  console.warn('[WARN] ACCESS_SECRET not set — using insecure demo default');
}
const ACCESS_EXPIRES_IN = '15m';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // mirrors "7d" — enforced server-side on opaque tokens

const users = [
  { id: 1, username: 'alice', passwordHash: bcrypt.hashSync('secret123',  10), role: 'admin', email: 'alice@example.com', roleVersion: 1 },
  // README §18: bump bob's roleVersion to 2, restart, and reuse a pre-bump access token to see 401 stale claims
  { id: 2, username: 'bob',   passwordHash: bcrypt.hashSync('password456', 10), role: 'user',  email: 'bob@example.com', roleVersion: 1 },
  { id: 3, username: 'carol', passwordHash: bcrypt.hashSync('mypass789',   10), role: 'user',  email: 'carol@example.com', roleVersion: 1 },
];

const posts = [
  { id: 1, userId: 1, title: 'Admin Notes', content: 'Internal: keys rotate on Fridays.' },
  { id: 2, userId: 2, title: 'My Post',     content: 'Hello world!' },
];

const ALLOWED_ROLES = ['admin', 'user'];

// In production: Redis with TTL — survives restarts, auto-expires refresh tokens
const refreshTokenStore = new Map(); // refreshToken -> { userId, expiresAt }
const accessTokenBlacklist = new Set(); // revoked access-token JTIs (lost on process restart)

console.log('[Step 3] Token lifecycle server on http://localhost:3003');
console.log('Access JWT 15m. Opaque refresh tokens (7d TTL). Logout revokes immediately.');

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

function purgeExpiredRefreshTokens() {
  const now = Date.now();
  for (const [token, entry] of refreshTokenStore) {
    if (entry.expiresAt <= now) refreshTokenStore.delete(token);
  }
}

function storeRefreshToken(refreshToken, userId) {
  refreshTokenStore.set(refreshToken, {
    userId,
    expiresAt: Date.now() + REFRESH_TTL_MS,
  });
}

function getRefreshEntry(refreshToken) {
  purgeExpiredRefreshTokens();
  const entry = refreshTokenStore.get(refreshToken);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) refreshTokenStore.delete(refreshToken);
    return null;
  }
  return entry;
}

function generateTokenPair(user) {
  const jti = crypto.randomUUID();
  const accessToken = jwt.sign(
    { id: user.id, username: user.username, role: user.role, roleVersion: user.roleVersion, jti },
    ACCESS_SECRET,
    { expiresIn: ACCESS_EXPIRES_IN }
  );
  // Opaque refresh token — not a JWT; server looks it up (use Redis + TTL in production)
  const refreshToken = crypto.randomBytes(40).toString('hex');
  storeRefreshToken(refreshToken, user.id);
  return { accessToken, refreshToken };
}

function resolveUserFromTokenClaims(claims) {
  const user = users.find(u => u.id === claims.id);
  if (!user) return { error: 'User not found' };
  if (user.role !== claims.role || user.roleVersion !== claims.roleVersion) {
    return { error: 'Token claims are stale — log in again' };
  }
  return { user, jti: claims.jti };
}

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  try {
    const claims = jwt.verify(authHeader.slice(7), ACCESS_SECRET);
    if (accessTokenBlacklist.has(claims.jti)) {
      return res.status(401).json({ error: 'Token has been revoked' });
    }
    const resolved = resolveUserFromTokenClaims(claims);
    if (resolved.error) {
      return res.status(401).json({ error: resolved.error });
    }
    req.user = {
      id: resolved.user.id,
      username: resolved.user.username,
      role: resolved.user.role,
      roleVersion: resolved.user.roleVersion,
      jti: resolved.jti,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token', detail: err.message });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Forbidden: requires role ${roles.join(' or ')}` });
    }
    next();
  };
}

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const { accessToken, refreshToken } = generateTokenPair(user);
  res.json({ accessToken, refreshToken, expiresIn: 900 });
});

app.post('/auth/refresh', (req, res) => {
  const { refreshToken } = req.body;
  const entry = refreshToken ? getRefreshEntry(refreshToken) : null;
  if (!entry) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
  const user = users.find(u => u.id === entry.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });

  refreshTokenStore.delete(refreshToken);
  const { accessToken, refreshToken: newRefresh } = generateTokenPair(user);
  res.json({ accessToken, refreshToken: newRefresh, expiresIn: 900 });
});

app.post('/auth/logout', authenticate, (req, res) => {
  accessTokenBlacklist.add(req.user.jti);
  const { refreshToken } = req.body;
  if (refreshToken) refreshTokenStore.delete(refreshToken);
  res.json({ message: 'Logged out successfully' });
});

app.get('/users', authenticate, requireRole('admin'), (req, res) => {
  res.json(users.map(u => ({ id: u.id, username: u.username, email: u.email, role: u.role })));
});

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

app.get('/admin/stats', authenticate, requireRole('admin'), (req, res) => {
  purgeExpiredRefreshTokens();
  res.json({
    totalUsers: users.length,
    activeRefreshTokens: refreshTokenStore.size,
    revokedAccessTokens: accessTokenBlacklist.size,
  });
});

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

app.put('/posts/:id', authenticate, (req, res) => {
  const post = posts.find(p => p.id === parseInt(req.params.id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (req.user.role !== 'admin' && post.userId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden: not the post owner' });
  }
  Object.assign(post, req.body);
  res.json(post);
});

app.get('/profile', authenticate, (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  res.json({ id: user.id, username: user.username, email: user.email, role: user.role });
});

app.listen(3003);
