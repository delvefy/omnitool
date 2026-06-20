/*
 * core.js — Flight Finder (built on the zero-dependency Node.js HTTP template).
 *
 * A Google-Flights-style search service. It serves an interactive page at
 * GET /search and exposes a small JSON API backed by a LIVE flight provider
 * (Kiwi.com Tequila API). It supports:
 *
 *   - city -> city, city -> country, country -> city, country -> country search
 *   - single day OR a date interval (earliest/latest departure)
 *   - round trips (outbound + return date intervals)
 *   - multi-city itineraries (e.g. Stockholm-Athens-Bucharest-Stockholm),
 *     each leg with its own date interval
 *
 * The file keeps the template's 3-section layout:
 *   1. ENDPOINTS  — the route table (URL -> handler + params).
 *   2. PARAMS     — declares every accepted input and how to read it.
 *   3. FUNCTIONS  — handlers, the flight provider + engine, and the runtime.
 *
 * db.json is still the template's tiny data store (the demo "items" resource).
 * Flight data is fetched live and is NOT persisted.
 *
 * Run with:
 *     TEQUILA_API_KEY=xxxxx node core.js        (alias: FLIGHT_API_KEY)
 *
 * Then open http://localhost:3000/search
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');
const SEARCH_HTML_PATH = path.join(__dirname, 'search.html');


/* ============================================================================
 * SECTION 1: ENDPOINTS
 * ----------------------------------------------------------------------------
 * Each key is "METHOD /path"; each value names a handler (FUNCTIONS section)
 * and the params (PARAMS section) it expects. A ":seg" path segment is a route
 * parameter.
 * ==========================================================================*/
const endpoints = {
  'GET    /':              { fn: 'home',          params: [] },

  // --- Flight finder ---
  'GET    /search':        { fn: 'searchPage',    params: [] },
  'GET    /api/health':    { fn: 'health',        params: [] },
  'GET    /api/locations': { fn: 'locations',     params: ['q', 'types', 'limit'] },
  'POST   /api/search':    { fn: 'searchFlights', params: ['tripType', 'trips', 'passengers', 'cabin', 'sort', 'maxStops', 'currency'] },

  // --- Template demo resource (kept from the base template) ---
  'GET    /items':         { fn: 'listItems',     params: ['q'] },
  'GET    /items/:id':     { fn: 'getItem',       params: ['id'] },
  'POST   /items':         { fn: 'createItem',    params: ['name', 'value'] },
  'PUT    /items/:id':     { fn: 'updateItem',    params: ['id', 'name', 'value'] },
  'DELETE /items/:id':     { fn: 'deleteItem',    params: ['id'] },
};


/* ============================================================================
 * SECTION 2: PARAMS
 * ----------------------------------------------------------------------------
 * For each param: source ('route'|'query'|'body'), type ('string'|'number'|
 * 'boolean'|'any'), required, and default. resolveParams() turns these into the
 * `args` object handed to each handler.
 * ==========================================================================*/
const params = {
  // routing / template
  id:    { source: 'route', type: 'string',  required: true },
  q:     { source: 'query', type: 'string',  required: false, default: '' },
  name:  { source: 'body',  type: 'string',  required: true },
  value: { source: 'body',  type: 'any',     required: false, default: null },

  // /api/locations
  types: { source: 'query', type: 'string',  required: false, default: 'airport,city,country' },
  limit: { source: 'query', type: 'number',  required: false, default: 10 },

  // /api/search  (trips is an array of legs; passengers is {adults,children,infants})
  tripType:   { source: 'body', type: 'string', required: false, default: 'oneway' },
  trips:      { source: 'body', type: 'any',    required: true },
  passengers: { source: 'body', type: 'any',    required: false, default: { adults: 1 } },
  cabin:      { source: 'body', type: 'string', required: false, default: 'economy' },
  sort:       { source: 'body', type: 'string', required: false, default: 'best' },
  maxStops:   { source: 'body', type: 'any',    required: false, default: null },
  currency:   { source: 'body', type: 'string', required: false, default: 'EUR' },
};


