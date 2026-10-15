'use strict';

const NEWTAB = 'orbit://newtab';
const FULL_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const PLAIN = /^(about:|file:|view-source:|orbit:|mailto:|tel:)/i;
const HOSTLIKE = /^(localhost|(\d{1,3}\.){3}\d{1,3}|\[[0-9a-fA-F:]+\]|([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})(:\d+)?([/?#].*)?$/;

/** Turn whatever was typed in the address bar into a URL. */
function resolveInput(text, searchTemplate) {
  const t = String(text || '').trim();
  const search = () => searchTemplate.replace('%s', encodeURIComponent(t));
  if (!t) return NEWTAB;
  if (/^javascript:/i.test(t)) return search();
  if (FULL_URL.test(t) || PLAIN.test(t)) return t;
  if (!/\s/.test(t) && HOSTLIKE.test(t)) {
    const host = t.replace(/^\[/, '').split(/[:/?#]/)[0];
    const local = host === 'localhost' || /^\d/.test(host) || t.startsWith('[');
    return (local ? 'http://' : 'https://') + t;
  }
  return search();
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

const isInternal = (url) => String(url || '').startsWith('orbit://');

module.exports = { NEWTAB, resolveInput, hostOf, isInternal };
