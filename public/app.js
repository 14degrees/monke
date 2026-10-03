const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TYPE_COLORS = { video: 'var(--video)', gif: 'var(--gif)', image: 'var(--image)', meme: 'var(--meme)', article: 'var(--article)', audio: 'var(--audio)', account: 'var(--account)' };

const state = { q: '', type: new Set(), source: new Set(), tag: new Set(), sort: 'new', page: 0, done: false, loading: false, items: [], total: 0, gen: 0 };

// ── URL <-> state ──
function readUrl() {
  const p = new URLSearchParams(location.search);
  state.q = p.get('q') || '';
  for (const k of ['type', 'source', 'tag']) state[k] = new Set((p.get(k) || '').split(',').filter(Boolean));
  state.sort = p.get('sort') || 'new';
  $('#q').value = state.q; $('#sort').value = state.sort;
}
function params() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  for (const k of ['type', 'source', 'tag']) if (state[k].size) p.set(k, [...state[k]].join(','));
  if (state.sort !== 'new') p.set('sort', state.sort);
  return p;
}
function writeUrl() { const s = params().toString(); history.replaceState(null, '', s ? `?${s}` : location.pathname); }

// ── data ──
async function api(path, opts = {}) {
  const tok = localStorageGet('monke-token');
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(tok ? { 'x-admin-token': tok } : {}), ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true;
  const gen = state.gen;
  const p = params(); p.set('page', state.page); p.set('limit', 60);
  try {
    const r = await api(`/api/media?${p}`);
    if (gen !== state.gen) return;
    state.total = r.total;
    state.items.push(...r.items);
    r.items.forEach((it, i) => $('#grid').append(card(it, state.items.length - r.items.length + i)));
    state.page++;
    if (state.sort === 'random' || r.items.length < 60) state.done = state.sort !== 'random' || !r.items.length;
    $('#count').textContent = `${state.total.toLocaleString()} items`;
    $('#sentinel').textContent = state.done ? (state.items.length ? '— end of the jungle —' : 'no monkeys match 🙈') : 'loading…';
  } catch (e) {
    $('#sentinel').textContent = `error: ${e.message}`;
  } finally { if (gen === state.gen) state.loading = false; }
}

function reset() {
  state.gen++; state.page = 0; state.done = false; state.loading = false; state.items = [];
  $('#grid').innerHTML = ''; writeUrl(); renderActive(); renderFacetState(); loadMore();
}

// ── cards ──
const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { thumbObserver.unobserve(e.target); resolveThumb(e.target); }
}, { rootMargin: '400px' });
let enrichQueue = Promise.resolve();
function resolveThumb(el) {
  const it = state.items[el.dataset.i];
  if (!it || it.thumb) return;
  // Serialize so we don't hammer the server; it fetches og:image for the page.
  enrichQueue = enrichQueue.then(async () => {
    try {
      const d = await api('/api/enrich', { method: 'POST', body: JSON.stringify({ key: it.key }) });
      Object.assign(it, d);
      if (d.thumb) el.replaceWith(card(it, Number(el.dataset.i)));
    } catch {}
  });
}

