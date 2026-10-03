// Backfill thumbnails/descriptions from og: tags for records that have none.
//   node scripts/enrich.js [limit=500] [concurrency=8]
import 'dotenv/config';
import { openStore } from '../lib/store.js';
import { enrichDoc } from '../lib/og.js';

const limit = Number(process.argv[2] || 500), conc = Number(process.argv[3] || 8);
const store = await openStore();
const todo = await store.missingThumbs(limit);
console.log(`${todo.length} records without thumbnails`);
let done = 0, hit = 0;
await Promise.all(Array.from({ length: conc }, async () => {
  while (todo.length) {
    const d = await enrichDoc(store, todo.shift());
    done++; if (d.thumb) hit++;
    process.stdout.write(`\r${done} checked, ${hit} thumbnails found`);
  }
}));
console.log();
await store.close();
