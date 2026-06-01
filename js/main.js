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
    'supplements': ['solidarity', 'liberation', 'genocide', 'timeline']
};

// Old subtab slugs that should resolve to a current one. Useful when a
// subtab is renamed — links shared on the old URL keep working, and the
// browser silently rewrites them to the canonical hash on landing.
const SUBTAB_ALIASES = {
    'supplements': {
        'globalsolidarity': 'solidarity'
    }
};

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

        // React to browser back/forward and to someone editing the URL hash.
        window.addEventListener('hashchange', () => this.syncTabFromHash());

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

        // Initialize first tab/subtab based on URL hash. Falls back to 'home'
        // for empty/unknown hashes. Skip URL update on initial call so landing
        // on "/" doesn't rewrite to "/#home".
        const parsed = this.parseHash();
        const initialTab = parsed.tab || 'home';
        this.switchTab(initialTab, { updateHash: false, subtab: parsed.subtab, section: parsed.section });

        // If the user landed on an aliased or non-canonical hash (e.g.
        // #supplements/globalsolidarity), silently rewrite the address bar to
        // the canonical form. We use replaceState so we don't push a junk
        // history entry for the old URL.
        if (parsed.tab) {
            this.canonicalizeHash();
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

        // Sync URL hash so users can copy the current tab's link from the address bar.
        if (updateHash) {
            this.writeHash();
        }
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
        if (updateHash) this.writeHash();
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

    syncTabFromHash() {
        const parsed = this.parseHash();
        if (!parsed.tab) return;
        if (parsed.tab !== this.activeTab) {
            // Don't re-push the hash we just read from.
            this.switchTab(parsed.tab, { updateHash: false, subtab: parsed.subtab, section: parsed.section });
        } else if (parsed.subtab && parsed.subtab !== this.activeSubtab) {
            this.switchSubtab(parsed.subtab, { updateHash: false });
            if (parsed.section) this.scrollToSection(parsed.section);
        } else if (parsed.section) {
            // Already on the right tab/subtab — just scroll to the section.
            this.scrollToSection(parsed.section);
        }
    }

    // The canonical hash string for the current activeTab/activeSubtab.
    // Tabs with subtabs always include the active subtab in the URL
    // (so "#supplements/solidarity", not bare "#supplements"). A bare
    // "#supplements" still resolves on landing — see parseHash — and gets
    // rewritten to the explicit form by canonicalizeHash.
    canonicalHash() {
        const tabHash = TAB_TO_HASH[this.activeTab];
        if (!tabHash) return null;
        if (this.activeSubtab) {
            return `#${tabHash}/${this.activeSubtab}`;
        }
        return `#${tabHash}`;
    }

    // Push the canonical hash. Used when the user actively navigates so
    // back/forward gets a history entry for each navigation.
    writeHash() {
        const newHash = this.canonicalHash();
        if (newHash && window.location.hash !== newHash) {
            history.pushState(null, '', newHash);
        }
    }

    // Replace (not push) the address bar with the canonical hash. Called once
    // on landing if the URL is non-canonical (e.g. an aliased subtab slug)
    // so we don't pollute history with the rewritten entry.
    canonicalizeHash() {
        // Don't rewrite modal hashes (owned by js/books.js); landing on
        // #book/<isbn> etc. must preserve the full fragment.
        if (MODAL_HASH_RE.test(window.location.hash)) return;
        // Don't rewrite a section deep-link (e.g. #techforpalestine) to the bare
        // tab hash — the section fragment must survive so the link keeps working.
        const raw = this.decodeHashPart((window.location.hash || '').replace(/^#/, ''));
        if (this.sectionIndex && this.sectionIndex.has(raw)) return;
        const canonical = this.canonicalHash();
        if (canonical && window.location.hash !== canonical) {
            history.replaceState(null, '', canonical);
        }
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
