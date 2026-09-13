/**
 * Cloudflare Worker: per-route social-preview metadata for the Supplements
 * subtabs (It's a Genocide, It's Apartheid, etc).
 *
 * The site's tab/subtab navigation is a client-side SPA (js/main.js), and
 * URL fragments (#...) are never sent to the server, so a crawler fetching
 * e.g. palestinelist.com/#supplements/genocide only ever sees the single
 * static <head> in index.html, no matter what follows the #. Real paths
 * like /supplements/genocide DO reach the server, so this Worker intercepts
 * just those known paths, fetches the origin's actual index.html (the single
 * source of truth for all page content), rewrites the title/meta tags in
 * its <head> to match that subtab, and returns it. Every other request on
 * the domain (/, /books, static assets, etc) is not matched by the route
 * below and never reaches this Worker at all.
 *
 * See README.md in this directory for deploy steps.
 */

const SUBTAB_META = {
  solidarity: {
    title: "Solidarity with Palestine",
    description: "Indigenous, Black American, and global solidarity movements standing with Palestine.",
  },
  liberation: {
    title: "Global Liberation",
    description: "Palestine in context with other liberation and anti-colonial struggles worldwide.",
  },
  genocide: {
    title: "It's a Genocide",
    description: "Courts, UN bodies, human rights organizations, and scholars who have found or recognized a genocide in Gaza.",
  },
  apartheid: {
    title: "It's Apartheid",
    description: "Courts, UN bodies, human rights organizations, and scholars who have found or asserted that Israel practices apartheid against Palestinians.",
  },
  timeline: {
    title: "Palestine Timeline",
    description: "An anticolonial timeline of Palestine from 1770 to the present.",
  },
};

// Matches the site's actual <title> tag (index.html). Kept as a literal
// string, not scraped, so a rewrite here can't silently break on a page
// fetch failure or an unexpected <title> format.
const SITE_TITLE_SUFFIX = "The Palestine List | Sources, Citations & Other Media for Start Here: Palestine";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/supplements\/([a-z]+)\/?$/);
    const meta = match && SUBTAB_META[match[1]];

    if (!meta) {
      // Not a known subtab path (shouldn't normally happen, since the Worker
      // route itself is scoped to /supplements/*, but stay safe). Pass the
      // request through untouched rather than guessing.
      return fetch(request);
    }

    // The SPA has one real document; fetch it fresh from the origin every
    // time so this never serves stale content relative to the live site.
    const originResponse = await fetch(new URL('/', url), {
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!originResponse.ok) return originResponse;

    const fullTitle = `${meta.title} | ${SITE_TITLE_SUFFIX}`;
    const canonicalUrl = `https://palestinelist.com/supplements/${match[1]}`;

    // index.html's CSS/JS/image references are relative ("css/styles.css",
    // "js/main.js"), fine when the page is served at "/", but this Worker
    // serves the SAME document at nested paths like "/supplements/genocide".
    // Left alone, the browser resolves those relative URLs against
    // "/supplements/" (dropping the last path segment), so every asset
    // 404s: unstyled page, and no JS at all (search, routing, everything
    // breaks). A <base> tag would fix this but has its own side effect: it
    // also changes how plain in-page anchors like <a href="#some-heading">
    // resolve, which would send anyone who clicks one of those (most aren't
    // JS-intercepted) to a full page reload at "/#some-heading" instead of
    // scrolling in place. Rewriting just these specific relative attributes
    // to absolute URLs fixes the asset loading without touching how any
    // anchor link resolves.
    const rewriteIfRelative = (attr) => ({
      element(el) {
        const value = el.getAttribute(attr);
        if (value && !/^(https?:)?\/\//i.test(value) && !value.startsWith('/')) {
          el.setAttribute(attr, `https://palestinelist.com/${value}`);
        }
      },
    });

    const rewriter = new HTMLRewriter()
      .on('link[href]', rewriteIfRelative('href'))
      .on('script[src]', rewriteIfRelative('src'))
      .on('img[src]', rewriteIfRelative('src'))
      .on('title', {
        element(el) { el.setInnerContent(fullTitle); },
      })
      .on('meta[name="description"]', {
        element(el) { el.setAttribute('content', meta.description); },
      })
      .on('meta[property="og:title"]', {
        element(el) { el.setAttribute('content', fullTitle); },
      })
      .on('meta[property="og:description"]', {
        element(el) { el.setAttribute('content', meta.description); },
      })
      .on('meta[property="og:url"]', {
        element(el) { el.setAttribute('content', canonicalUrl); },
      })
      .on('meta[name="twitter:title"]', {
        element(el) { el.setAttribute('content', fullTitle); },
      })
      .on('meta[name="twitter:description"]', {
        element(el) { el.setAttribute('content', meta.description); },
      })
      .on('link[rel="canonical"]', {
        element(el) { el.setAttribute('href', canonicalUrl); },
      });

    return rewriter.transform(originResponse);
  },
};
