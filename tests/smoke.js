'use strict';
/* Loads main.js against a fake `electron` module and drives the UI commands, to catch typos and wiring bugs. */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-smoke-'));
const handlers = {};
const ons = {};
const views = [];
const windows = [];
let protocolHandler = null;
let n = 0;

/** Unknown methods become no-ops, so the fakes keep working when main.js starts using more of Electron. */
const lenient = (obj) => new Proxy(obj, {
  get(t, k, r) {
    if (k in t) return Reflect.get(t, k, r);
    if (typeof k === 'symbol' || k === 'then') return undefined;
    return () => undefined;
  },
});

class FakeWC extends EventEmitter {
  constructor() {
    super(); this.id = ++n; this.url = ''; this.zoom = 0; this.sent = [];
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} };
    return lenient(this);
  }
  loadURL(u) { this.url = u; return Promise.resolve(); }
  getURL() { return this.url; }
  getTitle() { return 'Title'; }
  send(...a) { this.sent.push(a); }
  setWindowOpenHandler(f) { this.woh = f; }
  getZoomLevel() { return this.zoom; }
  setZoomLevel(z) { this.zoom = z; }
  isDestroyed() { return false; }
  isDevToolsOpened() { return false; }
}
class FakeView {
  constructor(opts) { this.webPreferences = (opts && opts.webPreferences) || {}; this.webContents = new FakeWC(); views.push(this); return lenient(this); }
  setBounds(b) { this.bounds = b; }
  setVisible(v) { this.visible = v; }
}
class FakeWin extends EventEmitter {
  constructor(o) {
    super(); this.opts = o; this.contentView = { addChildView() {}, removeChildView() {} }; this.closed = false; windows.push(this);
    return lenient(this);
  }
  getContentBounds() { return { width: 1200, height: 800 }; }
  getBounds() { return { x: 10, y: 10, width: 1200, height: 800 }; }
  getNormalBounds() { return { width: 1200, height: 800 }; }
  isMaximized() { return false; } isFullScreen() { return false; } isMinimized() { return false; } isDestroyed() { return this.closed; }
  close() { if (this.closed) return; this.emit('close'); this.closed = true; this.emit('closed'); }
}

const makeSession = () => {
  const s = {
    webRequest: { onBeforeSendHeaders(f) { s.headerHook = f; } }, setUserAgent() {}, on() {},
    setPermissionCheckHandler(f) { s.permCheck = f; }, setPermissionRequestHandler(f) { s.permReq = f; },
    clearStorageData: async () => {}, clearCache: async () => {}, protocol: { handle() {} },
  };
  return s;
};
const fakeSession = makeSession();
const partitions = {};
const electron = {
  app: {
    setName() {}, getPath: () => tmp, setPath() {}, requestSingleInstanceLock: () => true, on() {}, quit() {},
    commandLine: { appendSwitch() {} }, whenReady: () => Promise.resolve(), getVersion: () => '0.1.0',
  },
  BaseWindow: FakeWin, WebContentsView: FakeView,
  Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({ popup() {} }) },
  ipcMain: { handle: (c, f) => { handlers[c] = f; }, on: (c, f) => { ons[c] = f; } },
  protocol: { registerSchemesAsPrivileged() {}, handle: (s, f) => { protocolHandler = f; } },
  session: { defaultSession: fakeSession, fromPartition: (p) => (partitions[p] = partitions[p] || makeSession()) },
  shell: { openPath: async () => '', openExternal: async () => {} },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  clipboard: { writeText() {} },
  nativeTheme: { themeSource: 'system' },
  // castLabs Electron's Widevine component manager
  components: { whenReady: () => Promise.resolve(), status: () => ({ widevine: { status: 'installed', version: '4.10.0' } }) },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? electron : origLoad.call(this, req, ...rest); };

require('../main.js');

