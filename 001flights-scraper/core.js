/*
 * core.js — Flight Finder (built on the zero-dependency Node.js HTTP template).
 *
 * A Google-Flights-style search service. It serves an interactive page at
 * GET /search and exposes a small JSON API backed by a LIVE flight provider:
 * SerpApi's Google Flights engine (https://serpapi.com/google-flights-api).
 *
 * Supports:
 *   - city -> city, city -> country, country -> city, country -> country search
 *   - single day OR a date interval (earliest..latest departure)
 *   - round trips (outbound + return date intervals)
 *   - multi-city itineraries (e.g. Stockholm-Athens-Bucharest-Stockholm),
 *     each leg with its own date interval
 *
 * Design notes (because of how SerpApi/Google Flights works):
 *   - Google Flights takes ONE date per search, not a range. So a date interval
 *     is fanned out into one search per day (bounded — see the caps below — to
 *     protect your SerpApi quota).
 *   - SerpApi has no place-autocomplete endpoint, so a compact airport/city/
 *     country table is embedded here purely to (a) power /api/locations and
 *     (b) turn a typed city/country into the airport codes Google Flights wants
 *     (it accepts comma-separated IATA codes). All PRICES/TIMES are 100% live.
 *   - Round-trip & multi-city are modelled as independent one-way searches per
 *     leg, then combined. This keeps API usage bounded and returns full flight
 *     detail for every leg. Trade-off: a round-trip total is the sum of two
 *     one-way fares (airlines sometimes price true round trips lower).
 *
 * The file keeps the template's 3-section layout:
 *   1. ENDPOINTS  2. PARAMS  3. FUNCTIONS
 *
 * Run with (key can also live in auth.json — see below):
 *     SERPAPI_API_KEY=xxxxx node core.js
 * Then open http://localhost:3000/search
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');
const AUTH_PATH = path.join(__dirname, 'auth.json');
const SEARCH_HTML_PATH = path.join(__dirname, 'search.html');


/* ============================================================================
 * SECTION 1: ENDPOINTS
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
 * FLIGHT PROVIDER (SerpApi / Google Flights) + ENGINE
 * ----------------------------------------------------------------------------
 * API key resolution order:
 *   1. SERPAPI_API_KEY (or SERPAPI_KEY) environment variable
 *   2. auth.json  ->  { "serpapi": { "api_key": "..." } }   (git-ignored)
 *
 * Quota guards (env-overridable):
 *   SERPAPI_MAX_RANGE_DAYS  max days searched per leg date interval  (def 3)
 *   SERPAPI_MAX_CALLS       hard cap on API calls per search         (def 12)
 *   SERPAPI_CONCURRENCY     parallel API calls                       (def 4)
 *   SERPAPI_GL / SERPAPI_HL Google country/language                  (def us/en)
 *   SERPAPI_HOST            override host (def serpapi.com)
 * ==========================================================================*/

