import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './lib/store.js';
import { normalize } from './lib/normalize.js';
import { enrichDoc } from './lib/og.js';
import { scrapePass } from './lib/runner.js';
import { runDiscovery, DEFAULT_BRIEFS, agentAvailable } from './lib/agent.js';
import { SCRAPERS } from './scrapers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = await openStore();
const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const strip = ({ _id, og_error, ...d }) => d;
const jobs = { scrape: null, discover: null, log: [] };
const jlog = (s) => { jobs.log.unshift(`${new Date().toISOString().slice(11, 19)} ${s}`); jobs.log.length = Math.min(jobs.log.length, 200); console.log(s); };
// Admin actions (scrape/discover/add) need ADMIN_TOKEN when it is set, so a public deploy can't burn your API credits.
const admin = (req, res, next) => (!process.env.ADMIN_TOKEN || req.get('x-admin-token') === process.env.ADMIN_TOKEN ? next() : res.status(401).json({ error: 'admin token required' }));

app.get('/api/media', async (req, res, next) => {
  try {
    const { q, type, source, tag, sort } = req.query;
    const page = Math.max(0, Number(req.query.page) || 0), limit = Math.min(120, Number(req.query.limit) || 60);
    const r = await store.query({ q: q?.trim() || undefined, type, source, tag, sort, page, limit, nsfw: req.query.nsfw === '1' });
    res.json({ total: r.total, page, items: r.items.map(strip) });
  } catch (e) { next(e); }
});

app.get('/api/facets', async (_req, res, next) => { try { res.json(await store.facets()); } catch (e) { next(e); } });

// Lazy thumbnail resolution: the grid calls this for cards with no thumb as they scroll into view.
const inflight = new Map();
let active = 0;
app.post('/api/enrich', async (req, res, next) => {
  try {
    const key = String(req.body?.key || '');
    const doc = await store.get(key);
    if (!doc) return res.status(404).json({ error: 'not found' });
    if (doc.og_checked || doc.thumb) return res.json(strip(doc));
    if (active >= 12) return res.status(429).json({ error: 'busy' });
    if (!inflight.has(key)) { active++; inflight.set(key, enrichDoc(store, doc).finally(() => { active--; inflight.delete(key); })); }
    res.json(strip(await inflight.get(key)));
  } catch (e) { next(e); }
});

app.post('/api/add', admin, async (req, res, next) => {
  try {
    const d = normalize({ ...req.body, tags: [].concat(req.body.tags || []) }, 'manual');
    if (!d) return res.status(400).json({ error: 'need a valid url' });
    await store.upsertMany([d]);
    res.json(strip(await enrichDoc(store, await store.get(d.key))));
  } catch (e) { next(e); }
});

app.get('/api/status', async (_req, res, next) => {
  try {
    res.json({
      store: store.kind, scrapers: Object.entries(SCRAPERS).map(([n, s]) => ({ name: n, enabled: (s.needs || []).every(k => process.env[k]) })),
      agent: agentAvailable(), running: { scrape: !!jobs.scrape, discover: !!jobs.discover }, log: jobs.log.slice(0, 60),
      runs: await store.recentRuns(30), briefs: DEFAULT_BRIEFS, adminRequired: !!process.env.ADMIN_TOKEN,
    });
  } catch (e) { next(e); }
});

app.post('/api/scrape', admin, (req, res) => {
  if (jobs.scrape) return res.status(409).json({ error: 'already running' });
  const names = [].concat(req.body?.names || []);
  jobs.scrape = scrapePass(store, { names, pages: Number(req.body?.pages) || 3, log: jlog }).catch(e => jlog(`scrape failed: ${e.message}`)).finally(() => { jobs.scrape = null; });
  res.json({ started: true });
});

app.post('/api/discover', admin, (req, res) => {
  if (!agentAvailable()) return res.status(400).json({ error: 'set ANTHROPIC_API_KEY or OPENROUTER_API_KEY on the server' });
  if (jobs.discover) return res.status(409).json({ error: 'already running' });
  const brief = String(req.body?.brief || '').trim() || DEFAULT_BRIEFS[Math.floor(Math.random() * DEFAULT_BRIEFS.length)];
  jlog(`agent ▶ ${brief}`);
  jobs.discover = runDiscovery({ store, brief, log: jlog }).then(r => jlog(`agent ✓ ${r.saved} new — ${r.summary.slice(0, 200)}`)).catch(e => jlog(`agent ✗ ${e.message}`)).finally(() => { jobs.discover = null; });
  res.json({ started: true, brief });
});

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: err.message }); });

// Optional in-process schedulers, handy on a single Railway service.
const every = (min, fn) => { if (min > 0) { setTimeout(fn, 30000); setInterval(fn, min * 60000); } };
every(Number(process.env.AUTO_SCRAPE_MIN || 0), () => { if (!jobs.scrape) jobs.scrape = scrapePass(store, { log: jlog }).finally(() => { jobs.scrape = null; }); });
every(Number(process.env.AUTO_DISCOVER_MIN || 0), () => {
  if (jobs.discover || !agentAvailable()) return;
  const brief = DEFAULT_BRIEFS[Math.floor(Math.random() * DEFAULT_BRIEFS.length)];
  jobs.discover = runDiscovery({ store, brief, log: jlog }).catch(e => jlog(`agent ✗ ${e.message}`)).finally(() => { jobs.discover = null; });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`monke browser on http://localhost:${port} (store: ${store.kind})`));