(async function run() {
  await new Promise((r) => setTimeout(r, 200));
  const chromeView = views[0];
  const chromeEvt = (v) => ({ sender: (v || chromeView).webContents, senderFrame: { parent: null, url: 'orbit://ui/chrome.html' } });
  const call = (cmd, args, evt) => handlers['orbit:call'](evt || chromeEvt(), cmd, args);

  // ---- startup: one window = one browser-UI view + one tab
  assert.strictEqual(chromeView.webContents.url, 'orbit://ui/chrome.html');
  assert.strictEqual(views.length, 2, 'one tab opened at startup');
  assert.strictEqual(windows.length, 1);
  assert.strictEqual(windows[0].opts.frame, false, 'Orbit draws its own title bar by default');
  await call('chrome.ready');

  // ---- the page is shown exactly where the browser UI says #viewport is
  await call('chrome.layout', { viewport: { x: 0, y: 120, width: 1200, height: 680 }, popup: false });
  assert.deepStrictEqual(views[1].bounds, { x: 0, y: 120, width: 1200, height: 680 });
  await call('chrome.layout', { viewport: { x: 220, y: 90, width: 980, height: 710 }, popup: true });
  assert.strictEqual(views[1].bounds.x, 220);
  await call('chrome.layout', { viewport: { x: 0, y: 120, width: 1200, height: 680 }, popup: false });

  // ---- tabs
  await call('tabs.new', { url: 'example.com' });
  assert.strictEqual(views[2].webContents.url, 'https://example.com');
  await call('nav.go', { text: 'hello world' });
  assert.ok(views[2].webContents.url.startsWith('https://duckduckgo.com/?q=hello'));
  await call('tabs.move', { id: 3, index: 0 });
  await call('tabs.close', { id: 3 });
  await call('tabs.reopen');
  await call('openPage', { page: 'settings' });
  await call('openPage', { page: 'appearance' });
  assert.ok(views.some((v) => v.webContents.url.startsWith('orbit://appearance')));
  await call('zoom', { delta: 1 });

  // ---- bookmarks, history, search
  const b = await call('bookmarks.add', { url: 'https://a.com', title: 'A', parentId: 1 });
  await call('bookmarks.update', { id: b.id, title: 'A2', parentId: 2 });
  assert.strictEqual((await call('bookmarks.tree')).find((x) => x.id === b.id).parentId, 2);
  assert.strictEqual((await call('omnibox.suggest', { q: 'a2' })).length, 1);
  assert.ok((await call('extensions.list')).some((x) => x.id === 'night-pages'));
  await call('extensions.toggle', { id: 'night-pages', enabled: true });
  await call('settings.set', { key: 'identity', value: 'mac' });
  assert.strictEqual((await call('settings.get')).settings.identity, 'mac');
  await call('settings.set', { key: 'identity', value: 'windows' });
  await call('settings.set', { key: 'theme', value: 'light' });
  assert.strictEqual(electron.nativeTheme.themeSource, 'light');
  await call('css.set', { css: 'body{}' });
  await call('data.clear', { what: 'cache' });
  assert.ok(typeof (await call('bookmarks.exportHtml')) === 'string');

  // ---- appearance studio: every change is validated, nothing raw reaches the stylesheet
  const get = (u) => protocolHandler({ url: u });
  const ap = await call('appearance.get');
  assert.ok(ap.schema.length > 40 && ap.groups.length >= 6 && ap.themes.some((t) => t.name === 'dark'));
  const look = await call('appearance.set', { id: 'accent', value: '#ff2244' });
  assert.strictEqual(look.accent, '#ff2244');
  await assert.rejects(() => call('appearance.set', { id: 'accent', value: 'red; } body { display:none' }), /bad value/);
  await assert.rejects(() => call('appearance.set', { id: 'nope', value: 1 }), /unknown appearance/);
  await call('appearance.set', { id: 'tabs', value: 'left' });
  assert.strictEqual((await call('settings.get')).newtab.ntBrand != null, true);
  const css = await (await get('orbit://theme/current.css')).text();
  assert.ok(css.includes('--accent: #ff2244') && !css.includes('display:none'));
  await call('appearance.set', { id: 'btnHome', value: false });
  assert.ok((await (await get('orbit://theme/current.css')).text()).includes('#home'));
  const exported = await call('appearance.export');
  await call('appearance.reset');
  assert.deepStrictEqual(await call('appearance.set', { id: 'radius', value: 99 }), { radius: 24 });
  await call('appearance.import', { json: exported });
  assert.strictEqual((await call('appearance.get')).values.accent, '#ff2244');
  const themeId = await call('appearance.saveTheme', { name: 'My Look!' });
  assert.strictEqual(themeId, 'my-look');
  assert.ok((await call('themes.list')).includes('my-look'));
  await call('appearance.deleteTheme', { name: 'my-look' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64').toString('base64');
  const bg = await call('appearance.background', { ext: 'png', data: png });
  assert.strictEqual((await get('orbit://bg/' + bg)).status, 200);
  assert.strictEqual((await get('orbit://bg/..%2f..%2fsettings.json')).status, 404);
  await assert.rejects(() => call('appearance.background', { ext: 'svg', data: png }), /PNG, JPG/);
  await call('appearance.reset');
  await call('settings.set', { key: 'theme', value: 'dark' });

  // ---- protected video (Widevine)
  const drm = await call('drm.status');
  assert.strictEqual(drm.ecs, true);
  assert.strictEqual(drm.state, 'ready');
  assert.ok(drm.components.widevine);
  const allowed = await new Promise((res) => fakeSession.permReq(null, 'mediaKeySystem', res, { requestingUrl: 'https://bassthalk.com/x' }));
  assert.strictEqual(allowed, true, 'DRM players must be allowed to use the key system');
  assert.strictEqual(fakeSession.permCheck(null, 'mediaKeySystem', 'https://bassthalk.com'), true);
  assert.strictEqual(await new Promise((res) => fakeSession.permReq(null, 'openExternal', res, { requestingUrl: 'https://x.com/' })), false);

  // ---- windows: several, and private ones with their own session
  await call('win.new');
  assert.strictEqual(windows.length, 2);
  await call('win.newPrivate');
  assert.strictEqual(windows.length, 3);
  const priv = views.filter((v) => v.webPreferences.partition);
  assert.ok(priv.length >= 1 && /^orbit-private-/.test(priv[0].webPreferences.partition));
  assert.ok(partitions[priv[0].webPreferences.partition], 'private window has its own session');
  const privChrome = views.find((v) => v.webContents.url === 'orbit://ui/chrome.html' && v !== chromeView && windows[2] && true);
  assert.ok(privChrome);

  // ---- pages (orbit://) may use data commands, never window or tab control; websites get nothing
  const settingsTab = views.find((v) => v.webContents.url.startsWith('orbit://settings'));
  const pageEvt = { sender: settingsTab.webContents, senderFrame: { parent: null, url: 'orbit://settings/' } };
  await call('settings.get', {}, pageEvt);
  await call('appearance.get', {}, pageEvt);
  await call('drm.status', {}, pageEvt);
  await assert.rejects(() => call('tabs.close', { id: 1 }, pageEvt), /not allowed/);
  await assert.rejects(() => call('win.close', {}, pageEvt), /not allowed/);
  const webEvt = { sender: settingsTab.webContents, senderFrame: { parent: null, url: 'https://evil.example/' } };
  await assert.rejects(() => call('settings.get', {}, webEvt), /not allowed/);
  await assert.rejects(() => call('appearance.set', { id: 'accent', value: '#000' }, webEvt), /not allowed/);
  const frameEvt = { sender: settingsTab.webContents, senderFrame: { parent: {}, url: 'orbit://settings/' } };
  await assert.rejects(() => call('settings.get', {}, frameEvt), /not allowed/);

  // ---- identity is applied per request and per page
  const out = await new Promise((res) => fakeSession.headerHook({ url: 'https://bassthalk.com/x', requestHeaders: { 'User-Agent': 'Linux Electron', 'sec-ch-ua-platform': '"Linux"' } }, res));
  assert.ok(!/Linux|Electron/.test(JSON.stringify(out.requestHeaders)));
  const ev = {};
  ons['orbit:identity'](ev, 'khaled-sakr.com');
  assert.ok(ev.returnValue.includes('Win32'));
  const ev2 = {};
  ons['orbit:ext-scripts'](ev2, 'https://x.com/', true);
  assert.strictEqual(ev2.returnValue.css.length, 1);

  // ---- protocol
  const ui = await get('orbit://ui/chrome.html');
  assert.strictEqual(ui.status, 200);
  assert.ok(ui.headers.get('content-security-policy').includes('script-src orbit://ui'));
  for (const page of ['newtab', 'bookmarks', 'history', 'settings', 'appearance', 'extensions', 'identity', 'error']) assert.strictEqual((await get('orbit://' + page + '/')).status, 200, page);
  assert.ok((await (await get('orbit://theme/current.css')).text()).includes('--accent'));
  assert.notStrictEqual((await get('orbit://ui/../main.js')).status, 200);
  assert.notStrictEqual((await get('orbit://ui/%2e%2e/main.js')).status, 200);
  assert.strictEqual((await get('orbit://nothing/')).status, 404);

  // ---- window.open from a page becomes a tab
  const before = views.length;
  const r = views[1].webContents.woh({ url: 'https://popup.example/', disposition: 'foreground-tab' });
  assert.strictEqual(r.action, 'allow');
  assert.ok(r.createWindow());
  assert.strictEqual(views.length, before + 1);
  assert.strictEqual(views[1].webContents.woh({ url: 'javascript:alert(1)', disposition: 'foreground-tab' }).action, 'deny');

  console.log('ok  main process smoke test (' + views.length + ' views, ' + windows.length + ' windows)');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
