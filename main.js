'use strict';
const { app, BaseWindow, WebContentsView, Menu, ipcMain, protocol, session, shell, dialog, clipboard, nativeTheme, components } = require('electron');
const path = require('path');
const fs = require('fs');
const { Settings, Bookmarks, History } = require('./lib/store');
const { resolveInput, hostOf, isInternal, NEWTAB } = require('./lib/urls');
const ident = require('./lib/identity');
const extlib = require('./lib/extensions');
const A = require('./lib/appearance');
const LL = require('./lib/lumilist');

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
const BG_DIR = path.join(CONFIG, 'backgrounds');
const CUSTOM_CSS = path.join(CONFIG, 'custom.css');
const CUSTOM_JS = path.join(CONFIG, 'custom.js');
const SESSION_FILE = path.join(CONFIG, 'session.json');
const SAFE_MODE = !!process.env.ORBIT_SAFE;
[USER_THEMES, USER_EXT, BG_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));
if (!fs.existsSync(CUSTOM_CSS)) {
  fs.writeFileSync(CUSTOM_CSS, `/* Your own CSS. Applied last, to the browser UI and to Orbit's own pages.
   Colours and sizes are variables, e.g.:

   :root { --accent: #ff5d73; --radius: 4px; --tabstrip-h: 42px; }

   You can also restyle elements directly: #tabs .tab, #omnibox, #toolbar ...
   Most things are easier in orbit://appearance, which writes no CSS at all. */
`);
}
if (!fs.existsSync(CUSTOM_JS)) {
  fs.writeFileSync(CUSTOM_JS, `// Your own JavaScript for the browser UI (tab strip, toolbar, menus). Runs once when a window opens.
// It is the page that draws Orbit's chrome, so you can add buttons, change behaviour, anything.
// The \`orbit\` object is there: orbit.call('tabs.new', { url: 'https://example.com' }), orbit.on('state', fn) ...
// Start Orbit with ORBIT_SAFE=1 to skip this file and custom.css if something goes wrong.
`);
}

const settings = new Settings(path.join(CONFIG, 'settings.json'));
const bookmarks = new Bookmarks(path.join(CONFIG, 'bookmarks.json'));
const history = new History(path.join(CONFIG, 'history.json'));
const favicons = new LL.Favicons(path.join(CONFIG, 'favicons.json'));
let extensions = [];

