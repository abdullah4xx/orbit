'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  homepage: 'orbit://newtab',
  searchEngine: 'DuckDuckGo',
  searchEngines: {
    DuckDuckGo: 'https://duckduckgo.com/?q=%s',
    Google: 'https://www.google.com/search?q=%s',
    Bing: 'https://www.bing.com/search?q=%s',
    Brave: 'https://search.brave.com/search?q=%s',
  },
  theme: 'dark',
  showBookmarksBar: true,
  restoreSession: false,
  identity: 'windows',
  siteIdentity: {},
  downloadDir: '',
  extensionsEnabled: {},
  window: { width: 1280, height: 800, maximized: false },
};

const clone = (v) => JSON.parse(JSON.stringify(v));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

class Settings {
  constructor(file) {
    this.file = file;
    const loaded = readJson(file, {});
    this.data = loaded && typeof loaded === 'object' ? loaded : {};
  }
  get(key) { return key in this.data ? this.data[key] : clone(DEFAULTS[key]); }
  all() { const o = {}; for (const k of Object.keys(DEFAULTS)) o[k] = this.get(k); return o; }
  set(key, value) {
    if (!(key in DEFAULTS)) throw new Error('unknown setting: ' + key);
    const want = Array.isArray(DEFAULTS[key]) ? 'array' : typeof DEFAULTS[key];
    const got = Array.isArray(value) ? 'array' : typeof value;
    if (want !== got) throw new Error('bad type for ' + key);
    this.data[key] = value;
    writeJson(this.file, this.data);
  }
}

/** Small JSON-backed collection with debounced saving. */
class Persisted {
  constructor(file, fallback) {
    this.file = file;
    this.data = readJson(file, fallback);
    this._t = null;
  }
  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.flush(), 400);
  }
  flush() {
    clearTimeout(this._t);
    try { writeJson(this.file, this.data); } catch (e) { /* ignore */ }
  }
}

const BAR = 1;
const OTHER = 2;
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class Bookmarks extends Persisted {
  constructor(file) {
    super(file, null);
    if (!this.data || !Array.isArray(this.data.items)) this.data = { next: 3, items: [] };
    const now = Date.now();
    if (!this.get(BAR)) this.data.items.push({ id: BAR, parentId: null, kind: 'folder', title: 'Bookmarks bar', url: '', position: 0, created: now });
    if (!this.get(OTHER)) this.data.items.push({ id: OTHER, parentId: null, kind: 'folder', title: 'Other bookmarks', url: '', position: 1, created: now });
  }
  all() { return this.data.items.slice().sort((a, b) => (a.parentId || 0) - (b.parentId || 0) || a.position - b.position || a.id - b.id); }
  get(id) { return this.data.items.find((x) => x.id === Number(id)) || null; }
  children(parentId) { return this.data.items.filter((x) => x.parentId === Number(parentId)).sort((a, b) => a.position - b.position || a.id - b.id); }
  findUrl(url) { return this.data.items.find((x) => x.kind === 'bookmark' && x.url === url) || null; }
  _push(kind, title, url, parentId) {
    const parent = this.get(parentId || BAR);
    if (!parent || parent.kind !== 'folder') throw new Error('bad parent folder');
    const item = { id: this.data.next++, parentId: parent.id, kind, title: String(title || url || ''), url: url || '', position: this.children(parent.id).length, created: Date.now() };
    this.data.items.push(item);
    this.save();
    return item;
  }
  add(url, title, parentId) { return this._push('bookmark', title || url, url, parentId); }
  addFolder(title, parentId) { return this._push('folder', title || 'New folder', '', parentId); }
  update(id, fields) {
    const it = this.get(id);
    if (!it) throw new Error('not found');
    if (typeof fields.title === 'string') it.title = fields.title;
    if (it.kind === 'bookmark' && typeof fields.url === 'string' && fields.url) it.url = fields.url;
    this.save();
    return it;
  }
  _inside(node, ancestor) {
    let cur = this.get(node);
    while (cur) { if (cur.id === ancestor) return true; cur = cur.parentId == null ? null : this.get(cur.parentId); }
    return false;
  }
  move(id, parentId, position) {
    const it = this.get(id);
    const dest = this.get(parentId);
    if (!it || it.parentId == null) throw new Error('cannot move this item');
    if (!dest || dest.kind !== 'folder') throw new Error('bad destination');
    if (it.kind === 'folder' && this._inside(dest.id, it.id)) throw new Error('cannot move a folder into itself');
    const sibs = this.children(dest.id).filter((x) => x.id !== it.id);
    const pos = position == null ? sibs.length : Math.max(0, Math.min(Number(position), sibs.length));
    sibs.splice(pos, 0, it);
    it.parentId = dest.id;
    sibs.forEach((s, i) => { s.position = i; });
    this.save();
    return it;
  }
  remove(id) {
    const it = this.get(id);
    if (!it || it.parentId == null) throw new Error('cannot remove this item');
    const ids = new Set([it.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of this.data.items) if (!ids.has(x.id) && ids.has(x.parentId)) { ids.add(x.id); grew = true; }
    }
    this.data.items = this.data.items.filter((x) => !ids.has(x.id));
    this.save();
  }
  search(q, limit) {
    const s = String(q || '').toLowerCase();
    if (!s) return [];
    return this.data.items.filter((x) => x.kind === 'bookmark' && (x.title.toLowerCase().includes(s) || x.url.toLowerCase().includes(s))).slice(0, limit || 20);
  }
  importHtml(html) {
    const root = this.addFolder('Imported', OTHER).id;
    const stack = [];
    let pending = null;
    let count = 0;
    const re = /<dl[^>]*>|<\/dl>|<h3[^>]*>([\s\S]*?)<\/h3>|<a\s[^>]*?href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    const top = () => (stack.length ? stack[stack.length - 1] : root);
    while ((m = re.exec(String(html)))) {
      const tag = m[0].slice(0, 3).toLowerCase();
      if (tag === '<dl') {
        if (pending != null) { stack.push(pending); pending = null; } else if (!stack.length) stack.push(root);
      } else if (tag === '</d') {
        stack.pop();
      } else if (tag === '<h3') {
        pending = this._push('folder', unesc(m[1].replace(/<[^>]*>/g, '')), '', top()).id;
      } else if (/^(https?|file|ftp):/i.test(m[2])) {
        this._push('bookmark', unesc(m[3].replace(/<[^>]*>/g, '')), unesc(m[2]), top());
        count++;
      }
    }
    return count;
  }
  exportHtml() {
    const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>'];
    const walk = (pid, depth) => {
      const pad = '    '.repeat(depth);
      lines.push(pad + '<DL><p>');
      for (const c of this.children(pid)) {
        if (c.kind === 'folder') { lines.push(pad + '    <DT><H3>' + esc(c.title) + '</H3>'); walk(c.id, depth + 1); } else lines.push(pad + '    <DT><A HREF="' + esc(c.url) + '">' + esc(c.title) + '</A>');
      }
      lines.push(pad + '</DL><p>');
    };
    lines.push('<DL><p>');
    for (const rid of [BAR, OTHER]) { lines.push('    <DT><H3>' + esc(this.get(rid).title) + '</H3>'); walk(rid, 2); }
    lines.push('</DL><p>');
    return lines.join('\n');
  }
}
Bookmarks.BAR = BAR;
Bookmarks.OTHER = OTHER;

