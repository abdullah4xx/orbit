const q = new URLSearchParams(location.search);
const target = q.get('u') || '';
$('#url').textContent = target;
$('#desc').textContent = (q.get('d') || 'Unknown error').replace(/^ERR_/, '').replace(/_/g, ' ').toLowerCase();
$('#retry').addEventListener('click', () => orbit.call('nav.go', { text: target }));