function envInt(name, dflt, lo, hi) {
  const n = parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

const MAX_RANGE_DAYS = envInt('SERPAPI_MAX_RANGE_DAYS', 3, 1, 31);
const MAX_TOTAL_CALLS = envInt('SERPAPI_MAX_CALLS', 12, 1, 100);
const CONCURRENCY = envInt('SERPAPI_CONCURRENCY', 4, 1, 8);
const SERP_GL = process.env.SERPAPI_GL || 'us';
const SERP_HL = process.env.SERPAPI_HL || 'en';

// "best" ranking = generalized cost: money + a price-per-hour for travel time +
// a penalty per stopover. Tunable without touching the sort logic.
const TIME_VALUE_PER_HOUR = 35;
const STOP_PENALTY = 50;

const TRAVEL_CLASS = { economy: 1, premium: 2, business: 3, first: 4 };
const SERP_SORT = { best: 1, cheapest: 2, fastest: 5 }; // Google Flights sort_by
const SERP_STOPS = { 0: 1, 1: 2, 2: 3 };                // our maxStops -> Google stops

let _authCache;
function loadAuth() {
  if (_authCache !== undefined) return _authCache;
  try { _authCache = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')); }
  catch { _authCache = null; }
  return _authCache;
}
function serpKey() {
  if (process.env.SERPAPI_API_KEY) return process.env.SERPAPI_API_KEY;
  if (process.env.SERPAPI_KEY) return process.env.SERPAPI_KEY;
  const a = loadAuth();
  return (a && a.serpapi && a.serpapi.api_key) || '';
}

/* --- Embedded location table (autocomplete + name -> codes) ---------------- */
// [ IATA, City, Country, CountryCode, weight(1-10 importance) ]
const AIRPORT_ROWS = [
  // Europe
  ['ARN','Stockholm','Sweden','SE',8], ['BMA','Stockholm','Sweden','SE',4], ['NYO','Stockholm','Sweden','SE',3],
  ['GOT','Gothenburg','Sweden','SE',5], ['CPH','Copenhagen','Denmark','DK',9], ['OSL','Oslo','Norway','NO',8],
  ['HEL','Helsinki','Finland','FI',8], ['ATH','Athens','Greece','GR',8], ['SKG','Thessaloniki','Greece','GR',5],
  ['HER','Heraklion','Greece','GR',4], ['OTP','Bucharest','Romania','RO',7], ['CLJ','Cluj-Napoca','Romania','RO',4],
  ['LHR','London','United Kingdom','GB',10], ['LGW','London','United Kingdom','GB',8], ['STN','London','United Kingdom','GB',6],
  ['LTN','London','United Kingdom','GB',5], ['MAN','Manchester','United Kingdom','GB',7], ['EDI','Edinburgh','United Kingdom','GB',6],
  ['DUB','Dublin','Ireland','IE',8], ['CDG','Paris','France','FR',10], ['ORY','Paris','France','FR',7],
  ['NCE','Nice','France','FR',6], ['LYS','Lyon','France','FR',5], ['AMS','Amsterdam','Netherlands','NL',10],
  ['FRA','Frankfurt','Germany','DE',10], ['MUC','Munich','Germany','DE',9], ['BER','Berlin','Germany','DE',8],
  ['DUS','Dusseldorf','Germany','DE',7], ['HAM','Hamburg','Germany','DE',6], ['MAD','Madrid','Spain','ES',9],
  ['BCN','Barcelona','Spain','ES',9], ['AGP','Malaga','Spain','ES',6], ['PMI','Palma','Spain','ES',6],
  ['VLC','Valencia','Spain','ES',5], ['LIS','Lisbon','Portugal','PT',8], ['OPO','Porto','Portugal','PT',6],
  ['FCO','Rome','Italy','IT',9], ['MXP','Milan','Italy','IT',8], ['LIN','Milan','Italy','IT',5],
  ['VCE','Venice','Italy','IT',6], ['NAP','Naples','Italy','IT',5], ['VIE','Vienna','Austria','AT',9],
  ['ZRH','Zurich','Switzerland','CH',9], ['GVA','Geneva','Switzerland','CH',7], ['BRU','Brussels','Belgium','BE',8],
  ['WAW','Warsaw','Poland','PL',7], ['KRK','Krakow','Poland','PL',5], ['PRG','Prague','Czechia','CZ',7],
  ['BUD','Budapest','Hungary','HU',7], ['IST','Istanbul','Turkey','TR',10], ['SAW','Istanbul','Turkey','TR',7],
  ['AYT','Antalya','Turkey','TR',6], ['SOF','Sofia','Bulgaria','BG',5], ['BEG','Belgrade','Serbia','RS',5],
  ['ZAG','Zagreb','Croatia','HR',4], ['KEF','Reykjavik','Iceland','IS',5], ['RIX','Riga','Latvia','LV',5],
  ['TLL','Tallinn','Estonia','EE',4], ['VNO','Vilnius','Lithuania','LT',4],
  // Middle East / Africa
  ['DXB','Dubai','United Arab Emirates','AE',10], ['AUH','Abu Dhabi','United Arab Emirates','AE',8],
  ['DOH','Doha','Qatar','QA',9], ['TLV','Tel Aviv','Israel','IL',7], ['CAI','Cairo','Egypt','EG',7],
  ['RUH','Riyadh','Saudi Arabia','SA',7], ['JED','Jeddah','Saudi Arabia','SA',7], ['JNB','Johannesburg','South Africa','ZA',8],
  ['CPT','Cape Town','South Africa','ZA',6], ['NBO','Nairobi','Kenya','KE',6], ['LOS','Lagos','Nigeria','NG',6],
  ['CMN','Casablanca','Morocco','MA',6], ['ADD','Addis Ababa','Ethiopia','ET',6],
  // Asia
  ['SIN','Singapore','Singapore','SG',10], ['HKG','Hong Kong','Hong Kong','HK',10], ['BKK','Bangkok','Thailand','TH',9],
  ['KUL','Kuala Lumpur','Malaysia','MY',8], ['NRT','Tokyo','Japan','JP',9], ['HND','Tokyo','Japan','JP',9],
  ['KIX','Osaka','Japan','JP',7], ['ICN','Seoul','South Korea','KR',9], ['PEK','Beijing','China','CN',9],
  ['PVG','Shanghai','China','CN',9], ['CAN','Guangzhou','China','CN',8], ['DEL','Delhi','India','IN',9],
  ['BOM','Mumbai','India','IN',9], ['BLR','Bangalore','India','IN',7], ['MAA','Chennai','India','IN',6],
  ['HYD','Hyderabad','India','IN',6], ['CGK','Jakarta','Indonesia','ID',8], ['DPS','Bali','Indonesia','ID',6],
  ['MNL','Manila','Philippines','PH',7], ['TPE','Taipei','Taiwan','TW',8], ['CMB','Colombo','Sri Lanka','LK',5],
  ['MLE','Male','Maldives','MV',5],
  // Oceania
  ['SYD','Sydney','Australia','AU',9], ['MEL','Melbourne','Australia','AU',8], ['BNE','Brisbane','Australia','AU',7],
  ['PER','Perth','Australia','AU',6], ['AKL','Auckland','New Zealand','NZ',7],
  // North America
  ['JFK','New York','United States','US',10], ['EWR','New York','United States','US',8], ['LGA','New York','United States','US',6],
  ['LAX','Los Angeles','United States','US',10], ['SFO','San Francisco','United States','US',9], ['ORD','Chicago','United States','US',9],
  ['MIA','Miami','United States','US',8], ['DFW','Dallas','United States','US',8], ['ATL','Atlanta','United States','US',9],
  ['BOS','Boston','United States','US',8], ['SEA','Seattle','United States','US',8], ['IAD','Washington','United States','US',7],
  ['DCA','Washington','United States','US',6], ['DEN','Denver','United States','US',8], ['LAS','Las Vegas','United States','US',7],
  ['YYZ','Toronto','Canada','CA',9], ['YVR','Vancouver','Canada','CA',7], ['YUL','Montreal','Canada','CA',7],
  ['MEX','Mexico City','Mexico','MX',8], ['CUN','Cancun','Mexico','MX',6],
  // South America
  ['GRU','Sao Paulo','Brazil','BR',9], ['GIG','Rio de Janeiro','Brazil','BR',7], ['EZE','Buenos Aires','Argentina','AR',8],
  ['SCL','Santiago','Chile','CL',7], ['BOG','Bogota','Colombia','CO',7], ['LIM','Lima','Peru','PE',7],
  ['PTY','Panama City','Panama','PA',7],
];
const AIRPORTS = AIRPORT_ROWS.map((r) => ({ iata: r[0], city: r[1], country: r[2], cc: r[3], w: r[4] }));
const byIata = {};
for (const a of AIRPORTS) byIata[a.iata] = a;

function topCodes(list, n) {
  return list.slice().sort((a, b) => b.w - a.w).slice(0, n).map((a) => a.iata).join(',');
}

// Autocomplete: returns suggestions for airports, multi-airport cities, and countries.
function searchLocations(q, limit) {
  const low = String(q || '').toLowerCase().trim();
  if (low.length < 2) return [];
  const score = (hay) => {
    hay = String(hay).toLowerCase();
    if (hay === low) return 100;
    if (hay.startsWith(low)) return 60;
    if (hay.includes(low)) return 30;
    return 0;
  };
  const sugg = [];
  // Countries
  const countryMap = {};
  for (const a of AIRPORTS) {
    const s = score(a.country);
    if (s > 0) {
      if (!countryMap[a.cc]) countryMap[a.cc] = { country: a.country, list: [], s };
      countryMap[a.cc].list.push(a);
    }
  }
  for (const k in countryMap) {
    const c = countryMap[k];
    sugg.push({ type: 'country', s: c.s + 6, w: 10, value: topCodes(c.list, 6), label: c.country, sub: 'Country — any airport' });
  }
  // Cities (only multi-airport cities get a dedicated "all airports" entry)
  const cityMap = {};
  for (const a of AIRPORTS) {
    const s = score(a.city);
    if (s > 0) {
      const ck = a.city + '|' + a.cc;
      if (!cityMap[ck]) cityMap[ck] = { city: a.city, country: a.country, list: [], s };
      cityMap[ck].list.push(a);
      cityMap[ck].s = Math.max(cityMap[ck].s, s);
    }
  }
  for (const k in cityMap) {
    const c = cityMap[k];
    if (c.list.length > 1) {
      sugg.push({ type: 'city', s: c.s + 3, w: Math.max.apply(null, c.list.map((x) => x.w)), value: topCodes(c.list, 3), label: c.city + ' — all airports', sub: c.country });
    }
  }
  // Airports
  for (const a of AIRPORTS) {
    const s = Math.max(score(a.iata), score(a.city), score(a.country));
    if (s > 0) sugg.push({ type: 'airport', s, w: a.w, value: a.iata, label: `${a.city} (${a.iata})`, sub: a.country });
  }
  sugg.sort((x, y) => (y.s - x.s) || (y.w - x.w));
  const seen = new Set();
  const out = [];
  for (const x of sugg) {
    const key = x.type + '|' + x.label;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: x.type, value: x.value, label: x.label, sub: x.sub });
    if (out.length >= limit) break;
  }
  return out;
}