app.userAgentFallback = (ident.PROFILES[settings.get('identity')] || ident.PROFILES.windows).ua;
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
protocol.registerSchemesAsPrivileged([
  { scheme: 'orbit', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ---------------------------------------------------------------- state
// ---------------------------------------------------------------- Widevine (protected video)
// `components` only exists in castLabs' Electron build ("ECS", version ...+wvcus). Stock Electron ships no Widevine CDM,
// which is why DRM players show "Protected Content" errors. ECS downloads the CDM on first run (needs internet).
const drm = { ecs: !!components, state: components ? 'starting' : 'unsupported', error: '', downloaded: false };

function startWidevine() {
  if (!components) return Promise.resolve();
  const began = Date.now();
  const attempt = (n) => components.whenReady().then(() => {
    drm.state = 'ready';
    drm.error = '';
    if (Date.now() - began > 1500) {
      drm.downloaded = true;
      notify('Video protection (Widevine) is installed. Reload any video page that showed an error.');
    }
  }).catch((e) => {
    drm.state = 'failed';
    drm.error = String((e && e.message) || e);
    if (n >= 5) return undefined;
    drm.state = 'retrying';
    return new Promise((res) => setTimeout(res, 15000 * n)).then(() => attempt(n + 1)); // offline on first start, etc.
  });
  drm.state = 'starting';
  return attempt(1);
}

function drmStatus() {
  let comp = {};
  try { if (components) comp = JSON.parse(JSON.stringify(components.status() || {})); } catch (e) { comp = {}; }
  return { ecs: drm.ecs, state: drm.state, error: drm.error, downloaded: drm.downloaded, components: comp, electron: process.versions.electron };
}

const LUMILIST_ID = 'lumilist';
const lumilistOn = () => settings.get('extensionsEnabled')[LUMILIST_ID] !== false;

const PAGES = { newtab: '/newtab.html', bookmarks: '/bookmarks.html', history: '/history.html', settings: '/settings.html', appearance: '/appearance.html', extensions: '/extensions.html', identity: '/identity.html', error: '/error.html' };
const ZOOM_STEP = 0.5;

const wins = new Set();
let lastWin = null;
let nextTabId = 1;
let privateCounter = 0;
const closedUrls = [];
const permissionMemory = new Map();
const configuredSessions = new WeakSet();

const DEFAULT_SEARCH = 'https://duckduckgo.com/?q=%s';
const searchTemplate = () => (settings.get('searchEngines')[settings.get('searchEngine')] || DEFAULT_SEARCH);

// ---------------------------------------------------------------- look (appearance overrides)
let lookCache = null;
const look = () => lookCache || (lookCache = A.sanitize(settings.get('appearance')));

function setLook(next) {
  lookCache = A.sanitize(next);
  settings.set('appearance', lookCache, true);
  applyLook();
}

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

function readTheme() {
  const f = themeFile(settings.get('theme')) || themeFile('dark');
  try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; }
}

function themeCss() {
  let custom = '';
  if (!SAFE_MODE) { try { custom = fs.readFileSync(CUSTOM_CSS, 'utf8'); } catch (e) { /* ignore */ } }
  return readTheme() + '\n' + A.cssFor(look()) + '\n' + custom;
}

function themeMeta() {
  const pick = ['strip', 'surface', 'raised', 'field', 'text', 'text-dim', 'accent', 'line', 'page-bg'];
  return themeNames().map((name) => {
    const f = themeFile(name);
    let css = '';
    try { css = fs.readFileSync(f, 'utf8'); } catch (e) { /* ignore */ }
    const t = A.parseTheme(css);
    const vars = {};
    pick.forEach((k) => { if (t.vars[k]) vars[k] = t.vars[k]; });
    return { name, scheme: t.scheme, user: f.startsWith(USER_THEMES), vars };
  });
}

function frameColor() {
  const t = A.parseTheme(readTheme());
  const pick = look().frame || look().strip || t.vars.frame || t.vars.strip || '';
  return /^#[0-9a-f]{3,8}$/i.test(pick) ? pick : '#101318';
}

function applyTheme() {
  const m = /scheme:\s*(dark|light)/.exec(readTheme());
  nativeTheme.themeSource = m ? m[1] : 'system';
  const stamp = Date.now();
  for (const w of wins) w.send('theme', stamp);
  broadcastToPages('theme', stamp);
}

function applyLook() {
  applyTheme();
  for (const w of wins) w.applyLook();
}

// ---------------------------------------------------------------- helpers
function broadcastToPages(event, data) {
  for (const w of wins) for (const t of w.tabs) if (isInternal(t.wc.getURL())) t.wc.send('orbit:push', event, data);
}

function pushAll() { for (const w of wins) w.pushState(); }

function displayTitle(t) {
  const url = t.wc.getURL();
  if (!url || url === 'about:blank') return 'New tab';
  return hostOf(url) || url;
}

function tabState(t) {
  return { id: t.id, title: t.title || displayTitle(t), url: t.wc.getURL(), favicon: t.favicon, loading: t.loading };
}

function externalOpen(url) {
  if (/^(mailto|tel):/i.test(url)) shell.openExternal(url).catch(() => {});
}

function tabById(id) {
  for (const w of wins) { const t = w.tabs.find((x) => x.id === Number(id)); if (t) return t; }
  return null;
}

function ownerOf(tab) {
  for (const w of wins) if (w.tabs.includes(tab)) return w;
  return null;
}

// ---------------------------------------------------------------- one browser window
class Win {
  constructor(opts = {}) {
    this.private = !!opts.private;
    this.partition = this.private ? 'orbit-private-' + (++privateCounter) : '';
    this.tabs = [];
    this.active = null;
    this.chromeReady = false;
    this.popup = false;
    this.htmlFull = false;
    this.viewport = null; // where the page goes, measured by the browser UI (CSS px)
    this.lastSize = null;
    this.stateTimer = null;

    const L = look();
    const custom = (L.titleBar || 'custom') === 'custom';
    this.frameless = custom;
    const saved = settings.get('window');
    const o = { width: saved.width || 1280, height: saved.height || 800, minWidth: 640, minHeight: 420, title: 'Orbit', frame: !custom, backgroundColor: frameColor(), icon: path.join(__dirname, 'build', 'icon.png') };
    if (lastWin && lastWin.win && !lastWin.win.isDestroyed?.()) {
      try { const b = lastWin.win.getBounds(); o.x = b.x + 28; o.y = b.y + 28; o.width = b.width; o.height = b.height; } catch (e) { /* ignore */ }
    }
    this.win = new BaseWindow(o);
    if (!lastWin && !this.private && saved.maximized) this.win.maximize();

    this.chrome = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload-chrome.js'), contextIsolation: true, sandbox: true } });
    this.chrome.setBackgroundColor('#00000000');
    this.win.contentView.addChildView(this.chrome);
    const cwc = this.chrome.webContents;
    cwc.on('before-input-event', (e, i) => this.handleKey(e, i));
    cwc.on('context-menu', (e) => e.preventDefault());
    cwc.on('will-navigate', (e) => e.preventDefault());
    cwc.setWindowOpenHandler(() => ({ action: 'deny' }));
    cwc.on('did-finish-load', () => this.applyZoom());
    cwc.loadURL('orbit://ui/chrome.html');
    if (process.env.ORBIT_DEBUG) cwc.openDevTools({ mode: 'detach' });

    ['resize', 'enter-full-screen', 'leave-full-screen'].forEach((ev) => this.win.on(ev, () => this.onResize()));
    ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach((ev) => this.win.on(ev, () => this.pushState()));
    this.win.on('focus', () => { lastWin = this; });
    this.win.on('close', () => {
      if (this.private || wins.size > 1) return;
      try {
        const b = this.win.getNormalBounds();
        settings.set('window', { width: b.width, height: b.height, maximized: this.win.isMaximized() });
      } catch (e) { /* ignore */ }
    });
    this.win.on('closed', () => this.dispose());

    wins.add(this);
    lastWin = this;
    this.applyLook();
  }

  // ---- messaging
  send(event, data) {
    const wc = this.chrome && this.chrome.webContents;
    if (wc && !wc.isDestroyed()) wc.send('orbit:push', event, data);
  }

  stateFor() {
    const t = this.active;
    const url = t ? t.wc.getURL() : '';
    const bm = url ? bookmarks.findUrl(url) : null;
    const nav = t ? t.wc.navigationHistory : null;
    return {
      tabs: this.tabs.map(tabState),
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
      look: A.attrsFor(look()),
      private: this.private,
      frameless: this.frameless,
      maximized: this.win.isMaximized(),
      fullscreen: this.win.isFullScreen(),
    };
  }

  pushState() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      if (!this.chromeReady || !this.win) return;
      this.send('state', this.stateFor());
      if (this.active) this.win.setTitle((this.active.title || displayTitle(this.active)) + (this.private ? ' — Orbit (private)' : ' — Orbit'));
    }, 20);
  }

  // ---- look and layout
  zoomFactor() { return Math.max(0.5, Math.min(3, (look().uiScale || 100) / 100)); }

  applyZoom() { try { this.chrome.webContents.setZoomFactor(this.zoomFactor()); } catch (e) { /* ignore */ } }

  applyLook() {
    this.applyZoom();
    const rad = look().pageRadius || 0;
    for (const t of this.tabs) { try { t.view.setBorderRadius(rad); } catch (e) { /* ignore */ } }
    try { this.win.setBackgroundColor(frameColor()); } catch (e) { /* ignore */ }
    this.layout();
    this.pushState();
  }

  onResize() {
    const { width, height } = this.win.getContentBounds();
    if (this.viewport && this.lastSize) {
      const z = this.zoomFactor();
      this.viewport = Object.assign({}, this.viewport, {
        width: Math.max(0, this.viewport.width + (width - this.lastSize.width) / z),
        height: Math.max(0, this.viewport.height + (height - this.lastSize.height) / z),
      });
    }
    this.lastSize = { width, height };
    this.layout();
  }

  /** The browser UI covers the whole window; pages sit exactly where its #viewport element is. */
  layout() {
    if (!this.win) return;
    const { width, height } = this.win.getContentBounds();
    this.lastSize = { width, height };
    this.chrome.setBounds({ x: 0, y: 0, width, height });
    const full = this.htmlFull && !!this.active;
    this.chrome.setVisible(!full);
    let rect;
    if (full) rect = { x: 0, y: 0, width, height };
    else if (this.viewport) {
      const z = this.zoomFactor();
      const x = Math.max(0, Math.round(this.viewport.x * z));
      const y = Math.max(0, Math.round(this.viewport.y * z));
      rect = { x, y, width: Math.max(0, Math.min(width - x, Math.round(this.viewport.width * z))), height: Math.max(0, Math.min(height - y, Math.round(this.viewport.height * z))) };
    } else rect = { x: 0, y: 84, width, height: Math.max(0, height - 84) };
    for (const t of this.tabs) { t.view.setVisible(t === this.active); t.view.setBounds(rect); }
  }

  /** The browser UI sits under the pages, and on top of them while a menu is open. */
  restack() {
    if (this.popup) this.win.contentView.addChildView(this.chrome);
    else for (const t of this.tabs) this.win.contentView.addChildView(t.view);
  }

  setPopup(on) {
    if (this.popup === on) return;
    this.popup = on;
    this.restack();
  }

  focusOmnibox() {
    this.chrome.webContents.focus();
    this.send('focus-omnibox', null);
  }

  // ---- tabs
  createTab(url, opts = {}) {
    const ses = ensureSession(this.partition);
    void ses;
    const prefs = {
      preload: path.join(__dirname, 'preload-tab.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, spellcheck: true,
    };
    if (this.partition) prefs.partition = this.partition;
    const view = new WebContentsView({ webPreferences: prefs });
    const wc = view.webContents;
    const tab = { id: nextTabId++, view, wc, title: '', favicon: '', loading: false };
    try { view.setBorderRadius(look().pageRadius || 0); } catch (e) { /* ignore */ }

    const idx = opts.after && this.tabs.includes(opts.after) ? this.tabs.indexOf(opts.after) + 1 : this.tabs.length;
    this.tabs.splice(idx, 0, tab);
    this.win.contentView.addChildView(view);
    if (this.popup) this.win.contentView.addChildView(this.chrome);

    wc.on('page-title-updated', (e, title) => { tab.title = title; if (!this.private) history.setTitle(wc.getURL(), title); this.pushState(); });
    wc.on('page-favicon-updated', (e, icons) => { tab.favicon = (icons && icons[0]) || ''; if (!this.private && tab.favicon) favicons.note(hostOf(wc.getURL()), tab.favicon); this.pushState(); });
    wc.on('did-start-loading', () => { tab.loading = true; this.pushState(); });
    wc.on('did-stop-loading', () => { tab.loading = false; this.pushState(); });
    wc.on('did-navigate', (e, u) => { tab.favicon = ''; if (!this.private) history.visit(u, wc.getTitle()); this.pushState(); });
    wc.on('did-navigate-in-page', () => this.pushState());
    wc.on('did-fail-load', (e, code, desc, failedUrl, isMain) => {
      if (!isMain || code === -3) return;
      wc.loadURL('orbit://error/?u=' + encodeURIComponent(failedUrl) + '&d=' + encodeURIComponent(desc) + '&c=' + code).catch(() => {});
    });
    wc.on('will-navigate', (e, u) => {
      if (/^(mailto|tel):/i.test(u)) { e.preventDefault(); externalOpen(u); return; }
      if (/^file:/i.test(u) && !/^file:/i.test(wc.getURL())) e.preventDefault();
    });
    wc.on('found-in-page', (e, r) => { if (tab === this.active) this.send('find', { active: r.activeMatchOrdinal, count: r.matches }); });
    wc.on('enter-html-full-screen', () => { this.htmlFull = true; this.win.setFullScreen(true); this.layout(); });
    wc.on('leave-html-full-screen', () => { this.htmlFull = false; this.win.setFullScreen(false); this.layout(); });
    wc.on('before-input-event', (e, i) => this.handleKey(e, i));
    wc.on('context-menu', (e, params) => this.showContextMenu(tab, params));
    wc.setWindowOpenHandler((details) => {
      const u = details.url;
      if (u && !/^(https?|about|blob|data):/i.test(u)) { externalOpen(u); return { action: 'deny' }; }
      const background = details.disposition === 'background-tab';
      return { action: 'allow', createWindow: () => this.createTab(null, { activate: !background, after: tab }).wc };
    });

    if (url) loadIn(tab, url);
    if (opts.activate !== false) this.selectTab(tab); else { this.layout(); this.pushState(); }
    return tab;
  }

  selectTab(tab) {
    if (!tab || !this.tabs.includes(tab)) return;
    if (this.active && this.active !== tab) { try { this.active.wc.stopFindInPage('clearSelection'); } catch (e) { /* ignore */ } this.send('find-close', null); }
    this.active = tab;
    this.layout();
    this.pushState();
    if (!isInternal(tab.wc.getURL()) || tab.wc.getURL().startsWith('orbit://newtab')) tab.wc.focus();
  }

  closeTab(tab) {
    if (!tab || !this.tabs.includes(tab)) return;
    const url = tab.wc.getURL();
    if (!this.private && url && !url.startsWith('orbit://newtab') && url !== 'about:blank') closedUrls.push(url);
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    this.win.contentView.removeChildView(tab.view);
    try { tab.wc.close(); } catch (e) { /* ignore */ }
    if (!this.tabs.length) { this.active = null; this.win.close(); return; }
    if (this.active === tab) this.selectTab(this.tabs[Math.min(i, this.tabs.length - 1)]); else this.pushState();
  }

  cycle(dir) {
    if (this.tabs.length < 2) return;
    this.selectTab(this.tabs[(this.tabs.indexOf(this.active) + dir + this.tabs.length) % this.tabs.length]);
  }

  openPage(page, hash) {
    const base = 'orbit://' + page;
    const existing = this.tabs.find((t) => t.wc.getURL().startsWith(base));
    if (existing) { this.selectTab(existing); if (hash) loadIn(existing, base + '/#' + hash); return existing; }
    return this.createTab(base + (hash ? '/#' + hash : ''), { after: this.active });
  }

  reload(hard) {
    if (!this.active) return;
    if (hard) this.active.wc.reloadIgnoringCache(); else this.active.wc.reload();
  }

  zoom(delta) {
    if (!this.active) return;
    this.active.wc.setZoomLevel(delta === 0 ? 0 : Math.max(-4, Math.min(5, this.active.wc.getZoomLevel() + delta * ZOOM_STEP)));
    this.pushState();
  }

  toggleDevtools() {
    if (!this.active) return;
    if (this.active.wc.isDevToolsOpened()) this.active.wc.closeDevTools(); else this.active.wc.openDevTools({ mode: 'right' });
  }

  reopenTab() {
    const url = closedUrls.pop();
    if (url) this.createTab(url, { after: this.active });
  }

  // ---- keyboard
  handleKey(event, input) {
    if (input.type !== 'keyDown') return;
    const k = input.key;
    const lk = k.length === 1 ? k.toLowerCase() : k;
    let handled = true;
    if (input.control && !input.alt) {
      if (lk === 't') { if (input.shift) this.reopenTab(); else { this.createTab(NEWTAB, { after: this.active }); this.focusOmnibox(); } }
      else if (lk === 'n') openWindow([NEWTAB], { private: !!input.shift });
      else if (lk === 'w') { if (input.shift) this.win.close(); else this.closeTab(this.active); }
      else if (lk === 'l') this.focusOmnibox();
      else if (lk === 'r') this.reload(input.shift);
      else if (lk === 'd') this.send('toggle-bookmark', null);
      else if (lk === 'f') this.send('find-open', null);
      else if (lk === 'h') this.openPage('history');
      else if (lk === 'o' && input.shift) this.openPage('bookmarks');
      else if (k === ',') this.openPage('settings');
      else if (lk === 'q') app.quit();
      else if (k === 'Tab') this.cycle(input.shift ? -1 : 1);
      else if (k === 'PageDown') this.cycle(1);
      else if (k === 'PageUp') this.cycle(-1);
      else if (/^[1-9]$/.test(k)) this.selectTab(k === '9' ? this.tabs[this.tabs.length - 1] : this.tabs[Number(k) - 1]);
      else if (k === '+' || k === '=') this.zoom(1);
      else if (k === '-' || k === '_') this.zoom(-1);
      else if (k === '0') this.zoom(0);
      else handled = false;
    } else if (input.alt && !input.control) {
      if (k === 'ArrowLeft') { if (this.active && this.active.wc.navigationHistory.canGoBack()) this.active.wc.navigationHistory.goBack(); }
      else if (k === 'ArrowRight') { if (this.active && this.active.wc.navigationHistory.canGoForward()) this.active.wc.navigationHistory.goForward(); }
      else if (k === 'Home') { if (this.active) loadIn(this.active, settings.get('homepage')); }
      else handled = false;
    } else if (k === 'F5') this.reload(input.shift);
    else if (k === 'F6') this.focusOmnibox();
    else if (k === 'F11') this.win.setFullScreen(!this.win.isFullScreen());
    else if (k === 'F12') this.toggleDevtools();
    else handled = false;
    if (handled) event.preventDefault();
  }

  // ---- context menu
  showContextMenu(tab, p) {
    const items = [];
    const nav = tab.wc.navigationHistory;
    if (p.misspelledWord) {
      (p.dictionarySuggestions || []).slice(0, 5).forEach((s) => items.push({ label: s, click: () => tab.wc.replaceMisspelling(s) }));
      if (items.length) items.push({ type: 'separator' });
    }
    if (p.linkURL) {
      items.push({ label: 'Open link in new tab', click: () => this.createTab(p.linkURL, { activate: false, after: tab }) });
      items.push({ label: 'Open link in new window', click: () => openWindow([p.linkURL], { private: this.private }) });
      items.push({ label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) });
      items.push({ type: 'separator' });
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push({ label: 'Open image in new tab', click: () => this.createTab(p.srcURL, { after: tab }) });
      items.push({ label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) });
      items.push({ type: 'separator' });
    }
    if (p.isEditable) {
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    } else {
      if (p.selectionText) {
        const sel = p.selectionText.trim();
        items.push({ role: 'copy' });
        items.push({ label: 'Search for “' + sel.slice(0, 30) + (sel.length > 30 ? '…' : '') + '”', click: () => this.createTab(searchTemplate().replace('%s', encodeURIComponent(sel)), { after: tab }) });
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
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  dispose() {
    wins.delete(this);
    if (lastWin === this) lastWin = [...wins].pop() || null;
    for (const t of this.tabs) { try { t.wc.close(); } catch (e) { /* ignore */ } }
    try { this.chrome.webContents.close(); } catch (e) { /* ignore */ }
    this.tabs = [];
    this.active = null;
    clearTimeout(this.stateTimer);
    if (this.partition) {
      try { const ses = session.fromPartition(this.partition); ses.clearStorageData().catch(() => {}); ses.clearCache().catch(() => {}); } catch (e) { /* ignore */ }
    }
    this.win = null;
  }
}

function loadIn(tab, url) {
  tab.wc.loadURL(url).catch(() => { /* aborted or failed: did-fail-load handles it */ });
}

function openWindow(urls, opts = {}) {
  const w = new Win(opts);
  const list = urls && urls.length ? urls : [NEWTAB];
  list.forEach((u, i) => w.createTab(u, { activate: i === list.length - 1 }));
  if (list.length === 1 && list[0] === NEWTAB) w.focusOmnibox();
  return w;
}

// ---------------------------------------------------------------- orbit:// protocol
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
};
const CSP = "default-src 'none'; script-src orbit://ui orbit://custom; style-src orbit://ui orbit://theme 'unsafe-inline'; img-src * data:; base-uri 'none'; form-action 'none'";
const BG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);

