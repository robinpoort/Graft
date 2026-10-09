# Graft

Chrome extension (MV3) that swaps a stylesheet or a script on a live site for a file on
your own computer. Pick the site's `style.css` or `app.js`, point it at the one in your
project, and every save shows up on the real page — real content, real images, real
everything else. No deploy, no staging, no waiting to find out a margin was wrong.

## Install

1. `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → pick this folder.
3. Pin the icon to the toolbar.

## Use

Click the icon. A side panel opens next to the page.

The first time, the panel asks for permission and says why (see **Permissions** below).
After that it lists every stylesheet and every script with a `src` on the page you are on,
in two groups, in the order the page loads them. A file from another host — a CDN, Google
Fonts — says where it comes from.

- **Choose a local file…** opens the file picker. A stylesheet switches to that file at
  once, without a reload; a script reloads the page, because a script that has run cannot
  be taken back.
- While the panel is open, every save of the file shows up on the page within a second: a
  stylesheet in place, a script with a reload. The card says **Live** and when the file was
  last saved, to the second, so you can tell the page is showing the save you just made.
- **Use this file** switches between your file and the original. For a stylesheet both
  ways are instant.
- **Other file…** picks a different one; **Remove** forgets it.
- The **download** button on every card saves the live file, so you have something to
  start from. The file picker remembers the folder, so **Choose a local file…** opens
  right beside what you just saved.

Close the panel and the page keeps the last copy, also after a reload. Open it again and
it catches up with whatever you saved in between.

Everything is kept per site, by hostname: a file chosen on `www.example.com` does nothing
on `example.com` or anywhere else. A file that has something chosen for it but is not on
the page you are looking at is still listed, marked as such, so you can switch it off.

While a tab shows a local file its badge says how many, because a page with your local CSS
looks exactly like a deployed one, and an hour later you will not remember which it was.

## How it works

### Stylesheets

`content.js` runs on every page at `document_start` and reads what is stored for that
hostname. For each `<link rel="stylesheet">` that has a file chosen for it, the link stays
exactly where it is, switched off, and a `<style>` holding the file goes in right after it.
Nothing moves in the cascade: the local file wins and loses against the same rules the
original did. A `MutationObserver` does the same for links added later, links whose `href`
the page changes itself, and links it takes out.

The original is switched off with `media="not all"`. The first version used `disabled`,
and switching back to the original was where that showed: Chrome does not fetch a
disabled stylesheet, so the download only started then, and the page sat unstyled for as
long as it took. A sheet whose media matches nothing is still fetched and kept — it just
applies to nothing — so switching back is the same frame. The original media is put back
as it was, and given to the `<style>` too. A page that sets media itself later
(`media="print" onload="this.media='all'"` is how a lot of sites load CSS without
blocking) has whatever it sets become the value to put back.

The `<style>` lives in the page, so a relative `url()` or `@import` in it would resolve
against the page instead of against the stylesheet it replaces, and every font and
background image with a path like `../img/` would quietly go missing. They are made
absolute against the original's address before the file goes in.

### Scripts

A script cannot be taken back once it has run, so it is swapped before it runs. The parser
stops for a microtask checkpoint at every closing `</script>` tag, which hands the element
to the observers before the script is fetched and run. In that moment its `src` is pointed
at a `blob:` URL holding the local file, and its `integrity` attribute goes: the hash
belongs to the deployed file. Everything else about the element stays, so `defer` still
waits for the document, `async` still does not block, a nonce still counts, and the parser
still waits for it before running the next one. The original address is kept in
`data-graft-src`, and a `sourceURL` names the file in DevTools.

That leaves one problem: the parser does not wait for `chrome.storage`, and by the time it
answers every script in `<head>` has run. So `content.js` keeps a copy of the site's
enabled script overrides in the page's own `localStorage`, which answers on the spot, and
brings it up to date from `chrome.storage` once that answers. When the copy turns out to
have been out of date for a script on the page — a save, a switch, a site that cleared its
storage — the page is reloaded once and runs the right one from the top. A guard in
`sessionStorage` stops that from becoming a loop on a site that empties its storage on
every load.

A script added by another script has been started the moment it is inserted, before any
observer hears of it. Those are left alone and the card says so, rather than claiming a
swap that did not happen. A site whose Content Security Policy does not allow `blob:`
blocks the swap; the original is then loaded after all and the card says why.

### Matching

A file is matched by its address without the query string. `style.css?ver=6.4` and
`style.css?ver=6.5` are the same file one deploy apart, and a cache-buster must not lose
you your override.

### Following the file

The panel keeps a handle to the file from the picker, in IndexedDB, and looks at it once a
second while the panel is open and in view. Only the date Chrome gives the file is
compared; the contents are read when it changed and stored, and `content.js` picks them up
from `storage.onChanged`. Nothing in the page polls anything.

The contents go into `chrome.storage.local` because that is the only thing of ours
`content.js` can reach. A page cannot read your disk, and a file handle is of no use to
it. `unlimitedStorage`, because a compiled stylesheet with a few fonts inlined, or a
bundle, is a megabyte before anyone notices.

After a browser restart Chrome may want your OK again before the panel can read a file.
The card then says it is showing the last copy and offers **Allow file access**; the page
keeps working with that copy until you press it.

### Downloading

The live file is read by the page itself, through `chrome.scripting`, from its own cache:
the very bytes the page got, and Graft never has to talk to the site. The panel then
writes them wherever you choose with `showSaveFilePicker`. The read comes first, so a read
that fails leaves no empty file behind. Its limit is the page's: a file from another host
has to allow the page to read it, which most CDNs do and some do not.

## Files

| File | Responsibility |
| --- | --- |
| `content.js` | Swaps the stylesheets and scripts on the page for the stored files, keeps the script copy in the page's localStorage, and reports what it swapped. |
| `background.js` | Keeps the content script registered with the permission, sets the badge from what the page reports, and opens the panel from the toolbar. |
| `panel.js` | The coordinator. Follows the tab in front, lists its files, runs the pickers, the downloads and the file watcher. The only writer of the overrides. |
| `overrides.js` | What is swapped for what, per site, and the queue every write goes through. |
| `handles.js` | The file handles from the picker, in IndexedDB. |
| `hostaccess.js` | The one optional permission, and the content script it pays for. |
| `ui.js` | Element building, the icons, the error box, the live region. |
| `i18n.js` | Thin wrapper around `chrome.i18n`, plus locale-aware times. |
| `links.js` | Everything pointing at robinpoort.com, so URLs are changed in one place. |
| `_locales/{en,nl}/messages.json` | Every string in the extension. |
| `style.css` | All styling: tokens, panel chrome, and the panel's own parts. |
| `fonts/` | Barlow Semi Condensed (bold, woff2), bundled rather than fetched. Only for the small uppercase labels. |
| `icons/` | The toolbar and store icon, five sizes. |

`content.js` is a plain IIFE rather than a module, because a content script cannot use
`import`. That is why `normalize()` is written out a second time in `overrides.js`.

## Permissions

`favicon`, `scripting`, `sidePanel`, `storage` and `unlimitedStorage`. Installing Graft
shows no permission warning at all.

Swapping a file needs more than that. It means being on the page before it has loaded, on
every reload, without anyone clicking anything — and `activeTab` is granted by a click and
revoked the moment the tab navigates. So `http://*/*` and `https://*/*` are listed under
`optional_host_permissions`, and the panel asks for them the first time it opens, after
saying why, rather than greeting everyone at install with "read and change all your data
on all websites" before they know what the extension is for.