// Turn a typed value (or a code list from the autocomplete) into the
// comma-separated airport codes that Google Flights expects.
function resolveToCodes(value) {
  const v = String(value || '').trim();
  if (!v) throw { status: 400, body: { error: 'Missing origin or destination' } };
  if (/^[A-Za-z]{3}(\s*,\s*[A-Za-z]{3})*$/.test(v)) return v.toUpperCase().replace(/\s+/g, '');
  if (v.startsWith('/m/') || v.startsWith('/g/')) return v; // a Google location id
  const low = v.toLowerCase();
  // 2-letter country code
  if (/^[a-z]{2}$/.test(low)) {
    const list = AIRPORTS.filter((a) => a.cc === v.toUpperCase());
    if (list.length) return topCodes(list, 6);
  }
  // exact city
  let hit = AIRPORTS.filter((a) => a.city.toLowerCase() === low);
  if (hit.length) return topCodes(hit, 3);
  // exact country name
  hit = AIRPORTS.filter((a) => a.country.toLowerCase() === low);
  if (hit.length) return topCodes(hit, 6);
  // fuzzy
  hit = AIRPORTS.filter((a) => a.city.toLowerCase().includes(low) || a.country.toLowerCase().includes(low));
  if (hit.length) return topCodes(hit, 4);
  throw { status: 400, body: { error: `Could not find a place matching "${value}". Try an airport code (e.g. ARN), a city, or a country.` } };
}

