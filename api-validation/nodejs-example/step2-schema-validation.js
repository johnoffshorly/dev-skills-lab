'use strict';

// STEP 2: Add schema validation.
// Fixed: wrong types, unknown fields, NoSQL operator object payloads.
// Still vulnerable: unsafe HTML reflection if returning raw HTML.

const express = require('express');
const { z } = require('zod');
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

app.patch('/users/:email', validate(updateUserSchema), (req, res) => {
  const existing = users.get(req.params.email);
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  // Better: only validated fields are present.
  // Step 3 will make mapping even more explicit.
  const updated = { ...existing, ...req.validatedBody };
  users.set(req.params.email, updated);
  return res.json(updated);
});

app.post('/login', validate(loginSchema), (req, res) => {
  const { email, password } = req.validatedBody;
  const user = [...users.values()].find(candidate => (
    candidate.email === email && candidate.password === password
  ));

  if (!user) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  return res.json({ message: 'Logged in after validated scalar input', user });
});

app.post('/comments', validate(commentSchema), (req, res) => {
  // Still unsafe for HTML output. Step 3 fixes this.
  return res.type('html').send(`<h1>Comment</h1><div>${req.validatedBody.comment}</div>`);
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'MALFORMED_JSON' });
  return next(err);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`STEP 2 schema validation running on :${port}`));
