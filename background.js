/**
 * Graft — background.js
 *
 * Three jobs: keep the content script registered for exactly as long as the permission that
 * pays for it, turn what each page reports into its badge, and — in watcher.js — follow the
 * chosen files and store every change to them.
 *
 * The page reports that itself. Chrome wipes a tab's badge the moment it navigates, and a
 * page knows what it swapped without anyone having to ask — so content.js says how many
 * stylesheets it is showing a local file for, and that report is all that is acted on.
 */

import { ORIGINS, registerSwapScript, unregisterSwapScript } from './hostaccess.js';
import './watcher.js';

/**
 * The registered content script follows the permission, wherever that was changed — the
 * Allow button in the panel, or chrome://extensions taking it back.
 */
async function syncSwapScript() {
  if (await chrome.permissions.contains(ORIGINS)) await registerSwapScript();
  else await unregisterSwapScript();
}

chrome.runtime.onInstalled.addListener(syncSwapScript);
chrome.runtime.onStartup.addListener(syncSwapScript);
chrome.permissions.onAdded.addListener(syncSwapScript);
chrome.permissions.onRemoved.addListener(syncSwapScript);

// The toolbar icon opens the panel, the way it would a popup. A popup would not do: Chrome
// closes it the moment the file picker opens over it, and it is gone again the moment you
// click the page, which is exactly when you want to watch your saves come in.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// The brand blue with white on it, the same pair the panel's own buttons use. A swapped
// tab has to say so: a page showing your local file looks exactly like a deployed one.
const BADGE_BG = '#0042ff';
const BADGE_FG = '#ffffff';

// The worker is stopped and started whenever Chrome sees fit, so this runs again on every
// start. Setting a colour that is already set costs nothing.
chrome.action.setBadgeBackgroundColor({ color: BADGE_BG });
chrome.action.setBadgeTextColor?.({ color: BADGE_FG });

chrome.runtime.onMessage.addListener((message, sender) => {
  // Only a page reports on itself, and only ever about the tab it is sitting in — which
  // Chrome fills in, so a report can never be about someone else's tab.
  if (message?.action !== 'pageState' || !sender.tab) return;

  chrome.action
    .setBadgeText({ tabId: sender.tab.id, text: message.count ? String(message.count) : '' })
    .catch(() => {
      // The tab closed between the report and this call. Nothing left to label.
    });
});