/* --- SerpApi transport ---------------------------------------------------- */

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

// GET serpapi.com/search.json — resolves { status, json }, rejects on transport.
function serpGet(query) {
  const host = process.env.SERPAPI_HOST || 'serpapi.com';
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path: '/search.json' + buildQS(query), method: 'GET', timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 3e7) { req.destroy(); reject({ status: 502, body: { error: 'Upstream response too large' } }); } });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => { req.destroy(); reject({ status: 504, body: { error: 'SerpApi timed out' } }); });
    req.on('error', (e) => reject({ status: 502, body: { error: 'Could not reach SerpApi: ' + e.message } }));
    req.end();
  });
}

function isAuthError(msg) {
  return /api[_\s-]?key|unauthor|invalid key|account|run out|plan/i.test(String(msg || ''));
}

// One Google Flights one-way search. Returns the raw JSON, or null when the
// provider simply has no flights for that day (so one empty day doesn't fail
// the whole search). Throws on auth/transport errors.
async function serpOneWay(from, to, date, o) {
  const query = {
    engine: 'google_flights', api_key: serpKey(), type: 2,
    departure_id: from, arrival_id: to, outbound_date: date,
    travel_class: TRAVEL_CLASS[o.cabin] || 1,
    adults: o.pax.adults, children: o.pax.children, infants_in_seat: o.pax.infants,
    currency: o.currency, hl: SERP_HL, gl: SERP_GL,
    sort_by: SERP_SORT[o.sort] || 1,
  };
  if (o.maxStops != null && SERP_STOPS[o.maxStops]) query.stops = SERP_STOPS[o.maxStops];
  const { status, json } = await serpGet(query);
  if (status === 401 || status === 403) throw { status: 502, body: { error: 'SerpApi rejected the API key (check auth.json / SERPAPI_API_KEY).' } };
  if (json && json.error) {
    if (isAuthError(json.error)) throw { status: 502, body: { error: 'SerpApi: ' + json.error } };
    return null; // e.g. "hasn't returned any results for this query"
  }
  if (status >= 400 && !json) throw { status: 502, body: { error: `SerpApi error (HTTP ${status})` } };
  return json;
}

