// STEP 0: Naive baseline — all code in one blob.
// Problems present:
//   1. Duplicated logic  — ID parsing and task lookup copy-pasted into every handler
//   2. Mixed concerns    — HTTP parsing, business logic, and response formatting entangled
//   3. Magic strings     — status codes, field names, error messages scattered inline
//   4. Inconsistent errors — some return {error}, some {message}, some plain text
//   5. Hard to extend   — adding a route means copy-pasting existing patterns
// Nothing fixed yet.

const http = require('http');

const PORT = 3000;

let tasks = [
  { id: 1, title: 'Buy groceries', done: false },
  { id: 2, title: 'Write report', done: false },
];
let nextId = 3;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {

    // GET /tasks
    if (req.method === 'GET' && req.url === '/tasks') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tasks));
      return;
    }

    // POST /tasks
    if (req.method === 'POST' && req.url === '/tasks') {
      let data;
      try {
        data = JSON.parse(body);
      } catch (e) {
        res.writeHead(400);
        res.end('Bad JSON');                                      // PROBLEM: plain text, not JSON
        return;
      }
      // PROBLEM: title validation duplicated below in PUT handler
      if (!data.title || typeof data.title !== 'string' || data.title.trim() === '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Title is required' })); // PROBLEM: uses "message" key
        return;
      }
      const task = { id: nextId++, title: data.title.trim(), done: false };
      tasks.push(task);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
      return;
    }

    // GET /tasks/:id
    const getMatch = req.url.match(/^\/tasks\/(\d+)$/);
    if (req.method === 'GET' && getMatch) {
      // PROBLEM: ID parsing + task lookup repeated in every handler below
      const id = parseInt(getMatch[1]);
      if (isNaN(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid ID' }));
        return;
      }
      const task = tasks.find(t => t.id === id);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));          // PROBLEM: message varies per handler
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
      return;
    }

    // PUT /tasks/:id
    const putMatch = req.url.match(/^\/tasks\/(\d+)$/);
    if (req.method === 'PUT' && putMatch) {
      // PROBLEM: exact same ID parsing + task lookup as GET above — copy-pasted
      const id = parseInt(putMatch[1]);
      if (isNaN(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid ID' }));
        return;
      }
      const task = tasks.find(t => t.id === id);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));     // PROBLEM: different text than GET's "Not found"
        return;
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch (e) {
        res.writeHead(400);
        res.end('Bad JSON');
        return;
      }
      // PROBLEM: same title validation as POST — duplicated again
      if (data.title !== undefined) {
        if (typeof data.title !== 'string' || data.title.trim() === '') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Title must be non-empty string' })); // PROBLEM: "error" here, "message" in POST
          return;
        }
        task.title = data.title.trim();
      }
      if (data.done !== undefined) task.done = Boolean(data.done);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
      return;
    }

    // DELETE /tasks/:id
    const delMatch = req.url.match(/^\/tasks\/(\d+)$/);
    if (req.method === 'DELETE' && delMatch) {
      // PROBLEM: third copy of ID parsing + task lookup
      const id = parseInt(delMatch[1]);
      if (isNaN(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid ID' }));
        return;
      }
      const idx = tasks.findIndex(t => t.id === id);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'No such task' }));     // PROBLEM: "message" again, third variation
        return;
      }
      tasks.splice(idx, 1);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));                 // PROBLEM: no standard shape
      return;
    }

    // 404 fallback
    res.writeHead(404);
    res.end('Not found');                                         // PROBLEM: plain text
  });
});

server.listen(PORT, () => {
  console.log(`[STEP 0] Naive baseline running on http://localhost:${PORT}`);
  console.log('Problems: duplicated logic, mixed concerns, magic strings, inconsistent errors');
});