All sites rather than one at a time: without access to a site the panel cannot even read
the address of the tab, so it could not say which site it was asking about. The `tabs`
permission would fix that, and greet everyone with "read your browsing history" instead.

Granting it registers the content script through `chrome.scripting.registerContentScripts`.
The registration follows the permission from the service worker — `permissions.onAdded`,
`onRemoved`, `onStartup`, `onInstalled` — so revoking it from `chrome://extensions` takes
the script with it, and the panel asks again the next time it opens. Nothing is stored
beside it that could come to disagree with it: the granted permission *is* the setting.

The content script runs on every page but changes nothing on a site that has no file
chosen for it. It reads one key from storage and one from `localStorage` and stops there:
no observer, no message, and the worker is not woken.

`favicon` is for the page's icon in the header of the panel: Chrome's own copy, the one in
the tab strip. The site's own favicon URL was the first version, and every SVG, every
redirect and every favicon behind a login came out as a broken image.

## Design

The panel uses the robinpoort.com palette, the same tokens and the same components as
[Unfurl](../unfurl/) and [Spill](../spill/): the brand blue, the page's favicon and host in
the header, buttons with a bottom edge that sinks when pressed, pills for a state, and
Barlow Semi Condensed for the small uppercase labels. Everything the reader actually reads
stays on the system font, so the panel still looks like part of Chrome.

A side panel rather than a popup, for two reasons. Chrome closes a popup the moment the
file picker opens over it, and the click that picked the file never comes back. And a
popup is gone the moment you click the page, which is exactly when you want to watch your
saves come in.

A swapped card carries the brand tint and a blue edge. That is the state you must not
forget you are in. No left stripe: that is the error box's signature.

Barlow is bundled as woff2 under `fonts/` and loaded from `font-src 'self'`. Nothing is
requested from any host at runtime, and the CSP in the manifest says so: `img-src 'self'`
(the favicon comes from Chrome), `connect-src 'none'`, `object-src 'none'`,
`frame-src 'none'`, `base-uri 'none'`, `form-action 'none'`.

## Languages

English and Dutch, through `_locales`. Chrome picks the browser's UI language and falls
back to English. Every string lives in `_locales/{en,nl}/messages.json` and is read through
`t()` from `i18n.js`, which falls back to the key itself, so a missing translation is
visible immediately instead of silently empty. Times are formatted with `Intl`.

## Known limitations

- Only `<link rel="stylesheet">` and `<script src>` can be swapped. CSS pulled in through
  `@import`, written into a `<style>` or inlined by an optimisation plugin, a script
  written into the page itself, and modules loaded through `import` or `import()` have no
  file of their own to swap.
- A script added by another script cannot be swapped: it has started before anything
  else hears of it. The card says so.
- A swapped script runs from a `blob:` address. Code that works out where it lives from
  `document.currentScript.src` — webpack's automatic `publicPath` does — will look for its
  chunks in the wrong place, and relative imports in a swapped module do not resolve.
- A site whose Content Security Policy allows scripts only from listed hosts, without
  `blob:`, blocks a swapped script; the original runs instead.
- The script copy lives in the site's `localStorage`, which holds about 5 MB per site.
- A stylesheet with an `integrity` attribute is swapped all the same: the `<style>` is not
  checked against it. The original still is, and still loads.
- Does not work on `chrome://` pages, the Web Store or the PDF viewer. Chrome does not
  allow injection there. Pages on disk (`file://`) are left out on purpose: there is no
  deploy to wait for.
- Saves are followed only while the panel is open. With it closed the page shows the last
  copy until the panel is opened again.
- Reloading the extension leaves the pages that were open with a content script that can
  no longer hear anything. Reload those pages.
