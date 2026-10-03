// Each scraper: { name, needs?: [ENV...], run(ctx) → AsyncIterable<raw[]> }
// raw = { url, title, media_type?, media_url?, thumb?, description?, tags?, score?, author?, created_at?, nsfw? }
import { get, decodeEntities, sleep } from '../lib/http.js';
import { PRIMATE_RE } from '../lib/normalize.js';

const env = (k) => process.env[k];
const q = encodeURIComponent;

// ───────────────────────────── Reddit ─────────────────────────────
export const SUBREDDITS = [
  'monkeys', 'MonkeyMemes', 'monke', 'ape', 'apes', 'Harambe', 'gorillas', 'chimpanzees', 'orangutan',
  'Monkeys_Doing_Things', 'babymonkeys', 'monkeysdoingthings', 'capuchinmonkey', 'baboons', 'Primates',
  'primatology', 'primatememes', 'SpiderMonkeys', 'marmoset', 'Lemurs', 'OrangutanGifs', 'gibbons', 'bonobos',
];
let redditToken = null;
async function redditAuth() {
  if (!env('REDDIT_CLIENT_ID')) return null;
  if (redditToken && redditToken.exp > Date.now()) return redditToken.token;
  const r = await get('https://www.reddit.com/api/v1/access_token', {
    method: 'POST', body: 'grant_type=client_credentials',
    headers: { authorization: 'Basic ' + Buffer.from(`${env('REDDIT_CLIENT_ID')}:${env('REDDIT_CLIENT_SECRET') || ''}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
  });
  redditToken = { token: r.access_token, exp: Date.now() + (r.expires_in - 60) * 1000 };
  return redditToken.token;
}
async function redditGet(pathAndQuery) {
  const token = await redditAuth();
  if (token) return get(`https://oauth.reddit.com${pathAndQuery}`, { headers: { authorization: `Bearer ${token}` } });
  return get(`https://www.reddit.com${pathAndQuery.replace(/^(\/[^?]+)/, '$1.json')}`);
}
function redditPost(p, via) {
  const d = p.data;
  if (d.is_self && !d.preview) return null;
  const preview = d.preview?.images?.[0];
  const gifVariant = preview?.variants?.gif?.source?.url;
  const mp4 = d.secure_media?.reddit_video?.fallback_url || d.preview?.reddit_video_preview?.fallback_url || preview?.variants?.mp4?.source?.url;
  const img = preview?.source?.url;
  const media_url = decodeEntities(mp4 || gifVariant || (/\.(jpe?g|png|gif|webp)$/i.test(d.url) ? d.url : img) || '') || undefined;
  const thumb = decodeEntities(preview?.resolutions?.slice(-2)[0]?.url || img || (d.thumbnail?.startsWith('http') ? d.thumbnail : '')) || undefined;
  const ext = d.url && !/reddit\.com|redd\.it/.test(d.url) ? d.url : null;
  return {
    url: `https://www.reddit.com${d.permalink}`,
    title: d.title, media_url, thumb,
    media_type: d.is_video || mp4 ? 'video' : /\.gif/i.test(media_url || '') || gifVariant ? 'gif' : media_url ? 'image' : 'article',
    description: ext ? `Links to ${ext}` : undefined,
    tags: [`r/${d.subreddit}`, d.link_flair_text].filter(Boolean),
    score: d.score, author: d.author, nsfw: d.over_18, created_at: d.created_utc * 1000, source: 'reddit', via,
  };
}
const reddit = {
  name: 'reddit',
  async *run({ pages = 3 }) {
    const listings = [];
    for (const sub of SUBREDDITS) for (const t of ['all', 'year', 'month']) listings.push(`/r/${sub}/top?t=${t}&limit=100`);
    for (const term of ['monkey', 'monke', 'monkey meme', 'chimp', 'baboon', 'gorilla', 'orangutan', 'harambe', 'ape'])
      for (const sub of ['memes', 'gifs', 'AnimalsBeingDerps', 'AnimalsBeingJerks', 'NatureIsFuckingLit', 'funny', 'videos', 'interestingasfuck', 'dankmemes', 'reactiongifs', 'HighQualityGifs', 'all'])
        listings.push(`/r/${sub}/search?q=${q(term)}&restrict_sr=1&sort=top&t=all&limit=100`);
    for (const base of listings) {
      let after = '';
      for (let i = 0; i < pages; i++) {
        let res;
        try { res = await redditGet(`${base}${after ? `&after=${after}` : ''}`); } catch (e) { console.warn('[reddit]', e.message); break; }
        const posts = res?.data?.children || [];
        const keepAll = /^\/r\/(?!memes|gifs|AnimalsBeing|NatureIs|funny|videos|interesting|dankmemes|reactiongifs|HighQuality|all)/.test(base);
        yield posts.filter(p => keepAll || PRIMATE_RE.test(p.data.title)).map(p => redditPost(p, `reddit:${base.split('?')[0]}`)).filter(Boolean);
        after = res?.data?.after;
        if (!after) break;
        await sleep(env('REDDIT_CLIENT_ID') ? 700 : 2200);
      }
    }
  },
};

// ───────────────────────── Wikimedia Commons ──────────────────────
const commons = {
  name: 'commons',
  async *run({ pages = 5 }) {
    const queries = ['monkey', 'chimpanzee', 'baboon', 'macaque', 'gorilla', 'orangutan', 'capuchin', 'bonobo', 'mandrill', 'gibbon',
      'Naruto monkey selfie', 'Harambe', 'snow monkey', 'proboscis monkey', 'monkey gif', 'primate video', 'Ham chimpanzee', 'Koko gorilla', 'Planet of the Apes', 'King Kong 1933'];
    for (const term of queries) {
      for (let p = 0; p < pages; p++) {
        const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrlimit=50&gsroffset=${p * 50}` +
          `&gsrsearch=${q(term)}&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=480`;
        let res; try { res = await get(url); } catch (e) { console.warn('[commons]', e.message); break; }
        const pagesObj = res?.query?.pages || {};
        yield Object.values(pagesObj).map(pg => {
          const ii = pg.imageinfo?.[0]; if (!ii) return null;
          const meta = ii.extmetadata || {};
          const mime = ii.mime || '';
          return {
            url: ii.descriptionurl, title: pg.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''),
            media_url: ii.url, thumb: ii.thumburl,
            media_type: mime.startsWith('video') ? 'video' : mime === 'image/gif' ? 'gif' : mime.startsWith('audio') ? 'audio' : 'image',
            description: decodeEntities((meta.ImageDescription?.value || '').replace(/<[^>]+>/g, '')).slice(0, 400) || undefined,
            tags: ['wikimedia', term, meta.LicenseShortName?.value].filter(Boolean), author: (meta.Artist?.value || '').replace(/<[^>]+>/g, '') || undefined,
            source: 'wikimedia',
          };
        }).filter(Boolean);
        if (!res.continue) break;
        await sleep(400);
      }
    }
  },
};

// ───────────────────────────── Giphy ──────────────────────────────
const giphy = {
  name: 'giphy', needs: ['GIPHY_API_KEY'],
  async *run({ terms, pages = 4 }) {
    for (const kind of ['gifs', 'stickers']) for (const term of terms) for (let p = 0; p < pages; p++) {
      let res; try { res = await get(`https://api.giphy.com/v1/${kind}/search?api_key=${env('GIPHY_API_KEY')}&q=${q(term)}&limit=50&offset=${p * 50}&rating=r`); } catch (e) { console.warn('[giphy]', e.message); break; }
      yield (res.data || []).map(g => ({
        url: g.url, title: g.title || term, media_type: 'gif', media_url: g.images?.original?.url, thumb: g.images?.fixed_width?.url,
        tags: ['giphy', term, kind === 'stickers' ? 'sticker' : null].filter(Boolean), author: g.username || undefined, created_at: g.import_datetime, source: 'giphy',
      }));
      if ((res.pagination?.total_count ?? 0) <= (p + 1) * 50) break;
    }
  },
};

// ───────────────────────────── Tenor ──────────────────────────────
const tenor = {
  name: 'tenor', needs: ['TENOR_API_KEY'],
  async *run({ terms, pages = 4 }) {
    for (const term of terms) { let pos = '';
      for (let p = 0; p < pages; p++) {
        let res; try { res = await get(`https://tenor.googleapis.com/v2/search?key=${env('TENOR_API_KEY')}&client_key=monke&q=${q(term)}&limit=50&media_filter=gif,tinygif,mp4${pos ? `&pos=${pos}` : ''}`); } catch (e) { console.warn('[tenor]', e.message); break; }
        yield (res.results || []).map(r => ({
          url: r.itemurl, title: r.content_description || term, media_type: 'gif', media_url: r.media_formats?.gif?.url, thumb: r.media_formats?.tinygif?.url,
          tags: ['tenor', term, ...(r.tags || [])], created_at: r.created * 1000, source: 'tenor',
        }));
        pos = res.next; if (!pos) break;
      }
    }
  },
};

// ──────────────────────────── YouTube ─────────────────────────────
// With YOUTUBE_API_KEY uses the Data API; otherwise parses ytInitialData from the results page.
const YT_QUERIES = [
  'monkey meme', 'monkey on phone', 'baboon cell phone', 'chimp in office', 'monkey in suit commercial', 'careerbuilder chimps commercial',
  'etrade monkey commercial', '90s commercial monkey', 'japanese commercial monkey', 'monkey selfie', 'harambe', 'monkey puppet meme',
  'return to monke', 'funny monkey compilation', 'monkey dancing', 'monkeys spinning monkeys', 'baby monkey on a pig', 'snow monkeys hot spring',
  'lopburi monkeys', 'monkey steals phone', 'ikea monkey', 'punch monkey plush', 'chimp memory test ayumu', 'gorilla chest beat', 'orangutan laughing',
  'monkey asmr', 'monkey mukbang', 'drunk monkeys st kitts', 'planet of the apes scene', 'king kong scene', '2001 dawn of man', 'curious george theme',
  'monkey shorts', 'ape together strong', 'uh oh stinky', 'monkey thinking meme', 'monkey pfff meme', 'almost kissing monkey', 'monkey with headphones',
];
const youtube = {
  name: 'youtube',
  async *run({ pages = 2 }) {
    for (const term of YT_QUERIES) {
      if (env('YOUTUBE_API_KEY')) {
        let token = '';
        for (let p = 0; p < pages; p++) {
          let res; try { res = await get(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=50&q=${q(term)}&key=${env('YOUTUBE_API_KEY')}${token ? `&pageToken=${token}` : ''}`); } catch (e) { console.warn('[youtube]', e.message); break; }
          yield (res.items || []).map(it => ({
            url: `https://www.youtube.com/watch?v=${it.id.videoId}`, title: decodeEntities(it.snippet.title), media_type: 'video',
            description: decodeEntities(it.snippet.description), thumb: it.snippet.thumbnails?.high?.url, author: it.snippet.channelTitle,
            created_at: it.snippet.publishedAt, tags: ['youtube', term], source: 'youtube',
          }));
          token = res.nextPageToken; if (!token) break;
        }
      } else {
        let html; try { html = await get(`https://www.youtube.com/results?search_query=${q(term)}&hl=en`, { json: false, headers: { 'accept-language': 'en-US' } }); } catch (e) { console.warn('[youtube]', e.message); continue; }
        const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
        if (!m) continue;
        const out = []; const seen = new Set();
        (function walk(o) {
          if (!o || typeof o !== 'object') return;
          const v = o.videoRenderer || o.reelItemRenderer || o.shortsLockupViewModel;
          const id = v?.videoId || v?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
          if (id && !seen.has(id)) {
            seen.add(id);
            const title = v.title?.runs?.map(r => r.text).join('') || v.headline?.simpleText || v.overlayMetadata?.primaryText?.content || term;
            out.push({ url: `https://www.youtube.com/watch?v=${id}`, title, media_type: 'video', author: v.ownerText?.runs?.[0]?.text, tags: ['youtube', term], source: 'youtube' });
          }
          for (const k in o) walk(o[k]);
        })(JSON.parse(m[1]));
        yield out;
        await sleep(1500);
      }
    }
  },
};

// ──────────────────────────── Openverse ───────────────────────────
const openverse = {
  name: 'openverse',
  async *run({ terms, pages = 3 }) {
    for (const kind of ['images', 'audio']) for (const term of kind === 'audio' ? ['monkey', 'chimpanzee', 'gorilla', 'howler monkey'] : terms) for (let p = 1; p <= pages; p++) {
      let res; try { res = await get(`https://api.openverse.org/v1/${kind}/?q=${q(term)}&page_size=20&page=${p}`); } catch (e) { console.warn('[openverse]', e.message); break; }
      yield (res.results || []).map(r => ({
        url: r.foreign_landing_url || r.url, title: r.title || term, media_url: r.url, thumb: r.thumbnail,
        media_type: kind === 'audio' ? 'audio' : /\.gif/i.test(r.url) ? 'gif' : 'image', author: r.creator, tags: ['openverse', term, r.license, ...(r.tags || []).map(t => t.name)].filter(Boolean),
      }));
      if (p >= (res.page_count || 0)) break;
      await sleep(1100);
    }
  },
};

// ─────────────────────────── iNaturalist ──────────────────────────
const inaturalist = {
  name: 'inaturalist',
  async *run({ pages = 5 }) {
    for (let p = 1; p <= pages; p++) {
      let res; try { res = await get(`https://api.inaturalist.org/v1/observations?taxon_name=Primates&photos=true&quality_grade=research&order_by=votes&per_page=200&page=${p}`); } catch (e) { console.warn('[inaturalist]', e.message); break; }
      yield (res.results || []).map(o => {
        const ph = o.photos?.[0]; if (!ph) return null;
        return {
          url: `https://www.inaturalist.org/observations/${o.id}`, title: o.taxon?.preferred_common_name || o.taxon?.name || 'Primate',
          media_type: 'image', media_url: ph.url.replace('square', 'large'), thumb: ph.url.replace('square', 'medium'),
          tags: ['inaturalist', 'wild', o.taxon?.name, o.taxon?.preferred_common_name].filter(Boolean), score: o.faves_count, author: o.user?.login, created_at: o.observed_on, source: 'inaturalist',
        };
      }).filter(Boolean);
      await sleep(1000);
    }
  },
};

// ─────────────────────────── Internet Archive ─────────────────────
const archive = {
  name: 'archive',
  async *run({ pages = 3 }) {
    const queries = ['monkey commercial', 'chimpanzee commercial', 'monkey', 'chimp', 'gorilla', 'baboon', 'king kong', 'planet of the apes', 'monkey cartoon', 'space monkey'];
    for (const term of queries) for (let p = 1; p <= pages; p++) {
      const url = `https://archive.org/advancedsearch.php?q=${q(`(${term}) AND mediatype:(movies OR image)`)}&fl[]=identifier&fl[]=title&fl[]=mediatype&fl[]=year&fl[]=downloads&fl[]=description&sort[]=downloads+desc&rows=100&page=${p}&output=json`;
      let res; try { res = await get(url); } catch (e) { console.warn('[archive]', e.message); break; }
      const docs = res?.response?.docs || [];
      yield docs.filter(d => PRIMATE_RE.test(`${d.title} ${[].concat(d.description || '').join(' ')}`)).map(d => ({
        url: `https://archive.org/details/${d.identifier}`, title: [].concat(d.title)[0], media_type: d.mediatype === 'movies' ? 'video' : 'image',
        thumb: `https://archive.org/services/img/${d.identifier}`, year: Number.parseInt(d.year) || undefined, score: d.downloads,
        description: String([].concat(d.description || '')[0] || '').replace(/<[^>]+>/g, '').slice(0, 300) || undefined, tags: ['archive.org', term], source: 'archive',
      }));
      if (docs.length < 100) break;
    }
  },
};

// ──────────────────────────── Imgur ───────────────────────────────
const imgur = {
  name: 'imgur', needs: ['IMGUR_CLIENT_ID'],
  async *run({ terms, pages = 3 }) {
    for (const term of terms) for (let p = 0; p < pages; p++) {
      let res; try { res = await get(`https://api.imgur.com/3/gallery/search/top/all/${p}?q=${q(term)}`, { headers: { authorization: `Client-ID ${env('IMGUR_CLIENT_ID')}` } }); } catch (e) { console.warn('[imgur]', e.message); break; }
      yield (res.data || []).map(g => {
        const im = g.is_album ? g.images?.[0] : g; if (!im) return null;
        const media = im.mp4 || im.link;
        return {
          url: g.link, title: g.title || term, media_url: media, thumb: im.link && !im.animated ? im.link.replace(/(\.\w+)$/, 'm$1') : undefined,
          media_type: im.animated ? (im.has_sound ? 'video' : 'gif') : 'image', score: g.score, nsfw: g.nsfw, tags: ['imgur', term, ...(g.tags || []).map(t => t.name)], source: 'imgur',
        };
      }).filter(Boolean);
      if (!res.data?.length) break;
    }
  },
};

// ─────────────────────────── Pixabay / Pexels ─────────────────────
const pixabay = {
  name: 'pixabay', needs: ['PIXABAY_API_KEY'],
  async *run({ terms, pages = 2 }) {
    for (const kind of ['', 'videos/']) for (const term of terms.slice(0, 16)) for (let p = 1; p <= pages; p++) {
      let res; try { res = await get(`https://pixabay.com/api/${kind}?key=${env('PIXABAY_API_KEY')}&q=${q(term)}&per_page=200&page=${p}&safesearch=true`); } catch (e) { console.warn('[pixabay]', e.message); break; }
      yield (res.hits || []).map(h => kind ? {
        url: h.pageURL, title: h.tags || term, media_type: 'video', media_url: h.videos?.medium?.url, thumb: h.videos?.tiny?.thumbnail || h.videos?.medium?.thumbnail,
        tags: ['pixabay', 'stock', ...String(h.tags).split(', ')], score: h.likes, author: h.user, source: 'pixabay',
      } : {
        url: h.pageURL, title: h.tags || term, media_type: 'image', media_url: h.largeImageURL, thumb: h.webformatURL,
        tags: ['pixabay', 'stock', ...String(h.tags).split(', ')], score: h.likes, author: h.user, source: 'pixabay',
      });
      if ((res.totalHits || 0) <= p * 200) break;
    }
  },
};
const pexels = {
  name: 'pexels', needs: ['PEXELS_API_KEY'],
  async *run({ terms, pages = 2 }) {
    for (const kind of ['v1/search', 'videos/search']) for (const term of terms.slice(0, 16)) for (let p = 1; p <= pages; p++) {
      let res; try { res = await get(`https://api.pexels.com/${kind}?query=${q(term)}&per_page=80&page=${p}`, { headers: { authorization: env('PEXELS_API_KEY') } }); } catch (e) { console.warn('[pexels]', e.message); break; }
      yield (res.photos || res.videos || []).map(x => x.video_files ? {
        url: x.url, title: x.url.split('/').filter(Boolean).pop().replace(/-\d+$/, '').replace(/-/g, ' ') || term, media_type: 'video',
        media_url: x.video_files.find(f => f.quality === 'sd')?.link || x.video_files[0]?.link, thumb: x.image, author: x.user?.name, tags: ['pexels', 'stock', term], source: 'pexels',
      } : {
        url: x.url, title: x.alt || term, media_type: 'image', media_url: x.src?.large2x, thumb: x.src?.medium, author: x.photographer, tags: ['pexels', 'stock', term], source: 'pexels',
      });
      if (!res.next_page) break;
    }
  },
};

// ───────────────────────────── Lemmy ──────────────────────────────
const lemmy = {
  name: 'lemmy',
  async *run({ pages = 3 }) {
    for (const host of ['lemmy.world', 'lemmy.ml', 'sh.itjust.works']) for (const term of ['monkey', 'monke', 'chimp', 'gorilla', 'ape', 'orangutan', 'baboon']) for (let p = 1; p <= pages; p++) {
      let res; try { res = await get(`https://${host}/api/v3/search?q=${q(term)}&type_=Posts&sort=TopAll&limit=50&page=${p}`); } catch (e) { console.warn('[lemmy]', e.message); break; }
      const posts = res.posts || [];
      yield posts.filter(x => x.post.url && PRIMATE_RE.test(x.post.name)).map(x => ({
        url: x.post.ap_id || x.post.url, title: x.post.name, media_url: x.post.url, thumb: x.post.thumbnail_url, score: x.counts?.score, nsfw: x.post.nsfw,
        tags: ['lemmy', `c/${x.community?.name}`], created_at: x.post.published, source: 'lemmy',
      }));
      if (posts.length < 50) break;
    }
  },
};

// ───────────────────────── Know Your Meme ─────────────────────────
const knowyourmeme = {
  name: 'knowyourmeme',
  async *run({ pages = 3 }) {
    for (const term of ['monkey', 'monke', 'ape', 'chimp', 'chimpanzee', 'gorilla', 'baboon', 'orangutan', 'harambe', 'macaque', 'primate']) for (let p = 1; p <= pages; p++) {
      let html; try { html = await get(`https://knowyourmeme.com/search?context=entries&page=${p}&q=${q(term)}`, { json: false }); } catch (e) { console.warn('[kym]', e.message); break; }
      const out = []; const seen = new Set();
      for (const m of html.matchAll(/<a[^>]+href="(\/memes\/[a-z0-9-]+(?:--\d+)?)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const href = m[1]; if (seen.has(href) || /\/memes\/(all|popular|trending|submissions|researching|confirmed)/.test(href)) continue;
        const img = m[2].match(/(?:data-src|src)="(https:\/\/i\.kym-cdn\.com[^"]+)"/)?.[1];
        const alt = decodeEntities(m[2].match(/alt="([^"]+)"/)?.[1] || m[2].replace(/<[^>]+>/g, '').trim());
        if (!alt) continue;
        seen.add(href);
        out.push({ url: `https://knowyourmeme.com${href}`, title: alt, thumb: img?.replace('/masonry/', '/original/'), media_type: 'meme', tags: ['knowyourmeme', 'meme', term], source: 'knowyourmeme' });
      }
      yield out;
      if (!out.length) break;
      await sleep(2500);
    }
  },
};

// ───────────────────────────── Flickr ─────────────────────────────
const flickr = {
  name: 'flickr',
  async *run() {
    for (const tag of ['monkey', 'chimpanzee', 'gorilla', 'baboon', 'macaque', 'orangutan', 'capuchin', 'monkeymeme', 'snowmonkey', 'mandrill']) {
      let res; try { res = await get(`https://www.flickr.com/services/feeds/photos_public.gne?tags=${tag}&format=json&nojsoncallback=1`); } catch (e) { console.warn('[flickr]', e.message); continue; }
      yield (res.items || []).map(it => ({
        url: it.link, title: it.title || tag, media_type: 'image', media_url: it.media?.m?.replace('_m.', '_b.'), thumb: it.media?.m?.replace('_m.', '_n.'),
        author: it.author?.match(/"(.*)"/)?.[1], tags: ['flickr', ...String(it.tags || '').split(' ').slice(0, 10)], created_at: it.published, source: 'flickr',
      }));
    }
  },
};

export const SCRAPERS = { reddit, youtube, commons, giphy, tenor, openverse, inaturalist, archive, imgur, pixabay, pexels, lemmy, knowyourmeme, flickr };
