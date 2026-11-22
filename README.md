# Fieldguide

Point your camera at something and get a field guide card. The front is the
photograph; the back is a short, dense entry — definition, anatomy, history, why
it matters — written to make the reader an expert on the thing itself, never a
description of the picture.

Mobile-first, no accounts, no backend storage. Photographs, the album, the ledger
and the per-subject cache all live in the browser's IndexedDB.

## Run locally

```sh
bun install
bun run dev
```

Open the URL printed by Vite. The server binds to `0.0.0.0`.

## The Gemini key

Generation calls Google's Gemini API directly from the browser with a key the
user pastes into the app once; it is kept in `localStorage` and never sent
anywhere but Google. There is no key in this repository and none is needed to
run the interface.

Models: `gemini-3.5-flash-lite` first, `gemini-3.8-flash` as fallback, one
request per card.

## Where things are

- `index.html` — the single page: camera, card, album, ledger, key sheet.
- `src/main.js` — camera constraints and zoom, capture, card flow, Keep/discard.
- `src/gemini.js` — prompts, response schema and response normalisation.
- `src/db.js` — IndexedDB stores: `album`, `cache`, `prints`.
- `src/rarity.js` — tiers by specificity.
- `src/style.css` — paper and ink.
- `worker/index.js` — a three-line fetch handler for Freebuff Sites.

## Build and publish

```sh
bun run build
bun run preview
```

The build produces `dist/`, which any static host can serve. `deploy.json` is
the Freebuff Sites manifest: it uploads `dist/` with `worker/index.js` serving it
through the platform's `ASSETS` binding.
