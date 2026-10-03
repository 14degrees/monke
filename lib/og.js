// Resolve a thumbnail (and playable media, if exposed) for a page URL via its og:/twitter: tags.
import { get, extractMeta } from './http.js';
import { deriveEmbed } from './normalize.js';

export async function enrichDoc(store, doc) {
  const fields = { og_checked: true };
  try {
    const html = await get(doc.url, { json: false, retries: 1, timeout: 12000 });
    const meta = extractMeta(html, doc.url);
    if (meta.image) fields.thumb = meta.image;
    if (!doc.media_url && (meta.video || meta.image)) {
      const media_url = meta.video && /\.(mp4|webm)(\?|$)/i.test(meta.video) ? meta.video : null;
      if (media_url) fields.media_url = media_url;
    }
    if (!doc.description && meta.description) fields.description = meta.description.slice(0, 600);
    if (!doc.embed) { const e = deriveEmbed({ ...doc, ...fields }); if (e) fields.embed = e; }
  } catch (e) {
    fields.og_error = String(e.message).slice(0, 200);
    // Only give up for good on hard 4xx; timeouts/5xx get retried on a later pass.
    if (!/HTTP 4\d\d/.test(e.message)) delete fields.og_checked;
  }
  await store.setFields(doc.key, fields);
  return { ...doc, ...fields };
}