/* --- Normalization: SerpApi option -> slice-based itinerary --------------- */

function isoLocal(t) {
  if (!t) return '';
  t = String(t);
  return t.includes('T') ? t : t.replace(' ', 'T');
}
function cityOf(ap) {
  if (!ap) return '';
  return (byIata[ap.id] && byIata[ap.id].city) || ap.name || ap.id || '';
}
function generalizedCost(it) {
  return it.price + (it.totalDurationMin / 60) * TIME_VALUE_PER_HOUR + it.totalStops * STOP_PENALTY;
}

// A SerpApi flight option -> a single-slice itinerary (one leg / one direction).
function normOption(o, paxCount, currency, fallbackDate) {
  const fl = o.flights || [];
  if (!fl.length) return null;
  const segments = fl.map((f) => ({
    from: f.departure_airport && f.departure_airport.id,
    to: f.arrival_airport && f.arrival_airport.id,
    fromCity: cityOf(f.departure_airport),
    toCity: cityOf(f.arrival_airport),
    carrier: f.airline,
    flightNo: f.flight_number,
    depart: isoLocal(f.departure_airport && f.departure_airport.time),
    arrive: isoLocal(f.arrival_airport && f.arrival_airport.time),
    durationMin: f.duration || 0,
  }));
  const layovers = o.layovers || [];
  const durationMin = o.total_duration ||
    (segments.reduce((a, s) => a + s.durationMin, 0) + layovers.reduce((a, l) => a + (l.duration || 0), 0));
  const date = (segments[0].depart || '').slice(0, 10) || fallbackDate;
  const slice = {
    from: segments[0].from, to: segments[segments.length - 1].to,
    fromCity: segments[0].fromCity, toCity: segments[segments.length - 1].toCity,
    date, stops: Math.max(0, segments.length - 1), durationMin, segments,
  };
  const price = Math.round(o.price || 0);
  const it = {
    id: o.booking_token || o.departure_token || `${price}-${durationMin}-${segments[0].flightNo || ''}-${date}`,
    price, pricePerPax: Math.round(price / Math.max(1, paxCount)), currency,
    bookingUrl: null, seats: null,
    slices: [slice], totalDurationMin: durationMin, totalStops: slice.stops,
    _date: date,
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
  return { best: by((x) => x.score), cheapest: by((x) => x.price), fastest: by((x) => x.totalDurationMin) };
}

// Merge one chosen option per leg into a single multi-slice itinerary.
function mergeItins(picks, paxCount, currency) {
  const slices = picks.map((p) => p.slices[0]);
  const price = picks.reduce((a, p) => a + p.price, 0);
  const totalDurationMin = picks.reduce((a, p) => a + p.totalDurationMin, 0);
  const totalStops = picks.reduce((a, p) => a + p.totalStops, 0);
  const it = {
    id: picks.map((p) => p.id).join('|'),
    price, pricePerPax: Math.round(price / Math.max(1, paxCount)), currency,
    bookingUrl: null, seats: null,
    slices, totalDurationMin, totalStops,
  };
  it.score = generalizedCost(it);
  return it;
}

// Combine per-leg option lists into bounded, diverse multi-slice itineraries.
// Uses rank alignment across three metrics so cheapest/fastest/best combos all
// appear, without exploding into a full cartesian product.
function combineLegs(legsOptions, sort, paxCount, currency) {
  if (!legsOptions.length || legsOptions.some((l) => !l.length)) return [];
  const seen = new Set();
  const combined = [];
  for (const metric of ['cheapest', 'fastest', 'best']) {
    const sorted = legsOptions.map((l) => sortItins(l, metric));
    const K = Math.min(8, Math.min.apply(null, sorted.map((s) => s.length)));
    for (let i = 0; i < K; i++) {
      const it = mergeItins(sorted.map((s) => s[i]), paxCount, currency);
      if (!seen.has(it.id)) { seen.add(it.id); combined.push(it); }
    }
  }
  return sortItins(combined, sort).slice(0, 50);
}

function googleFlightsUrl(slices, tripType) {
  const f = slices[0];
  const place = (s, end) => (end === 'from' ? (s.fromCity || s.from) : (s.toCity || s.to));
  let q;
  if (tripType === 'round' && slices.length >= 2) {
    q = `Flights from ${place(f, 'from')} to ${place(f, 'to')} on ${f.date} returning ${slices[1].date}`;
  } else if (slices.length > 1) {
    q = 'Flights ' + slices.map((s) => `${place(s, 'from')} to ${place(s, 'to')} on ${s.date}`).join(', then ');
  } else {
    q = `Flights from ${place(f, 'from')} to ${place(f, 'to')} on ${f.date}`;
  }
  return 'https://www.google.com/travel/flights?q=' + encodeURIComponent(q);
}

/* --- Date / passenger helpers --------------------------------------------- */

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
function parseDateUTC(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) throw { status: 400, body: { error: `Invalid date "${s}", expected YYYY-MM-DD` } };
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
function fmtDateUTC(d) { return d.toISOString().slice(0, 10); }
function enumerateDates(from, to, cap) {
  const a = parseDateUTC(from);
  let b = to ? parseDateUTC(to) : a;
  if (b < a) b = a;
  const out = [];
  const d = new Date(a.getTime());
  while (d <= b && out.length < cap) { out.push(fmtDateUTC(d)); d.setUTCDate(d.getUTCDate() + 1); }
  return out.length ? out : [fmtDateUTC(a)];
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
  return null;
}
async function mapPool(items, n, fn) {
  const ret = new Array(items.length);
  let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; ret[idx] = await fn(items[idx], idx); } }
  const workers = [];
  for (let k = 0; k < Math.min(n, items.length); k++) workers.push(worker());
  await Promise.all(workers);
  return ret;
}

