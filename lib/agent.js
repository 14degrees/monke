// Claude-powered discovery agent: searches/fetches the open web on Anthropic's side (so it reaches sites
// your scrapers don't cover — TikTok, X, Instagram, news, blogs, stock sites) and saves finds via a tool.
import Anthropic from '@anthropic-ai/sdk';
import { normalize } from './normalize.js';

const MODEL = process.env.DISCOVER_MODEL || 'claude-opus-5-5';

const TOOLS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 40 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 25 },
  {
    name: 'check_known',
    description: 'Check which of these URLs are already in the archive. Call before saving to avoid duplicates.',
    input_schema: { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } } }, required: ['urls'], additionalProperties: false },
  },
  {
    name: 'save_media',
    description: 'Save monkey/ape media items to the archive. Only save URLs you actually saw in a search result or fetched page. Batch 5-30 items per call.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['url', 'title', 'media_type', 'description', 'tags'],
            properties: {
              url: { type: 'string', description: 'Canonical page URL (YouTube watch, giphy/tenor page, KYM entry, reddit post, tweet, TikTok video, stock page, …)' },
              media_url: { type: 'string', description: 'Direct .mp4/.gif/.jpg URL if you saw one' },
              thumb: { type: 'string', description: 'Direct thumbnail/og:image URL if you saw one' },
              title: { type: 'string' },
              media_type: { type: 'string', enum: ['video', 'gif', 'image', 'meme', 'article', 'audio', 'account'] },
              description: { type: 'string', description: 'One sentence: what it is and why it matters culturally' },
              tags: { type: 'array', items: { type: 'string' } },
              year: { type: 'integer' },
            },
          },
        },
      },
    },
  },
];

const SYSTEM = `You are a relentless internet archivist building the most exhaustive catalog of culturally relevant monkey and ape media: memes, meme templates, reaction gifs, viral videos, TV commercials, stock footage that became memes, famous individual animals, film/TV/game scenes, music videos, social accounts, and deep-cut internet history from every decade and country.

Work loop: search widely with varied phrasings and site: filters → fetch promising pages to extract the real media URLs and og:image thumbnails → check_known → save_media. Prefer canonical media pages over SEO content farms; skip spam domains. Never invent URLs. Keep it SFW. Keep going until you have exhausted the brief or your tool budget, then reply with a two-line summary.`;

function valid(item) {
  return item && typeof item.url === 'string' && /^https?:\/\//.test(item.url) && typeof item.title === 'string';
}

/**
 * @param {{store: any, brief: string, maxTurns?: number, log?: (s: string) => void}} opts
 * @returns {Promise<{saved: number, turns: number, summary: string}>}
 */
export async function runDiscovery({ store, brief, maxTurns = 40, log = console.log }) {
  const client = new Anthropic();
  const sample = (await store.query({ sort: 'random', limit: 150 })).items.map(d => `- ${d.title}`).join('\n');
  const messages = [{
    role: 'user',
    content: `BRIEF: ${brief}\n\nA random sample of what the archive already holds (find things NOT like these duplicates):\n${sample}`,
  }];
  let saved = 0, turns = 0, summary = '';

  while (turns++ < maxTurns) {
    const res = await client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      system: SYSTEM,
      tools: TOOLS,
      messages,
      output_config: { effort: 'high' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    }).finalMessage();

    if (res.stop_reason === 'refusal') { log('model declined; stopping'); break; }
    messages.push({ role: 'assistant', content: res.content });

    for (const b of res.content) {
      if (b.type === 'server_tool_use') log(`  ${b.name}: ${b.input?.query || b.input?.url || ''}`);
      if (b.type === 'text' && b.text.trim()) summary = b.text.trim();
    }
    if (res.stop_reason === 'pause_turn') continue; // server-side tool loop hit its iteration cap; resend to resume
    if (res.stop_reason !== 'tool_use') break;

    const results = [];
    for (const b of res.content.filter(c => c.type === 'tool_use')) {
      try {
        if (b.name === 'check_known') {
          const known = [];
          for (const u of (b.input.urls || []).slice(0, 200)) {
            const d = normalize({ url: u, title: u }, 'agent');
            if (d && await store.get(d.key)) known.push(u);
          }
          results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify({ known }) });
        } else if (b.name === 'save_media') {
          const items = (b.input.items || []).filter(valid);
          const docs = items.map(i => normalize(i, 'agent')).filter(Boolean);
          const r = await store.upsertMany(docs);
          saved += r.inserted;
          log(`  saved ${r.inserted} new (${docs.length} submitted) — total ${saved}`);
          results.push({ type: 'tool_result', tool_use_id: b.id, content: `Saved ${r.inserted} new, ${docs.length - r.inserted} were duplicates. Keep going.` });
        } else {
          results.push({ type: 'tool_result', tool_use_id: b.id, content: `Unknown tool ${b.name}`, is_error: true });
        }
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: b.id, content: `Error: ${e.message}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  await store.logRun({ kind: 'discover', brief, saved, turns });
  return { saved, turns, summary };
}

export const DEFAULT_BRIEFS = [
  'Monkeys and chimps in TV commercials from the 1980s-2000s worldwide (US, Japan, UK, Brazil) — find the actual YouTube uploads.',
  'Monkey meme formats on Know Your Meme and their source videos/images: every one you can find.',
  'Viral monkey TikToks, Instagram reels and X posts from 2020-2026, plus the big monkey/ape accounts.',
  'Famous individual primates (zoo animals, pets, lab and space animals, viral wild individuals) and the best footage of each.',
  'Stock photos/footage of monkeys doing human things (phones, suits, offices, laptops, cars) on Getty, Shutterstock, Pond5, Alamy, Storyblocks.',
  'Monkey and ape reaction gifs on Giphy and Tenor — every emotion.',
  'Apes in film, TV, cartoons and video games — iconic scenes and clips.',
  'Monkey music: songs, music videos, audio memes and sound effects.',
  'Non-English internet monkey culture: Japanese, Chinese, Korean, Indian, Thai, Indonesian, Brazilian, Mexican, Russian monkey memes and viral videos.',
  'Early internet monkey history: Flash animations, forums, rage comics, 2000s viral videos, Bonzi Buddy, eBaum\'s World, Newgrounds.',
];
