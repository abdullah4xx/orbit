let cfg = null;
const set = (key, value) => orbit.call('settings.set', { key, value });
const opt = (v, t, sel) => { const o = el('option', { value: v, text: t }); if (sel) o.selected = true; return o; };

function fill() {
  const s = cfg.settings;
  const idSel = $('#identity-default');
  const ruleSel = $('#rule-id');
  idSel.textContent = ''; ruleSel.textContent = '';
  cfg.identities.forEach((i) => { idSel.append(opt(i.id, i.label, i.id === s.identity)); ruleSel.append(opt(i.id, i.label, false)); });

  const rules = $('#rules');
  rules.textContent = '';
  Object.entries(s.siteIdentity).forEach(([host, id]) => {
    const label = (cfg.identities.find((i) => i.id === id) || {}).label || id;
    rules.append(el('div', { class: 'row' }, el('span', { class: 'grow', text: host }), el('span', { class: 'tag', text: label }),
      el('button', { class: 'btn small danger', text: 'Remove', onclick: async () => { const next = Object.assign({}, s.siteIdentity); delete next[host]; await set('siteIdentity', next); await refresh(); } })));
  });

  $('#homepage').value = s.homepage;
  const eng = $('#engine');
  eng.textContent = '';
  Object.keys(s.searchEngines).forEach((n) => eng.append(opt(n, n, n === s.searchEngine)));
  $('#showBar').checked = s.showBookmarksBar;
  $('#restore').checked = s.restoreSession;
  $('#dl').value = s.downloadDir;
  const ts = $('#theme-sel');
  ts.textContent = '';
  cfg.themes.forEach((t) => ts.append(opt(t, t, t === s.theme)));
  $('#cfg1').textContent = cfg.configDir;
  $('#about').textContent = 'Orbit ' + cfg.version + ' · Chromium ' + cfg.chrome + ' · settings folder: ' + cfg.configDir;
}

async function refresh() { cfg = await orbit.call('settings.get'); fill(); }

$('#identity-default').addEventListener('change', (e) => set('identity', e.target.value));
$('#rule-add').addEventListener('click', async () => {
  const host = $('#rule-host').value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!host) return;
  await set('siteIdentity', Object.assign({}, cfg.settings.siteIdentity, { [host]: $('#rule-id').value }));
  $('#rule-host').value = '';
  refresh();
});
$('#homepage').addEventListener('change', (e) => set('homepage', e.target.value.trim() || 'orbit://newtab'));
$('#engine').addEventListener('change', (e) => set('searchEngine', e.target.value));
$('#eng-add').addEventListener('click', async () => {
  const name = $('#eng-name').value.trim();
  const url = $('#eng-url').value.trim();
  if (!name || !/^https?:\/\/.+%s/.test(url)) { alert('Enter a name and a URL that contains %s'); return; }
  await set('searchEngines', Object.assign({}, cfg.settings.searchEngines, { [name]: url }));
  $('#eng-name').value = ''; $('#eng-url').value = '';
  refresh();
});
$('#showBar').addEventListener('change', (e) => set('showBookmarksBar', e.target.checked));
$('#restore').addEventListener('change', (e) => set('restoreSession', e.target.checked));
$('#dl').addEventListener('change', (e) => set('downloadDir', e.target.value.trim()));
$('#theme-sel').addEventListener('change', (e) => set('theme', e.target.value));
$('#css-save').addEventListener('click', async () => { await orbit.call('css.set', { css: $('#css').value }); $('#css-msg').textContent = 'Applied.'; setTimeout(() => { $('#css-msg').textContent = ''; }, 2000); });
$$('[data-clear]').forEach((b) => b.addEventListener('click', async () => {
  if (!confirm('Clear ' + b.dataset.clear + '?')) return;
  await orbit.call('data.clear', { what: b.dataset.clear });
  $('#clear-msg').textContent = 'Done.';
}));

orbit.call('css.get').then((c) => { $('#css').value = c; });
refresh();
