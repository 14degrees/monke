// Turns any scraped/discovered record into one canonical media document.
// Derives a dedupe key, an embeddable player, and a thumbnail wherever the URL alone allows it.

const MEDIA_TYPES = new Set(['video', 'gif', 'image', 'meme', 'article', 'audio', 'account']);

export function youtubeId(url) {
  const m = String(url).match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/,
  );
  return m ? m[1] : null;
}

export function giphyId(url) {
  const u = String(url);
  let m = u.match(/giphy\.com\/(?:gifs|stickers|clips)\/(?:[\w-]*-)?([A-Za-z0-9]{8,})(?:[/?#]|$)/);
  if (m) return m[1];
  m = u.match(/media\d?\.giphy\.com\/media\/(?:v1\.[^/]+\/)?([A-Za-z0-9]+)\//);
  return m ? m[1] : null;
}

export function tenorId(url) {
  const m = String(url).match(/tenor\.com\/(?:[A-Za-z-]+\/)?view\/[\w%-]*?-(\d{6,})(?:[/?#]|$)/);
  return m ? m[1] : null;
}

export function sourceFromUrl(url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\.|^m\.|^old\./, ''); } catch { return 'other'; }
  const map = [
    [/youtube\.com|youtu\.be/, 'youtube'], [/knowyourmeme\.com/, 'knowyourmeme'], [/giphy\.com/, 'giphy'],
    [/tenor\.com/, 'tenor'], [/reddit\.com|redd\.it/, 'reddit'], [/tiktok\.com/, 'tiktok'],
    [/twitter\.com|x\.com/, 'x'], [/instagram\.com/, 'instagram'], [/imgflip\.com/, 'imgflip'],
    [/wikipedia\.org/, 'wikipedia'], [/wikimedia\.org/, 'wikimedia'], [/gettyimages\./, 'getty'],
    [/shutterstock\.com/, 'shutterstock'], [/pond5\.com/, 'pond5'], [/imgur\.com/, 'imgur'],
    [/imdb\.com/, 'imdb'], [/archive\.org/, 'archive'], [/flickr\.com/, 'flickr'],
    [/pixabay\.com/, 'pixabay'], [/pexels\.com/, 'pexels'], [/inaturalist\.org/, 'inaturalist'],
    [/openverse\.org/, 'openverse'], [/vimeo\.com/, 'vimeo'], [/facebook\.com|fb\.watch/, 'facebook'],
    [/alamy\.com/, 'alamy'], [/storyblocks\.com/, 'storyblocks'], [/newgrounds\.com/, 'newgrounds'],
    [/9gag\.com/, '9gag'], [/tumblr\.com/, 'tumblr'], [/bsky\.app/, 'bluesky'], [/lemmy|kbin/, 'lemmy'],
  ];
  for (const [re, name] of map) if (re.test(host)) return name;
  return host || 'other';
}

/** Stable dedupe key: same video/gif from different URL shapes collapses to one record. */
export function canonicalKey(url) {
  const yt = youtubeId(url);
  if (yt) return `youtube:${yt}`;
  const gf = giphyId(url);
  if (gf) return `giphy:${gf}`;
  const tn = tenorId(url);
  if (tn) return `tenor:${tn}`;
  const rd = String(url).match(/reddit\.com\/r\/\w+\/comments\/(\w+)/);
  if (rd) return `reddit:${rd[1]}`;
  try {
    const u = new URL(url);
    const drop = /^(utm_|fbclid|gclid|si$|feature$|ref$|igsh|s$|t$)/;
    for (const k of [...u.searchParams.keys()]) if (drop.test(k)) u.searchParams.delete(k);
    u.hash = '';
    const host = u.hostname.replace(/^(www|m|old|mobile)\./, '').replace(/^twitter\.com$/, 'x.com');
    return `${host}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
  } catch {
    return String(url).trim().toLowerCase();
  }
}

function isDirectImage(url) { return /\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(url || ''); }
function isDirectVideo(url) { return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url || ''); }

/** Best-effort embed descriptor the browser can render without hitting our server. */
export function deriveEmbed(doc) {
  const url = doc.url;
  const yt = youtubeId(url);
  if (yt) return { kind: 'youtube', id: yt, src: `https://www.youtube-nocookie.com/embed/${yt}` };
  const gf = giphyId(url) || giphyId(doc.media_url);
  if (gf) return { kind: 'gif', id: gf, src: `https://media.giphy.com/media/${gf}/giphy.gif`, mp4: `https://media.giphy.com/media/${gf}/giphy.mp4` };
  const tn = tenorId(url);
  if (tn && !doc.media_url) return { kind: 'iframe', src: `https://tenor.com/embed/${tn}` };
  const m = doc.media_url;
  if (isDirectVideo(m)) return { kind: 'video', src: m };
  if (m && /\.gif(\?|$)/i.test(m)) return { kind: 'gif', src: m };
  if (isDirectImage(m)) return { kind: 'image', src: m };
  if (isDirectVideo(url)) return { kind: 'video', src: url };
  if (isDirectImage(url)) return { kind: /\.gif/i.test(url) ? 'gif' : 'image', src: url };
  const tt = String(url).match(/tiktok\.com\/@[\w.-]+\/video\/(\d+)/);
  if (tt) return { kind: 'iframe', src: `https://www.tiktok.com/embed/v2/${tt[1]}` };
  const vm = String(url).match(/vimeo\.com\/(\d+)/);
  if (vm) return { kind: 'iframe', src: `https://player.vimeo.com/video/${vm[1]}` };
  return null;
}

export function deriveThumb(doc) {
  if (doc.thumb) return doc.thumb;
  const yt = youtubeId(doc.url);
  if (yt) return `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`;
  const gf = giphyId(doc.url) || giphyId(doc.media_url);
  if (gf) return `https://media.giphy.com/media/${gf}/200w.gif`;
  if (isDirectImage(doc.media_url)) return doc.media_url;
  if (isDirectImage(doc.url)) return doc.url;
  return null;
}

function cleanTags(tags) {
  const out = new Set();
  for (const t of tags || []) {
    const s = String(t).toLowerCase().trim().replace(/^#/, '').replace(/\s+/g, ' ');
    if (s && s.length <= 40) out.add(s);
  }
  return [...out].slice(0, 30);
}

/**
 * @param {object} raw  {url, title, media_type?, source?, media_url?, thumb?, description?, tags?, year?, score?, author?, nsfw?, created_at?}
 * @param {string} via  which collector produced it, e.g. "reddit:r/monkeys", "swarm:memes", "agent"
 */
export function normalize(raw, via) {
  if (!raw || !raw.url || !/^https?:\/\//i.test(raw.url)) return null;
  const url = raw.url.trim();
  const doc = {
    key: canonicalKey(url),
    url,
    title: String(raw.title || '').trim().slice(0, 300) || url,
    description: raw.description ? String(raw.description).trim().slice(0, 1000) : undefined,
    media_url: raw.media_url || undefined,
    thumb: raw.thumb || undefined,
    source: raw.source || sourceFromUrl(url),
    tags: cleanTags(raw.tags),
    year: Number.isInteger(raw.year) ? raw.year : undefined,
    score: typeof raw.score === 'number' ? raw.score : undefined,
    author: raw.author || undefined,
    nsfw: raw.nsfw ? true : undefined,
    created_at: raw.created_at ? new Date(raw.created_at) : undefined,
  };
  doc.embed = deriveEmbed(doc) || undefined;
  doc.thumb = deriveThumb(doc) || undefined;
  let type = raw.media_type && MEDIA_TYPES.has(raw.media_type) ? raw.media_type : null;
  if (!type) {
    const k = doc.embed?.kind;
    type = k === 'youtube' || k === 'video' ? 'video' : k === 'gif' ? 'gif' : k === 'image' ? 'image' : 'article';
  }
  doc.media_type = type;
  doc.via = [via];
  for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
  return doc;
}

export const SEARCH_TERMS = [
  'monkey', 'monke', 'ape', 'chimpanzee', 'chimp', 'baboon', 'macaque', 'gorilla', 'orangutan',
  'capuchin', 'bonobo', 'gibbon', 'mandrill', 'lemur', 'spider monkey', 'snow monkey', 'proboscis monkey',
  'monkey meme', 'monkey reaction', 'monkey on phone', 'monkey in suit', 'monkey funny', 'harambe',
  'monkey puppet', 'return to monke', 'thinking monkey', 'chimp office', 'baboon phone', 'monkey dancing',
  'monkey selfie', 'ape meme', 'gorilla meme', 'orangutan funny', 'monkey commercial',
];

export const PRIMATE_RE = /\b(monke?y?s?|monke|apes?|chimps?|chimpanzees?|baboons?|macaques?|gorillas?|orangutans?|orang-utans?|capuchins?|bonobos?|gibbons?|mandrills?|lemurs?|primates?|harambe|marmosets?|tamarins?|simians?|kong)\b/i;
