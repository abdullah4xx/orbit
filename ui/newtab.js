$('#f').addEventListener('submit', (e) => { e.preventDefault(); orbit.call('nav.go', { text: $('#q').value }); });
(async function () {
  const [rows, top] = await Promise.all([orbit.call('bookmarks.tree'), orbit.call('history.top', { limit: 12 })]);
  const seen = new Set();
  const items = [];
  rows.filter((r) => r.parentId === 1 && r.kind === 'bookmark').forEach((r) => { seen.add(r.url); items.push({ title: r.title, url: r.url }); });
  top.forEach((h) => { if (!seen.has(h.url) && items.length < 14) items.push({ title: h.title || h.url, url: h.url }); });
  const box = $('#tiles');
  items.slice(0, 14).forEach((it) => {
    let host = it.url;
    try { host = new URL(it.url).hostname.replace(/^www\./, ''); } catch (e) { /* keep */ }
    const ic = el('span', { class: 'ic', text: (host[0] || '?').toUpperCase() });
    ic.style.background = 'hsl(' + hue(host) + ' 45% 42%)';
    box.append(el('a', { class: 'tile', href: it.url, title: it.url }, ic, el('span', { class: 't', text: it.title && it.title.length < 40 ? it.title : host })));
  });
})();
