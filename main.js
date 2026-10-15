'use strict';
const { app, BaseWindow, WebContentsView, Menu, ipcMain, protocol, session, shell, dialog, clipboard, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { Settings, Bookmarks, History } = require('./lib/store');
const { resolveInput, hostOf, isInternal, NEWTAB } = require('./lib/urls');
const ident = require('./lib/identity');
const extlib = require('./lib/extensions');

// ---------------------------------------------------------------- paths & setup
app.setName('orbit-browser');
const CONFIG = path.join(app.getPath('appData'), 'orbit-browser');
fs.mkdirSync(CONFIG, { recursive: true });
app.setPath('userData', CONFIG);

const UI_DIR = path.join(__dirname, 'ui');
const THEMES_DIR = path.join(__dirname, 'themes');
const USER_THEMES = path.join(CONFIG, 'themes');
const SYS_EXT = path.join(__dirname, 'extensions');
const USER_EXT = path.join(CONFIG, 'extensions');
const CUSTOM_CSS = path.join(CONFIG, 'custom.css');
const SESSION_FILE = path.join(CONFIG, 'session.json');
[USER_THEMES, USER_EXT].forEach((d) => fs.mkdirSync(d, { recursive: true }));
if (!fs.existsSync(CUSTOM_CSS)) {
  fs.writeFileSync(CUSTOM_CSS, `/* Your own CSS. Applied last, to the browser UI and to Orbit's own pages.
   Colours and sizes are variables, e.g.:

   :root { --accent: #ff5d73; --radius: 4px; --tabstrip-h: 42px; }

   You can also restyle elements directly: #tabs .tab, #omnibox, #toolbar ...
   Save it from Settings > Appearance and it applies instantly. */
`);
}

const settings = new Settings(path.join(CONFIG, 'settings.json'));
const bookmarks = new Bookmarks(path.join(CONFIG, 'bookmarks.json'));
const history = new History(path.join(CONFIG, 'history.json'));
let extensions = [];

app.userAgentFallback = (ident.PROFILES[settings.get('identity')] || ident.PROFILES.windows).ua;
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
protocol.registerSchemesAsPrivileged([
  { scheme: 'orbit', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ---------------------------------------------------------------- state
const TAB_PREFS = {
  preload: path.join(__dirname, 'preload-tab.js'),
  contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, spellcheck: true,
};
const PAGES = { newtab: '/newtab.html', bookmarks: '/bookmarks.html', history: '/history.html', settings: '/settings.html', extensions: '/extensions.html', identity: '/identity.html', error: '/error.html' };
const ZOOM_STEP = 0.5;

let win = null;
let chrome = null;
let chromeReady = false;
let chromeHeight = 84;
let chromeFull = false;
let htmlFull = false;
let tabs = [];
let active = null;
let nextTabId = 1;
const closedUrls = [];
let stateTimer = null;
const permissionMemory = new Map();

const searchTemplate = () => (settings.get('searchEngines')[settings.get('searchEngine')] || DEFAULT_SEARCH);
const DEFAULT_SEARCH = 'https://duckduckgo.com/?q=%s';

// ---------------------------------------------------------------- helpers
function send(event, data) {
  if (chrome && !chrome.webContents.isDestroyed()) chrome.webContents.send('orbit:push', event, data);
}

function broadcastToPages(event, data) {
  for (const t of tabs) if (isInternal(t.wc.getURL())) t.wc.send('orbit:push', event, data);
}

function load(tab, url) {
  tab.wc.loadURL(url).catch(() => { /* aborted or failed: did-fail-load handles it */ });
}

function displayTitle(t) {
  const url = t.wc.getURL();
  if (!url || url === 'about:blank') return 'New tab';
  return hostOf(url) || url;
}

function tabState(t) {
  return { id: t.id, title: t.title || displayTitle(t), url: t.wc.getURL(), favicon: t.favicon, loading: t.loading };
}

function stateFor() {
  const t = active;
  const url = t ? t.wc.getURL() : '';
  const bm = url ? bookmarks.findUrl(url) : null;
  const nav = t ? t.wc.navigationHistory : null;
  return {
    tabs: tabs.map(tabState),
    active: t ? t.id : null,
    url,
    loading: t ? t.loading : false,
    canBack: nav ? nav.canGoBack() : false,
    canForward: nav ? nav.canGoForward() : false,
    zoom: t ? Math.round(Math.pow(1.2, t.wc.getZoomLevel()) * 100) : 100,
    bookmarkId: bm ? bm.id : null,
    bar: bookmarks.children(Bookmarks.BAR),
    otherCount: bookmarks.children(Bookmarks.OTHER).length,
    showBar: settings.get('showBookmarksBar'),
    engine: settings.get('searchEngine'),
  };
}

function pushState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    if (!chromeReady) return;
    send('state', stateFor());
    if (win && active) win.setTitle((active.title || displayTitle(active)) + ' — Orbit');
  }, 20);
}

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  if (htmlFull && active) {
    chrome.setVisible(false);
    for (const t of tabs) { t.view.setVisible(t === active); t.view.setBounds({ x: 0, y: 0, width, height }); }
    return;
  }
  chrome.setVisible(true);
  chrome.setBounds({ x: 0, y: 0, width, height: chromeFull ? height : chromeHeight });
  for (const t of tabs) {
    t.view.setVisible(t === active);
    t.view.setBounds({ x: 0, y: chromeHeight, width, height: Math.max(0, height - chromeHeight) });
  }
}

