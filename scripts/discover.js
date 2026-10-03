// Discovery agent CLI (Claude API if ANTHROPIC_API_KEY, else OpenRouter).
//   node scripts/discover.js                         → every default brief, one at a time
//   node scripts/discover.js --parallel=6            → swarm: 6 briefs at once
//   node scripts/discover.js "brief text here"       → one custom brief
//   node scripts/discover.js --loop --parallel=4     → keep cycling forever
import 'dotenv/config';
import { openStore } from '../lib/store.js';
import { runDiscovery, DEFAULT_BRIEFS, agentAvailable } from '../lib/agent.js';

if (!agentAvailable()) { console.error('Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY'); process.exit(1); }
const args = process.argv.slice(2);
const loop = args.includes('--loop');
const parallel = Number(args.find(a => a.startsWith('--parallel='))?.split('=')[1] || 1);
const custom = args.filter(a => !a.startsWith('--')).join(' ').trim();
const briefs = custom ? [custom] : DEFAULT_BRIEFS;

const store = await openStore();
console.log(`store: ${store.kind} · ${briefs.length} briefs · ${parallel} at a time`);
do {
  const queue = briefs.map((b, i) => [i, b]);
  let total = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    while (queue.length) {
      const [i, brief] = queue.shift();
      const tag = `[${i + 1}]`;
      console.log(`${tag} ▶ ${brief.slice(0, 100)}`);
      try {
        const r = await runDiscovery({ store, brief, log: (s) => console.log(`${tag}${s}`) });
        total += r.saved;
        console.log(`${tag} ✓ ${r.saved} new in ${r.turns} turns (running total ${total})`);
      } catch (e) {
        console.error(`${tag} ✗`, e.message);
      }
    }
  }));
  console.log(`pass done: ${total} new`);
} while (loop);
await store.close();