function orbitHandler(request) {
  const u = new URL(request.url);
  const noStore = { 'cache-control': 'no-store' };
  if (u.hostname === 'theme') return new Response(themeCss(), { headers: Object.assign({ 'content-type': MIME['.css'] }, noStore) });
  if (u.hostname === 'custom') {
    let js = '';
    if (!SAFE_MODE && u.pathname === '/chrome.js') { try { js = fs.readFileSync(CUSTOM_JS, 'utf8'); } catch (e) { /* ignore */ } }
    return new Response(js, { headers: Object.assign({ 'content-type': MIME['.js'] }, noStore) });
  }
  if (u.hostname === 'bg') {
    const name = path.basename(decodeURIComponent(u.pathname));
    const ext = path.extname(name).toLowerCase();
    if (!BG_EXT.has(ext)) return new Response('Not found', { status: 404 });
    try { return new Response(fs.readFileSync(path.join(BG_DIR, name)), { headers: { 'content-type': MIME[ext] } }); } catch (e) { return new Response('Not found', { status: 404 }); }
  }
  const rel = u.hostname === 'ui' ? u.pathname : PAGES[u.hostname];
  if (!rel) return new Response('Not found', { status: 404 });
  const file = path.normalize(path.join(UI_DIR, rel));
  if (!file.startsWith(UI_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
  try {
    const ext = path.extname(file);
    const headers = Object.assign({ 'content-type': MIME[ext] || 'application/octet-stream' }, noStore);
    if (ext === '.html') headers['content-security-policy'] = CSP;
    return new Response(fs.readFileSync(file), { headers });
  } catch (e) {
    return new Response('Not found', { status: 404 });
  }
}

// ---------------------------------------------------------------- sessions: identity, downloads, permissions
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, base + ' (' + i + ')' + ext);
  return p;
}

