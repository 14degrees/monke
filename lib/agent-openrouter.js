// OpenRouter backend for the discovery agent (OpenAI-compatible chat completions).
//   web_search → DuckDuckGo HTML → Bing HTML → Perplexity Sonar (paid, last resort). SEARCH_BACKEND=sonar forces Sonar.
//   fetch_page → direct fetch + r.jina.ai fallback (lib/harvest.js).
// Search results and page links are harvested into the DB by the harness itself, so even small, cheap
// models that rarely call save_media still produce results; the model's job is choosing queries/pages.
import { TOOLS, SYSTEM, handleClientTool, briefPrompt } from './agent.js';
import { get, decodeEntities } from './http.js';
import { fetchPage, autoSave, isPrimateListing } from './harvest.js';

const BASE = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite';
const SEARCH_MODEL = process.env.OPENROUTER_SEARCH_MODEL || 'perplexity/sonar';

async function chat(body) {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json', 'x-title': 'monke archive' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`OpenRouter ${r.status}: ${j.error?.message || r.statusText}`);
  return j;
}

const strip = (x) => decodeEntities(String(x || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// Free engines are serialized process-wide and spaced out so parallel agents don't get us throttled.
let chain = Promise.resolve();
const gap = () => new Promise(r => setTimeout(r, 1500));
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.then(gap, gap); return p; };
const cooldown = { ddg: 0, bing: 0 };

async function ddg(query) {
  const html = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { json: false, retries: 0, timeout: 8000 });
  const results = [];
  for (const m of html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = m[1].replace(/&amp;/g, '&');
    const url = href.includes('uddg=') ? decodeURIComponent(href.split('uddg=')[1].split('&')[0]) : href.startsWith('//') ? `https:${href}` : href;
    if (!/duckduckgo\.com\/y\.js/.test(url)) results.push({ url, title: strip(m[2]) });
  }
  if (!results.length && /anomaly|captcha|challenge/i.test(html)) throw new Error('ddg throttled');
  return results;
}

