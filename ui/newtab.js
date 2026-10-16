(function () {
  'use strict';
  const call = (cmd, args) => orbit.call(cmd, args || {});
  const root = document.documentElement;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  let cfg = null; // settings.get
  let NT = {}; // effective new tab options (defaults filled in)
  let rows = []; // bookmarks
  let ll = { pages: [{ id: 'home', name: 'Home' }], layout: {} };
  let pageId = 'home';
  let editing = false;
  let hideCards = store.get('ll.hide') === '1';
  let compact = store.get('ll.compact') === '1';
  let ownSaves = 0;
  let dragEl = null;
  let dragLink = null;
  let clockTimer = null;
  const lumilistOn = () => !cfg || (cfg.settings.extensionsEnabled || {}).lumilist !== false;

  // ---------------------------------------------------------------- small helpers
  const safeHref = (u) => (/^(https?:|orbit:|file:|ftp:)/i.test(String(u || '')) ? u : '#');
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
  const withScheme = (s) => { const t = String(s || '').trim(); return !t ? '' : /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : 'https://' + t; };
  let noteTimer = null;
  function note(msg) {
    const n = $('#note');
    n.textContent = msg;
    n.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { n.hidden = true; }, 2600);
  }
  const fail = (e) => note(String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));

  // ---------------------------------------------------------------- data
  async function loadAll() {
    const [c, r, l] = await Promise.all([call('settings.get'), call('bookmarks.tree'), call('lumilist.get')]);
    cfg = c; NT = c.newtab || {}; rows = r; ll = l;
    if (!ll.pages.some((p) => p.id === pageId)) pageId = 'home';
  }

  const byParent = () => {
    const m = new Map();
    rows.slice().sort((a, b) => a.position - b.position).forEach((r) => { if (!m.has(r.parentId)) m.set(r.parentId, []); m.get(r.parentId).push(r); });
    return m;
  };

  function buildCards() {
    const m = byParent();
    const kids = (id) => m.get(id) || [];
    const linksOf = (id) => kids(id).filter((r) => r.kind === 'bookmark');
    const foldersOf = (id) => kids(id).filter((r) => r.kind === 'folder');
    const deep = (id, depth) => linksOf(id).concat(depth > 0 ? foldersOf(id).flatMap((f) => deep(f.id, depth - 1)) : []);
    const folderCard = (f) => ({ key: 'f' + f.id, id: f.id, title: f.title, links: linksOf(f.id), subs: foldersOf(f.id).map((s) => ({ title: s.title, links: deep(s.id, 2) })).filter((s) => s.links.length) });
    const cards = [];
    const bar = linksOf(1);
    if (bar.length || editing) cards.push({ key: 'bar', id: 1, title: 'Bookmarks bar', root: true, links: bar, subs: [] });
    foldersOf(1).forEach((f) => cards.push(folderCard(f)));
    const other = linksOf(2);
    if (other.length) cards.push({ key: 'other', id: 2, title: 'Other bookmarks', root: true, links: other, subs: [] });
    foldersOf(2).forEach((f) => cards.push(folderCard(f)));
    return cards;
  }

  function cardsOnPage(all) {
    const page = ll.pages.find((p) => p.id === pageId);
    if (!page || page.id === 'home') return all;
    const set = new Set(page.folders || []);
    return all.filter((c) => set.has(c.key));
  }

  function arrange(cards, cols) {
    const lay = ll.layout[pageId] || {};
    const out = Array.from({ length: cols }, () => []);
    const placed = [];
    const free = [];
    cards.forEach((c) => (lay[c.key] ? placed.push(c) : free.push(c)));
    placed.sort((a, b) => lay[a.key].col - lay[b.key].col || lay[a.key].pos - lay[b.key].pos);
    placed.forEach((c) => out[Math.min(lay[c.key].col, cols - 1)].push(c));
    const max = NT.ntMaxTiles || 20;
    const weight = (arr) => arr.reduce((s, x) => s + 2 + Math.min(x.links.length, max), 0);
    free.forEach((c) => {
      let best = 0;
      out.forEach((arr, i) => { if (weight(arr) < weight(out[best])) best = i; });
      out[best].push(c);
    });
    return out;
  }

  // ---------------------------------------------------------------- applying the look
  function effectiveCols() { return compact ? 1 : Math.max(1, Math.min(6, Number(NT.ntCols) || 4)); }

  function applyConfig() {
    const board = { narrow: 760, medium: 1000, wide: 1320 }[NT.ntBoard] || 1000;
    const font = { small: 11.5, medium: 12.5, large: 14 }[NT.ntTileSize] || 12.5;
    const s = root.style;
    s.setProperty('--cols', effectiveCols());
    s.setProperty('--board-w', (compact ? 460 : board) + 'px');
    s.setProperty('--card-a', String((NT.ntCardOpacity == null ? 12 : NT.ntCardOpacity) / 100));
    s.setProperty('--card-blur', (NT.ntCardBlur == null ? 14 : NT.ntCardBlur) + 'px');
    s.setProperty('--ll-font', font + 'px');
    root.dataset.align = NT.ntAlign || 'top';
    root.dataset.search = NT.ntSearch || 'hidden';
    root.dataset.icons = NT.ntIcons === false ? '0' : '1';
    root.classList.toggle('has-img', NT.ntBg === 'image');
    root.classList.toggle('classic', !lumilistOn());
    if (NT.ntBg === 'image' && NT.ntDim == null) $('#shade').style.setProperty('--nt-dim', '.3'); else $('#shade').style.removeProperty('--nt-dim');
    document.body.classList.toggle('hidecards', hideCards);
    document.body.classList.toggle('editing', editing && lumilistOn());
  }

  function renderHeader() {
    const classic = !lumilistOn();
    const brand = classic ? (NT.ntBrand || 'Orbit') : NT.ntBrand;
    const b = $('#brand');
    b.hidden = !brand;
    b.textContent = brand || '';
    const showSearch = classic || (NT.ntSearch && NT.ntSearch !== 'hidden');
    $('#inline-search').hidden = !showSearch;
    const g = $('#greet');
    g.hidden = !NT.ntGreeting;
    const h = new Date().getHours();
    g.textContent = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const c = $('#clock');
    c.hidden = !NT.ntClock || NT.ntClock === 'off';
    clearInterval(clockTimer);
    const tick = () => {
      if (c.hidden) return;
      c.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: NT.ntClock === '12h' });
    };
    tick();
    clockTimer = setInterval(tick, 15000);
  }

  // ---------------------------------------------------------------- dialogs
  function ask(title, fields, okText) {
    return new Promise((resolve) => {
      const form = $('#mform');
      const modal = $('#modal');
      form.textContent = '';
      form.append(el('h3', { text: title }));
      const inputs = {};
      fields.forEach((f) => {
        let input;
        if (f.type === 'select') {
          input = el('select');
          f.options.forEach(([v, l]) => input.append(el('option', { value: v, text: l })));
          input.value = f.value != null ? f.value : f.options[0][0];
        } else input = el('input', { type: 'text', value: f.value || '', placeholder: f.placeholder || '', spellcheck: 'false', autocomplete: 'off' });
        inputs[f.name] = input;
        form.append(el('label', {}, f.label, input));
      });
      const done = (v) => { modal.hidden = true; form.onsubmit = null; resolve(v); };
      form.append(el('div', { class: 'btns' }, el('button', { type: 'button', class: 'pbtn', text: 'Cancel', onclick: () => done(null) }), el('button', { type: 'submit', class: 'pbtn primary', text: okText || 'Save' })));
      form.onsubmit = (e) => { e.preventDefault(); const out = {}; for (const k of Object.keys(inputs)) out[k] = inputs[k].value.trim(); done(out); };
      modal.hidden = false;
      const first = Object.values(inputs)[0];
      if (first) { first.focus(); if (first.select) first.select(); }
    });
  }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') { $('#mform').querySelector('.btns button').click(); } });

  // ---------------------------------------------------------------- bookmarks editing
  async function addLink(card) {
    const v = await ask('Add a link to “' + card.title + '”', [{ name: 'title', label: 'Name', placeholder: 'Example' }, { name: 'url', label: 'Address', placeholder: 'example.com' }], 'Add');
    if (!v) return;
    const url = withScheme(v.url);
    if (!url) { note('Enter an address'); return; }
    try { await call('bookmarks.add', { url, title: v.title || hostOf(url) || url, parentId: card.id }); } catch (e) { fail(e); }
  }
  async function editLink(b) {
    const v = await ask('Edit link', [{ name: 'title', label: 'Name', value: b.title }, { name: 'url', label: 'Address', value: b.url }]);
    if (!v) return;
    try { await call('bookmarks.update', { id: b.id, title: v.title || b.title, url: withScheme(v.url) || b.url }); } catch (e) { fail(e); }
  }
  async function renameCard(c) {
    const v = await ask('Rename card', [{ name: 'title', label: 'Name', value: c.title }]);
    if (!v || !v.title) return;
    try { await call('bookmarks.update', { id: c.id, title: v.title }); } catch (e) { fail(e); }
  }
  async function deleteCard(c, onPage) {
    if (onPage) { // a custom page only lists cards; removing one never deletes bookmarks
      const page = ll.pages.find((p) => p.id === pageId);
      page.folders = (page.folders || []).filter((k) => k !== c.key);
      await saveLL();
      return;
    }
    if (!confirm('Delete the card “' + c.title + '” and the ' + c.links.length + ' bookmark(s) in it?')) return;
    try { await call('bookmarks.remove', { id: c.id }); } catch (e) { fail(e); }
  }
  async function newCard() {
    const all = buildCards();
    const page = ll.pages.find((p) => p.id === pageId);
    if (page && page.id !== 'home') {
      const avail = all.filter((c) => !(page.folders || []).includes(c.key));
      const opts = [['__new__', '＋ New card']].concat(avail.map((c) => [c.key, c.title]));
      const pick = await ask('Add a card to “' + page.name + '”', [{ name: 'which', label: 'Card', type: 'select', options: opts }], 'Next');
      if (!pick) return;
      if (pick.which !== '__new__') { page.folders = (page.folders || []).concat(pick.which); await saveLL(); return; }
    }
    const v = await ask('New card', [{ name: 'title', label: 'Name', placeholder: 'Work' }], 'Create');
    if (!v || !v.title) return;
    try {
      const f = await call('bookmarks.addFolder', { title: v.title, parentId: 1 });
      if (page && page.id !== 'home' && f && f.id) { page.folders = (page.folders || []).concat('f' + f.id); await saveLL(); }
    } catch (e) { fail(e); }
  }

  async function saveLL() {
    try { ll = await call('lumilist.set', { data: ll }); } catch (e) { fail(e); }
    render();
  }

  // ---------------------------------------------------------------- pages (tabs)
  function renderPages() {
    const box = $('#pages');
    box.textContent = '';
    ll.pages.forEach((p) => {
      const t = el('button', { class: 'ptab' + (p.id === pageId ? ' on' : ''), onclick: () => { pageId = p.id; render(); } }, el('span', { text: p.name }));
      if (p.id !== 'home') {
        const ren = el('span', { class: 'ed', title: 'Rename page', onclick: async (e) => { e.stopPropagation(); const v = await ask('Rename page', [{ name: 'name', label: 'Name', value: p.name }]); if (v && v.name) { p.name = v.name; await saveLL(); } } });
        ren.innerHTML = icon('pencil');
        const del = el('span', { class: 'ed', title: 'Delete page', onclick: async (e) => { e.stopPropagation(); if (!confirm('Delete the page “' + p.name + '”? Your bookmarks stay.')) return; ll.pages = ll.pages.filter((x) => x.id !== p.id); delete ll.layout[p.id]; pageId = 'home'; await saveLL(); } });
        del.innerHTML = icon('x');
        t.append(ren, del);
      }
      box.append(t);
    });
    const plus = el('button', { class: 'pplus', title: 'New page', onclick: async () => {
      if (ll.pages.length >= 12) { note('That is the most pages Lumilist can hold'); return; }
      const v = await ask('New page', [{ name: 'name', label: 'Name', placeholder: 'Work' }], 'Create');
      if (!v || !v.name) return;
      const id = 'p' + Date.now().toString(36);
      ll.pages.push({ id, name: v.name, folders: [] });
      pageId = id;
      await saveLL();
    } });
    plus.innerHTML = icon('plus');
    box.append(plus);
    const nc = el('button', { class: 'ptab', id: 'newcard', onclick: newCard }, el('span', { text: '＋ Card' }));
    box.append(nc);
  }

  // ---------------------------------------------------------------- the board
  function placeholder(host) {
    const ph = el('span', { class: 'ph', text: (host[0] || '?').toUpperCase(), 'data-host': host });
    ph.style.background = 'hsl(' + hue(host) + ' 45% 42%)';
    return ph;
  }

  function linkRow(b) {
    const host = hostOf(b.url);
    const a = el('a', { href: safeHref(b.url), title: b.url }, placeholder(host || b.title || '?'), el('span', { text: b.title || host || b.url }));
    const li = el('li', { 'data-id': b.id }, a);
    if (editing) {
      li.draggable = true;
      li.addEventListener('dragstart', (e) => { e.stopPropagation(); dragLink = b; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'link'); });
      li.addEventListener('dragend', () => { dragLink = null; $$('.card.over').forEach((c) => c.classList.remove('over')); });
      a.addEventListener('click', (e) => e.preventDefault());
    }
    const ed = el('button', { class: 'mini ed', title: 'Edit', onclick: () => editLink(b) });
    ed.innerHTML = icon('pencil');
    const rm = el('button', { class: 'mini ed', title: 'Remove', onclick: () => call('bookmarks.remove', { id: b.id }).catch(fail) });
    rm.innerHTML = icon('x');
    li.append(ed, rm);
    return li;
  }

  function cardEl(c) {
    const onCustom = pageId !== 'home';
    const head = el('header', {}, el('h3', { text: c.title, title: c.title }));
    if (!c.root) {
      const ren = el('button', { class: 'mini ed', title: 'Rename', onclick: () => renameCard(c) });
      ren.innerHTML = icon('pencil');
      head.append(ren);
    }
    const del = el('button', { class: 'mini ed', title: onCustom ? 'Remove from this page' : (c.root ? '' : 'Delete card'), onclick: () => deleteCard(c, onCustom) });
    del.innerHTML = icon('x');
    if (onCustom || !c.root) head.append(del);

    const ul = el('ul', { class: 'links' });
    const max = NT.ntMaxTiles || 20;
    c.links.slice(0, max).forEach((b) => ul.append(linkRow(b)));
    let extra = Math.max(0, c.links.length - max);
    const card = el('section', { class: 'card', 'data-key': c.key }, head, ul);
    if (!c.links.length && !c.subs.length) card.append(el('div', { class: 'empty', text: 'No links yet' }));
    c.subs.forEach((s) => {
      card.append(el('div', { class: 'sub', text: s.title }));
      const sl = el('ul', { class: 'links' });
      s.links.slice(0, max).forEach((b) => sl.append(linkRow(b)));
      extra += Math.max(0, s.links.length - max);
      card.append(sl);
    });
    if (extra) card.append(el('div', { class: 'more', text: '+ ' + extra + ' more in your bookmarks' }));
    card.append(el('button', { class: 'addrow', text: '＋ Add link', onclick: () => addLink(c) }));

    if (editing) {
      card.draggable = true;
      card.addEventListener('dragstart', (e) => { if (e.target !== card) return; dragEl = card; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'card'); });
      card.addEventListener('dragend', () => { if (!dragEl) return; card.classList.remove('dragging'); dragEl = null; saveLayout(); });
      card.addEventListener('dragover', (e) => { if (dragLink) { e.preventDefault(); card.classList.add('over'); } });
      card.addEventListener('dragleave', () => card.classList.remove('over'));
      card.addEventListener('drop', async (e) => {
        card.classList.remove('over');
        if (!dragLink) return;
        e.preventDefault();
        const b = dragLink;
        dragLink = null;
        if (b.parentId !== c.id) { try { await call('bookmarks.move', { id: b.id, parentId: c.id }); } catch (err) { fail(err); } }
      });
    }
    return card;
  }

  async function saveLayout() {
    if (effectiveCols() === 1 && !compact) return;
    if (compact) return; // the compact layout is a view, it never rewrites your arrangement
    const lay = {};
    $$('#board .col').forEach((col, i) => $$('.card', col).forEach((card, j) => { lay[card.dataset.key] = { col: i, pos: j }; }));
    ll.layout[pageId] = Object.assign({}, ll.layout[pageId] || {}, lay);
    try { ll = await call('lumilist.set', { data: ll }); } catch (e) { fail(e); }
  }

  function renderBoard() {
    const board = $('#board');
    board.textContent = '';
    const all = cardsOnPage(buildCards());
    const cols = effectiveCols();
    const arranged = arrange(all, cols);
    board.hidden = NT.ntTiles === false;
    arranged.forEach((list) => {
      const col = el('div', { class: 'col' });
      list.forEach((c) => col.append(cardEl(c)));
      col.addEventListener('dragover', (e) => {
        if (!dragEl) return;
        e.preventDefault();
        const after = $$('.card:not(.dragging)', col).find((x) => e.clientY < x.getBoundingClientRect().top + x.offsetHeight / 2);
        if (after) col.insertBefore(dragEl, after); else col.append(dragEl);
      });
      board.append(col);
    });
    if (!all.length && NT.ntTiles !== false) board.append(starter());
    fillIcons();
  }

  const STARTERS = [['Search', 'https://duckduckgo.com'], ['YouTube', 'https://www.youtube.com'], ['Gmail', 'https://mail.google.com'], ['GitHub', 'https://github.com'], ['Wikipedia', 'https://www.wikipedia.org']];
  function starter() {
    const ul = el('ul', { class: 'links' });
    STARTERS.forEach(([t, u]) => ul.append(el('li', {}, el('a', { href: u }, placeholder(hostOf(u)), el('span', { text: t })))));
    const add = el('button', { class: 'pbtn primary', text: 'Add these to my bookmarks', style: 'margin:8px 4px 4px', onclick: async () => {
      try {
        const f = await call('bookmarks.addFolder', { title: 'Favourites', parentId: 1 });
        for (const [t, u] of STARTERS) await call('bookmarks.add', { url: u, title: t, parentId: f.id });
      } catch (e) { fail(e); }
    } });
    const col = el('div', { class: 'col', style: 'grid-column: 1 / -1; max-width: 340px' }, el('section', { class: 'card' }, el('header', {}, el('h3', { text: 'Start here' })), ul, add,
      el('div', { class: 'more', text: 'Cards are your bookmark folders. Use the pencil at the bottom left to edit.' })));
    return col;
  }

  async function fillIcons() {
    const phs = $$('.ph[data-host]');
    if (!phs.length) return;
    const hosts = [...new Set(phs.map((p) => p.dataset.host).filter((h) => h.includes('.')))];
    if (!hosts.length) return;
    let map = {};
    try { map = await call('favicons.get', { hosts }); } catch (e) { return; }
    phs.forEach((ph) => {
      const url = map[ph.dataset.host];
      if (!url) return;
      const img = new Image();
      img.className = 'fi';
      img.alt = '';
      img.onload = () => { if (ph.isConnected) ph.replaceWith(img); };
      img.src = url;
    });
  }

  // ---------------------------------------------------------------- classic page (Lumilist switched off)
  async function renderClassic() {
    const box = $('#tiles');
    box.textContent = '';
    $('#classic').hidden = false;
    const top = await call('history.top', { limit: 12 }).catch(() => []);
    const seen = new Set();
    const items = [];
    rows.filter((r) => r.parentId === 1 && r.kind === 'bookmark').forEach((r) => { seen.add(r.url); items.push({ title: r.title, url: r.url }); });
    top.forEach((h) => { if (!seen.has(h.url) && items.length < 14) items.push({ title: h.title || h.url, url: h.url }); });
    items.slice(0, 14).forEach((it) => {
      const host = hostOf(it.url) || it.url;
      const ic = el('span', { class: 'ic', text: (host[0] || '?').toUpperCase() });
      ic.style.background = 'hsl(' + hue(host) + ' 45% 42%)';
      box.append(el('a', { class: 'tile', href: safeHref(it.url), title: it.url }, ic, el('span', { class: 't', text: it.title && it.title.length < 40 ? it.title : host })));
    });
  }

  // ---------------------------------------------------------------- customise panel
  let saveTimer = null;
  const pending = {};
  function setOpt(id, value, now) {
    NT[id] = value;
    pending[id] = value;
    applyConfig();
    renderHeader();
    if (!now) { renderBoardSoon(); } else renderBoard();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushOpts, now ? 0 : 120);
  }
  let boardTimer = null;
  const renderBoardSoon = () => { clearTimeout(boardTimer); boardTimer = setTimeout(() => { if (lumilistOn()) renderBoard(); }, 60); };
  async function flushOpts() {
    const p = Object.assign({}, pending);
    for (const k of Object.keys(pending)) delete pending[k];
    ownSaves++;
    try {
      for (const [id, value] of Object.entries(p)) await call('appearance.set', { id, value });
    } catch (e) { fail(e); }
    setTimeout(() => { ownSaves = Math.max(0, ownSaves - 1); }, 900);
  }

  function row(label, ...nodes) { return el('div', { class: 'prow' }, el('span', { text: label }), el('div', { class: 'val' }, ...nodes)); }
  const rangeCtl = (label, id, min, max, unit, step) => {
    const num = el('span', { class: 'num' });
    const r = el('input', { type: 'range', min, max, step: step || 1 });
    r.value = NT[id] == null ? min : NT[id];
    num.textContent = r.value + (unit || '');
    r.addEventListener('input', () => { num.textContent = r.value + (unit || ''); setOpt(id, Number(r.value), false); });
    return row(label, r, num);
  };
  const segCtl = (label, id, options, after) => {
    const seg = el('div', { class: 'seg' });
    const mark = () => $$('button', seg).forEach((b) => b.classList.toggle('on', b.dataset.v === String(NT[id])));
    options.forEach(([v, l]) => seg.append(el('button', { 'data-v': v, text: l, onclick: () => { setOpt(id, v, true); mark(); if (after) after(); } })));
    mark();
    return row(label, seg);
  };
  const boolCtl = (label, id) => {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = NT[id] !== false && !!NT[id];
    cb.addEventListener('change', () => setOpt(id, cb.checked, true));
    return row(label, el('label', { class: 'sw' }, cb, el('i')));
  };
  const colorCtl = (label, id, fallback) => {
    const c = el('input', { type: 'color' });
    c.value = /^#[0-9a-f]{6}$/i.test(NT[id] || '') ? NT[id] : fallback;
    c.addEventListener('input', () => setOpt(id, c.value, false));
    c.addEventListener('change', () => setOpt(id, c.value, true));
    return row(label, c);
  };

  function buildPanel() {
    const p = $('#panel');
    p.textContent = '';
    const again = () => buildPanel();
    p.append(el('h2', { text: 'Customise this page' }), el('div', { class: 'plink', style: 'margin-bottom:2px' }, 'Changes apply instantly.'));

    p.append(el('h4', { text: 'Background' }));
    p.append(segCtl('Style', 'ntBg', [['theme', 'Default'], ['color', 'Colour'], ['gradient', 'Gradient'], ['image', 'Image']], again));
    if (['color', 'gradient'].includes(NT.ntBg)) p.append(colorCtl(NT.ntBg === 'color' ? 'Colour' : 'Start colour', 'ntColor', '#c4174f'));
    if (NT.ntBg === 'gradient') { p.append(colorCtl('End colour', 'ntColor2', '#2c0814')); p.append(rangeCtl('Angle', 'ntAngle', 0, 360, '°', 5)); }
    if (NT.ntBg === 'image') {
      p.append(row('Image', el('button', { class: 'pbtn', text: 'Choose image…', onclick: () => $('#f-file').click() })));
      p.append(rangeCtl('Darken', 'ntDim', 0, 80, '%'));
      p.append(rangeCtl('Blur', 'ntBlur', 0, 30, 'px'));
    }

    p.append(el('h4', { text: 'Cards' }));
    p.append(rangeCtl('Columns', 'ntCols', 1, 6, ''));
    p.append(segCtl('Board width', 'ntBoard', [['narrow', 'Narrow'], ['medium', 'Medium'], ['wide', 'Wide']]));
    p.append(rangeCtl('Glass opacity', 'ntCardOpacity', 0, 80, '%'));
    p.append(rangeCtl('Glass blur', 'ntCardBlur', 0, 30, 'px'));
    p.append(segCtl('Text size', 'ntTileSize', [['small', 'S'], ['medium', 'M'], ['large', 'L']]));
    p.append(boolCtl('Site icons', 'ntIcons'));
    p.append(boolCtl('Show cards', 'ntTiles'));
    p.append(colorCtl('Accent colour', 'ntAccent', '#d81b60'));

    p.append(el('h4', { text: 'Top of the page' }));
    const brand = el('input', { type: 'text', placeholder: 'Title (optional)', maxlength: 40 });
    brand.value = NT.ntBrand || '';
    brand.addEventListener('change', () => setOpt('ntBrand', brand.value.trim(), true));
    p.append(row('Title', brand));
    p.append(segCtl('Clock', 'ntClock', [['off', 'Off'], ['24h', '24h'], ['12h', '12h']]));
    p.append(boolCtl('Greeting', 'ntGreeting'));
    p.append(segCtl('Search box', 'ntSearch', [['hidden', 'Off'], ['pill', 'Pill'], ['rounded', 'Round'], ['underline', 'Line']]));

    p.append(el('h4', { text: 'More' }));
    p.append(el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:4px' },
      el('button', { class: 'pbtn primary', text: editing ? 'Done editing' : 'Edit cards and links', onclick: () => { toggleEdit(); } }),
      el('button', { class: 'pbtn', text: 'Full appearance studio', onclick: () => call('nav.go', { text: 'orbit://appearance' }) }),
      el('button', { class: 'pbtn danger', text: 'Reset this page', onclick: async () => {
        if (!confirm('Put the background, cards and header back to the defaults? Your bookmarks are not touched.')) return;
        try { await call('appearance.reset', { group: 'newtab' }); await loadAll(); render(); buildPanel(); } catch (e) { fail(e); }
      } })));
  }

  function togglePanel(force) {
    const p = $('#panel');
    const on = force == null ? p.hidden : force;
    if (on) buildPanel();
    p.hidden = !on;
    $('#f-gear').classList.toggle('on', on);
  }

  function toggleEdit(force) {
    editing = force == null ? !editing : force;
    $('#f-edit').classList.toggle('on', editing);
    render();
    if (!$('#panel').hidden) buildPanel();
  }

  // ---------------------------------------------------------------- buttons, search, keys
  [['#f-search', 'search'], ['#f-downloads', 'download'], ['#f-private', 'mask'], ['#f-ext', 'grid'], ['#f-clear', 'trash'], ['#f-eye', 'eye'], ['#f-gear', 'gear'],
    ['#f-edit', 'pencil'], ['#f-phone', 'phone'], ['#f-image', 'image']].forEach(([s, n]) => { $(s).innerHTML = icon(n); });

  function openSearch() { $('#search-ov').hidden = false; $('#sq').value = ''; $('#sq').focus(); }
  function closeSearch() { $('#search-ov').hidden = true; }
  $('#f-search').addEventListener('click', openSearch);
  $('#search-ov').addEventListener('mousedown', (e) => { if (e.target.id === 'search-ov') closeSearch(); });
  $('#sf').addEventListener('submit', (e) => { e.preventDefault(); const t = $('#sq').value.trim(); if (t) call('nav.go', { text: t }); });
  $('#inline-search').addEventListener('submit', (e) => { e.preventDefault(); const t = $('#iq').value.trim(); if (t) call('nav.go', { text: t }); });
  $('#f-downloads').addEventListener('click', () => call('downloads.open').catch(fail));
  $('#f-private').addEventListener('click', () => call('win.newPrivate').catch(fail));
  $('#f-ext').addEventListener('click', () => call('nav.go', { text: 'orbit://extensions' }));
  $('#f-clear').addEventListener('click', async () => {
    if (!confirm('Clear your browsing history?')) return;
    try { await call('data.clear', { what: 'history' }); note('History cleared'); } catch (e) { fail(e); }
  });
  $('#f-eye').addEventListener('click', () => {
    hideCards = !hideCards;
    store.set('ll.hide', hideCards ? '1' : '0');
    $('#f-eye').innerHTML = icon(hideCards ? 'eyeoff' : 'eye');
    applyConfig();
  });
  $('#f-gear').addEventListener('click', () => togglePanel());
  $('#f-edit').addEventListener('click', () => toggleEdit());
  $('#f-phone').addEventListener('click', () => {
    compact = !compact;
    store.set('ll.compact', compact ? '1' : '0');
    $('#f-phone').classList.toggle('on', compact);
    render();
  });
  $('#f-image').addEventListener('click', () => $('#f-file').click());
  $('#f-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 15 * 1024 * 1024) { note('The image must be under 15 MB'); return; }
    try {
      const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(new Error('Could not read the file')); fr.readAsDataURL(f); });
      await call('appearance.background', { ext: (f.name.split('.').pop() || '').toLowerCase(), data });
      ownSaves++; setTimeout(() => { ownSaves = Math.max(0, ownSaves - 1); }, 900);
      await loadAll();
      render();
      if (!$('#panel').hidden) buildPanel();
      note('Background changed');
    } catch (err) { fail(err); }
  });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');
    if (e.key === 'Escape') { closeSearch(); if (!$('#modal').hidden) $('#mform').querySelector('.btns button').click(); else togglePanel(false); return; }
    if (!typing && (e.key === '/' || (e.ctrlKey && e.key.toLowerCase() === 'k')) && lumilistOn()) { e.preventDefault(); openSearch(); }
  });
  document.addEventListener('click', (e) => {
    const p = $('#panel');
    if (!p.hidden && !p.contains(e.target) && !e.target.closest('#f-gear') && !e.target.closest('#modal') && !e.target.closest('#f-file')) togglePanel(false);
  });

  // ---------------------------------------------------------------- render + live updates
  function render() {
    applyConfig();
    renderHeader();
    if (lumilistOn()) {
      $('#classic').hidden = true;
      renderPages();
      renderBoard();
    } else renderClassic();
  }

  let reloadTimer = null;
  const reload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(async () => { try { await loadAll(); render(); } catch (e) { /* page closing */ } }, 120); };
  orbit.on('bookmarks-changed', reload);
  orbit.on('lumilist-changed', reload);
  orbit.on('theme', () => { if (ownSaves === 0) reload(); });

  $('#f-eye').innerHTML = icon(hideCards ? 'eyeoff' : 'eye');
  $('#f-phone').classList.toggle('on', compact);
  loadAll().then(() => { render(); if (!lumilistOn()) $('#iq').focus(); }).catch(fail);
})();
