(function () {
  'use strict';
  const call = (cmd, args) => orbit.call(cmd, args || {});
  let D = null; // schema, groups, themes, fonts
  let V = {}; // values the user has changed
  let current = 'frame';
  let query = '';
  let dragging = false;
  const ctls = new Map(); // id -> { node, entry, update }
  const sections = []; // { id, node, title }

  // ---------------------------------------------------------------- helpers
  const NUM_DEFAULT = { uiScale: 100, ntAngle: 135, ntDim: 35, ntBlur: 0 };
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();
  const g2d = document.createElement('canvas').getContext('2d');
  function toHex(c) {
    g2d.fillStyle = '#000000';
    g2d.fillStyle = c || '#000000';
    const s = g2d.fillStyle;
    if (s[0] === '#') return s;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s);
    return m ? '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('') : '#000000';
  }
  let msgTimer = null;
  function toast(text, bad) {
    const m = $('#msg');
    m.textContent = text;
    m.className = bad ? 'err' : '';
    m.hidden = false;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { m.hidden = true; }, bad ? 6000 : 2200);
  }
  const fail = (e) => toast(String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''), true);

  // ---------------------------------------------------------------- saving (throttled while dragging)
  let pending = {};
  let timer = null;
  async function flush() {
    clearTimeout(timer);
    timer = null;
    const p = pending;
    pending = {};
    for (const [id, value] of Object.entries(p)) {
      try { V = await call('appearance.set', { id, value }); } catch (e) { fail(e); await reloadValues(); }
    }
    updateAll();
  }
  function commit(id, value, now) {
    if (value === null) delete V[id]; else V[id] = value;
    pending[id] = value;
    const c = ctls.get(id);
    if (c) c.node.classList.toggle('changed', id in V);
    if (now) flush(); else if (!timer) timer = setTimeout(flush, 70);
  }
  async function reloadValues() { V = (await call('appearance.get')).values; }

  // ---------------------------------------------------------------- controls
  function defaultOf(e) {
    if (e.type === 'range') {
      if (e.def != null) return e.def;
      if (e.var) { const n = parseFloat(cssVar(e.var)); if (Number.isFinite(n)) return n; }
      return NUM_DEFAULT[e.id] != null ? NUM_DEFAULT[e.id] : e.min;
    }
    if (e.type === 'color') return cssVar(e.var) || '#000000';
    if (e.type === 'text') return '';
    return e.def;
  }
  const valueOf = (e) => (e.id in V ? V[e.id] : defaultOf(e));

  function build(e) {
    const val = el('div', { class: 'val' });
    const undo = el('button', { class: 'undo', title: 'Back to the theme default', text: '↺', onclick: () => commit(e.id, null, true) });
    const name = el('div', { class: 'name' }, el('span', { text: e.label }));
    if (e.hint) name.append(el('span', { class: 'hint', text: e.hint }));
    const node = el('div', { class: 'ctl', 'data-id': e.id }, name, val);
    let update = () => {};

    if (e.type === 'color') {
      const text = el('input', { type: 'text', class: 'colortext', spellcheck: 'false' });
      const pick = el('input', { type: 'color' });
      if (e.alpha) pick.disabled = true;
      pick.addEventListener('input', () => { text.value = pick.value; commit(e.id, pick.value, false); });
      pick.addEventListener('change', () => commit(e.id, pick.value, true));
      text.addEventListener('change', () => { const t = text.value.trim(); commit(e.id, t || null, true); });
      val.append(pick, text, undo);
      update = () => { const v = valueOf(e); text.value = v; pick.value = toHex(v); };
    } else if (e.type === 'range') {
      const num = el('span', { class: 'num' });
      const r = el('input', { type: 'range', min: e.min, max: e.max, step: e.step || 1 });
      const show = () => { num.textContent = r.value + (e.unit || ''); };
      r.addEventListener('input', () => { dragging = true; show(); commit(e.id, Number(r.value), false); });
      r.addEventListener('change', () => { dragging = false; commit(e.id, Number(r.value), true); });
      val.append(r, num, undo);
      update = () => { if (dragging) return; r.value = valueOf(e); show(); };
    } else if (e.type === 'enum') {
      const seg = el('div', { class: 'seg' });
      e.options.forEach(([id, label]) => seg.append(el('button', { 'data-v': id, text: label, onclick: () => commit(e.id, id, true) })));
      val.append(seg, undo);
      update = () => { const v = valueOf(e); $$('button', seg).forEach((b) => b.classList.toggle('on', b.dataset.v === v)); };
    } else if (e.type === 'bool') {
      const cb = el('input', { type: 'checkbox' });
      cb.addEventListener('change', () => commit(e.id, cb.checked, true));
      val.append(el('label', { class: 'switch' }, cb, el('i')), undo);
      update = () => { cb.checked = !!valueOf(e); };
    } else if (e.type === 'text') {
      const inp = el('input', { type: 'text', class: 'texti', maxlength: e.max || 60, placeholder: e.hint || '', spellcheck: 'false' });
      if (e.fonts) {
        const dl = el('datalist', { id: 'fonts' });
        (D.fonts || []).forEach((f) => dl.append(el('option', { value: f })));
        inp.setAttribute('list', 'fonts');
        val.append(dl);
      }
      inp.addEventListener('change', () => {
        const t = inp.value.trim();
        commit(e.id, t || (e.id === 'ntBrand' ? '' : null), true);
      });
      val.append(inp, undo);
      update = () => { inp.value = e.id in V ? V[e.id] : defaultOf(e); };
    } else if (e.type === 'image') {
      const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif', hidden: true });
      const url = el('input', { type: 'text', class: 'texti', placeholder: 'or paste an https:// image address', spellcheck: 'false' });
      const cur = el('span', { class: 'muted small' });
      file.addEventListener('change', async () => {
        const f = file.files[0];
        file.value = '';
        if (!f) return;
        if (f.size > 15 * 1024 * 1024) { toast('The image must be under 15 MB', true); return; }
        const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(new Error('Could not read the file')); fr.readAsDataURL(f); }).catch(fail);
        if (!data) return;
        try { await call('appearance.background', { ext: (f.name.split('.').pop() || '').toLowerCase(), data }); await reloadValues(); updateAll(); toast('Background set'); } catch (err) { fail(err); }
      });
      url.addEventListener('change', async () => {
        const t = url.value.trim();
        try {
          if (t) V = await call('appearance.setMany', { values: { ntImage: t, ntBg: 'image' } }); else V = await call('appearance.set', { id: 'ntImage', value: null });
          updateAll();
        } catch (err) { fail(err); await reloadValues(); updateAll(); }
      });
      val.append(cur, el('button', { class: 'btn', text: 'Choose image…', onclick: () => file.click() }), file, url, undo);
      update = () => { const v = V.ntImage || ''; cur.textContent = v && !/^https:/.test(v) ? 'Using your image' : ''; url.value = /^https:/.test(v) ? v : ''; };
    }
    ctls.set(e.id, { node, entry: e, update });
    return node;
  }

  // Controls that only matter for one choice of another control.
  const COND = {
    ntColor: () => ['color', 'gradient'].includes(V.ntBg),
    ntColor2: () => V.ntBg === 'gradient',
    ntAngle: () => V.ntBg === 'gradient',
    ntImage: () => V.ntBg === 'image',
    ntDim: () => V.ntBg === 'image',
    ntBlur: () => V.ntBg === 'image',
    ntTileSize: () => V.ntTiles !== false,
    ntMaxTiles: () => V.ntTiles !== false,
    ntCols: () => V.ntTiles !== false,
    ntBoard: () => V.ntTiles !== false,
    ntCardOpacity: () => V.ntTiles !== false,
    ntCardBlur: () => V.ntTiles !== false,
    ntIcons: () => V.ntTiles !== false,
    sideW: () => ['left', 'right'].includes(V.tabs),
    sideCollapsed: () => ['left', 'right'].includes(V.tabs),
    winButtons: () => V.titleBar !== 'system',
    winSide: () => V.titleBar !== 'system',
  };

  function updateAll() {
    for (const [id, c] of ctls) {
      c.update();
      c.node.classList.toggle('changed', id in V);
      c.node.style.display = COND[id] && !COND[id]() ? 'none' : '';
    }
  }

  // ---------------------------------------------------------------- sections
  function addSection(id, title, lead, body, resetGroup) {
    const head = el('header', {}, el('h2', { text: title }), el('span', { class: 'grow' }));
    if (resetGroup) head.append(el('button', { class: 'btn small', text: 'Reset this page', onclick: async () => { try { V = await call('appearance.reset', { group: resetGroup }); updateAll(); toast('Reset'); } catch (e) { fail(e); } } }));
    const node = el('section', { 'data-id': id, hidden: true }, head, lead ? el('p', { class: 'lead', text: lead }) : null, body);
    sections.push({ id, node, title });
    return node;
  }

  function buildThemes() {
    const box = el('div');
    const grid = el('div', { class: 'themes' });
    const cur = D.theme;
    D.themes.forEach((t) => {
      const v = t.vars;
      const mock = el('div', { class: 'mock' }, el('i', { style: 'background:' + (v.strip || '#111') }, el('b', { style: 'background:' + (v.accent || '#e0a63a') })),
        el('i', { style: 'background:' + (v.surface || '#222') }), el('i', { style: 'background:' + (v['page-bg'] || '#181818') }));
      const card = el('button', { class: 'theme' + (t.name === cur ? ' on' : ''), title: t.name, onclick: () => pickTheme(t.name) },
        mock, el('div', { class: 'nm' }, el('span', { text: t.name }), el('span', { class: 'tag', text: t.user ? 'yours' : t.scheme })));
      if (t.user) card.append(el('span', { class: 'del', role: 'button', title: 'Delete theme', text: '×', onclick: (ev) => { ev.stopPropagation(); delTheme(t.name); } }));
      grid.append(card);
    });
    const name = el('input', { type: 'text', placeholder: 'Name for your theme', maxlength: 40, style: 'width:220px' });
    const save = el('button', { class: 'btn primary', text: 'Save current look as theme', onclick: async () => {
      try { await call('appearance.saveTheme', { name: name.value }); name.value = ''; await refreshAll(); toast('Theme saved'); } catch (e) { fail(e); }
    } });
    box.append(grid, el('div', { class: 'saverow' }, name, save),
      el('p', { class: 'muted small' }, 'Saved themes are plain CSS files in ', el('code', { text: D.configDir + '/themes' }), ' — share them, or write your own.'));
    return box;
  }

  async function pickTheme(name) {
    try {
      const colourOverrides = D.schema.some((e) => e.type === 'color' && e.group !== 'newtab' && e.id in V);
      if (colourOverrides && confirm('Clear your own colour changes so “' + name + '” shows exactly as designed?\n\nOK clears them, Cancel keeps them on top of the theme.')) {
        await call('appearance.reset', { group: 'frame' });
        await call('appearance.reset', { group: 'content' });
      }
      await call('settings.set', { key: 'theme', value: name });
      await refreshAll();
    } catch (e) { fail(e); }
  }
  async function delTheme(name) {
    if (!confirm('Delete the theme “' + name + '”?')) return;
    try { await call('appearance.deleteTheme', { name }); await refreshAll(); } catch (e) { fail(e); }
  }

  function buildAdvanced() {
    const box = el('div');
    const css = el('textarea', { class: 'code', spellcheck: 'false' });
    const js = el('textarea', { class: 'code', spellcheck: 'false', style: 'min-height:150px' });
    call('css.get').then((t) => { css.value = t; });
    call('js.get').then((t) => { js.value = t; });
    const imp = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    imp.addEventListener('change', async () => {
      const f = imp.files[0];
      imp.value = '';
      if (!f) return;
      try { V = await call('appearance.import', { json: await f.text() }); await refreshAll(); toast('Look imported'); } catch (e) { fail(e); }
    });
    box.append(
      el('h3', { text: 'Custom CSS' }),
      el('p', { class: 'muted small' }, 'Applied last, to the whole browser and Orbit’s pages. Any element, any variable — ', el('code', { text: '#tabs .tab' }), ', ', el('code', { text: '#omnibox' }), ', ', el('code', { text: '--accent' }), ' …'),
      css,
      el('div', { class: 'btnrow' }, el('button', { class: 'btn primary', text: 'Apply CSS', onclick: async () => { try { await call('css.set', { css: css.value }); toast('CSS applied'); } catch (e) { fail(e); } } })),
      el('h3', { text: 'Custom JavaScript' }),
      el('p', { class: 'muted small' }, 'Runs inside the browser window itself (not on websites) after Orbit’s own script. It can use ', el('code', { text: 'OrbitUI' }), ' to add menu items, buttons and popups. Takes effect the next time a window opens.'),
      js,
      el('div', { class: 'btnrow' }, el('button', { class: 'btn primary', text: 'Save script', onclick: async () => { try { await call('js.set', { js: js.value }); toast('Saved. Open a new window to run it.'); } catch (e) { fail(e); } } })),
      el('h3', { text: 'Backup and sharing' }),
      el('div', { class: 'btnrow' },
        el('button', { class: 'btn', text: 'Export my look…', onclick: async () => {
          try {
            const text = await call('appearance.export');
            const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: 'orbit-look.json' });
            document.body.append(a); a.click(); a.remove();
          } catch (e) { fail(e); }
        } }),
        el('button', { class: 'btn', text: 'Import a look…', onclick: () => imp.click() }), imp,
        el('span', { class: 'grow' }),
        el('button', { class: 'btn danger', text: 'Reset the whole look', onclick: async () => {
          if (!confirm('Reset every appearance setting to the theme defaults? Your custom CSS is kept.')) return;
          try { V = await call('appearance.reset'); updateAll(); toast('Everything reset'); } catch (e) { fail(e); }
        } })),
      el('p', { class: 'muted small' }, 'If a change ever makes Orbit hard to use, start it with ', el('code', { text: 'ORBIT_SAFE=1 orbit-browser' }), ' to ignore custom CSS and JavaScript. Files live in ', el('code', { text: D.configDir }), '.'));
    return box;
  }

  function buildAll() {
    const main = $('#main');
    main.textContent = '';
    ctls.clear();
    sections.length = 0;
    D.groups.forEach((g) => {
      const body = el('div');
      D.schema.filter((e) => e.group === g.id).forEach((e) => body.append(build(e)));
      if (g.id === 'frame') body.prepend(el('p', { class: 'muted small', text: 'Colours you change here sit on top of the theme. The dot marks what you changed; ↺ puts it back.' }));
      main.append(addSection(g.id, g.title, g.desc, body, g.id));
    });
    main.append(addSection('themes', 'Themes', 'Start from a look, then adjust anything.', buildThemes()));
    main.append(addSection('advanced', 'Advanced', 'CSS, JavaScript and sharing.', buildAdvanced()));
    const nav = $('#nav');
    nav.textContent = '';
    sections.forEach((s, i) => {
      if (s.id === 'themes') nav.append(el('div', { class: 'gap' }));
      nav.append(el('button', { 'data-id': s.id, text: s.title, onclick: () => { $('#find').value = ''; query = ''; show(s.id); } }));
    });
    updateAll();
    show(current);
  }

  function show(id) {
    current = id;
    const q = query.toLowerCase();
    $$('#nav button').forEach((b) => b.classList.toggle('on', !q && b.dataset.id === id));
    for (const s of sections) {
      if (!q) { s.node.hidden = s.id !== id; $$('.ctl', s.node).forEach((n) => { n.hidden = false; }); continue; }
      let any = false;
      $$('.ctl', s.node).forEach((n) => { const hit = n.textContent.toLowerCase().includes(q); n.hidden = !hit; any = any || hit; });
      s.node.hidden = !(any || s.title.toLowerCase().includes(q));
    }
  }

  async function refreshAll() {
    D = await call('appearance.get');
    V = D.values;
    buildAll();
  }

  $('#find').addEventListener('input', (e) => { query = e.target.value.trim(); show(current); });
  orbit.on('theme', () => { if (!dragging && !timer) setTimeout(async () => { try { await reloadValues(); updateAll(); } catch (e) { /* page closing */ } }, 350); });
  refreshAll().catch(fail);
})();