function focusOmnibox() {
  chrome.webContents.focus();
  send('focus-omnibox', null);
}

function externalOpen(url) {
  if (/^(mailto|tel):/i.test(url)) shell.openExternal(url).catch(() => {});
}

// ---------------------------------------------------------------- tabs
function createTab(url, opts = {}) {
  const view = new WebContentsView({ webPreferences: TAB_PREFS });
  const wc = view.webContents;
  const tab = { id: nextTabId++, view, wc, title: '', favicon: '', loading: false };

  const idx = opts.after && tabs.includes(opts.after) ? tabs.indexOf(opts.after) + 1 : tabs.length;
  tabs.splice(idx, 0, tab);
  win.contentView.addChildView(view);
  win.contentView.addChildView(chrome); // keep the browser UI on top

  wc.on('page-title-updated', (e, title) => { tab.title = title; history.setTitle(wc.getURL(), title); pushState(); });
  wc.on('page-favicon-updated', (e, icons) => { tab.favicon = (icons && icons[0]) || ''; pushState(); });
  wc.on('did-start-loading', () => { tab.loading = true; pushState(); });
  wc.on('did-stop-loading', () => { tab.loading = false; pushState(); });
  wc.on('did-navigate', (e, u) => { tab.favicon = ''; history.visit(u, wc.getTitle()); pushState(); });
  wc.on('did-navigate-in-page', () => pushState());
  wc.on('did-fail-load', (e, code, desc, failedUrl, isMain) => {
    if (!isMain || code === -3) return;
    wc.loadURL('orbit://error/?u=' + encodeURIComponent(failedUrl) + '&d=' + encodeURIComponent(desc) + '&c=' + code).catch(() => {});
  });
  wc.on('will-navigate', (e, u) => {
    if (/^(mailto|tel):/i.test(u)) { e.preventDefault(); externalOpen(u); return; }
    if (/^file:/i.test(u) && !/^file:/i.test(wc.getURL())) e.preventDefault();
  });
  wc.on('found-in-page', (e, r) => { if (tab === active) send('find', { active: r.activeMatchOrdinal, count: r.matches }); });
  wc.on('enter-html-full-screen', () => { htmlFull = true; win.setFullScreen(true); layout(); });
  wc.on('leave-html-full-screen', () => { htmlFull = false; win.setFullScreen(false); layout(); });
  wc.on('before-input-event', handleKey);
  wc.on('context-menu', (e, params) => showContextMenu(tab, params));
  wc.setWindowOpenHandler((details) => {
    const u = details.url;
    if (u && !/^(https?|about|blob|data):/i.test(u)) { externalOpen(u); return { action: 'deny' }; }
    const background = details.disposition === 'background-tab';
    return { action: 'allow', createWindow: () => createTab(null, { activate: !background, after: tab }).wc };
  });

  if (url) load(tab, url);
  if (opts.activate !== false) selectTab(tab); else { layout(); pushState(); }
  return tab;
}

