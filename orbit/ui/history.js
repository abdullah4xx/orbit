function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

async function load() {
  const rows = await orbit.call('history.list', { q: $('#search').value, limit: 500 });
  const box = $('#list');
  box.textContent = '';
  if (!rows.length) { box.append(el('div', { class: 'empty', text: 'No history.' })); return; }
  let last = '';
  rows.forEach((r) => {
    const label = dayLabel(r.last);
    if (label !== last) { box.append(el('div', { class: 'day', text: label })); last = label; }
    box.append(el('div', { class: 'item' },
      el('span', { class: 'time', text: new Date(r.last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
      el('div', { class: 'main' }, el('a', { href: r.url, text: r.title || r.url }), el('div', { class: 'u', text: r.url })),
      el('button', { class: 'btn small x', text: 'Remove', onclick: async () => { await orbit.call('history.remove', { id: r.id }); load(); } })));
  });
}
$('#search').addEventListener('input', load);
$('#clear').addEventListener('click', async () => { if (confirm('Clear all browsing history?')) { await orbit.call('history.clear'); load(); } });
load();
