#!/usr/bin/env node
/**
 * backfill-book-covers.mjs
 *
 * Replaces each book's cover_image with a verified URL, preferring
 * Bookshop.org's Ingram-hosted cover (https://images-us.bookshop.org/ingram/
 * <isbn>.jpg) over Open Library's (https://covers.openlibrary.org/b/isbn/
 * <isbn>-L.jpg). Both are deterministic, ISBN-keyed URLs, no scraping or API
 * key needed, but Open Library's coverage/accuracy is much worse: a spot
 * check of the site's own "Big Five" books found 6 of 15 Open Library covers
 * 404ing, while Bookshop resolved all of them. Across the full catalog,
 * Bookshop covers ~95% of ISBNs vs a much lower real (not just "field is
 * set") hit rate for Open Library.
 *
 * For each book with an isbn:
 *   1. HEAD https://images-us.bookshop.org/ingram/<isbn>.jpg?width=600
 *      -> 200: use it.
 *   2. Else HEAD https://covers.openlibrary.org/b/isbn/<isbn>-L.jpg?default=false
 *      -> 200: use it.
 *   3. Else: cover_image = null (matches how js/books.js already treats a
 *      missing cover: no wasted broken-image request/flash before onerror
 *      fires, which is what a since-fixed dead link would otherwise cause).
 *
 * This re-verifies EVERY book's cover on each run, not just ones currently
 * missing one. The point is correctness, not just filling gaps, since a
 * previously-set Open Library URL can be dead even though the field is
 * populated. Books without an isbn are left untouched entirely.
 *
 * After updating search-index.json it regenerates ONLY the <script
 * id="books-data"> block in index.html (via render-books.js buildModalData)
 * . It never rewrites the rendered Books HTML, since that block doesn't use
 * cover_image at all (only the modal does).
 *
 * Usage:
 *   node tools/backfill-book-covers.mjs           # DRY RUN, prints the plan
 *   node tools/backfill-book-covers.mjs --write    # apply (backs up first)
 */
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WRITE = process.argv.includes('--write');
const CONCURRENCY = 8;

const idxPath = resolve(ROOT, 'search-index.json');
const htmlPath = resolve(ROOT, 'index.html');

const bookshopUrl = (isbn) => `https://images-us.bookshop.org/ingram/${isbn}.jpg?width=600`;
const openLibraryUrl = (isbn) => `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`;

async function urlOk(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function resolveCover(isbn) {
  const bs = bookshopUrl(isbn);
  if (await urlOk(bs)) return { url: bs, source: 'bookshop' };
  const ol = openLibraryUrl(isbn);
  if (await urlOk(ol)) return { url: ol, source: 'openlibrary' };
  return { url: null, source: 'none' };
}

// Simple concurrency-limited map.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const idx = JSON.parse(await readFile(idxPath, 'utf8'));
const entries = idx.entries;
const books = entries.filter((e) => e.tab === 'books' && e.isbn);

console.log(`Checking covers for ${books.length} books (concurrency ${CONCURRENCY})...`);

const outcomes = await mapPool(books, CONCURRENCY, async (b) => {
  const { url, source } = await resolveCover(b.isbn);
  const changed = url !== (b.cover_image || null);
  return { book: b, url, source, changed };
});

const bySource = { bookshop: 0, openlibrary: 0, none: 0 };
const changes = [];
for (const o of outcomes) {
  bySource[o.source]++;
  if (o.changed) changes.push(o);
}

console.log(`\nResults:`);
console.log(`  Bookshop cover found:    ${bySource.bookshop}`);
console.log(`  Open Library fallback:   ${bySource.openlibrary}`);
console.log(`  No cover found anywhere: ${bySource.none}`);
console.log(`  Changed from current value: ${changes.length}`);

if (bySource.none > 0) {
  console.log(`\nBooks with no verified cover from either source:`);
  for (const o of outcomes.filter((o) => o.source === 'none')) {
    console.log(`   ${o.book.isbn}  ${o.book.title}`);
  }
}

if (!WRITE) {
  console.log(`\nDRY RUN, nothing written. Re-run with --write to apply (search-index.json is backed up first).`);
  process.exit(0);
}

await copyFile(idxPath, idxPath + '.bak-covers');

for (const o of outcomes) {
  o.book.cover_image = o.url;
}

await writeFile(idxPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');

// Regenerate ONLY the books-data block in index.html.
const rendererSrc = await readFile(resolve(ROOT, 'tools/render-books.js'), 'utf8');
// eslint-disable-next-line no-eval
eval(rendererSrc);
const R = globalThis.PalestineListBooks;

let html = await readFile(htmlPath, 'utf8');
const modalJson = JSON.stringify(R.buildModalData(entries)).replace(/<\//g, '<\\/');
const RE_DATA = /(<!-- books-data:start -->)([\s\S]*?)(<!-- books-data:end -->)/m;
if (!RE_DATA.test(html)) { console.error('No books-data markers in index.html'); process.exit(1); }
html = html.replace(RE_DATA, (_, o, _i, c) => `${o}\n<script id="books-data" type="application/json">${modalJson}<\/script>\n        ${c}`);
await writeFile(htmlPath, html, 'utf8');

console.log(`\n✓ Wrote ${changes.length} cover updates to search-index.json`);
console.log(`✓ Regenerated books-data in index.html (${R.buildModalData(entries).length} modal entries)`);
console.log('  Backup: search-index.json.bak-covers');