function selectTab(tab) {
  if (!tab || !tabs.includes(tab)) return;
  if (active && active !== tab) { try { active.wc.stopFindInPage('clearSelection'); } catch (e) { /* ignore */ } send('find-close', null); }
  active = tab;
  layout();
  pushState();
  if (!isInternal(tab.wc.getURL()) || tab.wc.getURL().startsWith('orbit://newtab')) tab.wc.focus();
}

function closeTab(tab) {
  if (!tab || !tabs.includes(tab)) return;
  const url = tab.wc.getURL();
  if (url && !url.startsWith('orbit://newtab') && url !== 'about:blank') closedUrls.push(url);
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  win.contentView.removeChildView(tab.view);
  try { tab.wc.close(); } catch (e) { /* ignore */ }
  if (!tabs.length) { active = null; win.close(); return; }
  if (active === tab) selectTab(tabs[Math.min(i, tabs.length - 1)]); else pushState();
}

function cycle(dir) {
  if (tabs.length < 2) return;
  selectTab(tabs[(tabs.indexOf(active) + dir + tabs.length) % tabs.length]);
}

function openPage(page, hash) {
  const base = 'orbit://' + page;
  const existing = tabs.find((t) => t.wc.getURL().startsWith(base));
  if (existing) { selectTab(existing); if (hash) load(existing, base + '/#' + hash); return existing; }
  return createTab(base + (hash ? '/#' + hash : ''), { after: active });
}

function reload(hard) {
  if (!active) return;
  if (hard) active.wc.reloadIgnoringCache(); else active.wc.reload();
}

function zoom(delta) {
  if (!active) return;
  active.wc.setZoomLevel(delta === 0 ? 0 : Math.max(-4, Math.min(5, active.wc.getZoomLevel() + delta * ZOOM_STEP)));
  pushState();
}

function toggleDevtools() {
  if (!active) return;
  if (active.wc.isDevToolsOpened()) active.wc.closeDevTools(); else active.wc.openDevTools({ mode: 'right' });
}

function startFind() { focusFind(); }
function focusFind() { chrome.webContents.focus(); send('find-open', null); }

// ---------------------------------------------------------------- keyboard
function handleKey(event, input) {
  if (input.type !== 'keyDown') return;
  const k = input.key;
  const lk = k.length === 1 ? k.toLowerCase() : k;
  let handled = true;
  if (input.control && !input.alt) {
    if (lk === 't') { if (input.shift) reopenTab(); else { createTab(NEWTAB, { after: active }); focusOmnibox(); } }
    else if (lk === 'w') closeTab(active);
    else if (lk === 'l') focusOmnibox();
    else if (lk === 'r') reload(input.shift);
    else if (lk === 'd') send('toggle-bookmark', null);
    else if (lk === 'f') startFind();
    else if (lk === 'h') openPage('history');
    else if (lk === 'o' && input.shift) openPage('bookmarks');
    else if (lk === 'q') app.quit();
    else if (k === 'Tab') cycle(input.shift ? -1 : 1);
    else if (k === 'PageDown') cycle(1);
    else if (k === 'PageUp') cycle(-1);
    else if (/^[1-9]$/.test(k)) selectTab(k === '9' ? tabs[tabs.length - 1] : tabs[Number(k) - 1]);
    else if (k === '+' || k === '=') zoom(1);
    else if (k === '-' || k === '_') zoom(-1);
    else if (k === '0') zoom(0);
    else handled = false;
  } else if (input.alt && !input.control) {
    if (k === 'ArrowLeft') { if (active && active.wc.navigationHistory.canGoBack()) active.wc.navigationHistory.goBack(); }
    else if (k === 'ArrowRight') { if (active && active.wc.navigationHistory.canGoForward()) active.wc.navigationHistory.goForward(); }
    else if (k === 'Home') load(active, settings.get('homepage'));
    else handled = false;
  } else if (k === 'F5') reload(input.shift);
  else if (k === 'F6') focusOmnibox();
  else if (k === 'F11') win.setFullScreen(!win.isFullScreen());
  else if (k === 'F12') toggleDevtools();
  else handled = false;
  if (handled) event.preventDefault();
}

function reopenTab() {
  const url = closedUrls.pop();
  if (url) createTab(url, { after: active });
}

