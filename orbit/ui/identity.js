(async function () {
  const rows = [];
  const add = (k, v) => rows.push([k, String(v)]);
  add('navigator.userAgent', navigator.userAgent);
  add('navigator.platform', navigator.platform);
  add('navigator.vendor', navigator.vendor);
  add('window.chrome', typeof window.chrome === 'object' ? 'present' : 'missing');
  let uaPlatform = '';
  if (navigator.userAgentData) {
    uaPlatform = navigator.userAgentData.platform;
    add('userAgentData.platform', uaPlatform);
    add('userAgentData.brands', navigator.userAgentData.brands.map((b) => b.brand + ' ' + b.version).join(', '));
    try {
      const h = await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'architecture', 'fullVersionList']);
      add('platformVersion', h.platformVersion);
      add('architecture', h.architecture);
    } catch (e) { /* ignore */ }
  }
  const blob = [navigator.userAgent, navigator.platform, uaPlatform].join(' ');
  const linux = /linux|x11/i.test(blob);
  const v = $('#verdict');
  v.append(el('h2', { text: linux ? 'Sites will see: Linux' : 'Sites will see: ' + (uaPlatform || navigator.platform) }),
    el('div', { class: 'muted', text: linux ? 'A site that blocks Linux would block this identity.' : 'A site that blocks Linux will not detect Linux from these values.' }));
  const box = $('#vals');
  rows.forEach(([k, val]) => box.append(el('div', { class: 'row' }, el('code', { class: 'muted', text: k, style: 'width:210px;flex:none' }), el('div', { class: 'grow', text: val, style: 'word-break:break-all' }))));
})();