async function bing(query) {
  const html = await get(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=30&setlang=en`, { json: false, retries: 0, timeout: 10000, headers: { 'accept-language': 'en-US,en' } });
  const results = [];
  for (const block of html.split('<li class="b_algo"').slice(1)) {
    const a = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = a[1].replace(/&amp;/g, '&');
    const enc = url.match(/[?&]u=a1([^&]+)/)?.[1];
    if (enc) { try { url = Buffer.from(enc.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch {} }
    const snippet = strip(block.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1]).slice(0, 240);
    if (/^https?:\/\//.test(url)) results.push({ url, title: strip(a[2]), snippet });
  }
  if (!results.length && /captcha|unusual traffic/i.test(html)) throw new Error('bing throttled');
  return results;
}

async function sonar(query) {
  const j = await chat({
    model: SEARCH_MODEL, max_tokens: 1000,
    messages: [{ role: 'user', content: `${query}\n\nList every relevant result page as "title — URL", favoring canonical media pages (YouTube, Giphy, Tenor, Know Your Meme, Reddit, TikTok, X, imgflip, stock sites).` }],
  });
  const msg = j.choices?.[0]?.message || {};
  const seen = new Set(); const results = [];
  const add = (url, title = '') => { if (url && !seen.has(url)) { seen.add(url); results.push({ url, title }); } };
  for (const a of msg.annotations || []) add(a.url_citation?.url, a.url_citation?.title);
  for (const u of j.citations || []) add(typeof u === 'string' ? u : u?.url);
  for (const r of j.search_results || []) add(r.url, r.title);
  for (const m of String(msg.content || '').matchAll(/https?:\/\/[^\s)\]>"']+/g)) add(m[0].replace(/[.,;]+$/, ''));
  return results;
}

/** Returns { results: [{url, title, snippet?}], engine }. */
export async function webSearch(query) {
  if (process.env.SEARCH_BACKEND === 'sonar') return { results: await sonar(query), engine: 'sonar' };
  const free = await serial(async () => {
    // Checked inside the queue so requests waiting behind a throttled engine skip it immediately.
    for (const [name, fn] of [['ddg', ddg], ['bing', bing]]) {
      if (cooldown[name] > Date.now()) continue;
      try {
        const results = await fn(query);
        if (results.length) return { results, engine: name };
      } catch { cooldown[name] = Date.now() + 5 * 60000; }
    }
    return null;
  });
  if (free) return free;
  if (process.env.SEARCH_BACKEND === 'free') throw new Error('free search engines are throttled; use fetch_page on known listing pages');
  return { results: await sonar(query), engine: 'sonar' };
}

const asFn = (t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } });
const OR_TOOLS = [
  { type: 'function', function: { name: 'web_search', description: 'Search the web. Use many varied phrasings, languages and site: filters. Media results are auto-saved.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'fetch_page', description: 'Read a page and auto-harvest every media link on it (YouTube, Giphy, Tenor, TikTok, X, KYM, imgflip, stock). Best on listicles, compilations, KYM entries, subreddits, giphy.com/search/<term>, tenor.com/search/<term>-gifs, imgflip.com/memesearch?q=<term>.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  ...TOOLS.filter(t => !t.type).map(asFn),
];

const queryTags = (q) => String(q).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && !/^(site|gifs?|giphy|tenor|youtube|https?|www|reaction|search|explore)$/.test(w)).slice(0, 4);

export async function runOpenRouterDiscovery({ store, brief, maxTurns = 30, maxSearches = 25, maxFetches = 20, log = console.log }) {
  const messages = [
    { role: 'system', content: `${SYSTEM}\n\nThe harness auto-saves media links from your searches and fetched pages, so focus on breadth: many distinct queries, and fetch_page on list/search/compilation pages that hold dozens of items. You may still call save_media for items you identify with better titles/descriptions.` },
    { role: 'user', content: await briefPrompt(store, brief) },
  ];
  let saved = 0, turns = 0, searches = 0, fetches = 0, nudges = 0, summary = '';
  const seenUrls = new Set(); // fetch_page only accepts URLs that came from real results (stops invented YouTube IDs)
  const LISTING_OK = /(giphy|tenor)\.com\/(search|explore)\/|imgflip\.com\/memesearch|knowyourmeme\.com\/(memes|search)|reddit\.com\/r\/\w+\/?(top|hot)?\/?(\?.*)?$|wikipedia\.org\/wiki\//i;
  while (turns++ < maxTurns) {
    const j = await chat({ model: MODEL, messages, tools: OR_TOOLS, max_tokens: 8000 });
    const msg = j.choices?.[0]?.message;
    if (!msg) break;
    messages.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
    if (msg.content?.trim()) summary = msg.content.trim();
    if (process.env.DEBUG_AGENT) log(`  · ${JSON.stringify({ content: msg.content?.slice(0, 200), tools: msg.tool_calls?.map(t => t.function.name) })}`);
    if (!msg.tool_calls?.length) {
      // Small models like to stop early; push them on while budget remains.
      if (nudges++ < 6 && (searches < maxSearches * 0.8 || fetches < maxFetches * 0.8)) {
        messages.push({ role: 'user', content: `Not done: ${saved} saved so far; ${maxSearches - searches} searches and ${maxFetches - fetches} page fetches left. Keep going with new queries and fetch_page on the best listing pages. Do not stop until the budget is used.` });
        continue;
      }
      break;
    }
    const results = await Promise.all(msg.tool_calls.map(async (call) => {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { return { role: 'tool', tool_call_id: call.id, content: 'Error: arguments were not valid JSON' }; }
      let content;
      try {
        if (call.function.name === 'web_search') {
          if (++searches > maxSearches) content = 'Search budget exhausted. Use fetch_page or finish.';
          else {
            const r = await webSearch(String(args.query || ''));
            r.results.forEach(x => seenUrls.add(x.url));
            const n = await autoSave(store, r.results, 'agent:openrouter', ['agent', ...queryTags(args.query)]);
            saved += n;
            log(`  🔎 [${r.engine}] ${args.query} → ${r.results.length} results, ${n} new`);
            content = JSON.stringify({ results: r.results.slice(0, 25), auto_saved: n });
          }
        } else if (call.function.name === 'fetch_page') {
          if (++fetches > maxFetches) content = 'Fetch budget exhausted. Finish.';
          else {
            const url = String(args.url || '');
            if (!seenUrls.has(url) && !LISTING_OK.test(url)) {
              fetches--;
              return { role: 'tool', tool_call_id: call.id, content: 'Refused: only fetch URLs that appeared in your search results or fetched pages (or giphy/tenor search pages, imgflip memesearch, KYM, subreddits, Wikipedia). Never construct URLs.' };
            }
            const page = await fetchPage(url);
            page.media_links.forEach(u => seenUrls.add(u));
            const trusted = isPrimateListing(url);
            const n = await autoSave(store, page.media_links.map(u => ({ url: u, trusted })), 'agent:openrouter', ['agent', ...queryTags(url)]);
            saved += n;
            log(`  📄 ${url} → ${page.media_links.length} media links, ${n} new`);
            content = JSON.stringify({ title: page.title, description: page.description, media_links: page.media_links.slice(0, 40), auto_saved: n, text: page.text?.slice(0, 2500), error: page.direct_error && page.jina_error ? page.jina_error : undefined });
          }
        } else {
          const r = await handleClientTool(store, call.function.name, args, log);
          saved += r.inserted;
          content = r.content;
        }
      } catch (e) { content = `Error: ${e.message}`; log(`  ⚠ ${call.function.name}: ${e.message}`); }
      return { role: 'tool', tool_call_id: call.id, content };
    }));
    messages.push(...results);
    // Keep the context (and cost) bounded: older tool outputs have already been acted on.
    const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter(i => i >= 0);
    for (const i of toolIdx.slice(0, -6)) if (messages[i].content.length > 400) messages[i].content = messages[i].content.slice(0, 400) + ' …[trimmed]';
  }
  await store.logRun({ kind: 'discover', backend: 'openrouter', model: MODEL, brief, saved, turns, searches, fetches });
  return { saved, turns, summary };
}