function card(it, i) {
  const el = document.createElement('article');
  el.className = 'card'; el.dataset.i = i;
  const c = TYPE_COLORS[it.media_type] || 'var(--muted)';
  const isVid = it.media_type === 'video' || it.embed?.kind === 'youtube';
  const hoverSrc = it.embed?.mp4 || (it.embed?.kind === 'video' ? it.embed.src : null);
  el.innerHTML = `
    <div class="media">${it.thumb
      ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(it.thumb)}" alt="${esc(it.title)}">`
      : `<div class="ph">${esc(it.title.slice(0, 90))}</div>`}
      ${isVid && !hoverSrc ? '<span class="play"></span>' : ''}
    </div>
    <div class="cap"><div class="t">${esc(it.title)}</div>
      <div class="b"><span class="dot" style="--c:${c}"></span>${esc(it.media_type)} · ${esc(it.source)}${it.year ? ` · ${it.year}` : ''}</div></div>`;
  const img = $('img', el);
  if (img) img.onerror = () => { img.replaceWith(Object.assign(document.createElement('div'), { className: 'ph', textContent: it.title.slice(0, 90) })); };
  if (hoverSrc && img) {
    el.addEventListener('mouseenter', () => {
      if ($('video', el)) return;
      const v = Object.assign(document.createElement('video'), { src: hoverSrc, muted: true, loop: true, playsInline: true, autoplay: true });
      v.oncanplay = () => v.classList.add('ready');
      $('.media', el).append(v);
    });
    el.addEventListener('mouseleave', () => $('video', el)?.remove());
  }
  if (!it.thumb) thumbObserver.observe(el);
  el.onclick = () => openLightbox(i);
  return el;
}

// ── lightbox ──
let lbIndex = -1;
function stageHtml(it) {
  const e = it.embed;
  if (e?.kind === 'youtube') return `<iframe src="${esc(e.src)}?autoplay=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  if (e?.kind === 'iframe') return `<iframe class="${/tiktok/.test(e.src) ? 'tall' : ''}" src="${esc(e.src)}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`;
  if (e?.mp4) return `<video src="${esc(e.mp4)}" autoplay loop muted playsinline controls poster="${esc(it.thumb || '')}"></video>`;
  if (e?.kind === 'video' || /\.(mp4|webm)(\?|$)/i.test(it.media_url || '')) return `<video src="${esc(e?.src || it.media_url)}" autoplay loop controls playsinline poster="${esc(it.thumb || '')}"></video>`;
  if (e?.src) return `<img referrerpolicy="no-referrer" src="${esc(e.src)}" alt="">`;
  if (it.media_url) return `<img referrerpolicy="no-referrer" src="${esc(it.media_url)}" alt="">`;
  if (it.thumb) return `<img referrerpolicy="no-referrer" src="${esc(it.thumb)}" alt="">`;
  return `<div class="ph">no preview — open the source ↗</div>`;
}
function openLightbox(i) {
  const it = state.items[i]; if (!it) return;
  lbIndex = i;
  $('#stage').innerHTML = stageHtml(it);
  const stImg = $('#stage img'); if (stImg) stImg.onerror = () => { if (it.thumb && stImg.src !== it.thumb) stImg.src = it.thumb; };
  $('#lbTitle').textContent = it.title;
  $('#lbBadges').innerHTML = [it.media_type, it.source, it.year, it.author && `by ${it.author}`, typeof it.score === 'number' && `★ ${it.score.toLocaleString()}`]
    .filter(Boolean).map(b => `<span class="badge">${esc(b)}</span>`).join('');
  $('#lbDesc').textContent = it.description || '';
  $('#lbTags').innerHTML = (it.tags || []).map(t => `<button class="chip" data-tag="${esc(t)}">#${esc(t)}</button>`).join('');
  $('#lbSource').href = it.url;
  $('#lbMedia').hidden = !it.media_url; if (it.media_url) $('#lbMedia').href = it.media_url;
  $('#lbVia').textContent = `found via ${(it.via || []).join(', ')}${it.discovered_at ? ` · ${new Date(it.discovered_at).toLocaleDateString()}` : ''}`;
  const lb = $('#lightbox'); if (!lb.open) lb.showModal();
  if (i >= state.items.length - 6) loadMore();
  if (!it.thumb && !it.embed && !it.og_checked) {
    api('/api/enrich', { method: 'POST', body: JSON.stringify({ key: it.key }) })
      .then(d => { Object.assign(it, d); if (lbIndex === i && (d.thumb || d.embed)) $('#stage').innerHTML = stageHtml(it); })
      .catch(() => {});
  }
}
function step(d) { const n = lbIndex + d; if (n >= 0 && n < state.items.length) openLightbox(n); }
$('#lightbox').addEventListener('close', () => { $('#stage').innerHTML = ''; });
$('#lightbox').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]') || e.target === e.currentTarget) $('#lightbox').close();
  if (e.target.closest('[data-prev]')) step(-1);
  if (e.target.closest('[data-next]')) step(1);
  const tag = e.target.closest('[data-tag]')?.dataset.tag;
  if (tag) { state.tag = new Set([tag]); $('#lightbox').close(); reset(); }
});
$('#lbCopy').onclick = async () => { try { await navigator.clipboard.writeText(state.items[lbIndex].url); $('#lbCopy').textContent = 'copied ✓'; setTimeout(() => ($('#lbCopy').textContent = 'copy link'), 1200); } catch {} };
document.addEventListener('keydown', (e) => {
  if (!$('#lightbox').open) { if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); } return; }
  if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1);
});

