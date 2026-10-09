/**
 * The one broad permission Graft asks for, and the content script it pays for.
 *
 * Swapping a stylesheet means being on the page before it has loaded, on every reload,
 * without anyone clicking anything. `activeTab` cannot do that: it is granted by a click
 * and revoked the moment the tab navigates. So it takes host access, and there is no way
 * round it.
 *
 * It is optional all the same, and asked for in the panel rather than at install time,
 * where "read and change all your data on all websites" would be the whole of what someone
 * sees before they know what the extension is for. The panel says why, then asks.
 *
 * All sites rather than one at a time: without access to a site the panel cannot even
 * read the address of the tab, so it could not say which site it was asking about. The
 * `tabs` permission would fix that and greet everyone with "read your browsing history"
 * instead, which is worse.
 *
 * The granted permission is the setting. Nothing is stored beside it that could come to
 * disagree with it — revoke it from chrome://extensions and the panel asks again.
 */

export const ORIGINS = { origins: ['http://*/*', 'https://*/*'] };

const SCRIPT_ID = 'graft-swap';

export const hasHostAccess = () => chrome.permissions.contains(ORIGINS);

/**
 * Registered rather than declared in the manifest, because a manifest content script is a
 * permission whether or not it has been granted.
 */
export async function registerSwapScript() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    if (existing.length) return;
    await chrome.scripting.registerContentScripts([{
      id: SCRIPT_ID,
      matches: ORIGINS.origins,
      js: ['content.js'],
      // Before the first <link> is parsed, or the original gets painted first.
      runAt: 'document_start',
    }]);
  } catch {
    // Registering without the permission, or twice over. Either way there is nothing to
    // do but leave it off.
  }
}

export async function unregisterSwapScript() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  } catch {
    // Not registered. Which is the state this was asking for.
  }
}