/* ============================================================================
 * SECTION 3: FUNCTIONS
 * ==========================================================================*/

/* --- Database helpers (template demo "items") ----------------------------- */

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) {
      return { items: [], _meta: { nextId: 1 } };
    }
    throw err;
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n');
}


/* ============================================================================
 * FLIGHT PROVIDER + ENGINE
 * ----------------------------------------------------------------------------
 * Live data comes from the Kiwi.com Tequila API (https://tequila.kiwi.com).
 * Configure with environment variables before starting the server:
 *
 *     TEQUILA_API_KEY   the API key (alias: FLIGHT_API_KEY)   [required]
 *     TEQUILA_HOST      override host (default api.tequila.kiwi.com)
 *
 * Provider endpoints used:
 *     GET  /locations/query   autocomplete (airports, cities, countries)
 *     GET  /v2/search         one-way & round-trip search (with date ranges)
 *     POST /v2/flights_multi  multi-city search (each leg with a date range)
 *
 * Everything below normalizes those payloads into ONE slice-based itinerary
 * shape, so the /search page renders one-way, round-trip and multi-city
 * results with identical code. A "slice" is one directed journey (one leg of a
 * multi-city trip, or the outbound/return half of a round trip) and contains
 * one or more flight "segments".
 * ==========================================================================*/

function apiKey() {
  return process.env.TEQUILA_API_KEY || process.env.FLIGHT_API_KEY || '';
}

// "best" ranking is a generalized cost: money + a price-per-hour for travel
// time + a penalty per stopover. Tunable without touching the sort logic.
const TIME_VALUE_PER_HOUR = 35;
const STOP_PENALTY = 50;

const CABIN_CODES = { economy: 'M', premium: 'W', business: 'C', first: 'F' };
const SORT_CODES  = { cheapest: 'price', fastest: 'duration', best: 'quality' };
const TEQUILA_TYPES = new Set(['airport', 'city', 'country', 'subdivision']);

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// "YYYY-MM-DD" -> "DD/MM/YYYY" (the format Tequila expects). Throws 400 on bad input.
function toDMY(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '').trim());
  if (!m) throw { status: 400, body: { error: `Invalid date "${d}", expected YYYY-MM-DD` } };
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// Build a query string from an object OR an array of [key, value] pairs.
// Arrays allow repeated keys (e.g. several location_types).
function buildQS(q) {
  const sp = new URLSearchParams();
  const pairs = Array.isArray(q) ? q : Object.entries(q || {});
  for (const [k, v] of pairs) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? '?' + s : '';
}

// Promise-based HTTPS call to the provider. Resolves parsed JSON, or rejects
// with a { status, body } the HTTP layer already knows how to send to clients.
function apiRequest(method, pathName, { query, body } = {}) {
  const key = apiKey();
  if (!key) {
    return Promise.reject({
      status: 503,
      body: { error: 'Flight API key not configured. Set TEQUILA_API_KEY (or FLIGHT_API_KEY).' },
    });
  }
  const host = process.env.TEQUILA_HOST || 'api.tequila.kiwi.com';
  const payload = body ? JSON.stringify(body) : null;
  const headers = { apikey: key, Accept: 'application/json' };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host, path: pathName + buildQS(query), method, headers, timeout: 25000 },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
          if (data.length > 2e7) { req.destroy(); reject({ status: 502, body: { error: 'Upstream response too large' } }); }
        });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = null; }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed || {});
          const detail = parsed && (parsed.error || parsed.message);
          reject({
            status: 502,
            body: { error: `Flight provider error (${res.statusCode})${detail ? ': ' + detail : ''}`, upstreamStatus: res.statusCode },
          });
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject({ status: 504, body: { error: 'Flight provider timed out' } }); });
    req.on('error', (e) => reject({ status: 502, body: { error: 'Could not reach flight provider: ' + e.message } }));
    if (payload) req.write(payload);
    req.end();
  });
}

/* --- Location resolution / autocomplete ----------------------------------- */

