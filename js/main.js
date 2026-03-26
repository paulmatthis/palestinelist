// Tab management
class TabManager {
    constructor() {
        this.activeTab = 'home';
        this.sidebar = document.getElementById('sidebar');
        this.contentArea = document.getElementById('content-area');
        this.hamburger = document.getElementById('hamburger');
        this.sidebarClose = document.getElementById('sidebar-close');
        this.outlineNav = document.getElementById('outline-nav');

        this.init();
    }

    init() {
        // Create overlay for mobile bottom sheet
        this.overlay = document.createElement('div');
        this.overlay.className = 'sidebar-overlay';
        document.body.appendChild(this.overlay);
        this.overlay.addEventListener('click', () => this.hideSidebar());

        // Set up tab buttons
        document.querySelectorAll('.tab-button').forEach(button => {
            button.addEventListener('click', (e) => {
                const tab = e.target.closest('.tab-button').dataset.tab;
                if (tab) this.switchTab(tab);
            });
        });

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

        // Initialize first tab
        this.switchTab('home');

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

    switchTab(tabName) {
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
        document.querySelector(`[data-tab="${tabName}"]`)?.classList.add('active');

        this.activeTab = tabName;

        // Update outline
        this.generateOutline(tabName);

        // Scroll to top
        this.contentArea.scrollTop = 0;

        // Hide sidebar on mobile
        this.hideSidebar();
    }

    generateOutline(tabName) {
        const tab = document.getElementById(`tab-${tabName}`);
        if (!tab) return;

        const headings = tab.querySelectorAll('h3, h4, h5');
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
                    this.updateActiveOutlineItem();
                }
            });

            this.outlineNav.appendChild(link);
        });

        this.updateActiveOutlineItem();
    }

    updateActiveOutlineItem() {
        const contentTop = this.contentArea.scrollTop + 100;
        let activeId = null;

        document.querySelectorAll(`#tab-${this.activeTab} h3, #tab-${this.activeTab} h4, #tab-${this.activeTab} h5`).forEach(heading => {
            const headingTop = heading.offsetTop - this.contentArea.offsetTop;
            if (headingTop <= contentTop) {
                activeId = heading.id;
            }
        });

        document.querySelectorAll('.outline-item').forEach(item => {
            item.classList.remove('active');
        });

        if (activeId) {
            document.querySelector(`a[href="#${activeId}"]`)?.classList.add('active');
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

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new TabManager();
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