function notify(msg) { for (const w of wins) w.send('toast', msg); }

function setupSession(ses) {
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
    notify('Downloading ' + name + ' …');
    item.once('done', (e, state) => notify(state === 'completed' ? 'Downloaded ' + name + ' → ' + dir : 'Download failed: ' + name));
  });

  // 'mediaKeySystem' is what DRM players ask for before they can play protected video: denying it breaks them even with Widevine installed.
  const AUTO = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'speaker-selection', 'window-management', 'mediaKeySystem', 'protected-media-identifier']);
  const ASK = { media: 'use your camera or microphone', geolocation: 'know your location', notifications: 'show notifications', midi: 'use MIDI devices', 'clipboard-read': 'read your clipboard' };

  ses.setPermissionCheckHandler((wc, permission, origin) => AUTO.has(permission) || permissionMemory.get(origin + '|' + permission) === true);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (AUTO.has(permission)) return callback(true);
    if (!ASK[permission]) return callback(false);
    const origin = hostOf(details.requestingUrl) || 'This page';
    const key = origin + '|' + permission;
    if (permissionMemory.has(key)) return callback(permissionMemory.get(key));
    const w = lastWin && lastWin.win ? lastWin.win : null;
    dialog.showMessageBox(w, { type: 'question', message: origin + ' wants to ' + ASK[permission], buttons: ['Block', 'Allow'], defaultId: 0, cancelId: 0 })
      .then((r) => { permissionMemory.set(key, r.response === 1); callback(r.response === 1); })
      .catch(() => callback(false));
    return undefined;
  });
}