class History extends Persisted {
  constructor(file) {
    super(file, null);
    if (!this.data || !Array.isArray(this.data.items)) this.data = { next: 1, items: [] };
    this.byUrl = new Map(this.data.items.map((x) => [x.url, x]));
  }
  visit(url, title) {
    if (!/^(https?|file):/i.test(url)) return;
    let it = this.byUrl.get(url);
    if (!it) {
      it = { id: this.data.next++, url, title: title || '', visits: 0, last: 0 };
      this.data.items.push(it);
      this.byUrl.set(url, it);
    }
    it.visits++;
    it.last = Date.now();
    if (title) it.title = title;
    if (this.data.items.length > 20000) {
      this.data.items.sort((a, b) => b.last - a.last);
      for (const x of this.data.items.splice(15000)) this.byUrl.delete(x.url);
    }
    this.save();
  }
  setTitle(url, title) {
    const it = this.byUrl.get(url);
    if (it && title) { it.title = title; this.save(); }
  }
  recent(q, limit) {
    const s = String(q || '').toLowerCase();
    return this.data.items
      .filter((x) => !s || x.url.toLowerCase().includes(s) || x.title.toLowerCase().includes(s))
      .sort((a, b) => b.last - a.last).slice(0, limit || 200);
  }
  suggest(q, limit) {
    const s = String(q || '').toLowerCase();
    if (!s) return [];
    return this.data.items
      .filter((x) => x.url.toLowerCase().includes(s) || x.title.toLowerCase().includes(s))
      .sort((a, b) => b.visits - a.visits || b.last - a.last).slice(0, limit || 6);
  }
  top(limit) { return this.data.items.slice().sort((a, b) => b.visits - a.visits || b.last - a.last).slice(0, limit || 8); }
  remove(id) {
    const it = this.data.items.find((x) => x.id === Number(id));
    if (!it) return;
    this.data.items = this.data.items.filter((x) => x !== it);
    this.byUrl.delete(it.url);
    this.save();
  }
  clear() { this.data.items = []; this.byUrl.clear(); this.save(); }
}

module.exports = { DEFAULTS, Settings, Bookmarks, History, readJson, writeJson };