// ---------------------------------------------------------------- context menu
function showContextMenu(tab, p) {
  const items = [];
  const nav = tab.wc.navigationHistory;
  if (p.misspelledWord) {
    (p.dictionarySuggestions || []).slice(0, 5).forEach((s) => items.push({ label: s, click: () => tab.wc.replaceMisspelling(s) }));
    if (items.length) items.push({ type: 'separator' });
  }
  if (p.linkURL) {
    items.push({ label: 'Open link in new tab', click: () => createTab(p.linkURL, { activate: false, after: tab }) });
    items.push({ label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) });
    items.push({ type: 'separator' });
  }
  if (p.mediaType === 'image' && p.srcURL) {
    items.push({ label: 'Open image in new tab', click: () => createTab(p.srcURL, { after: tab }) });
    items.push({ label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) });
    items.push({ type: 'separator' });
  }
  if (p.isEditable) {
    items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
  } else {
    if (p.selectionText) {
      const sel = p.selectionText.trim();
      items.push({ role: 'copy' });
      items.push({ label: 'Search for “' + sel.slice(0, 30) + (sel.length > 30 ? '…' : '') + '”', click: () => createTab(searchTemplate().replace('%s', encodeURIComponent(sel)), { after: tab }) });
      items.push({ type: 'separator' });
    }
    if (!p.linkURL) {
      items.push({ label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() });
      items.push({ label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() });
      items.push({ label: 'Reload', click: () => tab.wc.reload() });
      items.push({ type: 'separator' });
    }
  }
  items.push({ label: 'Inspect element', click: () => tab.wc.inspectElement(p.x, p.y) });
  Menu.buildFromTemplate(items).popup({ window: win });
}

// ---------------------------------------------------------------- themes
function themeFile(name) {
  for (const dir of [USER_THEMES, THEMES_DIR]) {
    const f = path.join(dir, path.basename(String(name)) + '.css');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function themeNames() {
  const names = new Set();
  for (const dir of [THEMES_DIR, USER_THEMES]) {
    try { fs.readdirSync(dir).filter((f) => f.endsWith('.css')).forEach((f) => names.add(f.slice(0, -4))); } catch (e) { /* ignore */ }
  }
  return [...names].sort();
}

function themeCss() {
  const f = themeFile(settings.get('theme')) || themeFile('dark');
  let css = '';
  try { css = fs.readFileSync(f, 'utf8'); } catch (e) { /* ignore */ }
  let custom = '';
  try { custom = fs.readFileSync(CUSTOM_CSS, 'utf8'); } catch (e) { /* ignore */ }
  return css + '\n' + custom;
}

function applyTheme() {
  const m = /scheme:\s*(dark|light)/.exec(themeCss());
  nativeTheme.themeSource = m ? m[1] : 'system';
  send('theme', Date.now());
  broadcastToPages('theme', Date.now());
}

// ---------------------------------------------------------------- orbit:// protocol
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const CSP = "default-src 'none'; script-src orbit://ui; style-src orbit://ui orbit://theme 'unsafe-inline'; img-src * data:; base-uri 'none'; form-action 'none'";

function registerProtocol() {
  protocol.handle('orbit', (request) => {
    const u = new URL(request.url);
    if (u.hostname === 'theme') return new Response(themeCss(), { headers: { 'content-type': MIME['.css'], 'cache-control': 'no-store' } });
    const rel = u.hostname === 'ui' ? u.pathname : PAGES[u.hostname];
    if (!rel) return new Response('Not found', { status: 404 });
    const file = path.normalize(path.join(UI_DIR, rel));
    if (!file.startsWith(UI_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const ext = path.extname(file);
      const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' };
      if (ext === '.html') headers['content-security-policy'] = CSP;
      return new Response(fs.readFileSync(file), { headers });
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ---------------------------------------------------------------- session: identity, downloads, permissions
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, base + ' (' + i + ')' + ext);
  return p;
}

function setupSession() {
  const ses = session.defaultSession;
  ses.setUserAgent((ident.PROFILES[settings.get('identity')] || ident.PROFILES.windows).ua);

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const p = ident.profileFor({ identity: settings.get('identity'), siteIdentity: settings.get('siteIdentity') }, hostOf(details.url));
    callback({ requestHeaders: ident.applyHeaders(p, details.requestHeaders) });
  });

  ses.on('will-download', (event, item) => {
    const dir = settings.get('downloadDir') || app.getPath('downloads');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    const target = uniquePath(dir, item.getFilename());
    const name = path.basename(target);
    item.setSavePath(target);
    send('toast', 'Downloading ' + name + ' …');
    item.once('done', (e, state) => send('toast', state === 'completed' ? 'Downloaded ' + name + ' → ' + dir : 'Download failed: ' + name));
  });

  const AUTO = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'speaker-selection', 'window-management']);
  const ASK = { media: 'use your camera or microphone', geolocation: 'know your location', notifications: 'show notifications', midi: 'use MIDI devices', 'clipboard-read': 'read your clipboard' };

  ses.setPermissionCheckHandler((wc, permission, origin) => AUTO.has(permission) || permissionMemory.get(origin + '|' + permission) === true);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (AUTO.has(permission)) return callback(true);
    if (!ASK[permission]) return callback(false);
    const origin = hostOf(details.requestingUrl) || 'This page';
    const key = origin + '|' + permission;
    if (permissionMemory.has(key)) return callback(permissionMemory.get(key));
    dialog.showMessageBox(win, { type: 'question', message: origin + ' wants to ' + ASK[permission], buttons: ['Block', 'Allow'], defaultId: 0, cancelId: 0 })
      .then((r) => { permissionMemory.set(key, r.response === 1); callback(r.response === 1); })
      .catch(() => callback(false));
    return undefined;
  });
}