/** Sets up the default session, or a private (in-memory) one, once. */
function ensureSession(partition) {
  const ses = partition ? session.fromPartition(partition) : session.defaultSession;
  if (!configuredSessions.has(ses)) {
    configuredSessions.add(ses);
    setupSession(ses);
    if (partition && ses.protocol) ses.protocol.handle('orbit', orbitHandler);
  }
  return ses;
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
const dlDir = () => settings.get('downloadDir') || app.getPath('downloads');

/** Who sent this message, and which window do they belong to? Websites are never allowed. */
function senderCtx(event) {
  const wc = event.sender;
  for (const w of wins) {
    if (w.chrome.webContents.id === wc.id) return { kind: 'chrome', win: w, tab: null };
    const tab = w.tabs.find((t) => t.wc.id === wc.id);
    if (tab) {
      const frame = event.senderFrame;
      if (frame && frame.parent === null && String(frame.url).startsWith('orbit://')) return { kind: 'page', win: w, tab };
      return null;
    }
  }
  return null;
}

function bookmarksChanged() { pushAll(); broadcastToPages('bookmarks-changed', null); }

function reloadWebTabs() {
  for (const w of wins) for (const t of w.tabs) if (!isInternal(t.wc.getURL())) t.wc.reload();
}

const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));

const COMMANDS = {
  'chrome.ready': (a, { win }) => { win.chromeReady = true; win.pushState(); return true; },
  'chrome.layout': (a, { win }) => {
    const vp = a.viewport;
    if (vp && [vp.x, vp.y, vp.width, vp.height].every((n) => Number.isFinite(Number(n)))) {
      win.viewport = { x: num(vp.x, 0, 20000), y: num(vp.y, 0, 20000), width: num(vp.width, 0, 20000), height: num(vp.height, 0, 20000) };
    }
    win.setPopup(!!a.popup);
    win.layout();
    return true;
  },
  'tabs.new': ({ url }, { win }) => {
    const t = win.createTab(url ? resolveInput(url, searchTemplate()) : NEWTAB, { after: win.active });
    if (!url) win.focusOmnibox();
    return t.id;
  },
  'tabs.close': ({ id }, { win }) => { const t = tabById(id); const w = t ? ownerOf(t) : win; if (t && w) w.closeTab(t); },
  'tabs.select': ({ id }, { win }) => win.selectTab(win.tabs.find((t) => t.id === Number(id))),
  'tabs.move': ({ id, index }, { win }) => {
    const t = win.tabs.find((x) => x.id === Number(id));
    if (!t) return;
    win.tabs.splice(win.tabs.indexOf(t), 1);
    win.tabs.splice(Math.max(0, Math.min(Number(index), win.tabs.length)), 0, t);
    win.pushState();
  },
  'tabs.duplicate': ({ id }, { win }) => { const t = win.tabs.find((x) => x.id === Number(id)); if (t) win.createTab(t.wc.getURL(), { after: t }); },
  'tabs.closeOthers': ({ id }, { win }) => {
    const keep = win.tabs.find((x) => x.id === Number(id));
    win.tabs.filter((t) => t !== keep).forEach((t) => win.closeTab(t));
    if (keep) win.selectTab(keep);
  },
  'tabs.reopen': (a, { win }) => win.reopenTab(),
  'tabs.toWindow': ({ id }, { win }) => {
    const t = win.tabs.find((x) => x.id === Number(id));
    if (!t || win.tabs.length < 2) return;
    const url = t.wc.getURL();
    win.closeTab(t);
    openWindow([url], { private: win.private });
  },
  'nav.go': ({ text }, { win, tab }) => {
    const t = tab || win.active;
    if (!t) return;
    loadIn(t, resolveInput(text, searchTemplate()));
    t.wc.focus();
  },
  'nav.back': (a, { win }) => { const t = win.active; if (t && t.wc.navigationHistory.canGoBack()) t.wc.navigationHistory.goBack(); },
  'nav.forward': (a, { win }) => { const t = win.active; if (t && t.wc.navigationHistory.canGoForward()) t.wc.navigationHistory.goForward(); },
  'nav.reload': ({ hard }, { win }) => win.reload(!!hard),
  'nav.stop': (a, { win }) => { if (win.active) win.active.wc.stop(); },
  'nav.home': (a, { win }) => { if (win.active) loadIn(win.active, settings.get('homepage')); },
  'find.search': ({ text, dir }, { win }) => {
    const t = win.active;
    if (!t) return;
    if (!text) { t.wc.stopFindInPage('clearSelection'); win.send('find', { active: 0, count: 0 }); return; }
    t.wc.findInPage(text, { forward: dir !== 'prev', findNext: !!dir });
  },
  'find.close': (a, { win }) => { if (win.active) { win.active.wc.stopFindInPage('clearSelection'); win.active.wc.focus(); } },
  zoom: ({ delta }, { win }) => win.zoom(Number(delta)),
  devtools: (a, { win }) => win.toggleDevtools(),
  openPage: ({ page, hash }, { win }) => { if (PAGES[page]) win.openPage(page, hash); },
  'omnibox.suggest': ({ q }, { win }) => {
    const seen = new Set();
    const out = [];
    const add = (type, title, url) => { if (!seen.has(url)) { seen.add(url); out.push({ type, title, url }); } };
    bookmarks.search(q, 4).forEach((b) => add('bookmark', b.title, b.url));
    if (!win.private) history.suggest(q, 6).forEach((h) => add('history', h.title, h.url));
    return out.slice(0, 8);
  },
  quit: () => app.quit(),

  'win.new': () => { openWindow([NEWTAB]); return true; },
  'win.newPrivate': () => { openWindow([NEWTAB], { private: true }); return true; },
  'win.minimize': (a, { win }) => { win.win.minimize(); return true; },
  'win.maximize': (a, { win }) => { if (win.win.isMaximized()) win.win.unmaximize(); else win.win.maximize(); return true; },
  'win.close': (a, { win }) => { win.win.close(); return true; },

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

  'settings.get': () => ({
    settings: settings.all(), themes: themeNames(), identities: ident.listProfiles(), version: app.getVersion(), chrome: process.versions.chrome, configDir: CONFIG,
    newtab: A.newtabFor(look()),
  }),
  'settings.set': ({ key, value }) => {
    if (key === 'appearance') { setLook(value); return true; }
    settings.set(key, value);
    if (key === 'theme') applyLook();
    if (key === 'identity') { session.defaultSession.setUserAgent((ident.PROFILES[value] || ident.PROFILES.windows).ua); reloadWebTabs(); }
    if (key === 'siteIdentity') reloadWebTabs();
    pushAll();
    return true;
  },
  'themes.list': () => themeNames(),
  'css.get': () => { try { return fs.readFileSync(CUSTOM_CSS, 'utf8'); } catch (e) { return ''; } },
  'css.set': ({ css }) => { fs.writeFileSync(CUSTOM_CSS, String(css)); applyTheme(); return true; },
  'js.get': () => { try { return fs.readFileSync(CUSTOM_JS, 'utf8'); } catch (e) { return ''; } },
  'js.set': ({ js }) => { fs.writeFileSync(CUSTOM_JS, String(js)); return true; },

  // -- appearance studio
  'appearance.get': () => ({
    values: look(), schema: A.SCHEMA, groups: A.GROUPS, themes: themeMeta(), theme: settings.get('theme'), configDir: CONFIG,
    fonts: ['Ubuntu', 'Cantarell', 'Noto Sans', 'Inter', 'Roboto', 'Fira Sans', 'Open Sans', 'Lato', 'Source Sans 3', 'JetBrains Mono', 'Fira Code', 'DejaVu Sans', 'Liberation Sans', 'Georgia', 'Segoe UI', 'system-ui', 'monospace', 'serif'],
  }),
  'appearance.set': ({ id, value }) => { setLook(A.setValue(look(), id, value)); return look(); },
  'appearance.setMany': ({ values, replace }) => {
    let next = replace ? {} : Object.assign({}, look());
    Object.entries(values || {}).forEach(([id, v]) => { next = A.setValue(next, id, v); });
    setLook(next);
    return look();
  },
  'appearance.reset': ({ group }) => {
    if (!group) { setLook({}); return look(); }
    const next = Object.assign({}, look());
    A.SCHEMA.filter((e) => e.group === group).forEach((e) => { delete next[e.id]; });
    setLook(next);
    return look();
  },
  'appearance.export': () => JSON.stringify({ orbit: 'look', version: 1, theme: settings.get('theme'), values: look(), css: (() => { try { return fs.readFileSync(CUSTOM_CSS, 'utf8'); } catch (e) { return ''; } })() }, null, 1),
  'appearance.import': ({ json }) => {
    let d;
    try { d = JSON.parse(String(json)); } catch (e) { throw new Error('That file is not valid JSON'); }
    if (!d || d.orbit !== 'look' || typeof d.values !== 'object') throw new Error('That is not an Orbit look file');
    if (typeof d.theme === 'string' && themeFile(d.theme)) settings.set('theme', d.theme);
    if (typeof d.css === 'string' && d.css.length < 200000) fs.writeFileSync(CUSTOM_CSS, d.css);
    setLook(A.sanitize(d.values));
    return look();
  },
  'appearance.saveTheme': ({ name }) => {
    const id = A.themeName(name);
    if (!id) throw new Error('Give the theme a name');
    const t = A.parseTheme(readTheme());
    fs.writeFileSync(path.join(USER_THEMES, id + '.css'), A.themeFileFor(t.vars, look(), t.scheme));
    const next = Object.assign({}, look());
    A.SCHEMA.filter((e) => e.var && e.group !== 'newtab').forEach((e) => { delete next[e.id]; });
    settings.set('theme', id);
    setLook(next);
    return id;
  },
  'appearance.deleteTheme': ({ name }) => {
    const f = path.join(USER_THEMES, path.basename(String(name)) + '.css');
    if (!fs.existsSync(f)) throw new Error('Only your own themes can be deleted');
    fs.unlinkSync(f);
    if (settings.get('theme') === name) settings.set('theme', 'dark');
    applyLook();
    return true;
  },
  'appearance.background': ({ ext, data }) => {
    const e = String(ext || '').toLowerCase().replace(/^\./, '');
    if (!BG_EXT.has('.' + e)) throw new Error('Use a PNG, JPG, WebP, GIF or AVIF image');
    const buf = Buffer.from(String(data || ''), 'base64');
    if (!buf.length || buf.length > 15 * 1024 * 1024) throw new Error('The image must be under 15 MB');
    const name = 'bg-' + Date.now() + '.' + e;
    fs.writeFileSync(path.join(BG_DIR, name), buf);
    try { fs.readdirSync(BG_DIR).filter((f) => f !== name).forEach((f) => fs.unlinkSync(path.join(BG_DIR, f))); } catch (err) { /* ignore */ }
    setLook(Object.assign({}, look(), { ntBg: 'image', ntImage: name }));
    return name;
  },

  'extensions.list': () => {
    reloadExtensions();
    const enabled = settings.get('extensionsEnabled');
    const list = extensions.map((x) => ({
      id: x.id, name: x.name, version: x.version, description: x.description, origin: x.origin, matches: x.matches,
      enabled: Object.prototype.hasOwnProperty.call(enabled, x.id) ? !!enabled[x.id] : x.defaultEnabled,
    }));
    // Built in and on by default: the new tab page. Turning it off gives a plain search page instead.
    list.unshift({
      id: LUMILIST_ID, name: 'Lumilist', version: '1.0', origin: 'built-in', matches: ['New tab page'], enabled: lumilistOn(),
      description: 'Your bookmark folders as glass cards on a background you choose. Drag cards around, edit links in place, add pages.',
    });
    return list;
  },
  'extensions.toggle': ({ id, enabled }) => {
    settings.set('extensionsEnabled', Object.assign({}, settings.get('extensionsEnabled'), { [id]: !!enabled }));
    if (id === LUMILIST_ID) broadcastToPages('lumilist-changed', null); else reloadWebTabs();
    return true;
  },
  'extensions.openFolder': () => shell.openPath(USER_EXT),
  // -- Lumilist (new tab page)
  'lumilist.get': () => LL.sanitize(settings.get('lumilist')),
  'lumilist.set': ({ data }) => { const clean = LL.sanitize(data); settings.set('lumilist', clean); return clean; },
  'favicons.get': ({ hosts }) => favicons.lookup(hosts),
  'downloads.open': () => { try { fs.mkdirSync(dlDir(), { recursive: true }); } catch (e) { /* ignore */ } return shell.openPath(dlDir()); },
  'drm.status': () => drmStatus(),
  'drm.retry': () => { if (drm.state !== 'starting' && drm.state !== 'retrying') startWidevine(); return drmStatus(); },
  'data.clear': async ({ what }) => {
    const ses = session.defaultSession;
    if (what === 'history') history.clear();
    else if (what === 'cookies') await ses.clearStorageData({ storages: ['cookies'] });
    else if (what === 'cache') await ses.clearCache();
    else if (what === 'all') { await ses.clearStorageData(); await ses.clearCache(); history.clear(); favicons.clear(); }
    return true;
  },
};

