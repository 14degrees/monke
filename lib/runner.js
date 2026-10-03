import { normalize, SEARCH_TERMS } from './normalize.js';
import { SCRAPERS } from '../scrapers/index.js';

/** One pass over the given scrapers (default: all whose API keys are present). */
export async function scrapePass(store, { names, pages = 3, log = console.log } = {}) {
  const totals = {};
  for (const name of names?.length ? names : Object.keys(SCRAPERS)) {
    const s = SCRAPERS[name];
    if (!s) { log(`unknown scraper ${name}`); continue; }
    const missing = (s.needs || []).filter(k => !process.env[k]);
    if (missing.length) { log(`- ${name}: skipped (set ${missing.join(', ')})`); continue; }
    const t0 = Date.now(); let seen = 0, inserted = 0, error;
    try {
      for await (const batch of s.run({ terms: SEARCH_TERMS, pages })) {
        const docs = batch.map(r => normalize(r, `scrape:${name}`)).filter(Boolean);
        seen += docs.length;
        inserted += (await store.upsertMany(docs)).inserted;
      }
    } catch (e) { error = e.message; }
    log(`${error ? '✗' : '✓'} ${name}: ${seen} seen, ${inserted} new (${((Date.now() - t0) / 1000).toFixed(0)}s)${error ? ` — ${error}` : ''}`);
    totals[name] = { seen, inserted };
    await store.logRun({ kind: 'scrape', scraper: name, seen, inserted, error, ms: Date.now() - t0 });
  }
  return totals;
}