function reloadExtensions() {
  extensions = extlib.discover([{ dir: SYS_EXT, origin: 'built-in' }, { dir: USER_EXT, origin: 'yours' }]);
}

ipcMain.on('orbit:identity', (e, host) => {
  const p = ident.profileFor({ identity: settings.get('identity'), siteIdentity: settings.get('siteIdentity') }, String(host || ''));
  e.returnValue = ident.patchSource(p);
});
ipcMain.on('orbit:ext-scripts', (e, url, isTop) => {
  e.returnValue = extlib.scriptsFor(extensions, settings.get('extensionsEnabled'), String(url), !!isTop);
});

// ---------------------------------------------------------------- commands (UI -> main)
const tabById = (id) => tabs.find((t) => t.id === Number(id));
const dlDir = () => settings.get('downloadDir') || app.getPath('downloads');

function senderKind(event) {
  const wc = event.sender;
  if (chrome && wc.id === chrome.webContents.id) return 'chrome';
  const tab = tabs.find((t) => t.wc.id === wc.id);
  const frame = event.senderFrame;
  if (tab && frame && frame.parent === null && String(frame.url).startsWith('orbit://')) return tab;
  return null;
}

function bookmarksChanged() { pushState(); broadcastToPages('bookmarks-changed', null); }

function reloadWebTabs() {
  for (const t of tabs) if (!isInternal(t.wc.getURL())) t.wc.reload();
}

