/**
 * The coordinator: knows which tab is in front, lists its stylesheets and scripts, lets
 * you pick a local file for each or download the live one, and shows whether each picked
 * file is being followed.
 *
 * Following them is the worker's job (watcher.js), so it goes on with the panel closed, and
 * so is storing: every change made here is asked of the worker. content.js only reads the
 * overrides and applies whatever lands in storage, so a page is never ahead of what is
 * stored.
 */

import { t, time, uiLanguage } from './i18n.js';
import { AUTHOR, authorUrl } from './links.js';
import { ORIGINS, hasHostAccess } from './hostaccess.js';
import { normalize, loadSite, siteKey, changeSite } from './overrides.js';
import { getHandle, putHandle, deleteHandle } from './handles.js';
import { $, h, downloadIcon, checkIcon, showError, clearError, announce } from './ui.js';

/** How often the panel looks whether each chosen file can still be read. */
const LOOK_MS = 1000;

// file:// is left out on purpose: a page on disk has no deploy to wait for.
const canRun = (url) => /^https?:/i.test(url || '');

/** The two kinds of file, in the order the panel lists them. */
const TYPES = {
  css: {
    head: 'uiSheets',
    picker: { description: 'uiPickerType', accept: { 'text/css': ['.css'] } },
  },
  js: {
    head: 'uiScripts',
    picker: { description: 'uiPickerTypeJs', accept: { 'text/javascript': ['.js', '.mjs'] } },
  },
};

let tabId = null;
let host = '';
let favicon = '';
/** A favicon that failed to load stays hidden until the page has a different one. */
let failedFavicon = '';
/**
 * What is on the page, in document order: { type, match, url, swapped, blocked }. `match`
 * is the address without its query string, `url` the one the page actually loaded.
 */
let items = [];
/** What is stored for this host. Replaced as a whole, never edited in place. */
let site = {};
/** File → the handle it was picked with. */
const handles = new Map();
/** File → whether it can be read: 'granted', 'prompt', 'gone' or 'missing'. */
const access = new Map();

/** Tab switches and page loads arrive in bursts; only the last one gets to draw. */
let loadToken = 0;
let checking = false;

const nameOf = (match) => new URL(match).pathname.split('/').pop() || match;
const itemOf = (match) => items.find((item) => item.match === match);
const typeOf = (match) => site[match]?.type || itemOf(match)?.type || 'css';

const pickerTypes = (type) => [{
  description: t(TYPES[type].picker.description),
  accept: TYPES[type].picker.accept,
}];

/* ------------------------------------------------------------------- page */

function show(view) {
  $('#sp-access').hidden = view !== 'access';
  $('#sp-files').hidden = view !== 'files';
  $('#sp-rescan').hidden = view !== 'files';
}

/**
 * Chrome's own copy of the page's favicon, the one in the tab strip: no request to the
 * site, whatever format the site uses, and a globe when it has none. The site's own
 * favicon URL was the first version, and every SVG, every redirect and every favicon
 * behind a login came out as a broken image.
 */
function faviconFor(pageUrl) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', '32');
  return url.href;
}

function setHead(title, summary = '') {
  $('#sp-host').textContent = title;
  $('#sp-summary').textContent = summary;
  const icon = $('#sp-favicon');
  // Redrawn every time the list is, so a favicon that failed has to stay failed here
  // rather than be shown again as a broken image a second later.
  icon.hidden = !host || !favicon || favicon === failedFavicon;
  if (!icon.hidden && icon.getAttribute('src') !== favicon) icon.src = favicon;
}

/**
 * The page cannot be changed. The list goes and the error carries the panel on its own,
 * with Chrome's own words under ours when it gave any.
 */
function refuse(...reasons) {
  host = '';
  show(null);
  setHead(t('uiNoSite'));
  showError(t('uiErrCannotRun'), ...reasons);
}

/**
 * A tab that was open before the permission was granted, or before the extension was
 * loaded, never got the content script. Injecting it here is what makes a file picked now
 * show up without a reload. The script guards against running twice, so this costs nothing
 * when it is already there.
 *
 * Returns Chrome's own words on failure, and nothing at all on success.
 */
async function ensureContentScript(id) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] });
    return null;
  } catch (error) {
    return error?.message || String(error);
  }
}

