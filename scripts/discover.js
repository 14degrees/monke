// Claude discovery agent CLI.
//   node scripts/discover.js                    → runs every default brief once
//   node scripts/discover.js "brief text here"  → one custom brief
//   node scripts/discover.js --loop             → cycles the default briefs forever
import 'dotenv/config';
import { openStore } from '../lib/store.js';
import { runDiscovery, DEFAULT_BRIEFS } from '../lib/agent.js';

if (!process.env.ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }
const args = process.argv.slice(2);
const loop = args.includes('--loop');
const custom = args.filter(a => !a.startsWith('--')).join(' ').trim();
const briefs = custom ? [custom] : DEFAULT_BRIEFS;

const store = await openStore();
console.log(`store: ${store.kind}`);
do {
  for (const brief of briefs) {
    console.log(`\n▶ ${brief}`);
    try {
      const r = await runDiscovery({ store, brief });
      console.log(`✓ ${r.saved} new items in ${r.turns} turns\n${r.summary}`);
    } catch (e) {
      console.error('✗', e.message);
    }
  }
} while (loop);
await store.close();
