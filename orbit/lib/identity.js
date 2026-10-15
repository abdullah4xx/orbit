'use strict';
/*
 * Identity = what the browser tells websites about itself.
 * Some sites (course platforms, video players) refuse to play on Linux. They look at:
 *   1. the User-Agent header                      -> rewritten in applyHeaders()
 *   2. Client Hints headers (Sec-CH-UA-*)         -> rewritten in applyHeaders()
 *   3. navigator.userAgent / platform / userAgentData in JavaScript -> patched by patchPage()
 * All three are changed together so they never contradict each other.
 */

function chromeMajor() {
  return String(process.versions.chrome || '140.0.0.0').split('.')[0];
}

function makeProfiles() {
  const M = chromeMajor();
  const full = M + '.0.0.0';
  const brands = [
    { brand: 'Not)A;Brand', version: '99' },
    { brand: 'Google Chrome', version: M },
    { brand: 'Chromium', version: M },
  ];
  const fullVersionList = brands.map((b) => ({ brand: b.brand, version: b.version === '99' ? '99.0.0.0' : full }));
  const common = { brands, fullVersionList, fullVersion: full, bitness: '64', architecture: 'x86' };
  const tail = ' AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + full + ' Safari/537.36';
  return {
    windows: Object.assign({
      id: 'windows', label: 'Windows (Chrome)',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' + tail,
      platform: 'Win32', uaPlatform: 'Windows', platformVersion: '15.0.0',
    }, common),
    mac: Object.assign({
      id: 'mac', label: 'macOS (Chrome)',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' + tail,
      platform: 'MacIntel', uaPlatform: 'macOS', platformVersion: '14.5.0',
    }, common),
    linux: Object.assign({
      id: 'linux', label: 'Linux (Chrome)',
      ua: 'Mozilla/5.0 (X11; Linux x86_64)' + tail,
      platform: 'Linux x86_64', uaPlatform: 'Linux', platformVersion: '6.8.0',
    }, common),
  };
}

const PROFILES = makeProfiles();

function listProfiles() {
  return Object.values(PROFILES).map((p) => ({ id: p.id, label: p.label }));
}

/** Pick the profile for a hostname: per-site rule first (example.com also covers sub.example.com), else the default. */
function profileFor(settings, hostname) {
  const rules = settings.siteIdentity || {};
  const host = String(hostname || '').toLowerCase();
  let best = '';
  for (const key of Object.keys(rules)) {
    const k = key.toLowerCase();
    if ((host === k || host.endsWith('.' + k)) && k.length > best.length && PROFILES[rules[key]]) best = key;
  }
  return PROFILES[best ? rules[best] : settings.identity] || PROFILES.windows;
}

const brandsHeader = (list) => list.map((b) => '"' + b.brand + '";v="' + b.version + '"').join(', ');

/** Rewrite request headers in place. */
function applyHeaders(p, headers) {
  for (const key of Object.keys(headers)) {
    switch (key.toLowerCase()) {
      case 'user-agent': headers[key] = p.ua; break;
      case 'sec-ch-ua': headers[key] = brandsHeader(p.brands); break;
      case 'sec-ch-ua-mobile': headers[key] = '?0'; break;
      case 'sec-ch-ua-platform': headers[key] = '"' + p.uaPlatform + '"'; break;
      case 'sec-ch-ua-platform-version': headers[key] = '"' + p.platformVersion + '"'; break;
      case 'sec-ch-ua-full-version-list': headers[key] = brandsHeader(p.fullVersionList.map((b) => ({ brand: b.brand, version: b.version }))); break;
      case 'sec-ch-ua-full-version': headers[key] = '"' + p.fullVersion + '"'; break;
      case 'sec-ch-ua-arch': headers[key] = '"' + p.architecture + '"'; break;
      case 'sec-ch-ua-bitness': headers[key] = '"' + p.bitness + '"'; break;
      case 'sec-ch-ua-model': headers[key] = '""'; break;
      default: break;
    }
  }
  return headers;
}

/* This function is stringified and run inside every page *before* the page's own scripts. */
function patchPage(p) {
  var def = function (obj, prop, getter) {
    try { Object.defineProperty(obj, prop, { get: getter, configurable: true, enumerable: true }); } catch (e) {}
  };
  var proto = Navigator.prototype;
  def(proto, 'userAgent', function () { return p.ua; });
  def(proto, 'appVersion', function () { return p.ua.replace(/^Mozilla\//, ''); });
  def(proto, 'platform', function () { return p.platform; });
  def(proto, 'vendor', function () { return 'Google Inc.'; });
  try {
    if ('userAgentData' in navigator) {
      var data = Object.create(window.NavigatorUAData ? window.NavigatorUAData.prototype : Object.prototype);
      var low = { brands: p.brands, mobile: false, platform: p.uaPlatform };
      Object.defineProperties(data, {
        brands: { get: function () { return low.brands.slice(); }, enumerable: true },
        mobile: { get: function () { return false; }, enumerable: true },
        platform: { get: function () { return p.uaPlatform; }, enumerable: true },
        toJSON: { value: function () { return { brands: low.brands.slice(), mobile: false, platform: p.uaPlatform }; } },
        getHighEntropyValues: {
          value: function (hints) {
            var all = {
              architecture: p.architecture, bitness: p.bitness, brands: p.brands, fullVersionList: p.fullVersionList,
              mobile: false, model: '', platform: p.uaPlatform, platformVersion: p.platformVersion,
              uaFullVersion: p.fullVersion, wow64: false,
            };
            var out = { brands: p.brands, mobile: false, platform: p.uaPlatform };
            (hints || []).forEach(function (h) { if (h in all) out[h] = all[h]; });
            return Promise.resolve(out);
          },
        },
      });
      def(proto, 'userAgentData', function () { return data; });
    }
  } catch (e) {}
  try {
    if (!window.chrome) {
      window.chrome = { runtime: {}, app: { isInstalled: false }, loadTimes: function () { return {}; }, csi: function () { return {}; } };
    }
  } catch (e) {}
}

function patchSource(p) {
  return '(' + patchPage.toString() + ')(' + JSON.stringify(p) + ');';
}

module.exports = { PROFILES, listProfiles, profileFor, applyHeaders, patchSource, patchPage };
