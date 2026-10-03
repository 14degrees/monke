// Storage: MongoDB when MONGODB_URI is set, otherwise an in-memory store seeded from data/*.json
// (so the browser works out of the box and can be demoed without a database).
import { MongoClient } from 'mongodb';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from './normalize.js';

const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Merge semantics shared by both stores: first writer wins on core fields, tags/via accumulate, blanks get filled. */
function mergeInto(existing, doc) {
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'tags' || k === 'via') existing[k] = [...new Set([...(existing[k] || []), ...v])];
    else if (existing[k] === undefined || existing[k] === null || existing[k] === '') existing[k] = v;
  }
  if (typeof doc.score === 'number' && doc.score > (existing.score ?? -Infinity)) existing.score = doc.score;
  return existing;
}

class MongoStore {
  constructor(uri, dbName) { this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 }); this.dbName = dbName; }
  async init() {
    await this.client.connect();
    this.col = this.client.db(this.dbName).collection('media');
    this.runs = this.client.db(this.dbName).collection('runs');
    await Promise.all([
      this.col.createIndex({ key: 1 }, { unique: true }),
      this.col.createIndex({ title: 'text', description: 'text', tags: 'text' }, { weights: { title: 5, tags: 3, description: 1 } }),
      this.col.createIndex({ media_type: 1, discovered_at: -1 }),
      this.col.createIndex({ source: 1 }),
      this.col.createIndex({ tags: 1 }),
      this.col.createIndex({ score: -1 }),
    ]);
    return this;
  }
  async upsertMany(docs) {
    docs = docs.filter(Boolean);
    if (!docs.length) return { inserted: 0, updated: 0 };
    const now = new Date();
    const ops = docs.map(d => {
      const { tags, via, score, ...rest } = d;
      const setOnInsert = { ...rest, discovered_at: now };
      const update = { $setOnInsert: setOnInsert, $addToSet: { tags: { $each: tags || [] }, via: { $each: via || [] } }, $set: { updated_at: now } };
      if (typeof score === 'number') update.$max = { score };
      return { updateOne: { filter: { key: d.key }, update, upsert: true } };
    });
    const r = await this.col.bulkWrite(ops, { ordered: false });
    // Fill thumbs/embeds/etc. that an earlier, poorer record of the same item lacked.
    const fills = docs.flatMap(d => ['thumb', 'embed', 'media_url', 'description'].filter(f => d[f]).map(f => ({
      updateOne: { filter: { key: d.key, [f]: { $in: [null, ''] } }, update: { $set: { [f]: d[f] } } },
    })));
    if (fills.length) await this.col.bulkWrite(fills, { ordered: false });
    return { inserted: r.upsertedCount, updated: r.modifiedCount };
  }
  async query({ q, type, source, tag, sort = 'new', page = 0, limit = 60, nsfw = false }) {
    const filter = {};
    if (type) filter.media_type = { $in: type.split(',') };
    if (source) filter.source = { $in: source.split(',') };
    if (tag) filter.tags = { $all: tag.split(',') };
    if (!nsfw) filter.nsfw = { $ne: true };
    let cursor;
    if (q) {
      const or = [{ title: { $regex: escapeRe(q), $options: 'i' } }, { tags: q.toLowerCase() }, { description: { $regex: escapeRe(q), $options: 'i' } }];
      Object.assign(filter, { $or: or });
    }
    const total = await this.col.countDocuments(filter);
    if (sort === 'random') {
      const items = await this.col.aggregate([{ $match: filter }, { $sample: { size: limit } }]).toArray();
      return { total, items };
    }
    const order = sort === 'top' ? { score: -1, discovered_at: -1 } : sort === 'old' ? { discovered_at: 1 } : { discovered_at: -1, _id: -1 };
    cursor = this.col.find(filter).sort(order).skip(page * limit).limit(limit);
    return { total, items: await cursor.toArray() };
  }
  async facets() {
    const [types, sources, tags, total] = await Promise.all([
      this.col.aggregate([{ $group: { _id: '$media_type', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
      this.col.aggregate([{ $group: { _id: '$source', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 60 }]).toArray(),
      this.col.aggregate([{ $unwind: '$tags' }, { $group: { _id: '$tags', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 120 }]).toArray(),
      this.col.estimatedDocumentCount(),
    ]);
    return { total, types, sources, tags };
  }
  async get(key) { return this.col.findOne({ key }); }
  async setFields(key, fields) { await this.col.updateOne({ key }, { $set: fields }); }
  async missingThumbs(limit) { return this.col.find({ thumb: { $exists: false }, og_checked: { $ne: true } }).limit(limit).toArray(); }
  async logRun(run) { await this.runs.insertOne({ ...run, at: new Date() }); }
  async recentRuns(n = 20) { return this.runs.find().sort({ at: -1 }).limit(n).toArray(); }
  async close() { await this.client.close(); }
}

class MemoryStore {
  async init() {
    this.items = new Map();
    this.runList = [];
    if (fs.existsSync(DATA_DIR)) {
      for (const f of fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).sort()) {
        const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        const list = Array.isArray(raw) ? raw : raw.items || [];
        await this.upsertMany(list.map(r => normalize(r, r.via || `seed:${f}`)));
      }
    }
    return this;
  }
  async upsertMany(docs) {
    let inserted = 0, updated = 0; const now = new Date();
    for (const d of docs.filter(Boolean)) {
      const ex = this.items.get(d.key);
      if (ex) { mergeInto(ex, d); updated++; } else { this.items.set(d.key, { _id: d.key, discovered_at: new Date(now.getTime() - this.items.size), ...d }); inserted++; }
    }
    return { inserted, updated };
  }
  async query({ q, type, source, tag, sort = 'new', page = 0, limit = 60, nsfw = false }) {
    let list = [...this.items.values()];
    if (type) { const s = new Set(type.split(',')); list = list.filter(d => s.has(d.media_type)); }
    if (source) { const s = new Set(source.split(',')); list = list.filter(d => s.has(d.source)); }
    if (tag) { const ts = tag.split(','); list = list.filter(d => ts.every(t => d.tags?.includes(t))); }
    if (!nsfw) list = list.filter(d => !d.nsfw);
    if (q) { const re = new RegExp(escapeRe(q), 'i'); list = list.filter(d => re.test(d.title) || re.test(d.description || '') || d.tags?.includes(q.toLowerCase())); }
    if (sort === 'random') { list = list.map(d => [Math.random(), d]).sort((a, b) => a[0] - b[0]).map(x => x[1]); return { total: list.length, items: list.slice(0, limit) }; }
    if (sort === 'top') list.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    else if (sort === 'old') list.sort((a, b) => a.discovered_at - b.discovered_at);
    else list.sort((a, b) => b.discovered_at - a.discovered_at);
    return { total: list.length, items: list.slice(page * limit, page * limit + limit) };
  }
  async facets() {
    const count = (fn) => { const m = new Map(); for (const d of this.items.values()) for (const v of [].concat(fn(d) || [])) m.set(v, (m.get(v) || 0) + 1); return [...m].map(([_id, n]) => ({ _id, n })).sort((a, b) => b.n - a.n); };
    return { total: this.items.size, types: count(d => d.media_type), sources: count(d => d.source).slice(0, 60), tags: count(d => d.tags).slice(0, 120) };
  }
  async get(key) { return this.items.get(key) || null; }
  async setFields(key, fields) { const d = this.items.get(key); if (d) Object.assign(d, fields); }
  async missingThumbs(limit) { return [...this.items.values()].filter(d => !d.thumb && !d.og_checked).slice(0, limit); }
  async logRun(run) { this.runList.unshift({ ...run, at: new Date() }); }
  async recentRuns(n = 20) { return this.runList.slice(0, n); }
  async close() {}
}

export async function openStore() {
  const uri = process.env.MONGODB_URI;
  if (uri) {
    const s = await new MongoStore(uri, process.env.MONGODB_DB || 'monke').init();
    s.kind = 'mongo';
    return s;
  }
  const s = await new MemoryStore().init();
  s.kind = 'memory';
  return s;
}
