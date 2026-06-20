/*
 * core.js — minimal Node.js HTTP app 000template (no external dependencies).
 *
 * The file is organized into three sections:
 *   1. ENDPOINTS  — the route table (what URL maps to what function).
 *   2. PARAMS     — declares the inputs each endpoint accepts and how to read them.
 *   3. FUNCTIONS  — the handlers (business logic) plus the small runtime that ties
 *                   everything together (db access, routing, the HTTP server).
 *
 * Data is persisted to ./db.json, which acts as the database.
 *
 * Run with:  node core.js     (listens on PORT, default 3000)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');


/* ============================================================================
 * SECTION 1: ENDPOINTS
 * ----------------------------------------------------------------------------
 * The route table. Each key is "METHOD /path" and each value declares:
 *   - fn:     the name of the handler in the FUNCTIONS section.
 *   - params: the names of the params (declared in the PARAMS section) that
 *             this endpoint expects.
 *
 * A path segment that starts with ":" is a route parameter (e.g. /items/:id).
 * To add a feature: add a row here, declare any new params below, and write the
 * matching handler in the FUNCTIONS section.
 * ==========================================================================*/
const endpoints = {
  'GET    /':            { fn: 'home',       params: [] },
  'GET    /items':       { fn: 'listItems',  params: ['q'] },
  'GET    /items/:id':   { fn: 'getItem',    params: ['id'] },
  'POST   /items':       { fn: 'createItem', params: ['name', 'value'] },
  'PUT    /items/:id':   { fn: 'updateItem', params: ['id', 'name', 'value'] },
  'DELETE /items/:id':   { fn: 'deleteItem', params: ['id'] },
};


/* ============================================================================
 * SECTION 2: PARAMS
 * ----------------------------------------------------------------------------
 * Declares every param an endpoint can receive. For each param:
 *   - source:   where it comes from — 'route', 'query', or 'body'.
 *   - type:     'string' | 'number' | 'boolean' | 'any' (used for coercion).
 *   - required: if true, a missing value is a 400 error.
 *   - default:  value used when the param is absent and not required.
 *
 * resolveParams() (in the FUNCTIONS section) reads these declarations to build
 * the `args` object handed to each handler.
 * ==========================================================================*/
const params = {
  id:    { source: 'route', type: 'string',  required: true },
  q:     { source: 'query', type: 'string',  required: false, default: '' },
  name:  { source: 'body',  type: 'string',  required: true },
  value: { source: 'body',  type: 'any',     required: false, default: null },
};


/* ============================================================================
 * SECTION 3: FUNCTIONS
 * ----------------------------------------------------------------------------
 * Handlers and the supporting runtime. Each handler has the signature
 *   (args, db) => { status, body }
 * where `args` is the resolved params object and `db` is the parsed db.json.
 * Mutate `db` and call saveDb(db) to persist changes.
 * ==========================================================================*/

/* --- Database helpers ------------------------------------------------------ */

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (err) {
    // Missing or empty file: start from a clean structure.
    if (err.code === 'ENOENT' || err instanceof SyntaxError) {
      return { items: [], _meta: { nextId: 1 } };
    }
    throw err;
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n');
}

/* --- Request handlers ------------------------------------------------------ */

function home() {
  return {
    status: 200,
    body: {
      name: 'core.js 000template API',
      endpoints: Object.keys(endpoints),
    },
  };
}

function listItems(args, db) {
  const q = args.q.toLowerCase();
  const items = q
    ? db.items.filter((it) => String(it.name).toLowerCase().includes(q))
    : db.items;
  return { status: 200, body: items };
}

function getItem(args, db) {
  const item = db.items.find((it) => it.id === args.id);
  if (!item) return { status: 404, body: { error: 'Item not found' } };
  return { status: 200, body: item };
}

function createItem(args, db) {
  const item = {
    id: String(db._meta.nextId++),
    name: args.name,
    value: args.value,
  };
  db.items.push(item);
  saveDb(db);
  return { status: 201, body: item };
}

function updateItem(args, db) {
  const item = db.items.find((it) => it.id === args.id);
  if (!item) return { status: 404, body: { error: 'Item not found' } };
  item.name = args.name;
  item.value = args.value;
  saveDb(db);
  return { status: 200, body: item };
}

function deleteItem(args, db) {
  const index = db.items.findIndex((it) => it.id === args.id);
  if (index === -1) return { status: 404, body: { error: 'Item not found' } };
  const [removed] = db.items.splice(index, 1);
  saveDb(db);
  return { status: 200, body: removed };
}

// Lookup table so the router can resolve a handler from its name.
const handlers = {
  home, listItems, getItem, createItem, updateItem, deleteItem,
};

/* --- Param resolution ------------------------------------------------------ */

function coerce(value, type) {
  if (value === undefined || value === null) return value;
  switch (type) {
    case 'number': {
      const n = Number(value);
      return Number.isNaN(n) ? value : n;
    }
    case 'boolean':
      return value === true || value === 'true' || value === '1';
    case 'string':
      return String(value);
    default:
      return value;
  }
}

// Builds the `args` object for an endpoint from its declared param names.
// Throws { status, body } on a validation error (missing required param).
function resolveParams(names, sources) {
  const args = {};
  for (const name of names) {
    const spec = params[name];
    if (!spec) throw { status: 500, body: { error: `Unknown param "${name}"` } };

    let raw = sources[spec.source] ? sources[spec.source][name] : undefined;

    if (raw === undefined || raw === '') {
      if (spec.required) {
        throw { status: 400, body: { error: `Missing required param "${name}"` } };
      }
      raw = spec.default;
    }
    args[name] = coerce(raw, spec.type);
  }
  return args;
}

/* --- Routing --------------------------------------------------------------- */

// Matches an incoming method + path against the endpoints table.
// Returns { route, params } or null. `params` holds captured route segments.
function matchRoute(method, pathname) {
  const reqParts = pathname.split('/').filter(Boolean);

  for (const key of Object.keys(endpoints)) {
    const [routeMethod, routePath] = key.split(/\s+/);
    if (routeMethod !== method) continue;

    const routeParts = routePath.split('/').filter(Boolean);
    if (routeParts.length !== reqParts.length) continue;

    const captured = {};
    let matched = true;
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) {
        captured[routeParts[i].slice(1)] = decodeURIComponent(reqParts[i]);
      } else if (routeParts[i] !== reqParts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route: endpoints[key], params: captured };
  }
  return null;
}

/* --- HTTP plumbing --------------------------------------------------------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject({ status: 413, body: { error: 'Payload too large' } });
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject({ status: 400, body: { error: 'Invalid JSON body' } });
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload + '\n');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const match = matchRoute(req.method, url.pathname);

    if (!match) return send(res, 404, { error: 'Not found' });

    const body = ['POST', 'PUT', 'PATCH'].includes(req.method)
      ? await readBody(req)
      : {};

    const query = Object.fromEntries(url.searchParams.entries());
    const args = resolveParams(match.route.params, {
      route: match.params,
      query,
      body,
    });

    const handler = handlers[match.route.fn];
    const result = await handler(args, loadDb());
    send(res, result.status, result.body);
  } catch (err) {
    if (err && err.status) return send(res, err.status, err.body);
    console.error(err);
    send(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`core.js template API listening on http://localhost:${PORT}`);
});