/**
 * Every <link rel="stylesheet"> and every <script src> on the page, ours included: a
 * swapped one is still there, so it is listed like any other. A swapped script reports
 * the address it was loaded from, not the blob: it is running from now.
 */
async function scanPage(id) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: () => [
        ...[...document.querySelectorAll('link[rel~="stylesheet" i][href]')]
          .map((link) => ({ type: 'css', url: link.href })),
        ...[...document.querySelectorAll('script[src]')]
          .map((script) => ({
            type: 'js',
            url: script.dataset.graftSrc || script.src,
            swapped: script.dataset.graft != null,
            blocked: script.dataset.graftBlocked != null,
          })),
      ],
    });
    const seen = new Set();
    return (result || []).flatMap((item) => {
      const match = normalize(item.url);
      if (!match || !/^https?:/.test(match) || seen.has(match)) return [];
      seen.add(match);
      return [{ ...item, match }];
    });
  } catch {
    return [];
  }
}

async function loadTab() {
  const token = ++loadToken;
  const stale = () => token !== loadToken;

  if (!await hasHostAccess()) {
    if (stale()) return;
    host = '';
    setHead(t('uiAccessPending'));
    show('access');
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (stale()) return;
  if (!tab || !canRun(tab.url)) return refuse(t('uiErrInternalPages'));

  // The Web Store is https too, and only says no when something is injected into it.
  const failed = await ensureContentScript(tab.id);
  if (stale()) return;
  if (failed) return refuse(t('uiErrInternalPages'), failed);

  const nextHost = new URL(tab.url).hostname;
  const [nextItems, nextSite] = await Promise.all([scanPage(tab.id), loadSite(nextHost)]);
  const nextHandles = await Promise.all(Object.keys(nextSite).map(
    async (match) => [match, await getHandle(nextHost, match)]));
  if (stale()) return;

  clearError();
  if (nextHost !== host) access.clear();
  tabId = tab.id;
  host = nextHost;
  favicon = faviconFor(tab.url);
  items = nextItems;
  site = nextSite;
  handles.clear();
  for (const [match, handle] of nextHandles) if (handle) handles.set(match, handle);

  show('files');
  render();
  checkFiles();
}

/* -------------------------------------------------------------- the files */

/**
 * Asks the worker to store a change for `forHost` — `set`, `enable` or `remove` — and
 * redraws if that is still the site in front.
 */
async function store(forHost, kind, match, value) {
  const stored = await changeSite(forHost, kind, match, value);
  if (!stored || forHost !== host) return;
  site = stored;
  render();
}

/**
 * Whether one chosen file can be read, which is what the card shows. Only looking: the
 * worker is the one that reads it when it was saved, and stores it.
 */
async function readable(match, override) {
  const handle = handles.get(match);
  if (!handle) return 'missing';
  if (await handle.queryPermission({ mode: 'read' }) !== 'granted') return 'prompt';
  // Nothing to follow while it is switched off.
  if (!override.enabled) return 'granted';
  try {
    // The file as it is now, without reading it: enough to know it is still there.
    await handle.getFile();
  } catch {
    return 'gone';
  }
  return 'granted';
}

/** Only while the panel is open and in view: a hidden panel shows no one anything. */
async function checkFiles() {
  if (checking || !host || document.hidden) return;
  checking = true;
  const forHost = host;
  let changed = false;

  try {
    for (const [match, override] of Object.entries(site)) {
      const state = await readable(match, override);
      if (forHost !== host) return;
      if (access.get(match) === state) continue;
      access.set(match, state);
      changed = true;
    }
  } finally {
    checking = false;
  }

  if (changed) render();
}

/* ---------------------------------------------------------------- actions */

// Chrome remembers the folder per id, so every picker — open or save — starts where the
// last one ended. Download a file, then choose it: the second dialog opens beside it.
const PICKER_ID = 'graft';

async function choose(match) {
  const forHost = host;
  const type = typeOf(match);
  const pick = (startIn) => window.showOpenFilePicker({ id: PICKER_ID, startIn, types: pickerTypes(type) });

  let handle;
  try {
    // Next to the file it had before, when there was one.
    [handle] = await pick(handles.get(match));
  } catch (error) {
    if (error?.name === 'AbortError') return;
    // The file it would have started next to has gone. Anywhere will do then.
    try {
      [handle] = await pick();
    } catch {
      return;
    }
  }

  let file;
  let code;
  try {
    file = await handle.getFile();
    code = await file.text();
  } catch {
    return;
  }

  await putHandle(forHost, match, handle);
  if (forHost === host) {
    handles.set(match, handle);
    access.set(match, 'granted');
  }
  await store(forHost, 'set', match, { type, name: file.name, code, lastModified: file.lastModified, enabled: true });
  announce(t('uiStatusSwapped', nameOf(match), file.name));
}

/**
 * The live file, read by the page itself from its own cache: the very bytes the page got,
 * and Graft never has to talk to the site. That is also its limit — a file from another
 * host has to allow the page to read it, which most CDNs do and some do not.
 */
async function readLive(url) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [url],
    func: async (address) => {
      try {
        const response = await fetch(address, { cache: 'force-cache' });
        if (!response.ok) return { error: `${response.status} ${response.statusText}` };
        return { text: await response.text() };
      } catch (error) {
        return { error: error.message };
      }
    },
  });
  if (result?.error) throw new Error(result.error);
  return result.text;
}

