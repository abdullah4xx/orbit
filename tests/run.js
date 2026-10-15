'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { resolveInput } = require('../lib/urls');
const ident = require('../lib/identity');
const { Settings, Bookmarks, History } = require('../lib/store');
const ext = require('../lib/extensions');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok  ' + name); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-test-'));

test('address bar input', () => {
  const s = 'https://duckduckgo.com/?q=%s';
  assert.strictEqual(resolveInput('example.com', s), 'https://example.com');
  assert.strictEqual(resolveInput('localhost:3000/x', s), 'http://localhost:3000/x');
  assert.strictEqual(resolveInput('192.168.1.1', s), 'http://192.168.1.1');
  assert.strictEqual(resolveInput('https://a.b/c', s), 'https://a.b/c');
  assert.strictEqual(resolveInput('orbit://settings', s), 'orbit://settings');
  assert.strictEqual(resolveInput('hello world', s), 'https://duckduckgo.com/?q=hello%20world');
  assert.strictEqual(resolveInput('javascript:alert(1)', s).startsWith('https://duckduckgo.com'), true);
  assert.strictEqual(resolveInput('', s), 'orbit://newtab');
});

test('headers never say Linux or Electron', () => {
  const p = ident.PROFILES.windows;
  const h = ident.applyHeaders(p, {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Electron/43', 'sec-ch-ua': '"Chromium";v="1"',
    'sec-ch-ua-platform': '"Linux"', 'sec-ch-ua-platform-version': '"6.8"', Accept: '*/*',
  });
  assert.ok(!/Linux|Electron|X11/.test(JSON.stringify(h)));
  assert.strictEqual(h['sec-ch-ua-platform'], '"Windows"');
  assert.strictEqual(h.Accept, '*/*');
  assert.ok(/Windows NT 10\.0/.test(h['User-Agent']));
});

test('per-site identity rules', () => {
  const s = { identity: 'windows', siteIdentity: { 'example.com': 'mac', 'a.example.com': 'linux' } };
  assert.strictEqual(ident.profileFor(s, 'example.com').id, 'mac');
  assert.strictEqual(ident.profileFor(s, 'www.example.com').id, 'mac');
  assert.strictEqual(ident.profileFor(s, 'a.example.com').id, 'linux');
  assert.strictEqual(ident.profileFor(s, 'other.org').id, 'windows');
  assert.strictEqual(ident.profileFor({ identity: 'nope', siteIdentity: {} }, 'x.org').id, 'windows');
});

test('page patch changes every value a site can read', async () => {
  class Navigator {}
  Object.defineProperty(Navigator.prototype, 'platform', { get() { return 'Linux x86_64'; }, configurable: true });
  Object.defineProperty(Navigator.prototype, 'userAgent', { get() { return 'X11; Linux Electron'; }, configurable: true });
  Object.defineProperty(Navigator.prototype, 'userAgentData', { get() { return { platform: 'Linux' }; }, configurable: true });
  class NavigatorUAData {}
  const sandbox = { Navigator, navigator: new Navigator(), window: { NavigatorUAData }, Promise, Object };
  vm.runInNewContext(ident.patchSource(ident.PROFILES.windows), sandbox);
  const n = sandbox.navigator;
  assert.strictEqual(n.platform, 'Win32');
  assert.ok(/Windows NT/.test(n.userAgent) && !/Linux|Electron/.test(n.userAgent));
  assert.strictEqual(n.userAgentData.platform, 'Windows');
  assert.strictEqual(n.userAgentData.mobile, false);
  assert.ok(n.userAgentData.brands.some((b) => b.brand === 'Google Chrome'));
  assert.ok(n.userAgentData instanceof NavigatorUAData);
  assert.strictEqual(n.vendor, 'Google Inc.');
  assert.strictEqual(typeof sandbox.window.chrome, 'object');
  return n.userAgentData.getHighEntropyValues(['platformVersion', 'architecture']).then((h) => {
    assert.strictEqual(h.platform, 'Windows');
    assert.strictEqual(h.platformVersion, '15.0.0');
  });
});

