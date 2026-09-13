// Tab management

// Map URL hash → data-tab name (used for deep-linking like palestinelist.com/#books)
// 'book' / 'author' / 'publisher' are modal sub-hashes consumed by js/books.js;
// they all live on the books tab so deep links land there before the modal opens.
const HASH_TO_TAB = {
    'home': 'home',
    'books': 'books',
    'book': 'books',
    'author': 'books',
    'publisher': 'books',
    'video': 'film-video',
    'misc': 'miscellaneous',
    'citations': 'citations',
    'supplements': 'supplements'
};

// Hashes that js/books.js owns — main.js should NOT canonicalize these away.
const MODAL_HASH_RE = /^#(book|author|publisher)\//;

// Inverse: data-tab name → hash fragment. Mirrors the `href` on each <a class="tab-button">.
const TAB_TO_HASH = {
    'home': 'home',
    'books': 'books',
    'film-video': 'video',
    'miscellaneous': 'misc',
    'citations': 'citations',
    'supplements': 'supplements'
};

// Tabs that have nested subtabs. First entry is the default (shown when the
// bare tab hash is used, e.g. #supplements lands on globalsolidarity).
// Nested URL form is "<tab>/<subtab>" — e.g. "#supplements/genocide".
const TAB_SUBTABS = {
    'supplements': ['solidarity', 'liberation', 'genocide', 'apartheid', 'timeline']
};

// Old subtab slugs that should resolve to a current one. Useful when a
// subtab is renamed — links shared on the old URL keep working, and the
// browser silently rewrites them to the canonical hash on landing.
const SUBTAB_ALIASES = {
    'supplements': {
        'globalsolidarity': 'solidarity'
    }
};

// Remember the page's original <title> (before any tab switching) so we can
// prefix it per-tab/subtab (e.g. "It's a Genocide | The Palestine List | …")
// without hardcoding the site name twice. Captured at script-parse time,
// before TabManager ever touches document.title.
const BASE_TITLE = document.title;

// Path segments that belong to js/books.js's modal routing (#book/<isbn> etc.
// today). Excluded from path-based tab resolution so a real /book/... URL
// (if one is ever linked) can't be hijacked into the Books tab by the path
// parser. That hash-only scheme is out of scope here.
const MODAL_PATH_HEADS = new Set(['book', 'author', 'publisher']);

// Tabs with a real, server-side route: a Cloudflare Worker in front of the
// static host serves index.html with correct per-route preview metadata for
// these paths (see worker-supplements/). The address bar only ever writes a
// real path (e.g. /supplements/genocide) for these tabs. Every other tab
// keeps writing the old hash scheme (#books, #video, etc), because the
// origin is a plain static host with no route for e.g. /books: a bookmarked
// or reloaded real-path URL there would 404, while a hash fragment never
// reaches the server at all and so can never 404 regardless of what the
// origin serves.
const PATH_ROUTED_TABS = new Set(['supplements']);

class TabManager {
    constructor() {
        this.activeTab = 'home';
        this.activeSubtab = null;
        this.sidebar = document.getElementById('sidebar');
        this.contentArea = document.getElementById('content-area');
        this.hamburger = document.getElementById('hamburger');
        this.sidebarClose = document.getElementById('sidebar-close');
        this.outlineNav = document.getElementById('outline-nav');

        this.init();
    }