const PAGE_CMDS = new Set([
  'nav.go', 'bookmarks.tree', 'bookmarks.add', 'bookmarks.addFolder', 'bookmarks.update', 'bookmarks.move', 'bookmarks.remove',
  'bookmarks.importHtml', 'bookmarks.exportHtml', 'history.list', 'history.top', 'history.remove', 'history.clear',
  'settings.get', 'settings.set', 'themes.list', 'css.get', 'css.set', 'js.get', 'js.set', 'extensions.list', 'extensions.toggle',
  'extensions.openFolder', 'data.clear', 'drm.status', 'drm.retry', 'lumilist.get', 'lumilist.set', 'favicons.get', 'downloads.open', 'win.new', 'win.newPrivate',
  'appearance.get', 'appearance.set', 'appearance.setMany', 'appearance.reset', 'appearance.export', 'appearance.import',
  'appearance.saveTheme', 'appearance.deleteTheme', 'appearance.background',
]);

ipcMain.handle('orbit:call', async (event, cmd, args) => {
  const ctx = senderCtx(event);
  if (!ctx) throw new Error('not allowed');
  const fn = COMMANDS[cmd];
  if (!fn) throw new Error('unknown command: ' + cmd);
  if (ctx.kind !== 'chrome' && !PAGE_CMDS.has(cmd)) throw new Error('not allowed: ' + cmd);
  const r = await fn(args || {}, ctx);
  return r === undefined ? null : r;
});

