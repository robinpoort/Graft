/**
 * Thin wrapper around chrome.i18n so the rest of the code stays readable. Falls back to
 * the key itself, which makes a missing translation immediately visible instead of
 * silently empty.
 */

const api = (typeof chrome !== 'undefined' && chrome.i18n) ? chrome.i18n : null;

export const t = (key, ...substitutions) =>
  (api ? api.getMessage(key, substitutions.map(String)) : '') || key;

export const uiLanguage = () => (api && api.getUILanguage ? api.getUILanguage() : 'en');

export const isDutch = () => uiLanguage().toLowerCase().startsWith('nl');

/**
 * When a file was last saved, to the second: the seconds are how you tell that the save
 * you just made is the one the page is showing.
 */
export const time = (ms) =>
  new Intl.DateTimeFormat(uiLanguage(), { timeStyle: 'medium' }).format(ms);