function normLocation(l) {
  const city = l.city ? l.city.name : (l.type === 'city' ? l.name : null);
  const country = l.country ? l.country.name : (l.type === 'country' ? l.name : null);
  const countryCode = l.country ? l.country.code : (l.type === 'country' ? l.code : null);
  let label, sub;
  if (l.type === 'airport') { label = `${l.name} (${l.code})`; sub = [city, country].filter(Boolean).join(', '); }
  else if (l.type === 'city') { label = `${l.name} — all airports`; sub = [country].filter(Boolean).join(', '); }
  else if (l.type === 'country') { label = l.name; sub = 'Country — any airport'; }
  else { label = l.name || l.code; sub = [city, country].filter(Boolean).join(', '); }
  return { value: l.code, code: l.code, type: l.type, name: l.name, city, country, countryCode, label, sub };
}

async function providerLocations(term, types, limit) {
  const q = [['term', term], ['locale', 'en-US'], ['limit', String(limit)], ['active_only', 'true']];
  for (const t of types) if (TEQUILA_TYPES.has(t)) q.push(['location_types', t]);
  const r = await apiRequest('GET', '/locations/query', { query: q });
  return (r.locations || []).map(normLocation);
}

// Resolve a free-text value OR a canonical code to a provider identifier
// (airport IATA / city code / country code). Cached per process.
const resolveCache = new Map();
async function resolveCode(value) {
  const v = String(value || '').trim();
  if (!v) throw { status: 400, body: { error: 'Missing origin or destination' } };
  // A canonical code coming straight from the autocomplete:
  //   2 letters = country (GB), 3 letters = airport/city (ARN/STO), or "city:XYZ".
  if (/^[A-Z]{2,3}$/.test(v) || /^[a-z]+:[A-Za-z]{2,3}$/.test(v)) return v;
  const cacheKey = v.toLowerCase();
  if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey);
  const matches = await providerLocations(v, ['city', 'airport', 'country'], 5);
  if (!matches.length) throw { status: 400, body: { error: `Could not find a place matching "${value}"` } };
  // For free text, prefer the broadest sensible match: city, then country, then airport.
  const order = { city: 0, country: 1, airport: 2 };
  matches.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
  const code = matches[0].code;
  resolveCache.set(cacheKey, code);
  return code;
}

/* --- Provider search calls ------------------------------------------------ */

async function providerSearch(o) {
  const q = [
    ['fly_from', o.from], ['fly_to', o.to],
    ['date_from', toDMY(o.dateFrom)], ['date_to', toDMY(o.dateTo)],
    ['flight_type', o.flightType],
    ['adults', o.pax.adults], ['children', o.pax.children], ['infants', o.pax.infants],
    ['selected_cabins', CABIN_CODES[o.cabin] || 'M'],
    ['curr', o.currency], ['locale', 'en'], ['limit', o.limit || 40],
    ['sort', SORT_CODES[o.sort] || 'quality'], ['vehicle_type', 'aircraft'],
  ];
  if (o.flightType === 'round') {
    q.push(['return_from', toDMY(o.returnFrom)], ['return_to', toDMY(o.returnTo)]);
  }
  if (o.maxStops != null) q.push(['max_stopovers', o.maxStops]);
  const r = await apiRequest('GET', '/v2/search', { query: q });
  return r.data || [];
}

async function providerMulti(requests, o) {
  const body = {
    requests: requests.map((rq) => {
      const r = {
        fly_from: rq.from, fly_to: rq.to,
        date_from: toDMY(rq.dateFrom), date_to: toDMY(rq.dateTo),
        adults: o.pax.adults, children: o.pax.children, infants: o.pax.infants,
        selected_cabins: CABIN_CODES[o.cabin] || 'M',
      };
      if (o.maxStops != null) r.max_stopovers = o.maxStops;
      return r;
    }),
  };
  const q = [['curr', o.currency], ['locale', 'en'], ['limit', o.limit || 40], ['sort', 'quality']];
  const r = await apiRequest('POST', '/v2/flights_multi', { query: q, body });
  return Array.isArray(r) ? r : (r.data || []);
}

/* --- Normalization: provider payload -> slice-based itineraries ----------- */

