(function () {
  'use strict';
  const call = (cmd, args) => orbit.call(cmd, args || {});
  let S = { tabs: [], active: null, url: '', loading: false, canBack: false, canForward: false, zoom: 100, bookmarkId: null, bar: [], otherCount: 0, showBar: true };
  let editing = false;
  let suggestions = [];
  let selIdx = 0;
  let popupKind = null;
  let dragId = null;
  let dragging = false;
  let pendingRender = false;
  let suggestTimer = null;
  let toastTimer = null;

  const popup = $('#popup');
  const scrim = $('#scrim');
  const urlInput = $('#url');
  const omni = $('#omnibox');

  // ---------------------------------------------------------------- icons
  [['#newtab', 'plus'], ['#back', 'back'], ['#forward', 'forward'], ['#reload', 'reload'], ['#home', 'home'], ['#star', 'star'], ['#menu', 'dots'],
    ['#findprev', 'up'], ['#findnext', 'down'], ['#findclose', 'x']].forEach(([s, n]) => { $(s).innerHTML = icon(n); });

  // ---------------------------------------------------------------- layout sync
  function syncLayout() { call('chrome.layout', { height: $('#bars').offsetHeight, full: !popup.hidden }); }
  new ResizeObserver(syncLayout).observe($('#bars'));

  // ---------------------------------------------------------------- helpers
  function rawUrl() {
    const u = S.url || '';
    if (!u || u === 'about:blank' || /^orbit:\/\/newtab\/?$/.test(u)) return '';
    const m = /^orbit:\/\/error\/\?u=([^&]*)/.exec(u);
    return m ? decodeURIComponent(m[1]) : u;
  }
  function shown() { return rawUrl().replace(/^https:\/\//, '').replace(/\/$/, ''); }
  const isInternal = () => /^orbit:\/\/(?!error)/.test(S.url || '');

  function updateUrlBox() {
    if (!editing) urlInput.value = shown();
    const raw = rawUrl();
    const sec = $('#secure');
    sec.classList.toggle('warn', /^http:/.test(raw));
    sec.innerHTML = /^https:/.test(raw) ? icon('lock') : /^http:/.test(raw) ? icon('warn') : icon('search');
    sec.title = /^http:/.test(raw) ? 'Not secure' : '';
    const star = $('#star');
    star.classList.toggle('on', !!S.bookmarkId);
    star.style.display = isInternal() ? 'none' : '';
    const chip = $('#zoomchip');
    chip.hidden = S.zoom === 100;
    chip.textContent = S.zoom + '%';
  }

  // ---------------------------------------------------------------- popups
  function openPopup(node, x, y, opts) {
    opts = opts || {};
    popup.textContent = '';
    popup.append(node);
    popup.style.minWidth = opts.width ? opts.width + 'px' : '';
    popup.hidden = false;
    scrim.hidden = false;
    popupKind = opts.kind || 'menu';
    const w = popup.offsetWidth;
    let left = opts.alignRight ? x - w : x;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    popup.style.left = left + 'px';
    popup.style.top = y + 'px';
    syncLayout();
  }
  function closePopup() {
    if (popup.hidden) return;
    popup.hidden = true;
    scrim.hidden = true;
    popupKind = null;
    syncLayout();
  }
  scrim.addEventListener('mousedown', closePopup);

  function mi(label, o) {
    o = o || {};
    const b = el('button', { class: 'mi' + (o.danger ? ' danger' : ''), onclick: (e) => { if (!o.keep) closePopup(); o.fn && o.fn(e); } },
      o.icon ? el('span', { html: null }) : null, el('span', { class: 'label', text: label }), o.sub ? el('span', { class: 'sub', text: o.sub }) : null, o.key ? el('span', { class: 'key', text: o.key }) : null);
    if (o.icon) b.firstChild.innerHTML = icon(o.icon);
    return b;
  }
  const sep = () => el('div', { class: 'sep' });
  const anchorBelow = (node) => { const r = node.getBoundingClientRect(); return { x: r.left, y: r.bottom + 4, right: r.right }; };

  // ---------------------------------------------------------------- tabs
  function renderTabs() {
    if (dragging) { pendingRender = true; return; }
    const box = $('#tabs');
    box.textContent = '';
    for (const t of S.tabs) {
      const fav = el('span', { class: 'fav' });
      if (t.loading) fav.innerHTML = '<i class="spin"></i>';
      else if (t.favicon) { const im = new Image(); im.src = t.favicon; im.onerror = () => { fav.innerHTML = icon('globe'); }; fav.append(im); } else fav.innerHTML = icon('globe');
      const x = el('button', { class: 'close', title: 'Close tab', onclick: (e) => { e.stopPropagation(); call('tabs.close', { id: t.id }); } });
      x.innerHTML = icon('x');
      const d = el('div', { class: 'tab' + (t.id === S.active ? ' active' : ''), title: t.title, draggable: 'true', 'data-id': t.id }, fav, el('span', { class: 'title', text: t.title }), x);
      d.addEventListener('mousedown', (e) => { if (e.button === 0 && t.id !== S.active) call('tabs.select', { id: t.id }); });
      d.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); call('tabs.close', { id: t.id }); } });
      d.addEventListener('contextmenu', (e) => { e.preventDefault(); tabMenu(t, e.clientX, e.clientY); });
      d.addEventListener('dragstart', (e) => { dragId = t.id; dragging = true; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(t.id)); });
      d.addEventListener('dragover', (e) => {
        if (dragId == null) return;
        e.preventDefault();
        const after = e.offsetX > d.offsetWidth / 2;
        $$('.tab').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
        d.classList.add(after ? 'drop-after' : 'drop-before');
      });
      d.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragId == null) return;
        const after = e.offsetX > d.offsetWidth / 2;
        const from = S.tabs.findIndex((n) => n.id === dragId);
        let to = S.tabs.findIndex((n) => n.id === t.id) + (after ? 1 : 0);
        if (from < to) to--;
        if (from !== to) call('tabs.move', { id: dragId, index: to });
      });
      d.addEventListener('dragend', () => {
        dragId = null; dragging = false;
        $$('.tab').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
        if (pendingRender) { pendingRender = false; renderTabs(); }
      });
      box.append(d);
    }
  }

  function tabMenu(t, x, y) {
    const box = el('div', {},
      mi('Reload', { fn: () => { call('tabs.select', { id: t.id }).then(() => call('nav.reload')); } }),
      mi('Duplicate', { fn: () => call('tabs.duplicate', { id: t.id }) }),
      sep(),
      mi('Close tab', { fn: () => call('tabs.close', { id: t.id }) }),
      mi('Close other tabs', { fn: () => call('tabs.closeOthers', { id: t.id }) }));
    openPopup(box, x, y);
  }

  // ---------------------------------------------------------------- bookmarks bar
  function renderBar() {
    const bar = $('#bmbar');
    bar.hidden = !S.showBar;
    bar.textContent = '';
    if (!S.showBar) return;
    if (!S.bar.length && !S.otherCount) bar.append(el('span', { class: 'hint', text: 'Bookmarks you add to the bar appear here' }));
    for (const b of S.bar) {
      const btn = el('button', { class: 'bm', title: b.url || b.title }, el('span', { class: 'ic' }), el('span', { text: b.title }));
      btn.firstChild.innerHTML = icon(b.kind === 'folder' ? 'folder' : 'globe');
      btn.firstChild.style.display = 'inline-grid';
      btn.addEventListener('click', () => { if (b.kind === 'folder') openFolder(b.id, btn); else call('nav.go', { text: b.url }); });
      btn.addEventListener('auxclick', (e) => { if (e.button === 1 && b.kind === 'bookmark') call('tabs.new', { url: b.url }); });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openPopup(el('div', {},
          b.kind === 'bookmark' ? mi('Open in new tab', { fn: () => call('tabs.new', { url: b.url }) }) : null,
          mi('Edit…', { fn: () => { const a = anchorBelow(btn); editBookmark(b.id, a.x, a.y); } }),
          mi('Delete', { danger: true, fn: () => call('bookmarks.remove', { id: b.id }) })), e.clientX, e.clientY);
      });
      bar.append(btn);
    }
    if (S.otherCount) {
      bar.append(el('span', { class: 'spacer' }));
      const o = el('button', { class: 'bm' }, el('span', { class: 'ic' }), el('span', { text: 'Other bookmarks' }));
      o.firstChild.innerHTML = icon('folder');
      o.firstChild.style.display = 'inline-grid';
      o.addEventListener('click', () => openFolder(2, o, true));
      bar.append(o);
    }
  }

  async function openFolder(id, anchor, right) {
    const rows = await call('bookmarks.tree');
    const kids = rows.filter((r) => r.parentId === id).sort((a, b) => a.position - b.position);
    const box = el('div');
    if (!kids.length) box.append(el('div', { class: 'mi', text: '(empty)' }));
    for (const k of kids) {
      if (k.kind === 'folder') box.append(mi(k.title, { icon: 'folder', keep: true, fn: () => openFolder(k.id, anchor, right) }));
      else box.append(mi(k.title, { icon: 'globe', sub: k.url.replace(/^https?:\/\//, ''), fn: () => call('nav.go', { text: k.url }) }));
    }
    box.append(sep(), mi('Manage bookmarks', { fn: () => call('openPage', { page: 'bookmarks', hash: 'folder=' + id }) }));
    const a = anchorBelow(anchor);
    openPopup(box, right ? a.right : a.x, a.y, { alignRight: !!right });
  }

  function folderOptions(rows, selected) {
    const sel = el('select');
    const walk = (pid, depth) => {
      rows.filter((r) => r.parentId === pid && r.kind === 'folder').sort((a, b) => a.position - b.position).forEach((f) => {
        const o = el('option', { value: f.id, text: '\u2003'.repeat(depth) + f.title });
        if (f.id === selected) o.selected = true;
        sel.append(o);
        walk(f.id, depth + 1);
      });
    };
    walk(null, 0);
    return sel;
  }

  async function editBookmark(id, x, y) {
    const rows = await call('bookmarks.tree');
    const bm = rows.find((r) => r.id === id);
    if (!bm) return;
    const title = el('input', { type: 'text', value: bm.title });
    const folder = folderOptions(rows, bm.parentId);
    const save = () => call('bookmarks.update', { id, title: title.value || bm.title, parentId: Number(folder.value) });
    title.addEventListener('change', save);
    folder.addEventListener('change', save);
    const box = el('div', { class: 'editor' },
      el('h4', { text: bm.kind === 'folder' ? 'Edit folder' : 'Bookmark' }),
      el('label', {}, 'Name', title), el('label', {}, 'Folder', folder),
      el('div', { class: 'row' },
        el('button', { class: 'btn danger', text: 'Remove', onclick: () => { call('bookmarks.remove', { id }); closePopup(); } }),
        el('button', { class: 'btn primary', text: 'Done', onclick: () => { save(); closePopup(); } })));
    openPopup(box, x, y, { kind: 'editor' });
    title.focus();
    title.select();
  }

  async function toggleStar() {
    if (!S.url || isInternal()) return;
    let id = S.bookmarkId;
    if (!id) {
      const tab = S.tabs.find((t) => t.id === S.active);
      const r = await call('bookmarks.add', { url: S.url, title: (tab && tab.title) || S.url, parentId: 1 });
      id = r.id;
    }
    const a = anchorBelow($('#star'));
    editBookmark(id, a.right - 300, a.y);
  }

  // ---------------------------------------------------------------- main menu
  function mainMenu() {
    const zr = el('div', { class: 'zoomrow' }, el('span', { class: 'label', text: 'Zoom' }),
      el('button', { class: 'btn', text: '−', onclick: () => call('zoom', { delta: -1 }) }),
      el('span', { class: 'pct', text: S.zoom + '%' }),
      el('button', { class: 'btn', text: '+', onclick: () => call('zoom', { delta: 1 }) }));
    const box = el('div', {},
      mi('New tab', { icon: 'plus', key: 'Ctrl+T', fn: () => call('tabs.new') }),
      mi('Reopen closed tab', { key: 'Ctrl+Shift+T', fn: () => call('tabs.reopen') }),
      sep(),
      mi('Bookmark this page', { icon: 'star', key: 'Ctrl+D', fn: toggleStar }),
      mi('Bookmarks', { icon: 'folder', key: 'Ctrl+Shift+O', fn: () => call('openPage', { page: 'bookmarks' }) }),
      mi('History', { icon: 'clock', key: 'Ctrl+H', fn: () => call('openPage', { page: 'history' }) }),
      mi('Extensions', { fn: () => call('openPage', { page: 'extensions' }) }),
      sep(), zr, sep(),
      mi('Find in page', { icon: 'search', key: 'Ctrl+F', fn: openFind }),
      mi('Developer tools', { key: 'F12', fn: () => call('devtools') }),
      sep(),
      mi('What do websites see?', { fn: () => call('openPage', { page: 'identity' }) }),
      mi('Settings', { fn: () => call('openPage', { page: 'settings' }) }),
      mi('Quit', { key: 'Ctrl+Q', fn: () => call('quit') }));
    const a = anchorBelow($('#menu'));
    openPopup(box, a.right, a.y, { alignRight: true, width: 280 });
  }

  // ---------------------------------------------------------------- omnibox
  function go(text) { closePopup(); urlInput.blur(); call('nav.go', { text }); }

  function renderSuggestions() {
    if (!suggestions.length) { if (popupKind === 'suggest') closePopup(); return; }
    const box = el('div');
    suggestions.forEach((s, i) => {
      const row = el('button', { class: 'mi' + (i === selIdx ? ' sel' : '') },
        el('span', {}), el('span', { class: 'label', text: s.title || s.url }),
        s.type === 'go' ? null : el('span', { class: 'sub', text: s.url.replace(/^https?:\/\//, '') }));
      row.firstChild.innerHTML = icon(s.type === 'go' ? 'search' : s.type === 'bookmark' ? 'star' : 'clock');
      row.addEventListener('mousedown', (e) => { e.preventDefault(); go(s.url); });
      box.append(row);
    });
    const r = omni.getBoundingClientRect();
    openPopup(box, r.left, r.bottom + 4, { kind: 'suggest', width: r.width });
    popup.style.maxWidth = r.width + 'px';
  }

  urlInput.addEventListener('focus', () => { editing = true; omni.classList.add('focus'); urlInput.value = rawUrl(); urlInput.select(); });
  urlInput.addEventListener('blur', () => { editing = false; omni.classList.remove('focus'); if (popupKind === 'suggest') closePopup(); updateUrlBox(); });
  urlInput.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(async () => {
      const q = urlInput.value.trim();
      if (!q) { suggestions = []; renderSuggestions(); return; }
      const list = await call('omnibox.suggest', { q });
      if (urlInput.value.trim() !== q) return;
      suggestions = [{ type: 'go', title: q, url: q }].concat(list);
      selIdx = 0;
      renderSuggestions();
    }, 60);
  });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); go(suggestions[selIdx] && popupKind === 'suggest' ? suggestions[selIdx].url : urlInput.value); }
    else if (e.key === 'Escape') { closePopup(); urlInput.value = rawUrl(); urlInput.select(); }
    else if (e.key === 'ArrowDown' && suggestions.length) { e.preventDefault(); selIdx = (selIdx + 1) % suggestions.length; renderSuggestions(); }
    else if (e.key === 'ArrowUp' && suggestions.length) { e.preventDefault(); selIdx = (selIdx - 1 + suggestions.length) % suggestions.length; renderSuggestions(); }
  });

  // ---------------------------------------------------------------- find bar
  function openFind() { $('#findbar').hidden = false; $('#findinput').focus(); $('#findinput').select(); }
  function closeFind() { if ($('#findbar').hidden) return; $('#findbar').hidden = true; $('#findcount').textContent = ''; call('find.close'); }
  $('#findinput').addEventListener('input', (e) => call('find.search', { text: e.target.value }));
  $('#findinput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') call('find.search', { text: e.target.value, dir: e.shiftKey ? 'prev' : 'next' });
    else if (e.key === 'Escape') closeFind();
  });
  $('#findnext').addEventListener('click', () => call('find.search', { text: $('#findinput').value, dir: 'next' }));
  $('#findprev').addEventListener('click', () => call('find.search', { text: $('#findinput').value, dir: 'prev' }));
  $('#findclose').addEventListener('click', closeFind);

  // ---------------------------------------------------------------- buttons
  $('#newtab').addEventListener('click', () => call('tabs.new'));
  $('#back').addEventListener('click', () => call('nav.back'));
  $('#forward').addEventListener('click', () => call('nav.forward'));
  $('#reload').addEventListener('click', () => call(S.loading ? 'nav.stop' : 'nav.reload'));
  $('#home').addEventListener('click', () => call('nav.home'));
  $('#star').addEventListener('click', toggleStar);
  $('#menu').addEventListener('click', mainMenu);
  $('#zoomchip').addEventListener('click', () => call('zoom', { delta: 0 }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopup(); });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------------------------------------------------------------- state from main
  function render() {
    renderTabs();
    renderBar();
    $('#back').disabled = !S.canBack;
    $('#forward').disabled = !S.canForward;
    $('#reload').innerHTML = icon(S.loading ? 'x' : 'reload');
    $('#progress').classList.toggle('on', !!S.loading);
    updateUrlBox();
  }

  orbit.on('state', (s) => { S = s; render(); });
  orbit.on('focus-omnibox', () => { urlInput.focus(); urlInput.select(); });
  orbit.on('find-open', openFind);
  orbit.on('find-close', () => { $('#findbar').hidden = true; });
  orbit.on('find', (r) => { $('#findcount').textContent = r.count ? r.active + ' / ' + r.count : ($('#findinput').value ? 'No matches' : ''); });
  orbit.on('theme', (t) => { $('#theme').href = 'orbit://theme/current.css?t=' + t; });
  orbit.on('toggle-bookmark', toggleStar);
  orbit.on('toast', (msg) => {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
  });

  call('chrome.ready');
  syncLayout();
})();