/** One timer per button, so a second download does not cut the first one's tick short. */
const doneTimers = new WeakMap();

async function download(match, control) {
  const name = nameOf(match);
  clearError();

  let text;
  try {
    text = await readLive(itemOf(match)?.url || match);
  } catch (error) {
    return showError(t('uiErrDownload', name), t('uiErrDownloadWhy'), error.message);
  }

  // After the read rather than before it: a dialog first would leave an empty file behind
  // whenever the read then fails. The read comes from cache and is quick, well within the
  // few seconds Chrome allows between the click and the dialog.
  let handle;
  try {
    handle = await window.showSaveFilePicker({ id: PICKER_ID, suggestedName: name, types: pickerTypes(typeOf(match)) });
  } catch (error) {
    if (error?.name === 'AbortError') return;
    return showError(t('uiErrDownload', name), t('uiErrDownloadSlow'));
  }

  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();

  announce(t('uiStatusDownloaded', name));
  control.dataset.done = '';
  clearTimeout(doneTimers.get(control));
  doneTimers.set(control, setTimeout(() => delete control.dataset.done, 1500));
}

/**
 * After a browser restart Chrome may want your OK again before a file can be read. Note
 * the request is the first thing in here: an `await` before it would spend the click that
 * makes it allowed to ask. The worker then takes the file over, and holds on to it.
 */
async function grant(match) {
  const handle = handles.get(match);
  if (!handle || await handle.requestPermission({ mode: 'read' }) !== 'granted') return;
  access.set(match, 'granted');
  render();
  chrome.runtime.sendMessage({ action: 'follow' }).catch(() => {});
  checkFiles();
}

async function toggle(match, enabled) {
  await store(host, 'enable', match, enabled);
  announce(enabled
    ? t('uiStatusSwapped', nameOf(match), site[match]?.name || '')
    : t('uiStatusOriginal', nameOf(match)));
}

async function remove(match) {
  const forHost = host;
  handles.delete(match);
  access.delete(match);
  await store(forHost, 'remove', match);
  await deleteHandle(forHost, match);
  announce(t('uiStatusRemoved', nameOf(match)));
}

/**
 * The request is the first thing in here, for the same reason as in grant(). The worker
 * registers the content script off permissions.onAdded; all that is left to do here is
 * load the tab again.
 */
async function allow() {
  clearError();
  const granted = await chrome.permissions.request(ORIGINS);
  if (!granted) return showError(t('uiErrNoAccess'), t('uiErrNoAccessWhy'));
  loadTab();
}

/* ----------------------------------------------------------------- render */

function stateOf(match, override) {
  const saved = time(override.lastModified);
  const js = override.type === 'js';
  const item = itemOf(match);
  if (!override.enabled) return { pill: t('uiStateOff'), note: t(js ? 'uiNoteOffJs' : 'uiNoteOff') };

  // A script can be chosen and still not have been swapped: the page says which.
  if (js && item?.blocked) return { pill: t('uiStateNotSwapped'), tone: 'error', note: t('uiNoteBlocked') };
  if (js && item && !item.swapped) return { pill: t('uiStateNotSwapped'), tone: 'warn', note: t('uiNoteLate') };

  switch (access.get(match)) {
    case 'granted': return { pill: t('uiStateLive'), tone: 'ok', note: t(js ? 'uiNoteLiveJs' : 'uiNoteLive', saved) };
    case 'prompt': return { pill: t('uiStateCopy'), tone: 'warn', note: t('uiNotePrompt', saved) };
    case 'gone': return { pill: t('uiStateMissing'), tone: 'error', note: t('uiNoteGone', saved) };
    case 'missing': return { pill: t('uiStateCopy'), tone: 'warn', note: t('uiNoteNoHandle', saved) };
    // Not looked at yet. A second from now it is one of the above.
    default: return { pill: t('uiStateCopy'), note: t('uiNoteCopy', saved) };
  }
}

