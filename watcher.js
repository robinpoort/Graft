/**
 * Following the chosen files, from the worker: with the panel open and with it closed.
 *
 * The panel used to do this itself, and closing it was the end of it — not only because it
 * stopped looking, but because Chrome forgets your OK for a file the moment nothing holds
 * on to it any more. Opened again, the panel had to ask for it again. The worker holds the
 * files instead, so the OK stays for as long as the browser runs, and every save reaches
 * the page whether the panel is open or not.
 *
 * Holding a file means staying awake: a worker Chrome stops lets go of everything. Chrome
 * stops a worker after 30 seconds without an event or a call to an extension API, so while
 * there is a file to follow, every look makes such a call. With nothing to follow — nothing
 * chosen, everything switched off, or a browser restart that took the OK with it — there is
 * no timer, and the worker goes to sleep as usual.
 *
 * The worker is also the one that stores, for the panel too: it asks with a message, the
 * worker changes the site, one change after another. With two writers, a save landing in
 * the same moment as a click could have written the switch you just flipped straight back.
 */

import { siteKey, updateSite } from './overrides.js';
import { getHandle } from './handles.js';

/** How often a followed file is looked at. Nobody saves faster than once a second. */
const WATCH_MS = 1000;

const SITE = /^site:/;

/** The changes the panel can ask for, by name. */
const CHANGES = {
  set: (site, match, entry) => { site[match] = entry; },
  enable: (site, match, enabled) => { if (site[match]) site[match].enabled = enabled; },
  remove: (site, match) => { delete site[match]; },
};

/** `host match` → { host, match, handle, lastModified }, for every file being followed. */
const following = new Map();
let timer = 0;
let looking = false;

/** One site's files at a time, in turn: a save and a click must not rebuild the list at once. */
let rebuilds = Promise.resolve();
const inTurn = (task) => (rebuilds = rebuilds.then(task).catch(() => {}));

/**
 * What can be followed on one site: the files that are switched on and that Chrome lets
 * Graft read. A file Chrome wants your OK for again is left alone until the panel has it;
 * the panel then says so, and this runs again.
 */
async function followSite(host, site = {}) {
  const next = await Promise.all(Object.entries(site)
    .filter(([, override]) => override.enabled)
    .map(async ([match, override]) => {
      const handle = await getHandle(host, match);
      const state = await handle?.queryPermission({ mode: 'read' }).catch(() => 'denied');
      return state === 'granted' && { host, match, handle, lastModified: override.lastModified };
    }));
  // The new handles are in hand before the old ones go, so the file is held all along.
  for (const key of [...following.keys()]) if (key.startsWith(`${host} `)) following.delete(key);
  for (const entry of next) if (entry) following.set(`${host} ${entry.match}`, entry);
  keepTime();
}

/** Every site, from the top: when the worker starts, and when the panel was given an OK. */
function followAll() {
  return inTurn(async () => {
    const stored = await chrome.storage.local.get(null);
    const hosts = new Set([
      ...Object.keys(stored).filter((key) => SITE.test(key)).map((key) => key.replace(SITE, '')),
      ...[...following.values()].map((entry) => entry.host),
    ]);
    for (const host of hosts) await followSite(host, stored[siteKey(host)]);
  });
}

function keepTime() {
  if (following.size && !timer) timer = setInterval(look, WATCH_MS);
  if (!following.size && timer) {
    clearInterval(timer);
    timer = 0;
  }
}

/**
 * One look at every followed file. Only the date Chrome gives the file is compared; reading
 * a whole bundle every second to find out nothing happened would be the expensive way to
 * learn the same thing.
 */
async function look() {
  if (looking) return;
  looking = true;
  // The call that tells Chrome the worker is busy. Its answer is of no interest.
  chrome.runtime.getPlatformInfo().catch(() => {});

  try {
    for (const entry of [...following.values()]) {
      let file;
      try {
        if (await entry.handle.queryPermission({ mode: 'read' }) !== 'granted') {
          // Taken back. The panel asks for it again, and says why.
          following.delete(`${entry.host} ${entry.match}`);
          continue;
        }
        file = await entry.handle.getFile();
      } catch {
        // Moved or deleted. The panel says so; the page keeps the last copy.
        continue;
      }
      if (file.lastModified === entry.lastModified) continue;

      let code;
      try {
        code = await file.text();
      } catch {
        // Caught halfway through a save. The next look gets the finished file.
        continue;
      }
      // Only over the copy this file wrote last: another file chosen in the meantime is
      // not this one's to overwrite.
      const before = entry.lastModified;
      await updateSite(entry.host, (site) => {
        const override = site[entry.match];
        if (override?.enabled && override.lastModified === before) Object.assign(override, { code, lastModified: file.lastModified });
      });
      entry.lastModified = file.lastModified;
    }
  } finally {
    looking = false;
    keepTime();
  }
}

/** Any change to a site — a save, a switch, another file — and its list is made again. */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (SITE.test(key)) inTurn(() => followSite(key.replace(SITE, ''), newValue));
  }
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // From the panel only: a page has no business changing what is swapped.
  if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return;

  if (message?.action === 'follow') followAll();

  if (message?.action === 'store' && CHANGES[message.kind]) {
    updateSite(message.host, (site) => CHANGES[message.kind](site, message.match, message.value))
      .then(reply, () => reply(null));
    return true;
  }
});

followAll();
