'use strict';
/*
 * Orbit extensions: a folder containing manifest.json plus scripts/styles that are injected into pages.
 *
 * {
 *   "name": "My extension", "version": "1.0", "description": "What it does",
 *   "matches": ["*://*.example.com/*"],   // or "<all_urls>" (default)
 *   "exclude_matches": [],
 *   "run_at": "document_start",           // or "document_end" (default)
 *   "all_frames": false,
 *   "js": ["content.js"], "css": ["style.css"],
 *   "default_enabled": true
 * }
 */
const fs = require('fs');
const path = require('path');

const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

function readInside(folder, rel) {
  const root = path.resolve(folder);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return null;
  try { return fs.readFileSync(full, 'utf8'); } catch (e) { return null; }
}

/** sources: [{dir, origin}] — later entries override earlier ones with the same folder name. */
function discover(sources) {
  const found = new Map();
  for (const { dir, origin } of sources) {
    let names = [];
    try { names = fs.readdirSync(dir).sort(); } catch (e) { continue; }
    for (const name of names) {
      const folder = path.join(dir, name);
      let m;
      try { m = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8')); } catch (e) { continue; }
      if (!m || typeof m !== 'object') continue;
      const matches = strList(m.matches);
      found.set(name, {
        id: name,
        name: String(m.name || name),
        version: String(m.version || ''),
        description: String(m.description || ''),
        path: folder,
        origin,
        matches: matches.length ? matches : ['<all_urls>'],
        exclude: strList(m.exclude_matches),
        runAt: m.run_at === 'document_start' ? 'start' : 'end',
        allFrames: !!m.all_frames,
        js: strList(m.js).map((f) => readInside(folder, f)).filter(Boolean),
        css: strList(m.css).map((f) => readInside(folder, f)).filter(Boolean),
        defaultEnabled: m.default_enabled !== false,
      });
    }
  }
  return [...found.values()];
}

function matchPattern(pattern, url) {
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  if (pattern === '<all_urls>') return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:';
  const m = /^(\*|https?|file):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const scheme = u.protocol.slice(0, -1);
  if (m[1] === '*' ? !(scheme === 'http' || scheme === 'https') : m[1] !== scheme) return false;
  const host = u.hostname;
  if (m[2] !== '*') {
    if (m[2].startsWith('*.')) {
      const base = m[2].slice(2);
      if (!(host === base || host.endsWith('.' + base))) return false;
    } else if (host !== m[2]) return false;
  }
  const re = new RegExp('^' + m[3].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(u.pathname + u.search);
}

function applies(ext, url, isTop) {
  if (!isTop && !ext.allFrames) return false;
  if (!ext.matches.some((p) => matchPattern(p, url))) return false;
  return !ext.exclude.some((p) => matchPattern(p, url));
}

/** What to inject into a page: { js: [{code, runAt}], css: [code] } */
function scriptsFor(exts, enabled, url, isTop) {
  const out = { js: [], css: [] };
  for (const ext of exts) {
    const on = Object.prototype.hasOwnProperty.call(enabled, ext.id) ? enabled[ext.id] : ext.defaultEnabled;
    if (!on || !applies(ext, url, isTop)) continue;
    ext.css.forEach((c) => out.css.push(c));
    ext.js.forEach((code) => out.js.push({ code, runAt: ext.runAt }));
  }
  return out;
}

module.exports = { discover, matchPattern, scriptsFor };
