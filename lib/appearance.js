'use strict';
/*
 * Orbit's look: one schema that describes every customisable thing about the browser's appearance.
 *
 * The same schema validates what is stored, builds the CSS that is injected into the browser UI and Orbit's pages,
 * and generates the controls on orbit://appearance. Values the user never touched are simply absent, so the
 * active theme stays in charge of them.
 */

const COLOR_RE = /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,\/-]+\))$/i;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

const GROUPS = [
  { id: 'frame', title: 'Browser colours', desc: 'The bars around the page.' },
  { id: 'content', title: 'Text and accents', desc: 'Text, highlights and Orbit’s own pages.' },
  { id: 'shape', title: 'Shape', desc: 'Corners, tabs and the address bar.' },
  { id: 'size', title: 'Size and type', desc: 'Heights, fonts and scale.' },
  { id: 'layout', title: 'Layout', desc: 'Where things go, and what is shown.' },
  { id: 'window', title: 'Window', desc: 'Title bar and window buttons. Applies to windows opened afterwards.' },
  { id: 'newtab', title: 'New tab page', desc: 'Background, clock and shortcuts.' },
];

const BOOL_BUTTONS = [
  ['btnBack', 'Back button', '#back'],
  ['btnForward', 'Forward button', '#forward'],
  ['btnReload', 'Reload button', '#reload'],
  ['btnHome', 'Home button', '#home'],
  ['btnStar', 'Bookmark star', '#star'],
  ['btnNewtab', 'New tab button', '#newtab, #newtab-side'],
  ['btnMenu', 'Menu button (Ctrl+, still opens Settings)', '#menu'],
];

const c = (id, group, label, v, extra) => Object.assign({ id, group, label, type: 'color', var: v || id }, extra || {});
const r = (id, group, label, min, max, v, unit, extra) => Object.assign({ id, group, label, type: 'range', min, max, step: 1, var: v, unit: unit || '' }, extra || {});
const e = (id, group, label, options, def, extra) => Object.assign({ id, group, label, type: 'enum', options, def }, extra || {});