const button = (action, label, className, describedBy) => h('button', {
  class: className,
  text: label,
  attrs: { type: 'button', 'data-action': action, 'aria-describedby': describedBy },
});

function renderCard(match, index) {
  const url = new URL(match);
  const name = nameOf(match);
  const folder = url.pathname.slice(0, url.pathname.length - name.length);
  const item = itemOf(match);
  // A file from somewhere else — a CDN, Google Fonts — says where it comes from.
  const where = (url.hostname === host ? '' : url.host) + folder;
  const path = item ? where : `${where} · ${t('uiNotOnPage')}`;
  const override = site[match];
  // Every card has the same buttons, so each one says which file it is about.
  const nameId = `sp-file-${index}`;

  const state = override && stateOf(match, override);
  const top = h('div', { class: 'sp-sheet__top' },
    h('div', { class: 'sp-sheet__text' },
      h('strong', { class: 'sp-sheet__name', text: name, attrs: { id: nameId, title: match } }),
      h('span', { class: 'sp-sheet__path', text: path })),
    state && h('span', { class: `sp-pill${state.tone ? ` sp-pill--${state.tone}` : ''}`, text: state.pill }),
    // Only what is on the page can be downloaded: the page is what reads it.
    item && h('button', {
      class: 'sp-iconbtn sp-iconbtn--small',
      attrs: { type: 'button', 'data-action': 'download', 'aria-label': t('uiDownload', name), title: t('uiDownloadTitle') },
    }, downloadIcon(), checkIcon()));

  if (!override) {
    return h('li', { class: 'sp-sheet', attrs: { 'data-match': match } },
      top,
      h('div', { class: 'sp-sheet__actions' },
        button('choose', t('uiChoose'), 'sp-btn sp-btn--ghost sp-btn--compact', nameId)));
  }

  // Live is good news and stays quiet; only what needs you is coloured.
  const noteTone = state.tone && state.tone !== 'ok' ? ` sp-note--${state.tone}` : '';

  return h('li', { class: `sp-sheet${override.enabled ? ' sp-sheet--on' : ''}`, attrs: { 'data-match': match } },
    top,
    h('div', { class: 'sp-sheet__local' },
      h('span', { class: 'sp-sheet__arrow', text: '↳', attrs: { 'aria-hidden': 'true' } }),
      h('span', { text: override.name })),
    h('p', { class: `sp-note${noteTone}`, text: state.note }),
    h('label', { class: 'sp-switch' },
      h('input', {
        attrs: { type: 'checkbox', 'data-action': 'toggle', 'aria-describedby': nameId },
        props: { checked: override.enabled },
      }),
      h('span', { text: t('uiUseFile') })),
    h('div', { class: 'sp-sheet__actions' },
      override.enabled && access.get(match) === 'prompt'
        && button('grant', t('uiAllowFile'), 'sp-btn sp-btn--compact', nameId),
      button('choose', t('uiChooseOther'), 'sp-btn sp-btn--ghost sp-btn--compact', nameId),
      button('remove', t('uiRemove'), 'sp-btn sp-btn--ghost sp-btn--compact sp-btn--remove', nameId)));
}

const count = (n, one, many) => (n === 1 ? t(one) : t(many, n));

/**
 * The list is drawn again as a whole, which is a handful of cards. Focus is put back on
 * the same control on the same card, or the first one on that card when the control has
 * gone — after Remove, say — so a keyboard never lands back at the top of the panel.
 */