function segDurationMin(s) {
  const a = Date.parse(s.utc_arrival || s.local_arrival);
  const d = Date.parse(s.utc_departure || s.local_departure);
  return (Number.isFinite(a) && Number.isFinite(d)) ? Math.max(0, Math.round((a - d) / 60000)) : 0;
}

function normSegment(s) {
  return {
    from: s.flyFrom, to: s.flyTo,
    fromCity: s.cityFrom, toCity: s.cityTo,
    carrier: s.airline,
    flightNo: `${s.airline || ''}${s.flight_no != null ? s.flight_no : ''}`,
    depart: s.local_departure, arrive: s.local_arrival,
    durationMin: segDurationMin(s),
  };
}

function sliceFrom(segs) {
  const segments = segs.map(normSegment);
  const first = segs[0], last = segs[segs.length - 1];
  const dep = Date.parse(first.utc_departure || first.local_departure);
  const arr = Date.parse(last.utc_arrival || last.local_arrival);
  const durationMin = (Number.isFinite(arr) && Number.isFinite(dep))
    ? Math.round((arr - dep) / 60000)
    : segments.reduce((a, s) => a + s.durationMin, 0);
  return {
    from: first.flyFrom, to: last.flyTo,
    fromCity: first.cityFrom, toCity: last.cityTo,
    date: String(first.local_departure || '').slice(0, 10),
    stops: Math.max(0, segs.length - 1),
    durationMin, segments,
  };
}

// Multi-city: split a flat route into one slice per requested leg by matching
// each leg's destination code (airport / city / country) against the segments.
function splitByDest(route, destCodes) {
  const slices = [];
  let cur = [], idx = 0;
  for (const s of route) {
    cur.push(s);
    const target = String(destCodes[idx] || '').toUpperCase();
    const reached = target && [s.flyTo, s.cityCodeTo, s.countryTo && s.countryTo.code]
      .filter(Boolean)
      .map((x) => String(x).toUpperCase())
      .includes(target);
    if (reached && idx < destCodes.length - 1) { slices.push(sliceFrom(cur)); cur = []; idx++; }
  }
  if (cur.length) slices.push(sliceFrom(cur));
  return slices;
}

function buildSlices(route, kind, destCodes) {
  if (!route || !route.length) return [];
  if (kind === 'round') {
    const out = route.filter((s) => !s.return);
    const back = route.filter((s) => s.return);
    return [out.length ? sliceFrom(out) : null, back.length ? sliceFrom(back) : null].filter(Boolean);
  }
  if (kind === 'multicity') return splitByDest(route, destCodes);
  return [sliceFrom(route)];
}

function generalizedCost(it) {
  return it.price + (it.totalDurationMin / 60) * TIME_VALUE_PER_HOUR + it.totalStops * STOP_PENALTY;
}

function normItin(d, kind, destCodes, paxCount, currency) {
  const slices = buildSlices(d.route || [], kind, destCodes);
  const totalDurationMin = slices.reduce((a, s) => a + s.durationMin, 0);
  const totalStops = slices.reduce((a, s) => a + s.stops, 0);
  const price = Math.round(d.price);
  const it = {
    id: d.id || d.booking_token || `${price}-${totalDurationMin}`,
    price,
    pricePerPax: Math.round(price / Math.max(1, paxCount)),
    currency,
    bookingUrl: d.deep_link || null,
    seats: d.availability ? d.availability.seats : null,
    slices, totalDurationMin, totalStops,
  };
  it.score = generalizedCost(it);
  return it;
}

function sortItins(list, sort) {
  const arr = list.slice();
  if (sort === 'cheapest') arr.sort((a, b) => a.price - b.price || a.score - b.score);
  else if (sort === 'fastest') arr.sort((a, b) => a.totalDurationMin - b.totalDurationMin || a.price - b.price);
  else arr.sort((a, b) => a.score - b.score);
  return arr;
}

function topPicks(list) {
  if (!list.length) return { best: null, cheapest: null, fastest: null };
  const by = (f) => list.reduce((m, x) => (f(x) < f(m) ? x : m));
  return {
    best: by((x) => x.score),
    cheapest: by((x) => x.price),
    fastest: by((x) => x.totalDurationMin),
  };
}