const COMMANDS = {
  'chrome.ready': () => { chromeReady = true; pushState(); return true; },
  'chrome.layout': ({ height, full }) => {
    chromeHeight = Math.max(40, Math.min(400, Math.round(Number(height) || 84)));
    chromeFull = !!full;
    layout();
    return true;
  },
  'tabs.new': ({ url }) => {
    const t = createTab(url ? resolveInput(url, searchTemplate()) : NEWTAB, { after: active });
    if (!url) focusOmnibox();
    return t.id;
  },
  'tabs.close': ({ id }) => closeTab(tabById(id)),
  'tabs.select': ({ id }) => selectTab(tabById(id)),
  'tabs.move': ({ id, index }) => {
    const t = tabById(id);
    if (!t) return;
    tabs.splice(tabs.indexOf(t), 1);
    tabs.splice(Math.max(0, Math.min(Number(index), tabs.length)), 0, t);
    pushState();
  },
  'tabs.duplicate': ({ id }) => { const t = tabById(id); if (t) createTab(t.wc.getURL(), { after: t }); },
  'tabs.closeOthers': ({ id }) => { const keep = tabById(id); tabs.filter((t) => t !== keep).forEach(closeTab); if (keep) selectTab(keep); },
  'tabs.reopen': () => reopenTab(),
  'nav.go': ({ text }, src) => {
    const tab = typeof src === 'object' ? src : active;
    if (!tab) return;
    load(tab, resolveInput(text, searchTemplate()));
    tab.wc.focus();
  },
  'nav.back': () => { if (active && active.wc.navigationHistory.canGoBack()) active.wc.navigationHistory.goBack(); },
  'nav.forward': () => { if (active && active.wc.navigationHistory.canGoForward()) active.wc.navigationHistory.goForward(); },
  'nav.reload': ({ hard }) => reload(!!hard),
  'nav.stop': () => { if (active) active.wc.stop(); },
  'nav.home': () => { if (active) load(active, settings.get('homepage')); },
  'find.search': ({ text, dir }) => {
    if (!active) return;
    if (!text) { active.wc.stopFindInPage('clearSelection'); send('find', { active: 0, count: 0 }); return; }
    active.wc.findInPage(text, { forward: dir !== 'prev', findNext: !!dir });
  },
  'find.close': () => { if (active) { active.wc.stopFindInPage('clearSelection'); active.wc.focus(); } },
  zoom: ({ delta }) => zoom(Number(delta)),
  devtools: () => toggleDevtools(),
  openPage: ({ page, hash }) => { if (PAGES[page]) openPage(page, hash); },
  'omnibox.suggest': ({ q }) => {
    const seen = new Set();
    const out = [];
    const add = (type, title, url) => { if (!seen.has(url)) { seen.add(url); out.push({ type, title, url }); } };
    bookmarks.search(q, 4).forEach((b) => add('bookmark', b.title, b.url));
    history.suggest(q, 6).forEach((h) => add('history', h.title, h.url));
    return out.slice(0, 8);
  },
  quit: () => app.quit(),

  'bookmarks.tree': () => bookmarks.all(),
  'bookmarks.add': ({ url, title, parentId }) => { const r = bookmarks.add(url, title, parentId); bookmarksChanged(); return r; },
  'bookmarks.addFolder': ({ title, parentId }) => { const r = bookmarks.addFolder(title, parentId); bookmarksChanged(); return r; },
  'bookmarks.update': ({ id, title, url, parentId }) => {
    bookmarks.update(id, { title, url });
    const it = bookmarks.get(id);
    if (parentId != null && it && it.parentId !== Number(parentId)) bookmarks.move(id, parentId);
    bookmarksChanged();
    return bookmarks.get(id);
  },
  'bookmarks.move': ({ id, parentId, position }) => { const r = bookmarks.move(id, parentId, position); bookmarksChanged(); return r; },
  'bookmarks.remove': ({ id }) => { bookmarks.remove(id); bookmarksChanged(); return true; },
  'bookmarks.importHtml': ({ html }) => { const n = bookmarks.importHtml(html); bookmarksChanged(); return n; },
  'bookmarks.exportHtml': () => {
    const file = uniquePath(dlDir(), 'orbit-bookmarks.html');
    fs.mkdirSync(dlDir(), { recursive: true });
    fs.writeFileSync(file, bookmarks.exportHtml());
    return file;
  },
  'history.list': ({ q, limit }) => history.recent(q, limit),
  'history.top': ({ limit }) => history.top(limit),
  'history.remove': ({ id }) => { history.remove(id); return true; },
  'history.clear': () => { history.clear(); return true; },

  'settings.get': () => ({ settings: settings.all(), themes: themeNames(), identities: ident.listProfiles(), version: app.getVersion(), chrome: process.versions.chrome, configDir: CONFIG }),
  'settings.set': ({ key, value }) => {
    settings.set(key, value);
    if (key === 'theme') applyTheme();
    if (key === 'identity') { session.defaultSession.setUserAgent((ident.PROFILES[value] || ident.PROFILES.windows).ua); reloadWebTabs(); }
    if (key === 'siteIdentity') reloadWebTabs();
    pushState();
    return true;
  },
  'themes.list': () => themeNames(),
  'css.get': () => { try { return fs.readFileSync(CUSTOM_CSS, 'utf8'); } catch (e) { return ''; } },
  'css.set': ({ css }) => { fs.writeFileSync(CUSTOM_CSS, String(css)); applyTheme(); return true; },
  'extensions.list': () => {
    reloadExtensions();
    const enabled = settings.get('extensionsEnabled');
    return extensions.map((x) => ({
      id: x.id, name: x.name, version: x.version, description: x.description, origin: x.origin, matches: x.matches,
      enabled: Object.prototype.hasOwnProperty.call(enabled, x.id) ? !!enabled[x.id] : x.defaultEnabled,
    }));
  },
  'extensions.toggle': ({ id, enabled }) => {
    settings.set('extensionsEnabled', Object.assign({}, settings.get('extensionsEnabled'), { [id]: !!enabled }));
    reloadWebTabs();
    return true;
  },
  'extensions.openFolder': () => shell.openPath(USER_EXT),
  'data.clear': async ({ what }) => {
    const ses = session.defaultSession;
    if (what === 'history') history.clear();
    else if (what === 'cookies') await ses.clearStorageData({ storages: ['cookies'] });
    else if (what === 'cache') await ses.clearCache();
    else if (what === 'all') { await ses.clearStorageData(); await ses.clearCache(); history.clear(); }
    return true;
  },
};

