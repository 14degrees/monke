// Load every data/*.json file (swarm output etc.) into Mongo.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../lib/store.js';
import { normalize } from '../lib/normalize.js';

if (!process.env.MONGODB_URI) { console.error('Set MONGODB_URI'); process.exit(1); }
const store = await openStore();
const dir = path.resolve('data');
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.items || [];
  const docs = list.map(r => normalize(r, r.via || `seed:${f}`)).filter(Boolean);
  const r = await store.upsertMany(docs);
  console.log(`${f}: ${docs.length} docs → ${r.inserted} new, ${r.updated} merged`);
}
await store.close();
