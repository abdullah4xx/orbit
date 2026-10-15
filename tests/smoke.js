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
let protocolHandler = null;
let n = 0;

class FakeWC extends EventEmitter {
  constructor() {
    super(); this.id = ++n; this.url = ''; this.zoom = 0; this.sent = [];
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} };
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
['focus', 'reload', 'reloadIgnoringCache', 'stop', 'close', 'stopFindInPage', 'findInPage', 'openDevTools', 'closeDevTools', 'inspectElement'].forEach((m) => { FakeWC.prototype[m] = function () {}; });
class FakeView { constructor() { this.webContents = new FakeWC(); views.push(this); } setBounds(b) { this.bounds = b; } setVisible(v) { this.visible = v; } setBackgroundColor() {} }
class FakeWin extends EventEmitter {
  constructor() { super(); this.contentView = { addChildView() {}, removeChildView() {} }; this.closed = false; }
  getContentBounds() { return { width: 1200, height: 800 }; }
  getNormalBounds() { return { width: 1200, height: 800 }; }
  isMaximized() { return false; } isFullScreen() { return false; }
  close() { this.closed = true; this.emit('close'); }
}
['setTitle', 'maximize', 'focus', 'restore', 'setFullScreen'].forEach((m) => { FakeWin.prototype[m] = function () {}; });

const fakeSession = { webRequest: { onBeforeSendHeaders(f) { fakeSession.headerHook = f; } }, setUserAgent() {}, on() {}, setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, clearStorageData: async () => {}, clearCache: async () => {} };
const electron = {
  app: {
    setName() {}, getPath: (k) => (k === 'appData' ? tmp : tmp), setPath() {}, requestSingleInstanceLock: () => true, on() {}, quit() {},
    commandLine: { appendSwitch() {} }, whenReady: () => Promise.resolve(), getVersion: () => '0.1.0',
  },
  BaseWindow: FakeWin, WebContentsView: FakeView,
  Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({ popup() {} }) },
  ipcMain: { handle: (c, f) => { handlers[c] = f; }, on: (c, f) => { ons[c] = f; } },
  protocol: { registerSchemesAsPrivileged() {}, handle: (s, f) => { protocolHandler = f; } },
  session: { defaultSession: fakeSession },
  shell: { openPath: async () => '', openExternal: async () => {} },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  clipboard: { writeText() {} },
  nativeTheme: { themeSource: 'system' },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? electron : origLoad.call(this, req, ...rest); };

require('../main.js');

(async () => {
  await new Promise((r) => setTimeout(r, 50));
  const chromeView = views[0];
  const chromeEvt = { sender: chromeView.webContents, senderFrame: { parent: null, url: 'orbit://ui/chrome.html' } };
  const call = (cmd, args, evt) => handlers['orbit:call'](evt || chromeEvt, cmd, args);

  assert.strictEqual(chromeView.webContents.url, 'orbit://ui/chrome.html');
  assert.strictEqual(views.length, 2, 'one tab opened at startup');
  await call('chrome.ready');
  await call('chrome.layout', { height: 120, full: true });
  assert.strictEqual(chromeView.bounds.height, 800);
  await call('chrome.layout', { height: 120, full: false });
  assert.strictEqual(chromeView.bounds.height, 120);
  assert.strictEqual(views[1].bounds.y, 120);

  await call('tabs.new', { url: 'example.com' });
  assert.strictEqual(views[2].webContents.url, 'https://example.com');
  await call('nav.go', { text: 'hello world' });
  assert.ok(views[2].webContents.url.startsWith('https://duckduckgo.com/?q=hello'));
  await call('tabs.move', { id: 3, index: 0 });
  await call('tabs.close', { id: 3 });
  await call('tabs.reopen');
  await call('openPage', { page: 'settings' });
  await call('zoom', { delta: 1 });

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

  // pages (orbit://) may use data commands, never tab control; websites get nothing
  const settingsTab = views.find((v) => v.webContents.url.startsWith('orbit://settings'));
  const pageEvt = { sender: settingsTab.webContents, senderFrame: { parent: null, url: 'orbit://settings/' } };
  await call('settings.get', {}, pageEvt);
  await assert.rejects(() => call('tabs.close', { id: 1 }, pageEvt), /not allowed/);
  const webEvt = { sender: settingsTab.webContents, senderFrame: { parent: null, url: 'https://evil.example/' } };
  await assert.rejects(() => call('settings.get', {}, webEvt), /not allowed/);
  const frameEvt = { sender: settingsTab.webContents, senderFrame: { parent: {}, url: 'orbit://settings/' } };
  await assert.rejects(() => call('settings.get', {}, frameEvt), /not allowed/);

  // identity is applied per request and per page
  const out = await new Promise((res) => fakeSession.headerHook({ url: 'https://bassthalk.com/x', requestHeaders: { 'User-Agent': 'Linux Electron', 'sec-ch-ua-platform': '"Linux"' } }, res));
  assert.ok(!/Linux|Electron/.test(JSON.stringify(out.requestHeaders)));
  const ev = {};
  ons['orbit:identity'](ev, 'khaled-sakr.com');
  assert.ok(ev.returnValue.includes('Win32'));
  const ev2 = {};
  ons['orbit:ext-scripts'](ev2, 'https://x.com/', true);
  assert.strictEqual(ev2.returnValue.css.length, 1);

  // protocol
  const get = (u) => protocolHandler({ url: u });
  const ui = await get('orbit://ui/chrome.html');
  assert.strictEqual(ui.status, 200);
  assert.ok(ui.headers.get('content-security-policy').includes("script-src orbit://ui"));
  for (const page of ['newtab', 'bookmarks', 'history', 'settings', 'extensions', 'identity', 'error']) assert.strictEqual((await get('orbit://' + page + '/')).status, 200, page);
  assert.ok((await (await get('orbit://theme/current.css')).text()).includes('--accent'));
  assert.notStrictEqual((await get('orbit://ui/../main.js')).status, 200);
  assert.notStrictEqual((await get('orbit://ui/%2e%2e/main.js')).status, 200);
  assert.strictEqual((await get('orbit://nothing/')).status, 404);

  // window.open from a page becomes a tab
  const before = views.length;
  const r = views[1].webContents.woh({ url: 'https://popup.example/', disposition: 'foreground-tab' });
  assert.strictEqual(r.action, 'allow');
  assert.ok(r.createWindow());
  assert.strictEqual(views.length, before + 1);
  assert.strictEqual(views[1].webContents.woh({ url: 'javascript:alert(1)', disposition: 'foreground-tab' }).action, 'deny');

  console.log('ok  main process smoke test (' + views.length + ' views created)');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
