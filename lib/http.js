const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 monke-archiver/0.1';

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** fetch with timeout, UA, and backoff on 429/5xx. Returns parsed JSON or text. */
export async function get(url, { json = true, headers = {}, retries = 3, timeout = 20000, method = 'GET', body } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { method, body, headers: { 'user-agent': UA, accept: json ? 'application/json' : 'text/html,*/*', ...headers }, signal: ctrl.signal, redirect: 'follow' });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt;
        await sleep(Math.min(wait, 60000));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return json ? await res.json() : await res.text();
    } catch (e) {
      if (attempt >= retries || /HTTP 4\d\d/.test(e.message)) throw e;
      await sleep(1500 * 2 ** attempt);
    } finally {
      clearTimeout(t);
    }
  }
}

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/** Pull og:/twitter: metadata out of an HTML page. */
export function extractMeta(html, baseUrl) {
  const pick = (...names) => {
    for (const n of names) {
      const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*>`, 'i');
      const tag = html.match(re)?.[0];
      const c = tag?.match(/content=["']([^"']*)["']/i)?.[1];
      if (c) return decodeEntities(c);
    }
    return null;
  };
  const abs = (u) => { try { return u ? new URL(u, baseUrl).href : null; } catch { return null; } };
  return {
    title: pick('og:title', 'twitter:title') || decodeEntities(html.match(/<title[^>]*>([^<]*)/i)?.[1] || '').trim() || null,
    description: pick('og:description', 'twitter:description', 'description'),
    image: abs(pick('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src')),
    video: abs(pick('og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream')),
  };
}