// ---------------------------------------------------------------- start / stop
function readSession() {
  try {
    const d = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (!Array.isArray(d)) return [];
    const groups = d.length && typeof d[0] === 'string' ? [d] : d; // older versions stored one flat list
    return groups.map((g) => (Array.isArray(g) ? g.filter((u) => typeof u === 'string') : [])).filter((g) => g.length);
  } catch (e) { return []; }
}

function openInitial(urls) {
  if (urls.length) { openWindow(urls); return; }
  const groups = settings.get('restoreSession') ? readSession() : [];
  if (!groups.length) { openWindow([NEWTAB]); return; }
  groups.forEach((g) => openWindow(g));
}

const argvUrls = (argv) => argv.filter((a) => /^(https?:\/\/|file:\/\/|orbit:\/\/)/i.test(a));

app.on('second-instance', (e, argv) => {
  const urls = argvUrls(argv);
  const w = lastWin && lastWin.win ? lastWin : [...wins][0];
  if (!w) { openWindow(urls); return; }
  if (w.win.isMinimized()) w.win.restore();
  w.win.focus();
  urls.forEach((u) => w.createTab(u, { after: w.active }));
});

app.on('before-quit', () => {
  try {
    if (settings.get('restoreSession')) {
      const groups = [...wins].filter((w) => !w.private).map((w) => w.tabs.map((t) => t.wc.getURL()).filter(Boolean)).filter((g) => g.length);
      fs.writeFileSync(SESSION_FILE, JSON.stringify(groups));
    }
  } catch (e) { /* ignore */ }
  try { settings.flush(); } catch (e) { /* ignore */ }
  bookmarks.flush();
  history.flush();
  favicons.flush();
});
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  reloadExtensions();
  protocol.handle('orbit', orbitHandler);
  ensureSession('');
  applyTheme();
  // Give Widevine a moment to be ready before the first page loads; on a first run that has to download it, don't hold the window back for long.
  await Promise.race([startWidevine(), new Promise((res) => setTimeout(res, 8000))]);
  openInitial(argvUrls(process.argv));
});

module.exports = { COMMANDS };
