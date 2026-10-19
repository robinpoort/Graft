/**
 * The extension in a real Chromium, headless: a test site with a stylesheet, a local file
 * chosen for it in the panel, and every save of that file checked on the page — with the
 * panel open, with it closed, and once it is opened again. The browser profile and the
 * copy of the extension it loads go to the system's temporary folder, not here.
 *
 *   cd test && npm install && npm test
 *
 * The file picker cannot be driven from a test, so the file is dropped on the panel
 * instead — Chrome hands over a file handle with read access, as the picker does — and the
 * picker is made to return that.
 */
const { chromium } = require('playwright');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SRC = path.resolve(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'graft-test');
fs.mkdirSync(OUT, { recursive: true });
const EXT = path.join(OUT, 'graft-granted');
fs.rmSync(EXT, { recursive: true, force: true });
// The extension as it ships, with the site access the panel would otherwise ask for.
fs.cpSync(SRC, EXT, { recursive: true, filter: (from) => !/^[/\\](test|\.git|node_modules)([/\\]|$)/.test(from.slice(SRC.length)) });
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
manifest.host_permissions = manifest.optional_host_permissions;
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));

const LOCAL = path.join(OUT, 'local.css');
const save = (color) => fs.writeFileSync(LOCAL, `h1 { color: ${color}; }\n`);

const server = http.createServer((req, res) => {
  if (req.url === '/style.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    return res.end('h1 { color: rgb(255, 0, 0); }');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A site</title><link rel="stylesheet" href="/style.css"></head><body><h1>Hello</h1></body></html>');
});

const ok = (cond, msg, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond && extra !== undefined) console.log('   ', JSON.stringify(extra).slice(0, 600)); if (!cond) process.exitCode = 1; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Asks `read` until it gives `want`, for up to `ms`; resolves to the last answer. */
const until = async (read, want, ms = 5000) => {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    last = await read();
    if (last === want) break;
  }
  return last;
};

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [];

  const profile = path.join(OUT, 'profile-' + Date.now());
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    locale: 'en-US',
    viewport: null,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--lang=en-US'],
  });
  // The panel runs in a tab here, so "the active tab" has to mean the site's.
  await context.addInitScript((pageBase) => {
    if (location.protocol !== 'chrome-extension:') return;
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async () => (await query({})).filter((tab) => (tab.url || '').startsWith(pageBase));
    window.showOpenFilePicker = async () => [window.__dropped];
  }, base);
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const panelUrl = `chrome-extension://${extId}/panel.html`;

  const site = context.pages()[0] || await context.newPage();
  await site.goto(`${base}/`);
  const colour = () => site.evaluate(() => getComputedStyle(document.querySelector('h1')).color);
  ok(await colour() === 'rgb(255, 0, 0)', 'the site as deployed: a red heading');

  const panel = await context.newPage();
  panel.on('pageerror', (e) => errors.push(e.message));
  panel.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const card = `[data-match="${base}/style.css"]`;
  const openPanel = async () => {
    await panel.goto(panelUrl);
    await panel.waitForSelector(card, { timeout: 10000 });
  };
  await openPanel();
  ok(!!await panel.$(`${card} [data-action="choose"]`), 'the panel lists the stylesheet, with a file to choose');

  /* ------------------------------------------------------- choosing the file */
  save('rgb(0, 128, 0)');
  await panel.evaluate(() => {
    document.addEventListener('dragover', (event) => event.preventDefault());
    document.addEventListener('drop', async (event) => {
      event.preventDefault();
      window.__dropped = await [...event.dataTransfer.items].find((item) => item.kind === 'file').getAsFileSystemHandle();
    });
  });
  const cdp = await context.newCDPSession(panel);
  const data = { items: [], files: [LOCAL], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: 20, y: 20, data });
  await panel.waitForFunction(() => window.__dropped, null, { timeout: 5000 });
  await panel.click(`${card} [data-action="choose"]`);
  ok(await until(colour, 'rgb(0, 128, 0)') === 'rgb(0, 128, 0)', 'chosen: the local file is on the page, without a reload');
  ok(await until(() => panel.$eval(`${card} .sp-pill`, (el) => el.textContent), 'Live') === 'Live', 'the card says Live');

  /* ------------------------------------------------------- saving, panel open */
  await wait(1100);
  save('rgb(0, 0, 255)');
  ok(await until(colour, 'rgb(0, 0, 255)') === 'rgb(0, 0, 255)', 'panel open: a save shows up on the page');
  const note = await panel.$eval(`${card} .sp-note`, (el) => el.textContent);
  ok(/\d:\d\d:\d\d/.test(note), `panel open: the card says when it was saved (${note})`);

  /* ----------------------------------------------------- saving, panel closed */
  // A closed side panel is a document gone without a tab of the extension closing. That
  // is what this does: the panel's tab goes to another page of the extension.
  await panel.goto(`chrome-extension://${extId}/manifest.json`);
  await wait(6000);
  save('rgb(128, 0, 128)');
  ok(await until(colour, 'rgb(128, 0, 128)') === 'rgb(128, 0, 128)', 'panel closed: a save still shows up on the page');
  await site.reload();
  ok(await colour() === 'rgb(128, 0, 128)', 'panel closed: and stays after a reload');

  /* ----------------------------------------------------- the panel opened again */
  await openPanel();
  const pill = await until(() => panel.$eval(`${card} .sp-pill`, (el) => el.textContent), 'Live');
  ok(pill === 'Live' && !await panel.$(`${card} [data-action="grant"]`), `opened again: still Live, no OK to give again (${pill})`);

  await panel.click(`${card} [data-action="toggle"]`);
  ok(await until(colour, 'rgb(255, 0, 0)') === 'rgb(255, 0, 0)', 'switched off: the original is back');
  await wait(1100);
  save('rgb(255, 165, 0)');
  await wait(1500);
  ok(await colour() === 'rgb(255, 0, 0)', 'switched off: a save changes nothing');
  await panel.click(`${card} [data-action="toggle"]`);
  ok(await until(colour, 'rgb(255, 165, 0)') === 'rgb(255, 165, 0)', 'switched on again: with the save made while it was off');

  await panel.click(`${card} [data-action="remove"]`);
  ok(await until(colour, 'rgb(255, 0, 0)') === 'rgb(255, 0, 0)', 'removed: the original is back');
  ok(await until(async () => !!await panel.$(`${card} [data-action="choose"]`), true), 'removed: the card offers a file to choose again');
  const stored = await sw.evaluate(() => chrome.storage.local.get(null));
  ok(!Object.keys(stored).length, 'removed: nothing left in storage', stored);

  ok(!errors.length, 'no errors in the panel', errors);

  await context.close();
  server.close();
  fs.rmSync(EXT, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
