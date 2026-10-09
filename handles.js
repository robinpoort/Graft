/**
 * The files themselves, as handles from the file picker, so the panel can keep reading
 * them after the picker has closed — and after the panel has, too.
 *
 * IndexedDB rather than chrome.storage: a handle can be stored, but only as a structured
 * clone, and chrome.storage only takes JSON.
 *
 * Keyed by site and stylesheet together. One stylesheet from a shared CDN can stand in two
 * sites at once, with a different local file for each.
 */

const key = (host, match) => `${host} ${match}`;

let db = null;

function open() {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('graft', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return db;
}

async function run(mode, action) {
  const store = (await open()).transaction('handles', mode).objectStore('handles');
  return new Promise((resolve, reject) => {
    const request = action(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const getHandle = (host, match) =>
  run('readonly', (store) => store.get(key(host, match))).catch(() => null);

export const putHandle = (host, match, handle) =>
  run('readwrite', (store) => store.put(handle, key(host, match)));

export const deleteHandle = (host, match) =>
  run('readwrite', (store) => store.delete(key(host, match))).catch(() => {});