/* --- Leg search ----------------------------------------------------------- */

// All options for one leg across its (capped) date interval.
async function searchLeg(from, to, dateFrom, dateTo, o) {
  const dates = enumerateDates(dateFrom, dateTo, o.dayCap);
  const lists = await mapPool(dates, CONCURRENCY, async (d) => {
    const json = await serpOneWay(from, to, d, o);
    if (!json) return [];
    const arr = (json.best_flights || []).concat(json.other_flights || []);
    const out = [];
    for (const op of arr) { const it = normOption(op, o.paxCount, o.currency, d); if (it) out.push(it); }
    return out;
  });
  const seen = new Set();
  const dedup = [];
  for (const l of lists) {
    for (const it of l) {
      const sig = it._date + '|' + it.slices[0].segments.map((s) => s.flightNo).join(',') + '|' + it.price;
      if (seen.has(sig)) continue;
      seen.add(sig);
      dedup.push(it);
    }
  }
  return sortItins(dedup, o.sort).slice(0, 40);
}

/* --- Request handlers: flight finder -------------------------------------- */

function home() {
  return {
    status: 200,
    body: {
      name: 'Flight Finder',
      ui: '/search',
      api: { health: 'GET /api/health', locations: 'GET /api/locations?q=...', search: 'POST /api/search' },
      provider: 'serpapi (google flights)',
      apiKeyConfigured: !!serpKey(),
    },
  };
}