// ── facets ──
let facets = null;
function chip(kind, id, n) {
  const color = kind === 'type' ? ` data-type style="--c:${TYPE_COLORS[id] || 'var(--line)'}"` : '';
  return `<button class="chip" data-k="${kind}" data-v="${esc(id)}"${color}>${kind === 'tag' ? '#' : ''}${esc(id)}<small>${n}</small></button>`;
}
async function loadFacets() {
  facets = await api('/api/facets');
  $('#types').innerHTML = facets.types.map(t => chip('type', t._id, t.n)).join('');
  $('#sources').innerHTML = facets.sources.map(t => chip('source', t._id, t.n)).join('');
  $('#tags').innerHTML = facets.tags.map(t => chip('tag', t._id, t.n)).join('');
  renderFacetState();
}
function renderFacetState() {
  document.querySelectorAll('.filters .chip').forEach(b => b.classList.toggle('on', state[b.dataset.k]?.has(b.dataset.v)));
}
function renderActive() {
  const parts = [...state.type, ...state.source, ...[...state.tag].map(t => `#${t}`)];
  if (state.q) parts.unshift(`“${state.q}”`);
  $('#active').innerHTML = parts.length ? `${esc(parts.join(' + '))} <button id="clear">clear</button>` : '';
  $('#clear')?.addEventListener('click', () => { state.q = ''; $('#q').value = ''; state.type.clear(); state.source.clear(); state.tag.clear(); reset(); });
}
$('.filters').addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  const set = state[b.dataset.k];
  set.has(b.dataset.v) ? set.delete(b.dataset.v) : set.add(b.dataset.v);
  reset();
});

// ── controls ──
let qTimer;
$('#q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = $('#q').value.trim(); reset(); }, 280); });
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(qTimer); state.q = $('#q').value.trim(); reset(); });
$('#sort').onchange = () => { state.sort = $('#sort').value; reset(); };
const applySize = (v) => document.documentElement.style.setProperty('--tile', `${v}px`);
$('#size').value = localStorageGet('monke-size') || 240; applySize($('#size').value);
$('#size').oninput = () => { applySize($('#size').value); localStorageSet('monke-size', $('#size').value); };
new IntersectionObserver((e) => { if (e[0].isIntersecting) loadMore(); }, { rootMargin: '1200px' }).observe($('#sentinel'));

// ── admin panel ──
let pollTimer;
async function refreshAdmin() {
  try {
    const s = await api('/api/status');
    $('#adminStore').textContent = `store: ${s.store}${s.store === 'memory' ? ' (set MONGODB_URI to persist)' : ''} · agent ${s.agent ? 'ready' : 'needs ANTHROPIC_API_KEY'}` +
      `${s.running.scrape ? ' · scraping…' : ''}${s.running.discover ? ' · agent hunting…' : ''}`;
    $('#tokRow').hidden = !s.adminRequired;
    $('#scraperList').innerHTML = s.scrapers.map(x => `<span class="chip ${x.enabled ? '' : 'off'}" title="${x.enabled ? 'enabled' : 'missing API key'}">${x.name}</span>`).join('');
    $('#runAgent').disabled = !s.agent || s.running.discover; $('#runScrape').disabled = s.running.scrape;
    $('#log').textContent = s.log.join('\n') || s.runs.map(r => `${new Date(r.at).toLocaleString()} ${r.kind} ${r.scraper || r.brief || ''} → ${r.inserted ?? r.saved ?? 0} new`).join('\n') || '—';
  } catch (e) { $('#adminStore').textContent = e.message; }
}
$('#adminBtn').onclick = () => { $('#token').value = localStorageGet('monke-token') || ''; $('#admin').showModal(); refreshAdmin(); pollTimer = setInterval(refreshAdmin, 3000); };
$('#admin').addEventListener('close', () => { clearInterval(pollTimer); loadFacets().catch(() => {}); });
$('#admin').addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === e.currentTarget) $('#admin').close(); });
$('#token').onchange = () => localStorageSet('monke-token', $('#token').value);
const act = (fn) => async () => { try { await fn(); } catch (e) { alert(e.message); } refreshAdmin(); };
$('#runScrape').onclick = act(() => api('/api/scrape', { method: 'POST', body: '{}' }));
$('#runAgent').onclick = act(() => api('/api/discover', { method: 'POST', body: JSON.stringify({ brief: $('#brief').value }) }));
$('#addForm').onsubmit = (e) => { e.preventDefault(); act(async () => {
  await api('/api/add', { method: 'POST', body: JSON.stringify({ url: $('#addUrl').value, tags: $('#addTags').value.split(',').map(s => s.trim()).filter(Boolean) }) });
  $('#addUrl').value = ''; $('#addTags').value = ''; reset();
})(); };

readUrl();
renderActive();
loadFacets().catch(() => {});
loadMore();
