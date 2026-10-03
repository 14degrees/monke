// Run scrapers and upsert into the store.
//   node scripts/scrape.js                 → one pass, all scrapers with keys present
//   node scripts/scrape.js reddit youtube  → only these
//   node scripts/scrape.js --loop          → forever; sleeps SCRAPE_INTERVAL_MIN (default 360) between passes
//   --pages=N                              → pagination depth per query (default 3)
import 'dotenv/config';
import { openStore } from '../lib/store.js';
import { scrapePass } from '../lib/runner.js';
import { sleep } from '../lib/http.js';

const args = process.argv.slice(2);
const loop = args.includes('--loop');
const pages = Number(args.find(a => a.startsWith('--pages='))?.split('=')[1] || 3);
const names = args.filter(a => !a.startsWith('--'));

const store = await openStore();
console.log(`store: ${store.kind}`);
if (store.kind === 'memory') console.warn('MONGODB_URI not set — results will be lost when this process exits.');
do {
  await scrapePass(store, { names, pages });
  if (loop) { const min = Number(process.env.SCRAPE_INTERVAL_MIN || 360); console.log(`sleeping ${min} min…`); await sleep(min * 60000); }
} while (loop);
await store.close();
