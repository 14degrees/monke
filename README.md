# 🐒 monke

An exhaustive, sourced archive of culturally relevant monkey and ape media: memes, reaction gifs, viral videos, 90s commercials, stock footage that turned into memes, famous animals, film/TV scenes and social accounts. It comes with a grid browser for looking through it.

Three ways content gets in:

| Collector | What it does | Runs where |
|---|---|---|
| **Swarm seed** (`data/*.json`) | Catalog built by a swarm of web-search agents, split by category (memes, ads, stock, viral, film/TV, gifs, social, music, deep cuts) plus a pass that looks for what's missing. Every entry links to its source. | Already in the repo |
| **Scrapers** (`scrapers/index.js`) | Reddit (23 primate subs plus searches of the big meme subs), YouTube, Wikimedia Commons, Giphy, Tenor, Openverse, iNaturalist, Internet Archive, Imgur, Pixabay, Pexels, Lemmy, Know Your Meme, Flickr | Your machine or Railway |
| **Claude discovery agent** (`lib/agent.js`) | Claude with server-side `web_search` and `web_fetch`. It hunts from a brief (for example "every monkey in a Japanese TV commercial"), checks for duplicates and saves what it finds. It reaches places the scrapers don't, such as TikTok, X, news sites and stock sites. | Same |

Everything goes into one `media` collection, deduped by a canonical key (`youtube:<id>`, `giphy:<id>`, `tenor:<id>`, `reddit:<id>`, otherwise the URL with tracking params removed). When the same item turns up again, its tags and `via` provenance are merged rather than duplicated.

## Run it

```bash
cp .env.example .env        # put MONGODB_URI in, plus any API keys you have
npm install
npm run seed                # load data/*.json into Mongo
npm start                   # http://localhost:3000
```

Without `MONGODB_URI` the server still runs: it serves `data/*.json` from memory, which is handy for a quick look.

### Collect more

```bash
npm run scrape                      # one pass over every scraper whose key is set
npm run scrape -- reddit youtube    # just these
npm run scrape:loop                 # forever, every SCRAPE_INTERVAL_MIN (default 6h)
npm run discover                    # Claude agent over the 10 default briefs
npm run discover -- "monkeys in Brazilian memes"
npm run discover -- --loop          # keep hunting forever
npm run enrich                      # backfill thumbnails from og:image tags
```

You can also start scrapes and agent runs from the ⚙︎ panel in the browser. On a single Railway service, set `AUTO_SCRAPE_MIN=360` and/or `AUTO_DISCOVER_MIN=60` so the server collects on its own.

If the site is public, set `ADMIN_TOKEN`. Scrape, agent and add then need that token (enter it in the ⚙︎ panel), so strangers can't spend your API credits.

### Keys (all optional)

Keyless sources: Reddit, YouTube (HTML fallback), Commons, Openverse, iNaturalist, Archive, Lemmy, KYM, Flickr. Each of these keys unlocks another source: `YOUTUBE_API_KEY`, `GIPHY_API_KEY`, `TENOR_API_KEY`, `IMGUR_CLIENT_ID`, `PIXABAY_API_KEY`, `PEXELS_API_KEY`. `REDDIT_CLIENT_ID`/`SECRET` avoid Reddit's blocks on requests without a login. `ANTHROPIC_API_KEY` turns on the agent (model `claude-opus-5-5`, override it with `DISCOVER_MODEL`).

## The browser

- Masonry grid with infinite scroll and a tile-size slider. Gifs and mp4s play when you hover over them.
- Search across title, tags and description. Filter chips for type, source and the top 120 tags, and you can combine them. Sorts: newest, top score, random, oldest.
- Lightbox with the real player: YouTube, TikTok and Vimeo embeds, mp4, gif or image. It also shows description, tags you can click, author, score, a link to the source and the raw media link, plus which collector found the item (`via`). Arrow keys move between items, `/` jumps to search.
- Cards with no thumbnail look up the page's `og:image` when they scroll into view, and the result is saved back to the DB.
- Filters live in the URL, so a filtered view can be shared.

## Document shape

```js
{ key, url, title, description, media_type: 'video'|'gif'|'image'|'meme'|'article'|'audio'|'account',
  source, media_url, thumb, embed: { kind: 'youtube'|'gif'|'video'|'image'|'iframe', src, mp4? },
  tags: [], via: ['swarm:memes', 'scrape:reddit', 'agent', ...], score, author, year, nsfw,
  discovered_at, updated_at }
```
