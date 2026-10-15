let rows = [];
let cur = 1;
let query = '';

const byPos = (a, b) => a.position - b.position;
const kids = (id) => rows.filter((r) => r.parentId === id).sort(byPos);
const say = (t) => { $('#msg').textContent = t || ''; };

async function load() {
  rows = await orbit.call('bookmarks.tree');
  if (!rows.some((r) => r.id === cur)) cur = 1;
  render();
}

function folderOptions(selected, skipId) {
  const sel = el('select');
  const walk = (pid, depth) => {
    rows.filter((r) => r.parentId === pid && r.kind === 'folder' && r.id !== skipId).sort(byPos).forEach((f) => {
      const o = el('option', { value: f.id, text: '\u2003'.repeat(depth) + f.title });
      if (f.id === selected) o.selected = true;
      sel.append(o);
      walk(f.id, depth + 1);
    });
  };
  walk(null, 0);
  return sel;
}

function renderTree() {
  const box = $('#tree');
  box.textContent = '';
  const walk = (pid, depth) => {
    rows.filter((r) => r.parentId === pid && r.kind === 'folder').sort(byPos).forEach((f) => {
      const b = el('button', { class: 'folder' + (f.id === cur && !query ? ' sel' : ''), text: f.title, style: 'padding-left:' + (10 + depth * 16) + 'px', onclick: () => { cur = f.id; query = ''; $('#search').value = ''; render(); } });
      box.append(b);
      walk(f.id, depth + 1);
    });
  };
  walk(null, 0);
}

function renderItem(it, siblings) {
  const row = el('div', { class: 'item' });
  const ic = el('span', { class: 'ic', text: it.kind === 'folder' ? '▸' : (it.title[0] || '•').toUpperCase() });
  const main = el('div', { class: 'main' });
  if (it.kind === 'folder') main.append(el('span', { class: 't', text: it.title, onclick: () => { cur = it.id; render(); } }));
  else main.append(el('a', { href: it.url, text: it.title || it.url }), el('div', { class: 'u', text: it.url }));
  const i = siblings.indexOf(it);
  const acts = el('div', { class: 'acts' });
  if (!query) {
    acts.append(el('button', { class: 'btn small', text: '↑', disabled: i <= 0, onclick: () => orbit.call('bookmarks.move', { id: it.id, parentId: it.parentId, position: i - 1 }) }));
    acts.append(el('button', { class: 'btn small', text: '↓', disabled: i >= siblings.length - 1, onclick: () => orbit.call('bookmarks.move', { id: it.id, parentId: it.parentId, position: i + 1 }) }));
  }
  const mv = folderOptions(it.parentId, it.kind === 'folder' ? it.id : null);
  mv.className = 'small';
  mv.style.height = '28px';
  mv.addEventListener('change', () => orbit.call('bookmarks.move', { id: it.id, parentId: Number(mv.value) }).catch((e) => say(e.message)));
  acts.append(mv);
  acts.append(el('button', { class: 'btn small', text: 'Edit', onclick: () => edit(row, it) }));
  acts.append(el('button', { class: 'btn small danger', text: 'Delete', onclick: () => { if (it.kind === 'bookmark' || confirm('Delete this folder and everything in it?')) orbit.call('bookmarks.remove', { id: it.id }); } }));
  row.append(ic, main, acts);
  return row;
}

function edit(row, it) {
  const t = el('input', { type: 'text', value: it.title });
  const u = it.kind === 'bookmark' ? el('input', { type: 'text', value: it.url }) : null;
  const save = () => orbit.call('bookmarks.update', { id: it.id, title: t.value, url: u ? u.value : undefined });
  row.textContent = '';
  row.append(el('div', { class: 'edit' }, t, u, el('div', { style: 'display:flex;gap:8px' },
    el('button', { class: 'btn primary small', text: 'Save', onclick: save }), el('button', { class: 'btn small', text: 'Cancel', onclick: load }))));
  t.focus();
}

function render() {
  renderTree();
  const list = $('#list');
  list.textContent = '';
  let items;
  let siblings;
  if (query) {
    const s = query.toLowerCase();
    items = rows.filter((r) => r.kind === 'bookmark' && (r.title.toLowerCase().includes(s) || r.url.toLowerCase().includes(s)));
    $('#title').textContent = 'Search results';
    siblings = items;
  } else {
    items = kids(cur);
    const f = rows.find((r) => r.id === cur);
    $('#title').textContent = f ? f.title : '';
    siblings = items;
  }
  if (!items.length) list.append(el('div', { class: 'empty', text: query ? 'Nothing found.' : 'This folder is empty.' }));
  items.forEach((it) => list.append(renderItem(it, siblings)));
}

$('#search').addEventListener('input', (e) => { query = e.target.value.trim(); render(); });
$('#newfolder').addEventListener('click', async () => {
  const name = prompt('Folder name', 'New folder');
  if (name) await orbit.call('bookmarks.addFolder', { title: name, parentId: cur });
});
$('#import').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const n = await orbit.call('bookmarks.importHtml', { html: await f.text() });
  say('Imported ' + n + ' bookmarks into "Imported" under Other bookmarks.');
  e.target.value = '';
});
$('#export').addEventListener('click', async () => say('Saved to ' + (await orbit.call('bookmarks.exportHtml'))));
orbit.on('bookmarks-changed', load);

const m = /folder=(\d+)/.exec(location.hash);
if (m) cur = Number(m[1]);
load();
