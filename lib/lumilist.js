'use strict';
/*
 * Lumilist: Orbit's built-in new tab page. Every card is one of your bookmark folders, so there is nothing to
 * import or keep in sync; this module only validates the little bit Lumilist stores itself — the page tabs and
 * where each card sits — and keeps a local cache of site icons.
 */
const fs = require('fs');
const { readJson, writeJson } = require('./store');

const MAX_PAGES = 12;
const MAX_CARDS = 300;
const KEY_RE = /^(bar|other|f\d{1,9})$/;
const ID_RE = /^[a-z0-9_-]{1,24}$/;
const cleanName = (s, fallback) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24) || fallback;
const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v)) || 0));

function defaults() { return { pages: [{ id: 'home', name: 'Home' }], layout: {} }; }

/** Returns a clean copy of whatever was stored or sent; Home always exists and always comes first. */
function sanitize(data) {
  const out = defaults();
  if (!data || typeof data !== 'object') return out;
  const seen = new Set(['home']);
  if (Array.isArray(data.pages)) {
    for (const p of data.pages) {
      if (!p || typeof p !== 'object') continue;
      if (p.id === 'home') { out.pages[0].name = cleanName(p.name, 'Home'); continue; }
      if (out.pages.length >= MAX_PAGES || typeof p.id !== 'string' || !ID_RE.test(p.id) || seen.has(p.id)) continue;
      seen.add(p.id);
      const page = { id: p.id, name: cleanName(p.name, 'Page') };
      page.folders = Array.isArray(p.folders) ? [...new Set(p.folders.filter((k) => typeof k === 'string' && KEY_RE.test(k)))].slice(0, MAX_CARDS) : [];
      out.pages.push(page);
    }
  }
  if (data.layout && typeof data.layout === 'object') {
    for (const [pid, cards] of Object.entries(data.layout)) {
      if (!seen.has(pid) || !cards || typeof cards !== 'object') continue;
      const clean = {};
      for (const [key, pos] of Object.entries(cards).slice(0, MAX_CARDS)) {
        if (KEY_RE.test(key) && pos && typeof pos === 'object') clean[key] = { col: int(pos.col, 0, 5), pos: int(pos.pos, 0, 999) };
      }
      out.layout[pid] = clean;
    }
  }
  return out;
}

/** host -> icon URL, learned from the pages you visit (never fetched from a third party). */
class Favicons {
  constructor(file) {
    this.file = file;
    const d = readJson(file, {});
    this.data = d && typeof d === 'object' ? d : {};
    this._t = null;
  }
  note(host, url) {
    if (!host || typeof url !== 'string' || !/^(https?:|data:image\/)/i.test(url) || url.length > 2000) return;
    if (this.data[host] === url) return;
    if (Object.keys(this.data).length > 3000 && !(host in this.data)) return;
    this.data[host] = url;
    clearTimeout(this._t);
    this._t = setTimeout(() => this.flush(), 2000);
  }
  lookup(hosts) {
    const out = {};
    for (const h of Array.isArray(hosts) ? hosts.slice(0, 500) : []) {
      const host = String(h);
      const hit = this.data[host] || this.data[host.replace(/^www\./, '')] || this.data['www.' + host];
      if (hit) out[host] = hit;
    }
    return out;
  }
  flush() {
    clearTimeout(this._t);
    this._t = null;
    try { writeJson(this.file, this.data); } catch (e) { /* ignore */ }
  }
  clear() { this.data = {}; try { fs.unlinkSync(this.file); } catch (e) { /* ignore */ } }
}

module.exports = { sanitize, defaults, Favicons, KEY_RE };
