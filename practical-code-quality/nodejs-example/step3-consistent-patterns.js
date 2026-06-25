// STEP 3: Consistent patterns — unified response shape, centralized error types, easy to extend.
// Improved: all responses use { ok: true, data } or { ok: false, error: { code, message } },
//   AppError class centralizes error creation, handle() wrapper eliminates scattered try/catch,
//   routes table makes adding new endpoints a one-liner.
// All step 0 problems addressed.

const http = require('http');

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  port: 3000,
  defaultTasks: [
    { id: 1, title: 'Buy groceries', done: false },
    { id: 2, title: 'Write report', done: false },
  ],
};

// ─── Unified error type ───────────────────────────────────────────────────────
// AppError carries HTTP status + machine-readable code + human message.
// Callers throw; the handle() wrapper catches and formats — handlers stay clean.

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const Errors = {
  invalidId:     () => new AppError(400, 'INVALID_ID',     'ID must be a positive integer'),
  invalidJson:   () => new AppError(400, 'INVALID_JSON',   'Request body must be valid JSON'),
  invalidTitle:  () => new AppError(400, 'INVALID_TITLE',  'Title must be a non-empty string'),
  notFound:      () => new AppError(404, 'NOT_FOUND',      'Task not found'),
  notFoundRoute: () => new AppError(404, 'NOT_FOUND',      'Route not found'),
};

// ─── Data / business logic layer ─────────────────────────────────────────────
// Throws AppError directly — no HTTP knowledge, easy to swap storage later.

const taskStore = (() => {
  let tasks = CONFIG.defaultTasks.map(t => ({ ...t }));
  let nextId = tasks.length + 1;

  function validateTitle(title) {
    if (typeof title !== 'string' || title.trim() === '') throw Errors.invalidTitle();
  }

  return {
    list: () => [...tasks],

    get(id) {
      const task = tasks.find(t => t.id === id);
      if (!task) throw Errors.notFound();
      return task;
    },

    create(title) {
      validateTitle(title);
      const task = { id: nextId++, title: title.trim(), done: false };
      tasks.push(task);
      return task;
    },

    update(id, fields) {
      const task = tasks.find(t => t.id === id);
      if (!task) throw Errors.notFound();
      if (fields.title !== undefined) {
        validateTitle(fields.title);
        task.title = fields.title.trim();
      }
      if (fields.done !== undefined) task.done = Boolean(fields.done);
      return task;
    },

    remove(id) {
      const idx = tasks.findIndex(t => t.id === id);
      if (idx === -1) throw Errors.notFound();
      tasks.splice(idx, 1);
    },
  };
})();

// ─── HTTP utilities ───────────────────────────────────────────────────────────

function parseId(str) {
  const id = parseInt(str, 10);
  if (isNaN(id) || id <= 0) throw Errors.invalidId();
  return id;
}

function parseBody(body) {
  try { return JSON.parse(body); }
  catch { throw Errors.invalidJson(); }
}

// Every response — success or error — shares the same outer shape.
// Consumers always check res.ok, then read res.data or res.error.
function sendSuccess(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, data }));
}

function sendError(res, err) {
  const status  = err instanceof AppError ? err.status  : 500;
  const code    = err instanceof AppError ? err.code    : 'INTERNAL_ERROR';
  const message = err instanceof AppError ? err.message : 'Internal server error';
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: { code, message } }));
}

// handle() wraps any handler: thrown AppErrors become proper error responses automatically.
// No handler needs its own try/catch.
function handle(fn) {
  return (req, res, ...args) => {
    try { fn(req, res, ...args); }
    catch (e) { sendError(res, e); }
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────
// Clean: no try/catch, no error construction, no status code literals.

const handlers = {
  list: handle((req, res) => {
    sendSuccess(res, 200, taskStore.list());
  }),

  create: handle((req, res, body) => {
    const { title } = parseBody(body);
    sendSuccess(res, 201, taskStore.create(title));
  }),

  get: handle((req, res, idStr) => {
    sendSuccess(res, 200, taskStore.get(parseId(idStr)));
  }),

  update: handle((req, res, idStr, body) => {
    sendSuccess(res, 200, taskStore.update(parseId(idStr), parseBody(body)));
  }),

  remove: handle((req, res, idStr) => {
    taskStore.remove(parseId(idStr));
    sendSuccess(res, 200, { deleted: true });
  }),
};

// ─── Router ───────────────────────────────────────────────────────────────────
// Adding a new route = one line in this table. Pattern is obvious and consistent.

const routes = [
  ['GET',    /^\/tasks$/,        (req, res, _, b) => handlers.list(req, res)],
  ['POST',   /^\/tasks$/,        (req, res, _, b) => handlers.create(req, res, b)],
  ['GET',    /^\/tasks\/(\d+)$/, (req, res, m)    => handlers.get(req, res, m[1])],
  ['PUT',    /^\/tasks\/(\d+)$/, (req, res, m, b) => handlers.update(req, res, m[1], b)],
  ['DELETE', /^\/tasks\/(\d+)$/, (req, res, m)    => handlers.remove(req, res, m[1])],
];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    for (const [method, pattern, fn] of routes) {
      const match = req.url.match(pattern);
      if (req.method === method && match) return fn(req, res, match, body);
    }
    sendError(res, Errors.notFoundRoute());
  });
});

server.listen(CONFIG.port, () => {
  console.log(`[STEP 3] Consistent patterns — running on http://localhost:${CONFIG.port}`);
  console.log('Fixed: unified { ok, data/error } shape, AppError, handle() wrapper, routes table');
  console.log('All step 0 problems resolved.');
});
