// STEP 2: Separate concerns — config, data layer, HTTP layer.
// Improved: business logic lives in taskStore (no HTTP knowledge),
//   HTTP handlers only translate HTTP ↔ store calls,
//   all config in one CONFIG object.
// Still missing: error handling not unified — handlers still do manual try/catch,
//   success and error responses have no shared wrapper shape.

const http = require('http');

// ─── Config ───────────────────────────────────────────────────────────────────
// One place to change port, seed data, or future settings.

const CONFIG = {
  port: 3000,
  defaultTasks: [
    { id: 1, title: 'Buy groceries', done: false },
    { id: 2, title: 'Write report', done: false },
  ],
};

// ─── Data / business logic layer ─────────────────────────────────────────────
// taskStore has zero HTTP knowledge — it throws plain Errors on bad input.
// Handlers are responsible for translating those errors into HTTP responses.

const taskStore = (() => {
  let tasks = CONFIG.defaultTasks.map(t => ({ ...t }));
  let nextId = tasks.length + 1;

  function validateTitle(title) {
    if (typeof title !== 'string' || title.trim() === '') {
      throw new Error('Title must be a non-empty string');
    }
  }

  return {
    list() {
      return [...tasks];
    },

    get(id) {
      return tasks.find(t => t.id === id) || null;
    },

    create(title) {
      validateTitle(title);
      const task = { id: nextId++, title: title.trim(), done: false };
      tasks.push(task);
      return task;
    },

    update(id, fields) {
      const task = tasks.find(t => t.id === id);
      if (!task) return null;
      if (fields.title !== undefined) {
        validateTitle(fields.title);
        task.title = fields.title.trim();
      }
      if (fields.done !== undefined) task.done = Boolean(fields.done);
      return task;
    },

    remove(id) {
      const idx = tasks.findIndex(t => t.id === id);
      if (idx === -1) return false;
      tasks.splice(idx, 1);
      return true;
    },
  };
})();

// ─── HTTP utilities ───────────────────────────────────────────────────────────

function parseId(str) {
  const id = parseInt(str, 10);
  return isNaN(id) ? null : id;
}

function parseBody(body) {
  try { return { data: JSON.parse(body), error: null }; }
  catch { return { data: null, error: 'Invalid JSON' }; }
}

function sendJSON(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// STILL MISSING: success responses return raw data; error responses return { error: msg }.
// No shared wrapper — consumers must handle two different shapes.
function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

// ─── HTTP handlers ────────────────────────────────────────────────────────────
// Each handler does only HTTP translation: parse input → call store → send response.
// No business logic here.

const handlers = {
  list(req, res) {
    sendJSON(res, 200, taskStore.list());
  },

  create(req, res, body) {
    const { data, error } = parseBody(body);
    if (error) return sendError(res, 400, error);
    // STILL MISSING: try/catch scattered across every handler that calls store
    try {
      const task = taskStore.create(data.title);
      sendJSON(res, 201, task);
    } catch (e) {
      sendError(res, 400, e.message);
    }
  },

  get(req, res, idStr) {
    const id = parseId(idStr);
    if (!id) return sendError(res, 400, 'Invalid ID');
    const task = taskStore.get(id);
    if (!task) return sendError(res, 404, 'Task not found');
    sendJSON(res, 200, task);
  },

  update(req, res, idStr, body) {
    const id = parseId(idStr);
    if (!id) return sendError(res, 400, 'Invalid ID');
    const { data, error } = parseBody(body);
    if (error) return sendError(res, 400, error);
    try {
      const task = taskStore.update(id, data);
      if (!task) return sendError(res, 404, 'Task not found');
      sendJSON(res, 200, task);
    } catch (e) {
      sendError(res, 400, e.message);
    }
  },

  remove(req, res, idStr) {
    const id = parseId(idStr);
    if (!id) return sendError(res, 400, 'Invalid ID');
    const ok = taskStore.remove(id);
    if (!ok) return sendError(res, 404, 'Task not found');
    sendJSON(res, 200, { deleted: true }); // STILL MISSING: different shape from task responses
  },
};

// ─── Router ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const idMatch = req.url.match(/^\/tasks\/(\d+)$/);

    if (req.method === 'GET'    && req.url === '/tasks') return handlers.list(req, res);
    if (req.method === 'POST'   && req.url === '/tasks') return handlers.create(req, res, body);
    if (req.method === 'GET'    && idMatch)              return handlers.get(req, res, idMatch[1]);
    if (req.method === 'PUT'    && idMatch)              return handlers.update(req, res, idMatch[1], body);
    if (req.method === 'DELETE' && idMatch)              return handlers.remove(req, res, idMatch[1]);

    sendError(res, 404, 'Route not found');
  });
});

server.listen(CONFIG.port, () => {
  console.log(`[STEP 2] Concerns separated — running on http://localhost:${CONFIG.port}`);
  console.log('Fixed: business logic in taskStore, HTTP in handlers, config in CONFIG');
  console.log('Still missing: no unified response shape, try/catch scattered in handlers');
});
