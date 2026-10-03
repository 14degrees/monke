// Claude-powered discovery agent: searches/fetches the open web on Anthropic's side (so it reaches sites
// your scrapers don't cover — TikTok, X, Instagram, news, blogs, stock sites) and saves finds via a tool.
import Anthropic from '@anthropic-ai/sdk';
import { normalize } from './normalize.js';

const MODEL = process.env.DISCOVER_MODEL || 'claude-opus-5-5';

export const TOOLS = [
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

export const SYSTEM = `You are a relentless internet archivist building the most exhaustive catalog of culturally relevant monkey and ape media: memes, meme templates, reaction gifs, viral videos, TV commercials, stock footage that became memes, famous individual animals, film/TV/game scenes, music videos, social accounts, and deep-cut internet history from every decade and country.

Work loop: search widely with varied phrasings and site: filters → fetch promising pages to extract the real media URLs and og:image thumbnails → check_known → save_media. Prefer canonical media pages over SEO content farms; skip spam domains. Never invent URLs. Keep it SFW. Keep going until you have exhausted the brief or your tool budget, then reply with a two-line summary.`;

function valid(item) {
  return item && typeof item.url === 'string' && /^https?:\/\//.test(item.url) && typeof item.title === 'string';
}

/** Shared by both backends: runs check_known / save_media against the store. */
export async function handleClientTool(store, name, input, log) {
  try {
    if (name === 'check_known') {
      const known = [];
      for (const u of (input.urls || []).slice(0, 200)) {
        const d = normalize({ url: u, title: u }, 'agent');
        if (d && await store.get(d.key)) known.push(u);
      }
      return { content: JSON.stringify({ known }), inserted: 0 };
    }
    if (name === 'save_media') {
      const docs = (input.items || []).filter(valid).map(i => normalize(i, 'agent')).filter(Boolean);
      const r = await store.upsertMany(docs);
      log(`  saved ${r.inserted} new (${docs.length} submitted)`);
      return { content: `Saved ${r.inserted} new, ${docs.length - r.inserted} were duplicates. Keep going.`, inserted: r.inserted };
    }
    return { content: `Unknown tool ${name}`, is_error: true, inserted: 0 };
  } catch (e) {
    return { content: `Error: ${e.message}`, is_error: true, inserted: 0 };
  }
}

export async function briefPrompt(store, brief) {
  const sample = (await store.query({ sort: 'random', limit: 150 })).items.map(d => `- ${d.title}`).join('\n');
  return `BRIEF: ${brief}\n\nA random sample of what the archive already holds (find things NOT like these duplicates):\n${sample}`;
}

/** Picks the backend from env: ANTHROPIC_API_KEY → Claude API; else OPENROUTER_API_KEY → OpenRouter. */
export async function runDiscovery(opts) {
  if (process.env.ANTHROPIC_API_KEY) return runClaudeDiscovery(opts);
  if (process.env.OPENROUTER_API_KEY) return (await import('./agent-openrouter.js')).runOpenRouterDiscovery(opts);
  throw new Error('Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY');
}

export const agentAvailable = () => !!(process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY);

/**
 * @param {{store: any, brief: string, maxTurns?: number, log?: (s: string) => void}} opts
 * @returns {Promise<{saved: number, turns: number, summary: string}>}
 */
async function runClaudeDiscovery({ store, brief, maxTurns = 40, log = console.log }) {
  const client = new Anthropic();
  const messages = [{ role: 'user', content: await briefPrompt(store, brief) }];
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
      const { content, is_error, inserted } = await handleClientTool(store, b.name, b.input, log);
      saved += inserted;
      results.push({ type: 'tool_result', tool_use_id: b.id, content, ...(is_error ? { is_error } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  await store.logRun({ kind: 'discover', backend: 'anthropic', brief, saved, turns });
  return { saved, turns, summary };
}

export const DEFAULT_BRIEFS = [
  // film / tv / games
  'Apes in film: Planet of the Apes (every era), King Kong (1933/1976/2005/MonsterVerse), 2001 Dawn of Man, Every Which Way But Loose (Clyde), Outbreak, Jumanji, Congo, Mighty Joe Young, Monkey Shines — iconic scene clips on YouTube plus gifs.',
  'Monkeys on TV and in animation: Marcel (Friends), Crystal the monkey (Community, Hangover II, Night at the Museum), Curious George, Abu, Rafiki, Ape Escape, Monkey (1978 Japanese series), Mojo Jojo, Spider-Monkey (Simpsons), Darwin (Wild Thornberrys) — clips, gifs, memes.',
  'Monkeys in video games: Donkey Kong, Diddy Kong, Super Monkey Ball, Bloons TD monkeys, Monkey Island, Ape Escape, Gorilla Tag, Conker — trailers, iconic moments, memes, speedrun clips.',
  // social
  'Viral monkey TikToks 2020-2026 and the biggest monkey TikTok accounts (pet monkeys, Punch the macaque, baby monkey channels, monkey ASMR). Return TikTok video and profile URLs.',
  'Monkey/ape accounts and viral posts on X/Twitter and Instagram: @apeonfone style accounts, monkey pfp culture, ape reaction accounts, viral monkey tweets with millions of views.',
  'Top Reddit posts of all time about monkeys/apes across r/monkeys, r/MonkeyMemes, r/AnimalsBeingDerps, r/NatureIsFuckingLit, r/gifs, r/interestingasfuck, r/funny. Return post URLs.',
  'YouTube Shorts and YouTube channels dedicated to monkeys: pet monkey vloggers, monkey rescue channels, Lopburi/Bali/Gibraltar monkey channels, monkey compilation channels.',
  // gifs
  'Monkey reaction gifs on Giphy — search every emotion and action (thinking, side-eye, dancing, typing, confused, screaming, clapping, vibing, sunglasses, thumbs up, shrug, crying, laughing). Return giphy.com/gifs pages.',
  'Ape/gorilla/orangutan/chimp reaction gifs on Tenor — every emotion and action. Return tenor.com/view pages.',
  // music / audio
  'Monkey music: Monkeys Spinning Monkeys (Kevin MacLeod), Dance Monkey, Shock the Monkey, Funky Monkey, Brass Monkey, Gorillaz, Monkey Wrench, Monkey Man, phonk monkey edits, monkey sound-effect memes (ooh ooh ah ah), banana songs. YouTube links.',
  // deep cuts / history
  'Early internet monkey history: Flash animations (Newgrounds, Albino Blacksheep, eBaum\'s World), Bonzi Buddy, 2000s viral monkey videos, monkey rage comics, 4chan-era SFW ape memes, Monkey Spinning gifs, Space monkeys.',
  'Non-English monkey internet culture: Japanese (Nikko Saru Gundan, monkey TV shows, snow monkeys), Chinese (Sun Wukong, Black Myth Wukong memes), Korean, Indian (Hanuman, Delhi metro monkeys), Thai (Lopburi), Indonesian (Bali), Brazilian/LatAm (macaco memes), Russian memes.',
  'Famous individual primates: Koko, Kanzi, Ayumu, Ham the astrochimp, Bubbles, Travis, Harambe, Naruto (selfie), Darwin (Ikea), Punch, Oliver the humanzee, Nim Chimpsky, Cheeta, Bonzo, Lucy. Footage, news, memes.',
  'Viral wild/zoo monkey news videos 2015-2026: monkey thefts, monkeys stealing phones/sunglasses, monkey gangs, zoo escapes, monkeys in cities, monkeys at temples, gorilla interactions with zoo visitors.',
  // ads
  'More monkey/chimp TV commercials worldwide 1970s-2020s beyond CareerBuilder/E*Trade: PG Tips chimps (UK), Japanese ads with monkeys, Cadbury Gorilla (Phil Collins drumming), Bugle Boy, Mountain Dew, Budweiser, Kia, Super Bowl monkey ads. YouTube uploads.',
  // stock & memes
  'Stock footage/photos of monkeys doing human things on Shutterstock, Pond5, Alamy, Storyblocks, Adobe Stock, iStock, Dreamstime (phones, laptops, suits, office, cars, headphones, sunglasses, money). Return the detail pages.',
  'Meme templates on imgflip featuring monkeys/apes/gorillas/chimps/orangutans — every one. Return imgflip memegenerator URLs.',
  'Know Your Meme entries about monkeys, apes, gorillas, chimps, orangutans, baboons, macaques, lemurs — find every entry beyond Monkey Puppet / Harambe / Return to Monke. Return knowyourmeme.com/memes URLs.',
];