const SCHEMA = [
  // ------------------------------------------------------------ colours
  c('strip', 'frame', 'Tab strip', 'strip'),
  c('tabActive', 'frame', 'Active tab', 'tab-active-bg'),
  c('toolbarBg', 'frame', 'Toolbar', 'toolbar-bg'),
  c('bmbarBg', 'frame', 'Bookmarks bar', 'bmbar-bg'),
  c('omniboxBg', 'frame', 'Address bar', 'omnibox-bg'),
  c('frame', 'frame', 'Frame around the page', 'frame'),
  c('raised', 'frame', 'Menus and popups', 'raised'),
  c('line', 'frame', 'Borders', 'line'),
  c('text', 'content', 'Text', 'text'),
  c('textDim', 'content', 'Dim text and icons', 'text-dim'),
  c('accent', 'content', 'Accent', 'accent'),
  c('accentInk', 'content', 'Text on accent', 'accent-ink'),
  c('danger', 'content', 'Warnings', 'danger'),
  c('pageBg', 'content', 'Orbit pages background', 'page-bg'),
  c('hover', 'content', 'Hover highlight', 'hover', { alpha: true }),
  c('press', 'content', 'Pressed highlight', 'press', { alpha: true }),

  // ------------------------------------------------------------ shape
  r('radius', 'shape', 'Corner roundness', 0, 24, 'radius', 'px'),
  e('tabStyle', 'shape', 'Tab style', [['classic', 'Classic'], ['rounded', 'Rounded'], ['pill', 'Pill'], ['underline', 'Underline'], ['square', 'Square'], ['floating', 'Floating'], ['ghost', 'Text only']], 'classic', { attr: 'tabstyle' }),
  e('omnibox', 'shape', 'Address bar shape', [['pill', 'Pill'], ['rounded', 'Rounded'], ['square', 'Square']], 'pill', { var: 'omni-radius', map: { pill: '999px', rounded: '10px', square: '3px' } }),
  r('pageGap', 'shape', 'Gap around the page', 0, 16, 'page-gap', 'px'),
  r('pageRadius', 'shape', 'Page corner roundness', 0, 20, 'page-radius', 'px', { pageRadius: true }),
  r('iconStroke', 'shape', 'Icon line thickness', 1, 3, 'icon-stroke', '', { step: 0.1 }),
  r('iconSize', 'shape', 'Icon size', 12, 24, 'icon-size', 'px'),

  // ------------------------------------------------------------ size and type
  r('tabstripH', 'size', 'Tab strip height', 28, 64, 'tabstrip-h', 'px'),
  r('toolbarH', 'size', 'Toolbar height', 32, 72, 'toolbar-h', 'px'),
  r('bmbarH', 'size', 'Bookmarks bar height', 22, 44, 'bmbar-h', 'px'),
  r('omniH', 'size', 'Address bar height', 24, 48, 'omni-h', 'px'),
  r('tabMax', 'size', 'Widest tab', 100, 400, 'tab-max', 'px'),
  r('sideW', 'size', 'Side tab panel width', 140, 360, 'side-w', 'px'),
  r('uiSize', 'size', 'Text size', 11, 18, 'ui-size', 'px'),
  r('uiScale', 'size', 'Interface zoom', 60, 200, null, '%', { step: 5, zoom: true }),
  { id: 'fontUi', group: 'size', label: 'Interface font', type: 'text', max: 60, hint: 'Any font installed on this computer, e.g. Inter or Fira Sans', fonts: true },

  // ------------------------------------------------------------ layout
  e('tabs', 'layout', 'Tabs', [['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left side'], ['right', 'Right side']], 'top', { attr: 'tabs' }),
  e('toolbarPos', 'layout', 'Toolbar', [['top', 'Top'], ['bottom', 'Bottom']], 'top', { attr: 'toolbar' }),
  e('bmPos', 'layout', 'Bookmarks bar', [['top', 'Top'], ['bottom', 'Bottom']], 'top', { attr: 'bm' }),
  { id: 'sideCollapsed', group: 'layout', label: 'Side tabs: icons only', type: 'bool', def: false, attr: 'sidecollapsed' },
].concat(BOOL_BUTTONS.map(([id, label]) => ({ id, group: 'layout', label: 'Show: ' + label, type: 'bool', def: true }))).concat([
  // ------------------------------------------------------------ window
  e('titleBar', 'window', 'Title bar', [['custom', 'Orbit’s own'], ['system', 'System']], 'custom', { attr: 'titlebar' }),
  e('winButtons', 'window', 'Window buttons', [['windows', 'Windows'], ['gnome', 'Round'], ['mac', 'Traffic lights'], ['minimal', 'Minimal']], 'gnome', { attr: 'winbtn' }),
  e('winSide', 'window', 'Window buttons side', [['right', 'Right'], ['left', 'Left']], 'right', { attr: 'winside' }),

  // ------------------------------------------------------------ new tab page
  e('ntBg', 'newtab', 'Background', [['theme', 'Theme'], ['color', 'Colour'], ['gradient', 'Gradient'], ['image', 'Image']], 'theme', { attr: null }),
  c('ntColor', 'newtab', 'Colour / gradient start', 'nt-color'),
  c('ntColor2', 'newtab', 'Gradient end', 'nt-color2'),
  r('ntAngle', 'newtab', 'Gradient angle', 0, 360, null, '°', { step: 5 }),
  { id: 'ntImage', group: 'newtab', label: 'Background image', type: 'image' },
  r('ntDim', 'newtab', 'Darken image', 0, 80, null, '%'),
  r('ntBlur', 'newtab', 'Blur image', 0, 30, null, 'px'),
  c('ntAccent', 'newtab', 'Card and button accent', 'nt-accent'),
  r('ntCols', 'newtab', 'Columns of cards', 1, 6, null, '', { def: 4 }),
  e('ntBoard', 'newtab', 'Board width', [['narrow', 'Narrow'], ['medium', 'Medium'], ['wide', 'Wide']], 'medium'),
  r('ntCardOpacity', 'newtab', 'Card glass opacity', 0, 80, null, '%', { def: 12 }),
  r('ntCardBlur', 'newtab', 'Card glass blur', 0, 30, null, 'px', { def: 14 }),
  { id: 'ntIcons', group: 'newtab', label: 'Show site icons', type: 'bool', def: true },
  { id: 'ntBrand', group: 'newtab', label: 'Title', type: 'text', max: 40, hint: 'Shown above the cards; empty hides it' },
  r('ntBrandSize', 'newtab', 'Title size', 16, 96, 'nt-brand-size', 'px'),
  e('ntClock', 'newtab', 'Clock', [['off', 'Off'], ['24h', '24 hour'], ['12h', '12 hour']], 'off'),
  { id: 'ntGreeting', group: 'newtab', label: 'Greeting', type: 'bool', def: false },
  e('ntSearch', 'newtab', 'Search box', [['pill', 'Pill'], ['rounded', 'Rounded'], ['underline', 'Underline'], ['hidden', 'Hidden']], 'hidden'),
  e('ntAlign', 'newtab', 'Vertical position', [['middle', 'Middle'], ['top', 'Top']], 'top'),
  { id: 'ntTiles', group: 'newtab', label: 'Show cards', type: 'bool', def: true },
  e('ntTileSize', 'newtab', 'Card text size', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], 'medium'),
  r('ntMaxTiles', 'newtab', 'Links shown per card', 3, 60, null, '', { def: 20 }),
]);

