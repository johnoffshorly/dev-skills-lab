// STEP 1: Extract reusable helper functions.
// Improved: duplicated ID parsing, task lookup, JSON parsing, and title validation
//   pulled into named helpers — each usable and testable independently.
// Still missing: concerns still mixed (HTTP + business logic share the same handler functions),
//   config still hard-coded inline, response shape not yet standardized.

const http = require('http');

const PORT = 3000;

let tasks = [
  { id: 1, title: 'Buy groceries', done: false },
  { id: 2, title: 'Write report', done: false },
];
let nextId = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Each does one thing and can be called from any handler without duplication.

function parseId(str) {
  const id = parseInt(str, 10);
  return isNaN(id) ? null : id;
}

function findTask(id) {
  return tasks.find(t => t.id === id) || null;
}

function parseBody(body) {
  try {
    return { data: JSON.parse(body), error: null };
  } catch {
    return { data: null, error: 'Invalid JSON' };
  }
}

function isValidTitle(title) {
  return typeof title === 'string' && title.trim().length > 0;
}

function sendJSON(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

// ─── Route handlers ───────────────────────────────────────────────────────────
// Duplication is gone — each helper is called once, not copy-pasted.
// STILL MISSING: business logic (creating/updating tasks) lives inside HTTP handlers.

function listTasks(req, res) {
  sendJSON(res, 200, tasks);
}

function createTask(req, res, body) {
  const { data, error } = parseBody(body);
  if (error) return sendError(res, 400, error);
  if (!isValidTitle(data.title)) return sendError(res, 400, 'Title required');

  // STILL MISSING: task construction lives here, not in a dedicated store/service
  const task = { id: nextId++, title: data.title.trim(), done: false };
  tasks.push(task);
  sendJSON(res, 201, task);
}

function getTask(req, res, idStr) {
  const id = parseId(idStr);
  if (!id) return sendError(res, 400, 'Invalid ID');
  const task = findTask(id);
  if (!task) return sendError(res, 404, 'Task not found');
  sendJSON(res, 200, task);
}

function updateTask(req, res, idStr, body) {
  const id = parseId(idStr);
  if (!id) return sendError(res, 400, 'Invalid ID');
  const task = findTask(id);
  if (!task) return sendError(res, 404, 'Task not found');

  const { data, error } = parseBody(body);
  if (error) return sendError(res, 400, error);

  // STILL MISSING: update logic still inside HTTP handler, not in a store
  if (data.title !== undefined) {
    if (!isValidTitle(data.title)) return sendError(res, 400, 'Title must be non-empty');
    task.title = data.title.trim();
  }
  if (data.done !== undefined) task.done = Boolean(data.done);
  sendJSON(res, 200, task);
}

function deleteTask(req, res, idStr) {
  const id = parseId(idStr);
  if (!id) return sendError(res, 400, 'Invalid ID');
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return sendError(res, 404, 'Task not found');
  tasks.splice(idx, 1);
  sendJSON(res, 200, { deleted: true });
}

// ─── Router ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const idMatch = req.url.match(/^\/tasks\/(\d+)$/);

    if (req.method === 'GET'    && req.url === '/tasks') return listTasks(req, res);
    if (req.method === 'POST'   && req.url === '/tasks') return createTask(req, res, body);
    if (req.method === 'GET'    && idMatch)              return getTask(req, res, idMatch[1]);
    if (req.method === 'PUT'    && idMatch)              return updateTask(req, res, idMatch[1], body);
    if (req.method === 'DELETE' && idMatch)              return deleteTask(req, res, idMatch[1]);

    sendError(res, 404, 'Route not found');
  });
});

server.listen(PORT, () => {
  console.log(`[STEP 1] Helpers extracted — running on http://localhost:${PORT}`);
  console.log('Fixed: no more duplicated ID/lookup/parse/validation logic');
  console.log('Still missing: mixed concerns, hard-coded config, no consistent response shape');
});