const PAGE_CMDS = new Set([
  'nav.go', 'bookmarks.tree', 'bookmarks.add', 'bookmarks.addFolder', 'bookmarks.update', 'bookmarks.move', 'bookmarks.remove',
  'bookmarks.importHtml', 'bookmarks.exportHtml', 'history.list', 'history.top', 'history.remove', 'history.clear',
  'settings.get', 'settings.set', 'themes.list', 'css.get', 'css.set', 'extensions.list', 'extensions.toggle',
  'extensions.openFolder', 'data.clear',
]);

ipcMain.handle('orbit:call', async (event, cmd, args) => {
  const src = senderKind(event);
  if (!src) throw new Error('not allowed');
  const fn = COMMANDS[cmd];
  if (!fn) throw new Error('unknown command: ' + cmd);
  if (src !== 'chrome' && !PAGE_CMDS.has(cmd)) throw new Error('not allowed: ' + cmd);
  const r = await fn(args || {}, src);
  return r === undefined ? null : r;
});

// ---------------------------------------------------------------- window
function buildWindow() {
  const w = settings.get('window');
  win = new BaseWindow({ width: w.width || 1280, height: w.height || 800, minWidth: 640, minHeight: 420, title: 'Orbit', backgroundColor: '#101318', icon: path.join(__dirname, 'build', 'icon.png') });
  if (w.maximized) win.maximize();

  chrome = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-chrome.js'), contextIsolation: true, sandbox: true } });
  chrome.setBackgroundColor('#00000000');
  win.contentView.addChildView(chrome);
  chrome.webContents.on('before-input-event', handleKey);
  chrome.webContents.on('context-menu', (e) => e.preventDefault());
  chrome.webContents.on('will-navigate', (e) => e.preventDefault());
  chrome.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  chrome.webContents.loadURL('orbit://ui/chrome.html');
  if (process.env.ORBIT_DEBUG) chrome.webContents.openDevTools({ mode: 'detach' });

  ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach((ev) => win.on(ev, layout));
  win.on('close', () => {
    const b = win.getNormalBounds();
    try { settings.set('window', { width: b.width, height: b.height, maximized: win.isMaximized() }); } catch (e) { /* ignore */ }
  });
  win.on('closed', () => { win = null; });
  layout();
}

function openInitial(urls) {
  let list = urls;
  if (!list.length && settings.get('restoreSession')) {
    try { list = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).filter((u) => typeof u === 'string'); } catch (e) { list = []; }
  }
  if (!list.length) list = [NEWTAB];
  list.forEach((u, i) => createTab(u, { activate: i === list.length - 1 }));
  if (list.length === 1 && list[0] === NEWTAB) focusOmnibox();
}

const argvUrls = (argv) => argv.filter((a) => /^(https?:\/\/|file:\/\/|orbit:\/\/)/i.test(a));

app.on('second-instance', (e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  argvUrls(argv).forEach((u) => createTab(u, { after: active }));
});

app.on('before-quit', () => {
  try {
    if (settings.get('restoreSession')) fs.writeFileSync(SESSION_FILE, JSON.stringify(tabs.map((t) => t.wc.getURL()).filter(Boolean)));
  } catch (e) { /* ignore */ }
  bookmarks.flush();
  history.flush();
});
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  reloadExtensions();
  registerProtocol();
  setupSession();
  buildWindow();
  applyTheme();
  openInitial(argvUrls(process.argv));
});

module.exports = { COMMANDS };
