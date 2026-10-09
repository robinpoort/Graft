/**
 * The pieces the panel needs to build and update itself: element building, the icons,
 * the error box and the live region.
 *
 * Nothing here knows what a stylesheet is. That is the point.
 */

const $ = (selector) => document.querySelector(selector);

function h(tag, options = {}, ...children) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text != null) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs || {})) {
    // Note: '' must be set. alt="" is how you say "decorative"; leaving the
    // attribute off makes screen readers announce the file name instead.
    if (value != null) node.setAttribute(name, value);
  }
  for (const [name, value] of Object.entries(options.props || {})) node[name] = value;
  for (const child of children.flat(Infinity)) if (child) node.append(child);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Drawn with the same stroke as Spill's cross and plus, symmetric about the middle of
 * the viewBox so it sits centred whatever size it is given.
 */
function strokeIcon(className, d) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2.2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/** An arrow down onto a line: the file coming to you. */
const downloadIcon = () => strokeIcon('sp-iconbtn__icon sp-icon--idle', 'M10 3 V12.5 M6 8.5 L10 12.5 L14 8.5 M4 16.5 H16');

/** The tick that stands in for it for a moment once the file is saved. */
const checkIcon = () => strokeIcon('sp-iconbtn__icon sp-icon--done', 'M4.5 10.5 L8.5 14.5 L15.5 5.5');

/**
 * The heading first, then a line per reason: ours in plain words, and under it whatever
 * Chrome itself said, in its own language rather than run together with our sentence.
 */
function showError(message, ...reasons) {
  const box = $('#sp-error');
  box.replaceChildren(
    h('span', { text: message }),
    ...reasons.filter(Boolean).map((reason) => h('span', { class: 'sp-error__reason', text: reason })));
  box.hidden = false;
}

const clearError = () => { $('#sp-error').hidden = true; };

/** A switch or a file swapped in changes a page you are not looking at; say so in words. */
const announce = (message) => { $('#sp-status').textContent = message; };

export { $, h, downloadIcon, checkIcon, showError, clearError, announce };