function health() {
  return {
    status: 200,
    body: {
      status: 'ok',
      provider: 'serpapi (google flights)',
      host: process.env.SERPAPI_HOST || 'serpapi.com',
      apiKeyConfigured: !!serpKey(),
      keySource: process.env.SERPAPI_API_KEY || process.env.SERPAPI_KEY ? 'env'
        : (loadAuth() && loadAuth().serpapi && loadAuth().serpapi.api_key ? 'auth.json' : 'none'),
      caps: { maxRangeDays: MAX_RANGE_DAYS, maxCallsPerSearch: MAX_TOTAL_CALLS, concurrency: CONCURRENCY },
      endpoints: Object.keys(endpoints),
    },
  };
}

function searchPage() {
  try {
    return { status: 200, type: 'html', body: fs.readFileSync(SEARCH_HTML_PATH, 'utf8') };
  } catch {
    return { status: 500, type: 'html', body: '<!doctype html><h1>search.html not found</h1>' };
  }
}

function locations(args) {
  const term = String(args.q || '').trim();
  const limit = clampInt(args.limit, 1, 25, 10);
  return { status: 200, body: { locations: searchLocations(term, limit) } };
}

async function searchFlights(args) {
  if (!serpKey()) {
    throw { status: 503, body: { error: 'No SerpApi key configured. Add it to auth.json ({ "serpapi": { "api_key": "..." } }) or set SERPAPI_API_KEY, then restart.' } };
  }

  const trips = Array.isArray(args.trips) ? args.trips : [];
  if (!trips.length) throw { status: 400, body: { error: 'Provide at least one flight (trip leg).' } };
  if (trips.length > 6) throw { status: 400, body: { error: 'A maximum of 6 legs is supported.' } };

  const pax = normPax(args.passengers);
  const paxCount = pax.adults + pax.children + pax.infants;
  const cabin = TRAVEL_CLASS[args.cabin] ? args.cabin : 'economy';
  const sort = SERP_SORT[args.sort] ? args.sort : 'best';
  const currency = /^[A-Za-z]{3}$/.test(args.currency || '') ? String(args.currency).toUpperCase() : 'EUR';
  const maxStops = normMaxStops(args.maxStops);

  let tripType = ['oneway', 'round', 'multicity'].includes(args.tripType) ? args.tripType : null;
  if (!tripType) tripType = trips.length > 1 ? 'multicity' : (trips[0].returnFrom ? 'round' : 'oneway');

  // Build the list of legs to search (each becomes one-way searches).
  const legSpecs = [];
  if (tripType === 'round') {
    const t = trips[0];
    legSpecs.push({ from: t.from, to: t.to, dateFrom: t.dateFrom, dateTo: t.dateTo || t.dateFrom });
    legSpecs.push({ from: t.to, to: t.from, dateFrom: t.returnFrom || t.dateTo || t.dateFrom, dateTo: t.returnTo || t.returnFrom || t.dateTo || t.dateFrom });
  } else if (tripType === 'multicity') {
    for (const t of trips) legSpecs.push({ from: t.from, to: t.to, dateFrom: t.dateFrom, dateTo: t.dateTo || t.dateFrom });
  } else {
    const t = trips[0];
    legSpecs.push({ from: t.from, to: t.to, dateFrom: t.dateFrom, dateTo: t.dateTo || t.dateFrom });
  }

  // Resolve places -> codes, and bound the per-leg day count so the total
  // number of API calls never exceeds MAX_TOTAL_CALLS.
  const dayCap = Math.max(1, Math.min(MAX_RANGE_DAYS, Math.floor(MAX_TOTAL_CALLS / legSpecs.length)));
  let truncated = false;
  for (const leg of legSpecs) {
    leg.fromCode = resolveToCodes(leg.from);
    leg.toCode = resolveToCodes(leg.to);
    const requested = enumerateDates(leg.dateFrom, leg.dateTo, 999).length;
    if (requested > dayCap) truncated = true;
  }

  const opts = { pax, paxCount, cabin, sort, currency, maxStops, dayCap };
  const legResults = await mapPool(legSpecs, CONCURRENCY, (leg) =>
    searchLeg(leg.fromCode, leg.toCode, leg.dateFrom, leg.dateTo, opts));

  let itineraries;
  if (tripType === 'oneway') itineraries = legResults[0] || [];
  else itineraries = combineLegs(legResults, sort, paxCount, currency);
  itineraries = sortItins(itineraries, sort).slice(0, 50);
  for (const it of itineraries) it.bookingUrl = googleFlightsUrl(it.slices, tripType);

  const notes = [];
  if (truncated) notes.push(`Date ranges were capped to ${dayCap} day(s) per leg to limit API usage (configurable via SERPAPI_MAX_RANGE_DAYS / SERPAPI_MAX_CALLS).`);
  if (tripType === 'round' || tripType === 'multicity') notes.push('Each leg is priced as a separate one-way fare; airline round-trip fares may differ.');

  return {
    status: 200,
    body: {
      query: {
        tripType, cabin, sort, currency, passengers: pax,
        legs: legSpecs.map((l) => ({ from: l.fromCode, to: l.toCode, dateFrom: l.dateFrom, dateTo: l.dateTo })),
      },
      results: { count: itineraries.length, itineraries, topPicks: topPicks(itineraries) },
      meta: { provider: 'serpapi', currency, generatedAt: new Date().toISOString(), notes },
    },
  };
}