test('settings persist and validate', () => {
  const f = path.join(tmp, 'settings.json');
  const s = new Settings(f);
  assert.strictEqual(s.get('identity'), 'windows');
  s.set('theme', 'light');
  assert.strictEqual(new Settings(f).get('theme'), 'light');
  assert.throws(() => s.set('nope', 1));
  assert.throws(() => s.set('theme', 5));
});

test('bookmarks: add, move, remove, protect roots', () => {
  const b = new Bookmarks(path.join(tmp, 'b1.json'));
  const f = b.addFolder('Study', 1);
  const a = b.add('https://a.com', 'A', f.id);
  const c = b.add('https://c.com', 'C', f.id);
  b.move(c.id, f.id, 0);
  assert.deepStrictEqual(b.children(f.id).map((x) => x.title), ['C', 'A']);
  assert.throws(() => b.move(f.id, f.id));
  assert.throws(() => b.remove(1));
  assert.strictEqual(b.findUrl('https://a.com').id, a.id);
  b.move(a.id, 2);
  assert.strictEqual(b.get(a.id).parentId, 2);
  b.remove(f.id);
  assert.strictEqual(b.get(c.id), null);
  assert.ok(b.get(a.id));
});

test('bookmarks: import and export round-trip', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>
    <DT><H3>Bookmarks bar</H3><DL><p>
      <DT><A HREF="https://one.com/?a=1&amp;b=2">One &amp; Co</A>
      <DT><H3>Deep</H3><DL><p><DT><A HREF="https://two.com">Two</A></DL><p>
      <DT><A HREF="javascript:alert(1)">bad</A>
    </DL><p></DL><p>`;
  const b = new Bookmarks(path.join(tmp, 'b2.json'));
  assert.strictEqual(b.importHtml(html), 2);
  assert.ok(b.findUrl('https://one.com/?a=1&b=2'));
  const deep = b.all().find((x) => x.title === 'Deep');
  assert.strictEqual(b.children(deep.id)[0].url, 'https://two.com');
  const out = b.exportHtml();
  const b2 = new Bookmarks(path.join(tmp, 'b3.json'));
  assert.strictEqual(b2.importHtml(out), 2);
});

test('history', () => {
  const h = new History(path.join(tmp, 'h.json'));
  h.visit('https://a.com/', 'Alpha');
  h.visit('https://a.com/', 'Alpha');
  h.visit('https://b.com/', 'Beta');
  h.visit('orbit://settings', 'x');
  assert.strictEqual(h.data.items.length, 2);
  assert.strictEqual(h.top(1)[0].url, 'https://a.com/');
  assert.strictEqual(h.suggest('bet')[0].title, 'Beta');
  h.clear();
  assert.strictEqual(h.recent('').length, 0);
});

test('extensions: patterns and injection', () => {
  assert.ok(ext.matchPattern('*://*.example.com/*', 'https://sub.example.com/a?b=1'));
  assert.ok(ext.matchPattern('*://*.example.com/*', 'http://example.com/'));
  assert.ok(!ext.matchPattern('*://*.example.com/*', 'https://notexample.com/'));
  assert.ok(!ext.matchPattern('https://a.com/x/*', 'https://a.com/y'));
  assert.ok(ext.matchPattern('<all_urls>', 'https://any.org/p'));
  assert.ok(!ext.matchPattern('<all_urls>', 'orbit://settings'));
  const list = ext.discover([{ dir: path.join(__dirname, '..', 'extensions'), origin: 'built-in' }]);
  const night = list.find((x) => x.id === 'night-pages');
  assert.ok(night && night.css.length === 1 && night.defaultEnabled === false);
  assert.deepStrictEqual(ext.scriptsFor(list, {}, 'https://x.com/', true).css, []);
  assert.strictEqual(ext.scriptsFor(list, { 'night-pages': true }, 'https://x.com/', true).css.length, 1);
  assert.strictEqual(ext.scriptsFor(list, { 'night-pages': true }, 'https://x.com/', false).css.length, 0);
});

console.log('\n' + passed + ' unit tests passed');
require('./smoke');