function render() {
  const active = document.activeElement;
  const row = active?.closest?.('[data-match]');
  const focus = row && { match: row.dataset.match, action: active.dataset.action };

  const onPage = (type) => items.filter((item) => item.type === type).map((item) => item.match);
  const swapped = items.filter((item) => site[item.match]?.enabled && (item.type === 'css' || item.swapped)).length;
  // Only what there is: "0 scripts" on a page without any says nothing worth reading.
  const summary = [];
  if (onPage('css').length) summary.push(count(onPage('css').length, 'uiSummaryOne', 'uiSummaryMany'));
  if (onPage('js').length) summary.push(count(onPage('js').length, 'uiSummaryScriptsOne', 'uiSummaryScriptsMany'));
  if (swapped) summary.push(t('uiSummarySwapped', swapped));
  setHead(host, summary.join(' · '));

  // Per kind: the page's own files first, in its order, then anything chosen for a file
  // that is not on this page — you still need to be able to switch it off.
  let index = 0;
  const groups = Object.keys(TYPES).flatMap((type) => {
    const matches = [
      ...onPage(type),
      ...Object.keys(site).filter((match) => site[match].type === type && !itemOf(match)),
    ];
    if (!matches.length) return [];
    const headId = `sp-head-${type}`;
    return [h('section', { class: 'sp-group', attrs: { 'aria-labelledby': headId } },
      h('h2', { class: 'sp-section__head', attrs: { id: headId }, text: `${t(TYPES[type].head)} (${matches.length})` }),
      h('ul', { class: 'sp-sheets' }, matches.map((match) => renderCard(match, index++))))];
  });

  $('#sp-groups').replaceChildren(...groups);
  $('#sp-empty').hidden = groups.length > 0;
  $('#sp-hint').hidden = !Object.keys(site).length;

  if (!focus) return;
  const card = [...document.querySelectorAll('#sp-groups [data-match]')].find((li) => li.dataset.match === focus.match);
  (card?.querySelector(`[data-action="${focus.action}"]`) || card?.querySelector('[data-action]'))?.focus();
}

/* ------------------------------------------------------------------ start */

function applyStaticStrings() {
  // The panel is translated, so the document has to say which language it ended up in.
  document.documentElement.lang = uiLanguage();
  document.title = t('appShortName');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel));
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);

  const link = $('#sp-author');
  link.textContent = `${AUTHOR.name}, ${t('uiAuthorRole')}`;
  const url = authorUrl();
  // No page for it yet? Then no link at all, rather than one that lands on a 404.
  if (url) link.href = url;
  else link.replaceWith(h('span', { class: 'sp-foot__link', text: link.textContent }));
}

function start() {
  applyStaticStrings();

  // A favicon that will not load is no favicon.
  $('#sp-favicon').addEventListener('error', (event) => {
    failedFavicon = event.target.getAttribute('src');
    event.target.hidden = true;
  });

  $('#sp-allow').addEventListener('click', allow);
  $('#sp-rescan').addEventListener('click', loadTab);

  $('#sp-groups').addEventListener('click', (event) => {
    const control = event.target.closest('button[data-action]');
    if (!control) return;
    const { match } = control.closest('[data-match]').dataset;
    if (control.dataset.action === 'choose') choose(match);
    if (control.dataset.action === 'download') download(match, control);
    if (control.dataset.action === 'grant') grant(match);
    if (control.dataset.action === 'remove') remove(match);
  });

  $('#sp-groups').addEventListener('change', (event) => {
    if (event.target.dataset.action !== 'toggle') return;
    toggle(event.target.closest('[data-match]').dataset.match, event.target.checked);
  });

  // The panel stays open while you browse, so it follows the tab in front.
  chrome.tabs.onActivated.addListener(loadTab);
  // The tab on show as well as the active one: a script swap reloads the page, and the
  // list has to catch up with it even when you clicked into the panel to make it.
  chrome.tabs.onUpdated.addListener((id, changeInfo, tab) => {
    if ((tab.active || id === tabId) && (changeInfo.status === 'complete' || changeInfo.url)) loadTab();
  });
  chrome.permissions.onAdded.addListener(loadTab);
  chrome.permissions.onRemoved.addListener(loadTab);

  // Every save the worker stores, so the card says when the file was saved last.
  chrome.storage.onChanged.addListener((changes, area) => {
    const change = changes[siteKey(host)];
    if (area !== 'local' || !host || !change) return;
    site = change.newValue || {};
    render();
  });

  setInterval(checkFiles, LOOK_MS);
  loadTab();
  // The worker may have been stopped since it last held the files; this wakes it to look.
  chrome.runtime.sendMessage({ action: 'follow' }).catch(() => {});
}

start();
