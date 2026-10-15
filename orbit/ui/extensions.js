async function load() {
  const list = await orbit.call('extensions.list');
  const box = $('#list');
  box.textContent = '';
  if (!list.length) box.append(el('div', { class: 'empty', text: 'No extensions yet.' }));
  list.forEach((x) => {
    const sw = el('label', { class: 'switch' }, el('input', { type: 'checkbox', checked: x.enabled }), el('i'));
    sw.firstChild.addEventListener('change', async (e) => { await orbit.call('extensions.toggle', { id: x.id, enabled: e.target.checked }); });
    box.append(el('div', { class: 'card' }, el('div', { class: 'row' },
      el('div', { class: 'grow' },
        el('div', {}, el('strong', { text: x.name }), ' ', el('span', { class: 'muted', text: x.version }), ' ', el('span', { class: 'tag', text: x.origin })),
        el('div', { class: 'desc', text: x.description }),
        el('div', { class: 'desc', text: 'Runs on: ' + x.matches.join(', ') })),
      sw)));
  });
}
$('#open').addEventListener('click', () => orbit.call('extensions.openFolder'));
load();
