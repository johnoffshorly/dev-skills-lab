'use strict';

// STEP 3: Final safer API.
// Fixed: request gates, schema validation, explicit safe mapping, HTML output encoding.

const express = require('express');
const helmet = require('helmet');
const { z } = require('zod');
const app = express();

app.use(helmet());

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

const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  bio: z.string().trim().max(500).optional()
}).strict();

const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform(v => v.toLowerCase()),
  password: z.string().min(1).max(128)
}).strict();

const commentSchema = z.object({
  comment: z.string().min(1).max(500)
}).strict();

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'VALIDATION_FAILED',
        details: result.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      });
    }
    req.validatedBody = result.data;
    return next();
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

app.patch('/users/:email', validate(updateUserSchema), (req, res) => {
  const existing = users.get(req.params.email);
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  // Explicit allow-list mapping. Sensitive fields cannot be changed by client payload.
  const safeUpdate = {};
  if (req.validatedBody.displayName !== undefined) safeUpdate.displayName = req.validatedBody.displayName;
  if (req.validatedBody.bio !== undefined) safeUpdate.bio = req.validatedBody.bio;

  const updated = { ...existing, ...safeUpdate };
  users.set(req.params.email, updated);

  // Do not return password or internal sensitive data.
  return res.json({
    id: updated.id,
    email: updated.email,
    displayName: updated.displayName,
    bio: updated.bio,
    role: updated.role,
    accountStatus: updated.accountStatus
  });
});

app.post('/login', validate(loginSchema), (req, res) => {
  const { email, password } = req.validatedBody;
  const user = [...users.values()].find(candidate => (
    candidate.email === email && candidate.password === password
  ));

  if (!user) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  return res.json({ message: 'Logged in after validated scalar input', userId: user.id });
});

app.post('/comments', validate(commentSchema), (req, res) => {
  const safeComment = escapeHtml(req.validatedBody.comment);
  return res.type('html').send(`<h1>Comment</h1><div>${safeComment}</div>`);
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'MALFORMED_JSON' });
  return next(err);
});

app.use((err, req, res, next) => {
  console.error(err);
  return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`STEP 3 safer API running on :${port}`));