function normPax(p) {
  if (typeof p === 'number') return { adults: clampInt(p, 1, 9, 1), children: 0, infants: 0 };
  p = p || {};
  return {
    adults: clampInt(p.adults, 1, 9, 1),
    children: clampInt(p.children, 0, 9, 0),
    infants: clampInt(p.infants, 0, 9, 0),
  };
}

function normMaxStops(v) {
  if (v === 0 || v === '0') return 0;
  if (v === 1 || v === '1') return 1;
  if (v === 2 || v === '2') return 2;
  return null; // "any"
}

/* --- Request handlers: flight finder -------------------------------------- */

function home() {
  return {
    status: 200,
    body: {
      name: 'Flight Finder',
      ui: '/search',
      api: {
        health: 'GET /api/health',
        locations: 'GET /api/locations?q=...',
        search: 'POST /api/search',
      },
      provider: 'tequila',
      apiKeyConfigured: !!apiKey(),
    },
  };
}

function health() {
  return {
    status: 200,
    body: {
      status: 'ok',
      provider: 'tequila',
      host: process.env.TEQUILA_HOST || 'api.tequila.kiwi.com',
      apiKeyConfigured: !!apiKey(),
      endpoints: Object.keys(endpoints),
    },
  };
}

// Serves the single self-contained search page. Read fresh each request so
// edits to search.html show up without a restart.
function searchPage() {
  try {
    return { status: 200, type: 'html', body: fs.readFileSync(SEARCH_HTML_PATH, 'utf8') };
  } catch {
    return { status: 500, type: 'html', body: '<!doctype html><h1>search.html not found</h1>' };
  }
}

async function locations(args) {
  const term = String(args.q || '').trim();
  if (term.length < 2) return { status: 200, body: { locations: [] } };
  const types = String(args.types || 'airport,city,country').split(',').map((s) => s.trim()).filter(Boolean);
  const limit = clampInt(args.limit, 1, 25, 10);
  const locs = await providerLocations(term, types, limit);
  return { status: 200, body: { locations: locs } };
}

async function searchFlights(args) {
  if (!apiKey()) {
    throw { status: 503, body: { error: 'Flight API key not configured. Set TEQUILA_API_KEY (or FLIGHT_API_KEY) to enable search.' } };
  }

  const trips = Array.isArray(args.trips) ? args.trips : [];
  if (!trips.length) throw { status: 400, body: { error: 'Provide at least one flight (trip leg).' } };
  if (trips.length > 6) throw { status: 400, body: { error: 'A maximum of 6 legs is supported.' } };

  const pax = normPax(args.passengers);
  const paxCount = pax.adults + pax.children + pax.infants;
  const cabin = CABIN_CODES[args.cabin] ? args.cabin : 'economy';
  const sort = SORT_CODES[args.sort] ? args.sort : 'best';
  const currency = /^[A-Za-z]{3}$/.test(args.currency || '') ? String(args.currency).toUpperCase() : 'EUR';
  const maxStops = normMaxStops(args.maxStops);

  let tripType = ['oneway', 'round', 'multicity'].includes(args.tripType) ? args.tripType : null;
  if (!tripType) tripType = trips.length > 1 ? 'multicity' : (trips[0].returnFrom ? 'round' : 'oneway');

  let raw = [];
  let destCodes = [];
  let queryLegs = [];

  if (tripType === 'multicity') {
    const requests = [];
    for (const t of trips) {
      const from = await resolveCode(t.from);
      const to = await resolveCode(t.to);
      const dateFrom = t.dateFrom;
      const dateTo = t.dateTo || t.dateFrom;
      requests.push({ from, to, dateFrom, dateTo });
      destCodes.push(to);
      queryLegs.push({ from, to, dateFrom, dateTo });
    }
    raw = await providerMulti(requests, { pax, cabin, currency, maxStops, limit: 50 });
  } else if (tripType === 'round') {
    const t = trips[0];
    const from = await resolveCode(t.from);
    const to = await resolveCode(t.to);
    const dateFrom = t.dateFrom;
    const dateTo = t.dateTo || t.dateFrom;
    const returnFrom = t.returnFrom || t.dateTo || t.dateFrom;
    const returnTo = t.returnTo || returnFrom;
    raw = await providerSearch({ from, to, dateFrom, dateTo, returnFrom, returnTo, flightType: 'round', pax, cabin, sort, maxStops, currency, limit: 50 });
    destCodes = [to, from];
    queryLegs = [
      { from, to, dateFrom, dateTo },
      { from: to, to: from, dateFrom: returnFrom, dateTo: returnTo },
    ];
  } else { // oneway
    const t = trips[0];
    const from = await resolveCode(t.from);
    const to = await resolveCode(t.to);
    const dateFrom = t.dateFrom;
    const dateTo = t.dateTo || t.dateFrom;
    raw = await providerSearch({ from, to, dateFrom, dateTo, flightType: 'oneway', pax, cabin, sort, maxStops, currency, limit: 50 });
    destCodes = [to];
    queryLegs = [{ from, to, dateFrom, dateTo }];
  }

  const itineraries = sortItins(
    raw.map((d) => normItin(d, tripType, destCodes, paxCount, currency)).filter((it) => it.slices.length),
    sort
  );

  return {
    status: 200,
    body: {
      query: { tripType, cabin, sort, currency, passengers: pax, legs: queryLegs },
      results: {
        count: itineraries.length,
        itineraries: itineraries.slice(0, 50),
        topPicks: topPicks(itineraries),
      },
      meta: { provider: 'tequila', currency, generatedAt: new Date().toISOString() },
    },
  };
}