    init() {
        // Build the section index BEFORE the first switchTab/generateOutline so
        // those reuse the ids we assign here (rather than assigning their own).
        this.buildSectionIndex();

        // Create overlay for mobile bottom sheet
        this.overlay = document.createElement('div');
        this.overlay.className = 'sidebar-overlay';
        document.body.appendChild(this.overlay);
        this.overlay.addEventListener('click', () => this.hideSidebar());

        // Set up tab buttons. These are <a> tags with hrefs like "#books" so
        // right-click → "Copy link address" gives a useful URL, but we
        // intercept the click to avoid the browser jumping to the h1 anchor.
        document.querySelectorAll('.tab-button').forEach(button => {
            button.addEventListener('click', (e) => {
                // Allow modifier-clicks (open in new tab, etc.) to behave natively.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
                e.preventDefault();
                const tab = e.currentTarget.dataset.tab;
                if (tab) this.switchTab(tab);
            });
        });

        // Set up subtab buttons (same modifier-click handling as tabs).
        document.querySelectorAll('.subtab-button').forEach(button => {
            button.addEventListener('click', (e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
                e.preventDefault();
                const subtab = e.currentTarget.dataset.subtab;
                if (subtab) this.switchSubtab(subtab);
            });
        });

        // popstate fires for both path and hash history entries (back/forward).
        // hashchange fires when only the hash portion changes directly. Both
        // call the same idempotent sync function, so it's safe to listen for both.
        window.addEventListener('popstate', () => this.syncFromLocation());
        window.addEventListener('hashchange', () => this.syncFromLocation());

        // Set up hamburger menu
        this.hamburger.addEventListener('click', () => this.toggleSidebar());
        this.sidebarClose.addEventListener('click', () => this.hideSidebar());

        // Close sidebar when clicking outline item
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('outline-item')) {
                this.hideSidebar();
            }
        });

        // Set up scroll listener for active outline
        this.contentArea.addEventListener('scroll', () => this.updateActiveOutlineItem());

        // Initialize first tab/subtab. Real paths (e.g. /supplements/genocide)
        // take priority. That's what a Cloudflare Worker rewrites per-route
        // preview metadata for, so it must win over a stale hash. Falls back
        // to the legacy hash scheme (#supplements/genocide) for old shared
        // links, then to 'home' for empty/unknown locations. Skip URL update
        // on initial call so landing on "/" doesn't rewrite anything yet.
        const located = this.resolveLocation();
        const initialTab = located.tab || 'home';
        this.switchTab(initialTab, { updateHash: false, subtab: located.subtab, section: located.section });

        // If the user landed on an aliased/non-canonical hash (e.g.
        // #supplements/globalsolidarity) or an old hash-based tab link,
        // silently rewrite the address bar to the canonical path form. We use
        // replaceState so we don't push a junk history entry for the old URL.
        // Skip entirely for a truly unrecognized location (located.tab null)
        // so a stray/typo'd URL isn't clobbered into "/".
        if (located.tab) {
            this.canonicalizeLocation();
        }

        // Dark mode toggle

        const darkToggle = document.getElementById('dark-toggle');

        if (darkToggle) {
            const icon = darkToggle.querySelector('i');
            const setIcon = (isDark) => {
                icon.classList.remove('fa-moon', 'fa-sun');
                icon.classList.add(isDark ? 'fa-sun' : 'fa-moon');
            };

            // Restore saved preference
            const isDarkSaved = localStorage.getItem('darkMode') === 'true';
            if (isDarkSaved) {
                document.body.classList.add('dark-mode');
            }
            setIcon(isDarkSaved);

            darkToggle.addEventListener('click', () => {
                document.body.classList.toggle('dark-mode');
                const isDark = document.body.classList.contains('dark-mode');
                setIcon(isDark);
                localStorage.setItem('darkMode', isDark);
            });
        }

    }

    switchTab(tabName, { updateHash = true, subtab = null, section = null } = {}) {
        // Hide all tabs
        document.querySelectorAll('.tab-content').forEach(tab => {
            tab.classList.remove('active');
        });

        // Show selected tab
        const tab = document.getElementById(`tab-${tabName}`);
        if (tab) {
            tab.classList.add('active');
        }

        // Update active button
        document.querySelectorAll('.tab-button').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelector(`.tab-button[data-tab="${tabName}"]`)?.classList.add('active');

        this.activeTab = tabName;

        // Resolve subtab if this tab has any. Honor an explicit subtab arg
        // when valid, otherwise fall back to the default (first listed).
        const subs = TAB_SUBTABS[tabName];
        if (subs && subs.length) {
            const target = (subtab && subs.includes(subtab)) ? subtab : subs[0];
            this.activateSubtab(target);
        } else {
            this.activeSubtab = null;
        }

        // Update outline (scoped to active subtab if one exists)
        this.generateOutline();

        // Scroll to top — unless we're deep-linking to a section, in which case
        // jump to that section instead of resetting to the top of the tab.
        if (section) {
            this.scrollToSection(section);
        } else {
            this.contentArea.scrollTop = 0;
        }

        // Hide sidebar on mobile
        this.hideSidebar();

        // Sync the address bar (real path, e.g. /supplements/genocide) so
        // users can copy the current tab's link, and update the browser tab
        // title to match.
        if (updateHash) {
            this.writeLocation();
        }
        this.updateDocumentTitle();
    }

    // Switch subtab within the current top tab. Does not change activeTab.
    switchSubtab(subtabName, { updateHash = true } = {}) {
        const subs = TAB_SUBTABS[this.activeTab];
        if (!subs || !subs.includes(subtabName)) return;
        if (this.activeSubtab === subtabName) return;
        this.activateSubtab(subtabName);
        this.generateOutline();
        this.contentArea.scrollTop = 0;
        this.hideSidebar();
        if (updateHash) this.writeLocation();
        this.updateDocumentTitle();
    }

    // Set document.title to "<label> | <original site title>" for any
    // non-home tab/subtab, matching the format used for social-preview titles
    // (e.g. "It's a Genocide | The Palestine List | …"). Reads the label
    // straight from the visible tab/subtab button text, so it never drifts
    // out of sync with what's actually on the page. Home keeps the site's
    // original, unprefixed title.
    updateDocumentTitle() {
        if (this.activeTab === 'home') {
            document.title = BASE_TITLE;
            return;
        }
        let label = null;
        if (this.activeSubtab) {
            const el = document.querySelector(
                `.subtab-button[data-subtab="${this.activeSubtab}"] .subtab-full`);
            label = el?.textContent.trim() || null;
        }
        if (!label) {
            const el = document.querySelector(`.tab-button[data-tab="${this.activeTab}"] .tab-full`);
            label = el?.textContent.trim() || null;
        }
        document.title = label ? `${label} | ${BASE_TITLE}` : BASE_TITLE;
    }

    // Show the named subtab inside the current activeTab and update button states.
    // Internal helper — does not touch the outline, scroll, or URL.
    activateSubtab(subtabName) {
        const tabRoot = document.getElementById(`tab-${this.activeTab}`);
        if (!tabRoot) return;

        tabRoot.querySelectorAll('.subtab-content').forEach(el => {
            el.classList.remove('active');
        });
        const panel = document.getElementById(`subtab-${subtabName}`);
        if (panel) panel.classList.add('active');

        tabRoot.querySelectorAll('.subtab-button').forEach(btn => {
            btn.classList.remove('active');
        });
        tabRoot.querySelector(`.subtab-button[data-subtab="${subtabName}"]`)?.classList.add('active');

        this.activeSubtab = subtabName;
    }

    // Walk every heading across all tabs once, assign a stable id to any that
    // lack one (slugified from the heading text, de-duplicated globally), and
    // record which tab/subtab each id lives in. This is what powers
    // section-level deep links like palestinelist.com/#techforpalestine — with
    // no manually-maintained registry. New sections are picked up on the next
    // load automatically; hand-authored ids (like #techforpalestine) are kept
    // verbatim. Runs once in init(), before the first generateOutline(), so the
    // outline reuses these exact ids. Cost is ~one querySelectorAll over the
    // page plus a slug per heading — negligible next to parsing the document.
    buildSectionIndex() {
        this.sectionIndex = new Map();      // id -> { tab, subtab }
        const used = new Set();

        // URL-safe slug: collapse any run of non-alphanumerics (spaces, emoji,
        // punctuation like | ( ) & and especially "/") to a single hyphen, so
        // the id survives intact in a shared URL fragment. Heading text on this
        // site routinely contains those characters, and a raw "/" in particular
        // would otherwise be misread by parseHash as a tab/subtab separator.
        // Because this pass assigns ids to EVERY heading before the first
        // generateOutline(), the outline reuses these exact ids (it only
        // computes its own when an id is missing), so the two never diverge.
        const slug = (text) => {
            const body = text.toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')   // non-alphanumeric runs -> hyphen
                .replace(/^-+|-+$/g, '')       // trim leading/trailing hyphens
                .substring(0, 50)
                .replace(/-+$/, '');           // re-trim if cut mid-hyphen
            return `heading-${body}`;
        };

        const register = (el, tab, subtab) => {
            let id = el.id;
            if (id) {
                // Pre-existing (often hand-authored) id — keep it, but warn on
                // collisions so duplicate manual anchors get caught in dev.
                if (used.has(id)) {
                    console.warn(`[sections] duplicate id "${id}" — deep links to it are ambiguous`);
                }
            } else {
                const base = slug(el.textContent.trim());
                if (!base || base === 'heading-') return;   // skip empty headings
                id = base;
                let n = 2;
                while (used.has(id)) id = `${base}-${n++}`;  // guarantee uniqueness
                el.id = id;
            }
            used.add(id);
            if (!this.sectionIndex.has(id)) {
                this.sectionIndex.set(id, { tab, subtab });
            }
        };

        document.querySelectorAll('.tab-content').forEach(tabEl => {
            const tab = tabEl.id.replace(/^tab-/, '');
            if (!tab) return;
            // Subtab-scoped headings first, so each carries its owning subtab.
            tabEl.querySelectorAll('.subtab-content').forEach(subEl => {
                const subtab = subEl.id.replace(/^subtab-/, '') || null;
                subEl.querySelectorAll('h2, h3, h4, h5, h6')
                    .forEach(h => register(h, tab, subtab));
            });
            // Then headings that live directly on the tab (not in any subtab).
            tabEl.querySelectorAll('h2, h3, h4, h5, h6').forEach(h => {
                if (h.closest('.subtab-content')) return;
                register(h, tab, null);
            });
        });
    }

    // Scroll the content area to a section id. Deferred a frame so it runs
    // after switchTab has flipped the target tab to display:block and it has
    // layout. Uses the same offset math as updateActiveOutlineItem() for a
    // consistent landing position under the sticky header.
    scrollToSection(id) {
        requestAnimationFrame(() => {
            const el = document.getElementById(id);
            if (!el) return;
            const top = el.offsetTop - this.contentArea.offsetTop - 20;
            this.contentArea.scrollTop = Math.max(0, top);
            this.updateActiveOutlineItem();
        });
    }

    // decodeURIComponent that never throws on a malformed fragment.
    decodeHashPart(s) {
        try { return decodeURIComponent(s); } catch (e) { return s; }
    }

    // Parse window.location.hash into { tab, subtab, section }.
    // Handles flat ("books"), nested ("supplements/genocide"), bare
    // tabs-with-subtabs ("supplements", which resolves to the default subtab
    // — we leave subtab=null here and let switchTab pick the default), and
    // section ids ("techforpalestine"), which resolve to their owning
    // tab/subtab plus the section to scroll to.
    // Returns { tab: null, subtab: null, section: null } for empty/unknown hashes.
    parseHash() {
        const raw = (window.location.hash || '').replace(/^#/, '');
        if (!raw) return { tab: null, subtab: null, section: null };

        const slash = raw.indexOf('/');
        if (slash !== -1) {
            const head = raw.slice(0, slash);
            let sub = raw.slice(slash + 1);
            const tab = HASH_TO_TAB[head];
            const subs = tab ? TAB_SUBTABS[tab] : null;
            // Resolve subtab aliases (e.g. globalsolidarity → solidarity).
            const aliases = tab ? SUBTAB_ALIASES[tab] : null;
            if (aliases && aliases[sub]) {
                sub = aliases[sub];
            }
            if (tab && subs && subs.includes(sub)) {
                return { tab, subtab: sub, section: null };
            }
            // Nested form but unrecognized — fall through to flat lookup of head.
            return { tab: HASH_TO_TAB[head] || null, subtab: null, section: null };
        }

        // Known tab hash (e.g. #books, #misc).
        const flatTab = HASH_TO_TAB[raw];
        if (flatTab) return { tab: flatTab, subtab: null, section: null };

        // Otherwise: is it a section id? Resolve to its owning tab/subtab and
        // carry the section so the caller can scroll to it after switching.
        // Decode first so an encoded fragment matches the literal id we stored.
        const sectionId = this.decodeHashPart(raw);
        const sec = this.sectionIndex && this.sectionIndex.get(sectionId);
        if (sec) return { tab: sec.tab, subtab: sec.subtab || null, section: sectionId };

        return { tab: null, subtab: null, section: null };
    }

    // Parse window.location.pathname into { tab, subtab }. Mirrors parseHash's
    // shape but for real paths (e.g. "/supplements/genocide"), which is what a
    // Cloudflare Worker can see and rewrite per-route preview metadata for
    // (URL fragments never reach the server, so the hash scheme alone can't
    // support that). Bare "/" and unrecognized paths return tab: null so the
    // caller falls back to parseHash() / the default.
    parsePath() {
        const raw = (window.location.pathname || '/').replace(/^\/+|\/+$/g, '');
        if (!raw) return { tab: null, subtab: null };

        const slash = raw.indexOf('/');
        const head = slash === -1 ? raw : raw.slice(0, slash);
        if (MODAL_PATH_HEADS.has(head)) return { tab: null, subtab: null };

        const tab = HASH_TO_TAB[head];
        if (!tab) return { tab: null, subtab: null };
        if (slash === -1) return { tab, subtab: null };

        let sub = raw.slice(slash + 1);
        const subs = TAB_SUBTABS[tab];
        const aliases = SUBTAB_ALIASES[tab];
        if (aliases && aliases[sub]) sub = aliases[sub];
        if (subs && subs.includes(sub)) return { tab, subtab: sub };

        // Recognized tab, unrecognized subtab segment. Still route to the tab.
        return { tab, subtab: null };
    }

    // Resolve the current location to { tab, subtab, section }, preferring a
    // real path over the legacy hash scheme. When a path carries the route,
    // any hash present is interpreted purely as a section anchor (not a
    // second, redundant tab token). Modal hashes are left alone entirely for
    // js/books.js to handle.
    resolveLocation() {
        const pathParsed = this.parsePath();
        if (pathParsed.tab) {
            let section = null;
            if (!MODAL_HASH_RE.test(window.location.hash || '')) {
                const raw = this.decodeHashPart((window.location.hash || '').replace(/^#/, ''));
                if (raw && this.sectionIndex && this.sectionIndex.has(raw)) section = raw;
            }
            return { tab: pathParsed.tab, subtab: pathParsed.subtab, section };
        }
        return this.parseHash();
    }

    syncFromLocation() {
        const located = this.resolveLocation();
        if (!located.tab) return;
        if (located.tab !== this.activeTab) {
            // Don't re-push the location we just read from.
            this.switchTab(located.tab, { updateHash: false, subtab: located.subtab, section: located.section });
        } else if (located.subtab && located.subtab !== this.activeSubtab) {
            this.switchSubtab(located.subtab, { updateHash: false });
            if (located.section) this.scrollToSection(located.section);
        } else if (located.section) {
            // Already on the right tab/subtab — just scroll to the section.
            this.scrollToSection(located.section);
        }
    }

    // The canonical hash string for the current activeTab/activeSubtab. The
    // address-bar form for any tab NOT in PATH_ROUTED_TABS.
    canonicalHash() {
        const tabSlug = TAB_TO_HASH[this.activeTab];
        if (!tabSlug) return null;
        return this.activeSubtab ? `#${tabSlug}/${this.activeSubtab}` : `#${tabSlug}`;
    }

    // The canonical real path for the current activeTab/activeSubtab. Only
    // meaningful when activeTab is in PATH_ROUTED_TABS. Callers check that
    // first. Tabs with subtabs always include the active subtab in the path
    // (so "/supplements/solidarity", not bare "/supplements").
    canonicalPath() {
        const tabSlug = TAB_TO_HASH[this.activeTab];
        if (!tabSlug) return null;
        return this.activeSubtab ? `/${tabSlug}/${this.activeSubtab}` : `/${tabSlug}`;
    }

    // Push the canonical location. Used when the user actively navigates so
    // back/forward gets a history entry for each navigation. PATH_ROUTED_TABS
    // write a real path (dropping any stale hash); every other tab writes an
    // absolute "/#hash" (dropping any stale real path, e.g. coming back from
    // a Supplements deep link) so it never ends up nested under a leftover
    // "/supplements" prefix.
    writeLocation() {
        if (PATH_ROUTED_TABS.has(this.activeTab)) {
            const newPath = this.canonicalPath();
            if (newPath && window.location.pathname + window.location.hash !== newPath) {
                history.pushState(null, '', newPath);
            }
            return;
        }
        const newHash = this.canonicalHash();
        const newUrl = newHash && `/${newHash}`;
        if (newUrl && window.location.pathname + window.location.hash !== newUrl) {
            history.pushState(null, '', newUrl);
        }
    }

    // Replace (not push) the address bar with the canonical location. Called
    // once on landing if the URL is non-canonical (e.g. an aliased subtab
    // slug, or an old #hash link into Supplements) so we don't pollute
    // history with the rewritten entry.
    canonicalizeLocation() {
        // Don't rewrite modal hashes (owned by js/books.js); landing on
        // #book/<isbn> etc. must preserve the full fragment.
        if (MODAL_HASH_RE.test(window.location.hash)) return;

        if (PATH_ROUTED_TABS.has(this.activeTab)) {
            // A valid section-anchor hash is preserved and appended to the new path.
            const rawHash = this.decodeHashPart((window.location.hash || '').replace(/^#/, ''));
            const hasSectionHash = rawHash && this.sectionIndex && this.sectionIndex.has(rawHash);
            const canonical = this.canonicalPath();
            if (!canonical) return;
            const desired = hasSectionHash ? `${canonical}#${rawHash}` : canonical;
            const current = window.location.pathname + window.location.hash;
            if (desired !== current) history.replaceState(null, '', desired);
            return;
        }

        // Hash-scheme tabs: don't rewrite a section deep-link (e.g.
        // #techforpalestine) to the bare tab hash. The section fragment
        // must survive so the link keeps working.
        const raw = this.decodeHashPart((window.location.hash || '').replace(/^#/, ''));
        if (this.sectionIndex && this.sectionIndex.has(raw)) return;
        const canonical = this.canonicalHash();
        if (!canonical) return;
        const desired = `/${canonical}`;
        const current = window.location.pathname + window.location.hash;
        if (desired !== current) history.replaceState(null, '', desired);
    }

    // The DOM element whose headings should populate the outline. Scopes to
    // the active subtab when one exists, otherwise uses the whole tab.
    activeContentRoot() {
        if (this.activeSubtab) {
            return document.getElementById(`subtab-${this.activeSubtab}`);
        }
        return document.getElementById(`tab-${this.activeTab}`);
    }

    // Returns the array of heading elements that should populate the outline
    // for the currently-active content root. Most tabs use h3/h4/h5 verbatim;
    // the timeline subtab is dense enough that we filter to era headers (h2)
    // plus starred entries (⭐) so the sidebar stays scannable.
    outlineHeadings(root) {
        if (this.activeSubtab === 'timeline') {
            return Array.from(root.querySelectorAll('h2, h3, h4, h5')).filter(h => {
                const text = h.textContent.trim();
                if (!text) return false;
                if (h.tagName === 'H2') return true;
                return text.includes('⭐');
            });
        }
        return Array.from(root.querySelectorAll('h3, h4, h5'));
    }

    generateOutline() {
        const root = this.activeContentRoot();
        if (!root) return;

        const headings = this.outlineHeadings(root);
        const outline = [];

        headings.forEach(heading => {
            const level = parseInt(heading.tagName[1]);
            const text = heading.textContent.trim();

            // Ensure heading has an id
            if (!heading.id) {
                heading.id = `heading-${text.toLowerCase().replace(/\s+/g, '-').substring(0, 50)}`;
            }

            outline.push({
                level,
                text,
                id: heading.id
            });
        });

        this.renderOutline(outline);
    }

    renderOutline(outline) {
        this.outlineNav.innerHTML = '';

        if (outline.length === 0) {
            this.outlineNav.innerHTML = '<p style="color: #999; padding: 10px 0;">No sections in this tab</p>';
            return;
        }

        outline.forEach(item => {
            const link = document.createElement('a');
            link.href = `#${item.id}`;
            link.className = `outline-item level-${item.level}`;
            link.textContent = item.text;

            link.addEventListener('click', (e) => {
                e.preventDefault();
                const target = document.getElementById(item.id);
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth' });
                    // Reflect the section in the address bar so the URL is
                    // copyable and back/forward steps through visited sections.
                    // pushState (rather than assigning location.hash) avoids the
                    // browser's synchronous anchor jump fighting the smooth
                    // scroll above, and avoids a redundant hashchange → re-scroll;
                    // traversal is still handled by the existing hashchange
                    // listener. Guard against duplicate history entries on repeat
                    // clicks of the same item.
                    const newHash = `#${item.id}`;
                    if (window.location.hash !== newHash) {
                        history.pushState(null, '', newHash);
                    }
                    this.updateActiveOutlineItem();
                }
            });

            this.outlineNav.appendChild(link);
        });

        this.updateActiveOutlineItem();
    }

    updateActiveOutlineItem() {
        const root = this.activeContentRoot();
        if (!root) return;
        const contentTop = this.contentArea.scrollTop + 100;
        let activeId = null;

        // Use the same filtered heading set as the outline itself so the
        // active highlight only steps through items the user can see in the sidebar.
        this.outlineHeadings(root).forEach(heading => {
            const headingTop = heading.offsetTop - this.contentArea.offsetTop;
            if (headingTop <= contentTop) {
                activeId = heading.id;
            }
        });

        document.querySelectorAll('.outline-item').forEach(item => {
            item.classList.remove('active');
        });

        if (activeId) {
            const activeLink = document.querySelector(`a[href="#${activeId}"]`);
            if (activeLink) {
                activeLink.classList.add('active');
                // Keep the active item vertically centered in the sidebar so
                // there's always context above and below it. scrollIntoView
                // walks up to the nearest scrollable ancestor (the sidebar),
                // so the main content stays put — no scroll-jacking.
                activeLink.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        }
    }

    toggleSidebar() {
        if (window.innerWidth <= 768) {
            if (this.sidebar.classList.contains('visible')) {
                this.hideSidebar();
            } else {
                this.showSidebar();
            }
        } else {
            this.sidebar.classList.toggle('hidden');
        }
    }

    showSidebar() {
        this.sidebar.classList.add('visible');
        this.sidebar.classList.remove('hidden');
        if (this.overlay) this.overlay.classList.add('visible');
    }

    hideSidebar() {
        if (window.innerWidth <= 768) {
            this.sidebar.classList.remove('visible');
            this.sidebar.classList.add('hidden');
            if (this.overlay) this.overlay.classList.remove('visible');
        }
    }
}

// Lightbox: click any timeline image to open it full-size in a modal overlay.
// Vanilla JS, no dependencies. The overlay is created lazily on first open
// and reused thereafter. Closes on click anywhere, Esc, or clicking the
// close button. The full-resolution image (img.src) is shown — we don't
// need a separate "large version" because the timeline images are already
// at native resolution; CSS just renders them smaller in the page flow.
class Lightbox {
    constructor() {
        this.overlay = null;
        this.imgEl = null;
        this.captionEl = null;
        this.init();
    }

    init() {
        // Event delegation: a single click handler on the document catches
        // clicks on any timeline image now or later (handles future content).
        document.addEventListener('click', (e) => {
            const img = e.target.closest('#subtab-timeline img');
            if (!img) return;
            e.preventDefault();
            this.open(img);
        });

        // Esc closes whether or not focus is in the overlay.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.overlay && this.overlay.classList.contains('visible')) {
                this.close();
            }
        });
    }

    ensureOverlay() {
        if (this.overlay) return;
        const overlay = document.createElement('div');
        overlay.className = 'lightbox-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.innerHTML = `
            <button class="lightbox-close" aria-label="Close image">×</button>
            <img class="lightbox-image" alt="" />
            <div class="lightbox-caption"></div>
        `;
        document.body.appendChild(overlay);

        this.overlay = overlay;
        this.imgEl = overlay.querySelector('.lightbox-image');
        this.captionEl = overlay.querySelector('.lightbox-caption');

        // Close on backdrop click (but not when clicking the image itself).
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.classList.contains('lightbox-close')) {
                this.close();
            }
        });
    }

    open(srcImg) {
        this.ensureOverlay();
        this.imgEl.src = srcImg.src;
        this.imgEl.alt = srcImg.alt || '';
        // Caption: prefer figcaption sibling, fall back to alt text.
        const figcap = srcImg.closest('figure')?.querySelector('figcaption');
        const caption = figcap ? figcap.textContent : (srcImg.alt || '');
        this.captionEl.textContent = caption;
        this.captionEl.style.display = caption ? '' : 'none';
        // Lock body scroll while open
        document.body.style.overflow = 'hidden';
        // Trigger transition by adding class on next frame
        requestAnimationFrame(() => this.overlay.classList.add('visible'));
    }

    close() {
        if (!this.overlay) return;
        this.overlay.classList.remove('visible');
        document.body.style.overflow = '';
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Expose the TabManager instance so other scripts (e.g. js/search.js)
    // can call switchTab() to jump to a tab/subtab without re-implementing
    // the URL-hash and outline plumbing.
    window.__tabManager = new TabManager();
    new Lightbox();
});

// Handle window resize
window.addEventListener('resize', () => {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    if (window.innerWidth > 768) {
        sidebar.classList.remove('hidden');
        sidebar.classList.remove('visible');
        if (overlay) overlay.classList.remove('visible');
    } else {
        sidebar.classList.remove('visible');
        sidebar.classList.add('hidden');
        if (overlay) overlay.classList.remove('visible');
    }
});
