import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalKey, normalize, youtubeId, giphyId, tenorId, sourceFromUrl } from '../lib/normalize.js';

test('youtube ids from every URL shape collapse to one key', () => {
  const urls = ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s', 'https://youtu.be/dQw4w9WgXcQ?si=abc', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ'];
  for (const u of urls) assert.equal(canonicalKey(u), 'youtube:dQw4w9WgXcQ');
  assert.equal(youtubeId('https://example.com'), null);
});

test('giphy / tenor ids', () => {
  assert.equal(giphyId('https://giphy.com/gifs/monkey-puppet-side-eye-H5C8CevNMbpBqNqFjl'), 'H5C8CevNMbpBqNqFjl');
  assert.equal(giphyId('https://media.giphy.com/media/H5C8CevNMbpBqNqFjl/giphy.gif'), 'H5C8CevNMbpBqNqFjl');
  assert.equal(tenorId('https://tenor.com/view/monkey-thinking-monkey-thinking-gif-123456789'), '123456789');
  assert.equal(tenorId('https://tenor.com/en-GB/view/monkey-gif-987654321'), '987654321');
});

test('generic URLs drop tracking params and trailing slash', () => {
  assert.equal(canonicalKey('https://www.KnowYourMeme.com/memes/monkey-puppet/?utm_source=x#top'), 'knowyourmeme.com/memes/monkey-puppet');
  assert.equal(canonicalKey('https://twitter.com/apeonfone'), canonicalKey('https://x.com/apeonfone'));
});

test('normalize derives embed, thumb, type, source', () => {
  const d = normalize({ url: 'https://youtu.be/dQw4w9WgXcQ', title: ' Monkey ', tags: ['Phone', 'phone', '#Chimp'] }, 'test');
  assert.equal(d.media_type, 'video');
  assert.equal(d.source, 'youtube');
  assert.equal(d.embed.kind, 'youtube');
  assert.match(d.thumb, /i\.ytimg\.com/);
  assert.deepEqual(d.tags, ['phone', 'chimp']);
  const g = normalize({ url: 'https://giphy.com/gifs/abc-H5C8CevNMbpBqNqFjl', title: 'g' }, 't');
  assert.equal(g.media_type, 'gif');
  assert.match(g.embed.mp4, /giphy\.mp4$/);
  assert.equal(normalize({ url: 'ftp://nope', title: 'x' }, 't'), null);
  assert.equal(sourceFromUrl('https://www.gettyimages.com/detail/photo/x'), 'getty');
});