/* --- Request handlers: template demo "items" ------------------------------ */

function listItems(args, db) {
  const q = args.q.toLowerCase();
  const items = q ? db.items.filter((it) => String(it.name).toLowerCase().includes(q)) : db.items;
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
    case 'number': { const n = Number(value); return Number.isNaN(n) ? value : n; }
    case 'boolean': return value === true || value === 'true' || value === '1';
    case 'string': return String(value);
    default: return value;
  }
}

function resolveParams(names, sources) {
  const args = {};
  for (const name of names) {
    const spec = params[name];
    if (!spec) throw { status: 500, body: { error: `Unknown param "${name}"` } };

    let raw = sources[spec.source] ? sources[spec.source][name] : undefined;

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
      if (routeParts[i].startsWith(':')) captured[routeParts[i].slice(1)] = decodeURIComponent(reqParts[i]);
      else if (routeParts[i] !== reqParts[i]) { matched = false; break; }
    }
    if (matched) return { route: endpoints[key], params: captured };
  }
  return null;
}

/* --- HTTP plumbing --------------------------------------------------------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) reject({ status: 413, body: { error: 'Payload too large' } }); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject({ status: 400, body: { error: 'Invalid JSON body' } }); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type) {
  if (type === 'html' || type === 'text') {
    res.writeHead(status, { 'Content-Type': type === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' });
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
    if (!serpKey()) {
      console.log('  WARNING: no SerpApi key found. Add it to auth.json or set');
      console.log('           SERPAPI_API_KEY, then restart. Search is disabled until then.');
    }
  });
}

module.exports = {
  handlers, normOption, combineLegs, mergeItins, sortItins, topPicks,
  enumerateDates, resolveToCodes, searchLocations, googleFlightsUrl, server,
};
