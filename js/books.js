/**
 * Books-tab runtime: modal + hash routing.
 *
 * Reads the inert <script id="books-data" type="application/json"> block that
 * build-books.mjs injects and wires up:
 *   - Click on .book-title-link[data-isbn]      → open book detail modal
 *   - Click on .book-author-link[data-author]   → open author modal
 *   - Click on .book-publisher-link[data-publisher] → open publisher modal
 *
 * URL hashes:
 *   #book/<isbn>            book detail
 *   #author/<slug>          author modal
 *   #publisher/<slug>       publisher modal
 *
 * Modal hashes don't conflict with the tab manager's hash scheme (tab hashes
 * are single tokens or "<tab>/<subtab>"). When a modal hash is opened we
 * pushState so back/forward navigates between modal states naturally.
 */
(function () {
  'use strict';

  // ---------- Init ---------------------------------------------------------

  const MODAL_HASH_PATTERN = /^#(book|author|publisher)\/(.+)$/;

  let books = [];
  let byIsbn = new Map();
  let byAuthorSlug = new Map();
  let byPublisherSlug = new Map();
  let modalRoot = null;
  let baseHashBeforeModal = '#books'; // restored when modal closes

  function slugify(s) {
    return String(s || '')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function loadData() {
    const node = document.getElementById('books-data');
    if (!node) {
      console.warn('[books.js] no #books-data block found — modal disabled');
      return false;
    }
    try {
      books = JSON.parse(node.textContent || '[]');
    } catch (e) {
      console.error('[books.js] failed to parse books-data', e);
      return false;
    }
    // Index
    for (const b of books) {
      if (b.isbn) byIsbn.set(b.isbn, b);
      for (const a of (b.authors || [])) {
        if (!a || a === 'et al.') continue;
        const s = slugify(a);
        if (!byAuthorSlug.has(s)) byAuthorSlug.set(s, { name: a, books: [] });
        byAuthorSlug.get(s).books.push(b);
      }
      if (b.publisher) {
        const s = slugify(b.publisher);
        if (!byPublisherSlug.has(s)) byPublisherSlug.set(s, { name: b.publisher, books: [] });
        byPublisherSlug.get(s).books.push(b);
      }
    }
    return true;
  }

  // ---------- Modal DOM ----------------------------------------------------

  function ensureModalRoot() {
    if (modalRoot) return modalRoot;
    modalRoot = document.getElementById('book-modal-root');
    if (!modalRoot) {
      modalRoot = document.createElement('div');
      modalRoot.id = 'book-modal-root';
      document.body.appendChild(modalRoot);
    }
    modalRoot.innerHTML = `
      <div class="bm-overlay" data-bm-close></div>
      <div class="bm-dialog" role="dialog" aria-modal="true" aria-labelledby="bm-title">
        <button class="bm-close" data-bm-close aria-label="Close">×</button>
        <div class="bm-body"></div>
      </div>
    `;
    modalRoot.addEventListener('click', (e) => {
      if (e.target.matches('[data-bm-close]')) closeModal();
    });
    return modalRoot;
  }

  function injectStyles() {
    if (document.getElementById('book-modal-styles')) return;
    const css = `
      #book-modal-root { display: none; position: fixed; inset: 0; z-index: 1000; }
      #book-modal-root.is-open { display: block; }
      #book-modal-root .bm-overlay {
        position: absolute; inset: 0; background: rgba(0,0,0,.55);
        animation: bm-fade .15s ease-out;
      }
      #book-modal-root .bm-dialog {
        position: relative; max-width: 720px; width: calc(100% - 32px);
        max-height: calc(100vh - 32px);
        margin: 16px auto; background: #fff; color: #222;
        border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,.3);
        overflow: hidden; display: flex; flex-direction: column;
        animation: bm-pop .15s ease-out;
      }
      body.dark-mode #book-modal-root .bm-dialog { background: #1c1c1c; color: #eee; }
      #book-modal-root .bm-close {
        position: absolute; top: 8px; right: 8px;
        background: transparent; border: 0; font-size: 28px; line-height: 1;
        cursor: pointer; color: inherit; padding: 4px 10px; border-radius: 4px;
      }
      #book-modal-root .bm-close:hover { background: rgba(0,0,0,.06); }
      body.dark-mode #book-modal-root .bm-close:hover { background: rgba(255,255,255,.08); }
      #book-modal-root .bm-body { padding: 24px; overflow-y: auto; }
      #book-modal-root h2 { margin: 0 0 .15em; font-size: 22px; line-height: 1.25; padding-right: 36px; }
      #book-modal-root .bm-subtitle { color: #666; margin: 0 0 .8em; font-style: italic; }
      body.dark-mode #book-modal-root .bm-subtitle { color: #aaa; }
      #book-modal-root .bm-meta { color: #555; font-size: 14px; margin: .4em 0 1em; }
      body.dark-mode #book-modal-root .bm-meta { color: #bbb; }
      #book-modal-root .bm-meta a { color: inherit; text-decoration: underline; }
      #book-modal-root .bm-detail { display: grid; grid-template-columns: 130px 1fr; gap: 20px; }
      /* When the cover image fails to load (or is missing), drop the cover
         column entirely so the text takes the full dialog width. The onerror
         handler on .bm-cover adds .no-cover to .bm-detail. */
      #book-modal-root .bm-detail.no-cover { grid-template-columns: 1fr; }
      #book-modal-root .bm-cover {
        width: 130px; height: auto; aspect-ratio: 2/3; object-fit: cover;
        background: #eee; border-radius: 4px;
      }
      body.dark-mode #book-modal-root .bm-cover { background: #2a2a2a; }
      #book-modal-root .bm-description {
        margin: 1em 0 0; font-size: 14.5px; line-height: 1.5;
      }
      #book-modal-root .bm-buy {
        display: inline-block; margin-top: 1em; padding: 8px 16px;
        background: #1a7a3a; color: #fff; border-radius: 4px;
        text-decoration: none; font-weight: 600; font-size: 14px;
      }
      #book-modal-root .bm-buy:hover { background: #146028; }
      #book-modal-root .bm-list { list-style: none; padding: 0; margin: 1em 0 0; }
      #book-modal-root .bm-list li { padding: 6px 0; border-bottom: 1px solid #eee; }
      body.dark-mode #book-modal-root .bm-list li { border-bottom-color: #2a2a2a; }
      #book-modal-root .bm-list li:last-child { border-bottom: 0; }
      #book-modal-root .bm-list a { color: inherit; text-decoration: none; font-weight: 600; }
      #book-modal-root .bm-list a:hover { text-decoration: underline; }
      #book-modal-root .bm-list .bm-year { color: #888; font-weight: 400; font-size: 13px; margin-left: 6px; }
      body.dark-mode #book-modal-root .bm-list .bm-year { color: #aaa; }
      @keyframes bm-fade { from { opacity: 0 } to { opacity: 1 } }
      @keyframes bm-pop  { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1; transform: translateY(0) } }
      @media (max-width: 520px) {
        #book-modal-root .bm-detail { grid-template-columns: 1fr; }
        #book-modal-root .bm-cover { width: 100px; margin: 0 auto; }
      }
    `;
    const style = document.createElement('style');
    style.id = 'book-modal-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------- Modal content renderers --------------------------------------

  function authorsHtml(authors) {
    return (authors || []).map(a => {
      if (!a || a === 'et al.') return escapeHtml(a || '');
      const s = slugify(a);
      return `<a href="#author/${s}">${escapeHtml(a)}</a>`;
    }).join(', ');
  }

  function publisherHtml(p) {
    if (!p) return '';
    return `<a href="#publisher/${slugify(p)}">${escapeHtml(p)}</a>`;
  }

  function bookYear(b) {
    // Mirror render-books.js: prefer the editorial .year, fall back to
    // publication_date (which is whatever edition the ISBN points at).
    if (b.year) return String(b.year);
    if (b.publication_date) {
      const m = String(b.publication_date).match(/^(\d{4})/);
      if (m) return m[1];
    }
    return '';
  }

  function renderBookModal(b) {
    const root = ensureModalRoot();
    const body = root.querySelector('.bm-body');
    const year = bookYear(b);
    const buyLabel = (b.url || '').includes('bookshop.org')
      ? 'View on Bookshop.org'
      : 'View link';

    const metaParts = [];
    if (b.publisher) metaParts.push(publisherHtml(b.publisher));
    if (year) metaParts.push(escapeHtml(year));
    if (b.page_count) metaParts.push(`${b.page_count} pages`);
    if (b.isbn) metaParts.push(`ISBN ${escapeHtml(b.isbn)}`);
    const meta = metaParts.join(' · ');

    // When the cover image fails (404 from covers.openlibrary.org with
    // ?default=false, or a network error), hide the <img> AND tag the
    // parent .bm-detail so the CSS collapses to a single column.
    const coverFallback = `onerror="this.style.display='none'; this.closest('.bm-detail').classList.add('no-cover')"`;

    const cover = b.cover_image
      ? `<img class="bm-cover" src="${escapeHtml(b.cover_image)}" alt="Cover of ${escapeHtml(b.title || '')}" ${coverFallback}>`
      : '';
    // If we have no cover URL at all, render the dialog single-column from the start.
    const detailClass = b.cover_image ? 'bm-detail' : 'bm-detail no-cover';

    body.innerHTML = `
      <div class="${detailClass}">
        ${cover}
        <div>
          <h2 id="bm-title">${b.starred ? '⭐ ' : ''}${escapeHtml(b.title || '')}</h2>
          ${b.subtitle ? `<p class="bm-subtitle">${escapeHtml(b.subtitle)}</p>` : ''}
          <div class="bm-meta">
            ${b.authors && b.authors.length ? `by ${authorsHtml(b.authors)}` : ''}
            ${meta ? `<br>${meta}` : ''}
          </div>
          ${b.url ? `<a class="bm-buy" href="${escapeHtml(b.url)}" target="_blank" rel="noopener">${buyLabel}</a>` : ''}
        </div>
      </div>
      ${b.description ? `<div class="bm-description">${escapeHtml(b.description)}</div>` : ''}
    `;
    openModal();
  }

  function renderListModal({ heading, books }) {
    const root = ensureModalRoot();
    const body = root.querySelector('.bm-body');
    // Sort by publication year asc, then title
    const sorted = books.slice().sort((a, b) => {
      const ya = parseInt(bookYear(a) || 0, 10);
      const yb = parseInt(bookYear(b) || 0, 10);
      if (ya !== yb) return ya - yb;
      return (a.title || '').localeCompare(b.title || '');
    });
    const items = sorted.map(b => {
      const y = bookYear(b);
      const isbnAttr = b.isbn ? ` data-isbn="${b.isbn}"` : '';
      return `<li>
        <a href="${b.isbn ? `#book/${b.isbn}` : (b.url || '#')}"${isbnAttr}>${b.starred ? '⭐ ' : ''}${escapeHtml(b.title || '')}</a>
        ${y ? `<span class="bm-year">${escapeHtml(y)}</span>` : ''}
      </li>`;
    }).join('');
    body.innerHTML = `
      <h2 id="bm-title">${escapeHtml(heading)}</h2>
      <p class="bm-meta">${sorted.length} ${sorted.length === 1 ? 'title' : 'titles'} in this list</p>
      <ul class="bm-list">${items}</ul>
    `;
    openModal();
  }

  // ---------- Modal open/close --------------------------------------------

  function openModal() {
    const root = ensureModalRoot();
    root.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  function closeModal({ restoreHash = true } = {}) {
    if (!modalRoot) return;
    modalRoot.classList.remove('is-open');
    document.body.style.overflow = '';
    if (restoreHash && MODAL_HASH_PATTERN.test(window.location.hash)) {
      history.pushState(null, '', baseHashBeforeModal || '#books');
    }
  }

  // ---------- Hash routing ------------------------------------------------

  function parseModalHash(hash) {
    const m = MODAL_HASH_PATTERN.exec(hash || '');
    if (!m) return null;
    return { type: m[1], key: decodeURIComponent(m[2]) };
  }

  function ensureBooksTab() {
    // If we're not already on the books tab, switch to it.
    const tm = window.__tabManager;
    if (tm && tm.activeTab !== 'books') {
      baseHashBeforeModal = '#books';
      tm.switchTab('books', { updateHash: false });
    }
  }

  function applyHash() {
    const parsed = parseModalHash(window.location.hash);
    if (!parsed) {
      // No modal hash → close any open modal (without rewriting the URL)
      if (modalRoot && modalRoot.classList.contains('is-open')) {
        closeModal({ restoreHash: false });
      }
      return;
    }
    ensureBooksTab();
    if (parsed.type === 'book') {
      const b = byIsbn.get(parsed.key);
      if (!b) {
        console.warn('[books.js] no book for ISBN', parsed.key);
        return;
      }
      renderBookModal(b);
    } else if (parsed.type === 'author') {
      const a = byAuthorSlug.get(parsed.key);
      if (!a) {
        console.warn('[books.js] no author for slug', parsed.key);
        return;
      }
      renderListModal({
        heading: `Books by ${a.name}`,
        books: a.books,
      });
    } else if (parsed.type === 'publisher') {
      const p = byPublisherSlug.get(parsed.key);
      if (!p) {
        console.warn('[books.js] no publisher for slug', parsed.key);
        return;
      }
      renderListModal({
        heading: `Published by ${p.name}`,
        books: p.books,
      });
    }
  }

  function openHash(newHash) {
    // Record where we came from so closing can restore it
    if (!MODAL_HASH_PATTERN.test(window.location.hash)) {
      baseHashBeforeModal = window.location.hash || '#books';
    }
    if (window.location.hash !== newHash) {
      history.pushState(null, '', newHash);
    }
    applyHash();
  }

  // ---------- Click delegation --------------------------------------------

  function wireClicks() {
    document.addEventListener('click', (e) => {
      // Modifier clicks (open in new tab) → let the browser handle natively.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
      const a = e.target.closest('a');
      if (!a) return;

      // Book title link with explicit data-isbn (the renderer's default form).
      const isbn = a.dataset.isbn;
      if (a.classList.contains('book-title-link') && isbn && byIsbn.has(isbn)) {
        e.preventDefault();
        openHash(`#book/${encodeURIComponent(isbn)}`);
        return;
      }

      // Permissive fallback: ANY <a> inside the books tab whose href is a
      // bookshop.org/a/104178/<isbn-13> URL opens the modal if that ISBN is
      // known. This lets hand-authored Big Five links (and any other bare
      // bookshop links you paste in) open modals without remembering to set
      // class="book-title-link" data-isbn="…" each time.
      const href = a.getAttribute('href') || '';
      const booksTab = a.closest('#tab-books');
      if (booksTab) {
        const m = href.match(/bookshop\.org\/a\/104178\/(97[89]\d{10})/);
        if (m && byIsbn.has(m[1])) {
          e.preventDefault();
          openHash(`#book/${encodeURIComponent(m[1])}`);
          return;
        }
      }
      // Author link
      if (a.classList.contains('book-author-link')) {
        const name = a.dataset.author || a.textContent.trim();
        const slug = slugify(name);
        if (byAuthorSlug.has(slug)) {
          e.preventDefault();
          openHash(`#author/${encodeURIComponent(slug)}`);
        }
        return;
      }
      // Publisher link
      if (a.classList.contains('book-publisher-link')) {
        const name = a.dataset.publisher || a.textContent.trim();
        const slug = slugify(name);
        if (byPublisherSlug.has(slug)) {
          e.preventDefault();
          openHash(`#publisher/${encodeURIComponent(slug)}`);
        }
        return;
      }
      // In-modal book link → re-route through #book/<isbn>
      const inModalIsbn = a.dataset.isbn;
      if (modalRoot && modalRoot.contains(a) && inModalIsbn && byIsbn.has(inModalIsbn)) {
        e.preventDefault();
        openHash(`#book/${encodeURIComponent(inModalIsbn)}`);
      }
    });

    // Esc closes modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modalRoot && modalRoot.classList.contains('is-open')) {
        closeModal();
      }
    });
  }

  // ---------- Boot --------------------------------------------------------

  function boot() {
    if (!loadData()) return;
    injectStyles();
    ensureModalRoot();
    wireClicks();
    // React to hashchange + back/forward
    window.addEventListener('hashchange', applyHash);
    window.addEventListener('popstate', applyHash);
    // If we landed on a modal hash, open it (after main.js has initialized)
    if (MODAL_HASH_PATTERN.test(window.location.hash)) {
      // run after DOM is ready and main.js has had a chance to set up
      setTimeout(applyHash, 0);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose a small API for ad-hoc use / debugging
  window.PalestineListBooksRuntime = {
    openBook: (isbn) => openHash(`#book/${encodeURIComponent(isbn)}`),
    openAuthor: (nameOrSlug) => {
      const slug = byAuthorSlug.has(nameOrSlug) ? nameOrSlug : slugify(nameOrSlug);
      openHash(`#author/${encodeURIComponent(slug)}`);
    },
    closeModal,
    _data: () => ({ books, byIsbn, byAuthorSlug, byPublisherSlug }),
  };
})();
