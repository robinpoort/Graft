// Graft — content.js
// Swaps a stylesheet or a script for a local file.
//
// A stylesheet is swapped in place, live: the original <link> stays where it is, switched
// off, and a <style> holding the file goes in right after it, so nothing moves in the
// cascade. Every change the panel stores is applied the moment it lands.
//
// A script cannot be taken back once it has run, so it is swapped before it runs: its src
// is pointed at the local file before the parser gets to it. A change to a script reloads
// the page.
//
// A plain IIFE, not a module: a content script cannot use `import`. That is why
// normalize() is written out a second time in overrides.js.

(() => {
  // Registered for every page, and injected again by the panel into a tab that was open
  // before the permission was granted. Once is enough.
  if (window.__graftLoaded) return;
  window.__graftLoaded = true;

  const KEY = `site:${location.hostname}`;
  const LINKS = 'link[rel~="stylesheet" i][href]';

  function normalize(href) {
    try {
      const url = new URL(href, location.href);
      return url.origin + url.pathname;
    } catch {
      return null;
    }
  }

  /** The address a script was loaded from, also once it has been pointed at ours. */
  const scriptSource = (script) => script.dataset.graftSrc || script.src;

  /* ================================================================= scripts */

  /**
   * The scripts to swap, mirrored into the page's own localStorage.
   *
   * A script has to be swapped before the parser runs it, and the parser does not wait for
   * chrome.storage: by the time it answers, every script in <head> has run. localStorage
   * answers on the spot. So this keeps a copy there — the enabled script overrides for
   * this site and nothing else — and chrome.storage stays the one the panel writes to. The
   * page can read the copy; it is your own file, on your own screen.
   */
  const MIRROR = 'graft:scripts';

  /** Two reloads for the same files within this long means the copy is not sticking. */
  const RELOAD_GUARD_MS = 10000;
  const RELOAD_KEY = 'graft:reload';

  function readMirror() {
    try {
      return JSON.parse(localStorage.getItem(MIRROR)) || {};
    } catch {
      return {};
    }
  }

  /** Returns whether the copy is there now, read back rather than assumed. */
  function writeMirror(scripts) {
    try {
      const value = JSON.stringify(scripts);
      if (value === '{}') localStorage.removeItem(MIRROR);
      else localStorage.setItem(MIRROR, value);
      return (localStorage.getItem(MIRROR) || '{}') === value;
    } catch {
      // Over the site's quota, or storage switched off.
      return false;
    }
  }

  /** Enough to tell one save from the next without comparing whole bundles. */
  const signature = (entry) => (entry ? `${entry.name}|${entry.lastModified}|${entry.code?.length ?? 0}` : '');

  let mirror = readMirror();
  let scriptObserver = null;
  const blobs = new Map(); // signature → blob URL

  /**
   * A blob: URL rather than an inline script, so the element keeps everything else it had:
   * `defer` still waits for the document, `async` still does not block, a nonce still
   * counts, and the parser still waits for it before running the next one.
   *
   * The sourceURL names it in DevTools, where a stack trace would otherwise point at a
   * random blob id.
   */
  function blobFor(entry) {
    const key = signature(entry);
    if (!blobs.has(key)) {
      const code = `${entry.code}\n//# sourceURL=graft:///${entry.name}`;
      blobs.set(key, URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    }
    return blobs.get(key);
  }

  /**
   * Whether the parser is the one adding this script, which is the only case where the
   * swap is in time. A script added by another script has been started on insertion,
   * before any observer hears of it: changing its src then changes nothing, and marking it
   * as swapped would be a lie. Two signs give one away: the document has finished parsing,
   * or the element carries the force-async flag every script-created script starts with
   * (`async` true without the attribute).
   */
  const parserInserted = (script) =>
    document.readyState === 'loading' && !(script.async && !script.hasAttribute('async'));

  function swapScript(script) {
    if (script.dataset.graftSrc || !script.src || !parserInserted(script)) return;
    const original = script.src;
    const entry = mirror[normalize(original)];
    if (!entry) return;

    script.dataset.graftSrc = original;
    script.dataset.graft = entry.name;
    // The hash belongs to the deployed file. Ours would fail it, and not run at all.
    script.removeAttribute('integrity');
    script.src = blobFor(entry);

    // A site whose Content Security Policy does not allow blob: blocks it. Then the
    // original runs after all — later than it would have, but a page with its script is
    // better than a page without — and the panel says why.
    script.addEventListener('error', () => {
      script.dataset.graftBlocked = '';
      const fallback = document.createElement('script');
      for (const { name, value } of script.attributes) {
        if (!/^(src|integrity|data-graft.*)$/.test(name)) fallback.setAttribute(name, value);
      }
      // Chrome hides a nonce from getAttribute once the element is in the page.
      fallback.nonce = script.nonce;
      fallback.async = false;
      fallback.src = original;
      script.after(fallback);
      report();
    }, { once: true });
  }

  /**
   * The parser hands every <script> to the observers before it runs it: it stops for a
   * microtask checkpoint at each closing </script> tag. That checkpoint is the whole trick.
   */
  function watchScripts() {
    if (scriptObserver || !Object.keys(mirror).length) return;
    scriptObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node.nodeName === 'SCRIPT') swapScript(node);
      }
    });
    scriptObserver.observe(document, { childList: true, subtree: true });
  }

  /**
   * What chrome.storage says against what the page ran. If a script on this page should
   * have been different, the copy is brought up to date and the page reloaded, so it runs
   * the right one from the top. A script that is not on this page only needs the copy.
   */
  function syncScripts(site) {
    const fresh = {};
    for (const [match, entry] of Object.entries(site)) {
      if (entry.type === 'js' && entry.enabled) fresh[match] = { name: entry.name, code: entry.code, lastModified: entry.lastModified };
    }

    const all = new Set([...Object.keys(fresh), ...Object.keys(mirror)]);
    const changed = [...all].filter((match) => signature(fresh[match]) !== signature(mirror[match]));
    if (!changed.length) {
      // The copy stuck: whatever reload brought us here worked, and the next one may too.
      try { sessionStorage.removeItem(RELOAD_KEY); } catch {}
      return;
    }

    const onPage = new Set([...document.querySelectorAll('script[src]')].map((s) => normalize(scriptSource(s))));
    if (!writeMirror(fresh)) {
      console.warn('[Graft] Could not keep a copy of the scripts in this site’s localStorage, so they cannot be swapped here.');
      return;
    }
    mirror = fresh;
    watchScripts();
    if (!changed.some((match) => onPage.has(match))) return;

    // A site that empties its localStorage on every load would otherwise reload forever:
    // the same files asked for twice in a row, without a load in between that found its
    // copy, is the sign. The guard is cleared by the first load that does find it.
    const stamp = [...all].map((match) => signature(fresh[match])).join(';');
    try {
      const [last, at] = JSON.parse(sessionStorage.getItem(RELOAD_KEY)) || [];
      if (last === stamp && Date.now() - at < RELOAD_GUARD_MS) {
        console.warn('[Graft] This site keeps losing the copy of the scripts in its localStorage, so they cannot be swapped here.');
        return;
      }
      sessionStorage.setItem(RELOAD_KEY, JSON.stringify([stamp, Date.now()]));
    } catch {
      return;
    }
    location.reload();
  }

  /* ============================================================= stylesheets */

  /**
   * How the original is switched off: a media query that matches nothing.
   *
   * Not `disabled`, which was the first version. Chrome does not fetch a disabled
   * stylesheet, so switching back to the original started the download only then, and
   * the page sat there unstyled until it arrived. A sheet whose media matches nothing is
   * still fetched and kept, it just applies to nothing — so switching back is instant.
   * It also stops being render-blocking, which suits a sheet nobody is going to see.
   */
  const OFF = 'not all';

  /** Link → the <style> standing in for it. */
  const styles = new WeakMap();

  /** Link → its own media attribute, to put back. `null` when it had none at all. */
  const media = new WeakMap();

  /** Base URL → the file with its paths resolved, so a save is resolved once, not per link. */
  const absolutized = new Map();

  let overrides = {};
  let linkObserver = null;

  /**
   * The <style> lives in the page, so a relative url() or @import in it would resolve
   * against the page instead of against the stylesheet it replaces — and every font and
   * background image with a path like `../img/` would quietly go missing. So they are made
   * absolute, against the original's own address.
   */
  function absolutize(css, base) {
    const resolve = (match, path, build) => {
      path = path.trim();
      // Already absolute, protocol-relative, a data: URI or an SVG fragment: leave it.
      if (!path || /^([a-z][\w+.-]*:|\/\/|#)/i.test(path)) return match;
      try {
        return build(new URL(path, base).href);
      } catch {
        return match;
      }
    };
    return css
      .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, path) =>
        resolve(match, path, (url) => `url(${quote}${url}${quote})`))
      .replace(/@import\s+(['"])(.*?)\1/gi, (match, quote, path) =>
        resolve(match, path, (url) => `@import ${quote}${url}${quote}`));
  }

  function cssFor(override, base) {
    const hit = absolutized.get(base);
    if (hit?.source === override.code) return hit.css;
    // Named in DevTools, where the rules would otherwise come from "(index)".
    const css = `${absolutize(override.code, base)}\n/*# sourceURL=graft:///${override.name} */`;
    absolutized.set(base, { source: override.code, css });
    return css;
  }

  /**
   * Switches the original off and returns the media it is meant to have.
   *
   * The page may set media itself later on: `media="print" onload="this.media='all'"` is
   * how a lot of sites load CSS without blocking. Whatever it sets becomes the value to put
   * back, and to give the <style>, and the link is switched off again.
   */
  function silence(link) {
    const own = link.getAttribute('media');
    if (own === OFF) return media.get(link) ?? null;
    media.set(link, own);
    link.setAttribute('media', OFF);
    return own;
  }

  function restore(link) {
    const own = media.get(link);
    media.delete(link);
    if (own == null) link.removeAttribute('media');
    else link.setAttribute('media', own);
  }

  /** Returns whether the link is showing a local file now. */
  function applyTo(link) {
    const override = link.isConnected && link.matches(LINKS) && overrides[normalize(link.href)];
    const style = styles.get(link);

    if (override?.enabled && override.type === 'css') {
      const own = silence(link);
      const swap = style || document.createElement('style');
      styles.set(link, swap);
      if (own) swap.media = own;
      else swap.removeAttribute('media');
      swap.dataset.graft = override.name;
      const css = cssFor(override, link.href);
      if (swap.textContent !== css) swap.textContent = css;
      if (link.nextSibling !== swap) link.after(swap);
      return true;
    }

    if (style) {
      styles.delete(link);
      restore(link);
      // The original back and ours out in the same task, so there is no frame with
      // neither. Only if the original has arrived, though: a link switched back while it
      // is still downloading keeps the local file up until it is there.
      if (link.sheet) {
        style.remove();
      } else {
        link.addEventListener('load', () => style.remove(), { once: true });
        link.addEventListener('error', () => style.remove(), { once: true });
      }
    }
    return false;
  }

  /**
   * A link added later, a link whose href the page swaps itself (a theme switcher), or a
   * link the page takes out: all of them go through applyLinks again. Our own changes come
   * back through here too, and settle on the second pass, which finds nothing to do.
   */
  function onLinkMutations(records) {
    let changed = false;
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target.nodeName === 'LINK') changed = true;
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeName === 'LINK') changed = true;
      }
      for (const node of record.removedNodes) {
        if (!styles.has(node)) continue;
        styles.get(node).remove();
        styles.delete(node);
        changed = true;
      }
    }
    if (changed) applyLinks();
  }

  function applyLinks() {
    for (const link of document.querySelectorAll(LINKS)) applyTo(link);
    report();
  }

  /* ================================================================== shared */

  /**
   * Starts at 0 because a navigation clears the badge: a page that swaps nothing has
   * nothing to say, and the worker is not woken for every page load in every tab.
   */
  let reported = 0;

  function report() {
    const links = [...document.querySelectorAll(LINKS)].filter((link) => styles.has(link)).length;
    const scripts = document.querySelectorAll('script[data-graft]:not([data-graft-blocked])').length;
    const count = links + scripts;
    if (count === reported) return;
    reported = count;
    chrome.runtime.sendMessage({ action: 'pageState', count }).catch(() => {
      // The extension was reloaded under this page. It will be back on the next load.
    });
  }

  /** Nothing is watched on a site that has nothing swapped, which is nearly all of them. */
  function setOverrides(value) {
    overrides = value || {};
    syncScripts(overrides);
    if (!linkObserver && Object.values(overrides).some((entry) => entry.type === 'css')) {
      linkObserver = new MutationObserver(onLinkMutations);
      linkObserver.observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href', 'rel', 'media'],
      });
    }
    applyLinks();
  }

  // Before anything else, and before the first await: this is the part that cannot wait.
  watchScripts();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) setOverrides(changes[KEY].newValue);
  });

  // A page restored from the back/forward cache does not run this script again, and its
  // badge went with the navigation away from it.
  addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    reported = 0;
    report();
  });

  // Scripts at the end of <body> are only parsed after this, so the badge is counted again
  // once they are all in.
  document.addEventListener('DOMContentLoaded', report);

  chrome.storage.local.get(KEY).then((result) => setOverrides(result[KEY]));
})();