const BY_ID = new Map(SCHEMA.map((x) => [x.id, x]));

/** Returns the cleaned value, or undefined when it is not acceptable. */
function cleanValue(entry, v) {
  switch (entry.type) {
    case 'color': {
      if (typeof v !== 'string') return undefined;
      const s = v.trim();
      return s.length <= 64 && COLOR_RE.test(s) ? s : undefined;
    }
    case 'range': {
      const n = Number(v);
      if (!Number.isFinite(n)) return undefined;
      const step = entry.step || 1;
      const clamped = Math.max(entry.min, Math.min(entry.max, n));
      return Number((Math.round(clamped / step) * step).toFixed(2));
    }
    case 'enum':
      return entry.options.some((o) => o[0] === v) ? v : undefined;
    case 'bool':
      return typeof v === 'boolean' ? v : undefined;
    case 'text': {
      if (typeof v !== 'string') return undefined;
      let s = v.replace(/[\u0000-\u001f\u007f<>{}\\;"'`]/g, '').trim();
      if (entry.fonts) s = s.replace(/[^\w .,-]/g, '').trim();
      return s.slice(0, entry.max || 60);
    }
    case 'image': {
      if (typeof v !== 'string') return undefined;
      const s = v.trim();
      if (!s) return '';
      if (FILE_RE.test(s)) return s;
      try {
        const u = new URL(s);
        return u.protocol === 'https:' && s.length <= 500 && !/["'()\\\s]/.test(s) ? s : undefined;
      } catch (err) { return undefined; }
    }
    default: return undefined;
  }
}

/** Keeps only known ids with acceptable values. */
function sanitize(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const entry of SCHEMA) {
    if (!Object.prototype.hasOwnProperty.call(obj, entry.id)) continue;
    const v = cleanValue(entry, obj[entry.id]);
    if (v !== undefined) out[entry.id] = v;
  }
  return out;
}

/** Applies one change; value null/undefined removes the override. Returns the new overrides. */
function setValue(vals, id, value) {
  const entry = BY_ID.get(id);
  if (!entry) throw new Error('unknown appearance setting: ' + id);
  const next = Object.assign({}, vals);
  if (value === null || value === undefined) { delete next[id]; return next; }
  const v = cleanValue(entry, value);
  if (v === undefined) throw new Error('bad value for ' + id);
  next[id] = v;
  return next;
}

const fontStack = (name) => '"' + name + '", "Ubuntu", "Cantarell", "Noto Sans", system-ui, sans-serif';

/** The CSS that expresses the overrides. Everything is whitelisted, so no raw user text reaches the stylesheet. */
function cssFor(vals) {
  const v = sanitize(vals);
  const decl = [];
  for (const entry of SCHEMA) {
    if (!(entry.id in v) || !entry.var) continue;
    const val = v[entry.id];
    if (entry.type === 'color') decl.push('--' + entry.var + ': ' + val);
    else if (entry.type === 'range') decl.push('--' + entry.var + ': ' + val + (entry.unit === '%' || entry.unit === '°' ? '' : entry.unit));
    else if (entry.type === 'enum' && entry.map) decl.push('--' + entry.var + ': ' + entry.map[val]);
  }
  if (v.fontUi) decl.push('--font-user: ' + fontStack(v.fontUi));

  // New tab page
  const nt = v.ntBg || 'theme';
  if (nt === 'color' && v.ntColor) decl.push('--nt-bg: ' + v.ntColor);
  else if (nt === 'gradient') decl.push('--nt-bg: linear-gradient(' + (v.ntAngle == null ? 135 : v.ntAngle) + 'deg, ' + (v.ntColor || '#243b55') + ', ' + (v.ntColor2 || '#141e30') + ')');
  else if (nt === 'image' && v.ntImage) {
    const src = FILE_RE.test(v.ntImage) ? 'orbit://bg/' + v.ntImage : v.ntImage;
    decl.push('--nt-bg: url("' + src + '") center / cover no-repeat');
  }
  if (v.ntDim != null) decl.push('--nt-dim: ' + (v.ntDim / 100));
  if (v.ntBlur != null) decl.push('--nt-blur: ' + v.ntBlur + 'px');

  let css = decl.length ? ':root { ' + decl.join('; ') + '; }\n' : '';
  const hidden = BOOL_BUTTONS.filter(([id]) => v[id] === false).map((x) => x[2]);
  if (hidden.length) css += hidden.join(', ') + ' { display: none !important; }\n';
  if (v.ntBg === 'image' || v.ntBg === 'gradient' || v.ntBg === 'color') css += 'html.newtab-page { --has-nt-bg: 1; }\n';
  return css;
}

/** Values the browser UI reads as data-* attributes on <html>. Always complete. */
function attrsFor(vals) {
  const v = sanitize(vals);
  const out = {};
  for (const entry of SCHEMA) {
    if (!entry.attr) continue;
    const val = entry.id in v ? v[entry.id] : entry.def;
    out[entry.attr] = typeof val === 'boolean' ? (val ? '1' : '0') : String(val);
  }
  return out;
}

/** Everything the new tab page needs to know that CSS cannot express. */
function newtabFor(vals) {
  const v = sanitize(vals);
  const out = {};
  for (const entry of SCHEMA) {
    if (entry.group !== 'newtab') continue;
    out[entry.id] = entry.id in v ? v[entry.id] : (entry.def !== undefined ? entry.def : null);
  }
  if (out.ntBrand == null) out.ntBrand = '';
  return out;
}

/** Reads the custom properties and colour scheme out of a theme file. */
function parseTheme(css) {
  const text = String(css || '');
  const m = /scheme:\s*(dark|light)/.exec(text);
  const vars = {};
  const re = /--([a-z0-9-]+)\s*:\s*([^;}]+)/gi;
  let hit;
  while ((hit = re.exec(text))) vars[hit[1]] = hit[2].trim();
  return { scheme: m ? m[1] : 'dark', vars };
}

/** A theme file for what the browser looks like right now (theme variables with the overrides applied). */
function themeFileFor(themeVars, vals, scheme) {
  const v = sanitize(vals);
  const out = Object.assign({}, themeVars);
  for (const entry of SCHEMA) {
    if (!(entry.id in v) || !entry.var) continue;
    if (entry.group === 'newtab') continue;
    if (entry.type === 'color') out[entry.var] = v[entry.id];
    else if (entry.type === 'range') out[entry.var] = v[entry.id] + (entry.unit === '%' || entry.unit === '°' ? '' : entry.unit);
  }
  const body = Object.keys(out).sort().map((k) => '  --' + k + ': ' + out[k] + ';').join('\n');
  return '/* scheme: ' + (scheme === 'light' ? 'light' : 'dark') + ' */\n:root {\n' + body + '\n}\n';
}

function themeName(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().replace(/\s+/g, '-').slice(0, 40);
  return s || null;
}

module.exports = { SCHEMA, GROUPS, BOOL_BUTTONS, sanitize, setValue, cssFor, attrsFor, newtabFor, parseTheme, themeFileFor, themeName, cleanValue };
