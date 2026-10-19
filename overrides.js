/**
 * Which files are swapped, and for what. Kept per site in chrome.storage.local:
 *
 *   `site:<hostname>` → { [file URL]: { type, name, code, lastModified, enabled } }
 *
 * `type` is 'css' or 'js'. The file's contents travel with it. content.js has to swap a
 * stylesheet before the page paints and a script before the page runs it, on every load,
 * with or without the panel open — and storage is the only thing of ours it can reach. A
 * file handle is no use to it: a page cannot read your disk.
 *
 * `unlimitedStorage`, because a compiled stylesheet with a few fonts inlined, or a bundle,
 * is a megabyte before anyone notices, and the default quota is ten for every site
 * together.
 */

export const siteKey = (host) => `site:${host}`;

/**
 * The URL without its query string. `style.css?ver=6.4` and `style.css?ver=6.5` are the
 * same sheet one deploy apart, and a cache-buster must not lose you your override.
 *
 * Written out a second time in content.js, which cannot import it.
 */
export function normalize(href) {
  try {
    const url = new URL(href);
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}

export async function loadSite(host) {
  try {
    return (await chrome.storage.local.get(siteKey(host)))[siteKey(host)] || {};
  } catch {
    return {};
  }
}

/**
 * Every write is read, changed and written back in turn. The file watcher and a click can
 * otherwise both read the same site, and whichever writes last throws the other's change
 * away. Resolves to the site as stored.
 *
 * Only the worker calls this. The panel asks it with `changeSite`, so all writes are in the
 * one queue.
 */
let writes = Promise.resolve();

export function updateSite(host, mutate) {
  const key = siteKey(host);
  const task = writes.then(async () => {
    const site = (await chrome.storage.local.get(key))[key] || {};
    mutate(site);
    // An empty site is no site: nothing left behind for content.js to read on every load.
    if (Object.keys(site).length) await chrome.storage.local.set({ [key]: site });
    else await chrome.storage.local.remove(key);
    return site;
  });
  writes = task.catch(() => {});
  return task;
}

/**
 * A change asked of the worker, which makes it: `set` a file's entry, `enable` it or not,
 * or `remove` it. Resolves to the site as stored, or null when the worker could not.
 */
export const changeSite = (host, kind, match, value) =>
  chrome.runtime.sendMessage({ action: 'store', host, kind, match, value }).catch(() => null);
