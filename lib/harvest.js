// Page harvesting shared by the OpenRouter agent and the keyless `harvest` scraper:
// fetch a page (direct, then r.jina.ai fallback), pull out every media-item link, and keep the primate ones.
import { get, extractMeta, decodeEntities } from './http.js';
import { normalize, PRIMATE_RE } from './normalize.js';

export const MEDIA_LINK = /youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/|giphy\.com\/(gifs|clips|stickers)\/|tenor\.com\/([a-z-]+\/)?view\/|knowyourmeme\.com\/(memes|photos|videos)\/[a-z0-9]|tiktok\.com\/@[^/]+\/video\/|(x|twitter)\.com\/\w+\/status\/\d+|instagram\.com\/(p|reel)\/|reddit\.com\/r\/\w+\/comments\/|imgflip\.com\/(i\/|memegenerator\/)|gettyimages\.[a-z.]+\/detail\/|shutterstock\.com\/(image|video)-|pond5\.com\/stock-|\.(mp4|gif|webm)(\?|$)/i;

const MEDIA_HOST = /(youtube\.com|youtu\.be|giphy\.com|tenor\.com|knowyourmeme\.com|tiktok\.com|imgflip\.com|reddit\.com|x\.com|twitter\.com|instagram\.com|gettyimages\.|shutterstock\.com|pond5\.com|alamy\.com|storyblocks\.com|stock\.adobe\.com|istockphoto\.com|dreamstime\.com|imgur\.com|vimeo\.com|dailymotion\.com|archive\.org|wikimedia\.org|newgrounds\.com)/i;
const LISTING = /\/(search|explore|tags?|hashtag|results|trending)\b|search_query=|[?&]q=|\/c\/|\/channel\/|\/user\/|\/@[^/]+\/?$/i;
const CDN_FILE = /^https?:\/\/(media\d?|i)\.(giphy|tenor)\.com\/|^https?:\/\/i\.kym-cdn\.com\/|^https?:\/\/i\.imgflip\.com\//i;
const JUNK = /\.(css|js|svg|ico|woff2?)(\?|$)|\/(static|assets|_next)\/|giphy\.com\/(gifs|stickers)\/?$|\/embed\/?$/i;

export function slugTitle(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).filter(x => !/^(view|gifs|memes|photos|videos|i|detail|photo|video|stock-footage|memegenerator|\d+)$/.test(x)).pop() || u.hostname;
    return decodeURIComponent(seg).replace(/\.(gif|mp4|webm|jpe?g|png|webp)$/i, '').replace(/[-_]+/g, ' ').replace(/\b(gif|gifs)\b\s*\d*$/i, '').replace(/\b[a-z0-9]{12,}\b/gi, '').replace(/\b\d{6,}\b/g, '').replace(/\s+/g, ' ').trim() || url;
  } catch { return url; }
}

function absLinks(html, base) {
  const out = new Set();
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) out.add(m[0]);
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/g)) { try { out.add(new URL(decodeEntities(m[1]), base).href); } catch {} }
  return [...out].map(u => u.replace(/&amp;/g, '&').replace(/[.,;]+$/, '')).filter(u => !JUNK.test(u));
}

/** Read a page: title, og tags, media-item links, image urls and (when Jina was used) text. */
export async function fetchPage(url, { jina = 'fallback' } = {}) {
  const out = { url, media_links: [] };
  if (jina !== 'only') {
    try {
      const html = await get(url, { json: false, retries: 1, timeout: 15000 });
      Object.assign(out, extractMeta(html, url));
      out.media_links = absLinks(html, url).filter(u => MEDIA_LINK.test(u) && u !== url);
    } catch (e) { out.direct_error = e.message; }
  }
  if (jina === 'only' || (jina === 'fallback' && (out.media_links.length < 3 || !out.title))) {
    try {
      const md = await get(`https://r.jina.ai/${url}`, {
        json: false, retries: 1, timeout: 45000,
        headers: { accept: 'text/plain', 'x-with-links-summary': 'true', 'x-with-images-summary': 'true', ...(process.env.JINA_API_KEY ? { authorization: `Bearer ${process.env.JINA_API_KEY}` } : {}) },
      });
      out.title ||= md.match(/^Title:\s*(.+)$/m)?.[1];
      const links = absLinks(md, url);
      out.media_links = [...new Set([...out.media_links, ...links.filter(u => MEDIA_LINK.test(u) && u !== url)])];
      out.images = [...new Set(links.filter(u => /\.(jpe?g|png|webp|gif)(\?|$)/i.test(u)))].slice(0, 20);
      out.text = md.slice(0, 6000);
    } catch (e) { out.jina_error = e.message; }
  }
  out.media_links = [...new Set(out.media_links)].slice(0, 150);
  return out;
}

/** Turn candidate links into normalized docs (primate-relevant media items only). */
export function harvestDocs(candidates, via, tags = []) {
  const docs = [];
  for (const c of candidates) {
    if (!c.url || (!MEDIA_LINK.test(c.url) && !MEDIA_HOST.test(c.url))) continue;
    if (LISTING.test(c.url) && !MEDIA_LINK.test(c.url)) continue;
    if (CDN_FILE.test(c.url)) continue; // raw gif/mp4 files: the canonical item page is linked alongside
    const slug = slugTitle(c.url);
    const title = (c.title || (slug === c.url || slug.length < 3 ? `${tags.filter(t => t !== 'agent').join(' ')} gif`.trim() : slug)).replace(/\s*[-|–]\s*(Find & Share on GIPHY|GIPHY|Tenor|YouTube|Know Your Meme|Imgflip|TikTok|Getty Images)\s*$/i, '').trim();
    if (!c.trusted && !PRIMATE_RE.test(`${title} ${c.url.replace(/[-_/]/g, ' ')}`)) continue;
    const d = normalize({ url: c.url, title, description: c.snippet || undefined, tags }, via);
    if (d) docs.push(d);
  }
  return docs;
}

export async function autoSave(store, candidates, via, tags) {
  const docs = harvestDocs(candidates, via, tags);
  return docs.length ? (await store.upsertMany(docs)).inserted : 0;
}

/** A listing page is "all primate" when it's a gif-site search/explore page for a primate term. */
export function isPrimateListing(url) {
  return /(giphy|tenor)\.com\/(explore|search)\//i.test(url) && PRIMATE_RE.test(decodeURIComponent(url).replace(/[-_/]/g, ' '));
}