/* --- Request handlers: template demo "items" ------------------------------ */

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
  const item = { id: String(db._meta.nextId++), name: args.name, value: args.value };
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
  home, health, searchPage, locations, searchFlights,
  listItems, getItem, createItem, updateItem, deleteItem,
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

// Builds `args` for an endpoint from its declared param names.
// Throws { status, body } on a validation error (missing required param).
function resolveParams(names, sources) {
  const args = {};
  for (const name of names) {
    const spec = params[name];
    if (!spec) throw { status: 500, body: { error: `Unknown param "${name}"` } };

    let raw = sources[spec.source] ? sources[spec.source][name] : undefined;

    // For scalar body params an empty string counts as missing; objects/arrays
    // (type 'any') are passed through as-is.
    const isEmpty = raw === undefined || (raw === '' && spec.type !== 'any');
    if (isEmpty) {
      if (spec.required) throw { status: 400, body: { error: `Missing required param "${name}"` } };
      raw = spec.default;
    }
    args[name] = coerce(raw, spec.type);
  }
  return args;
}

/* --- Routing --------------------------------------------------------------- */

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

function send(res, status, body, type) {
  if (type === 'html' || type === 'text') {
    res.writeHead(status, {
      'Content-Type': type === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    });
    res.end(typeof body === 'string' ? body : String(body));
    return;
  }
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload + '\n');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const match = matchRoute(req.method, url.pathname);

    if (!match) return send(res, 404, { error: 'Not found' });

    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const query = Object.fromEntries(url.searchParams.entries());
    const args = resolveParams(match.route.params, { route: match.params, query, body });

    const handler = handlers[match.route.fn];
    const result = await handler(args, loadDb());
    send(res, result.status, result.body, result.type);
  } catch (err) {
    if (err && err.status) return send(res, err.status, err.body);
    console.error(err);
    send(res, 500, { error: 'Internal server error' });
  }
});

// Start the server only when run directly (`node core.js`). When required as a
// module (e.g. by tests) the handlers are exported instead, without listening.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Flight Finder listening on http://localhost:${PORT}`);
    console.log(`  Open the search UI:  http://localhost:${PORT}/search`);
    if (!apiKey()) {
      console.log('  WARNING: no flight API key set. Search is disabled until you set');
      console.log('           TEQUILA_API_KEY (or FLIGHT_API_KEY) and restart.');
    }
  });
}

module.exports = { handlers, buildSlices, normItin, sortItins, topPicks, toDMY, server };
