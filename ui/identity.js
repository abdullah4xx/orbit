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

// ---------------------------------------------------------------- protected video (Widevine) check
(function () {
  const verdict = $('#drm-verdict');
  const rows = $('#drm-rows');
  const row = (k, v) => rows.append(el('div', { class: 'row' }, el('code', { class: 'muted', text: k, style: 'width:210px;flex:none' }), el('div', { class: 'grow', text: v, style: 'word-break:break-all' })));
  const probe = (robustness) => navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
    initDataTypes: ['cenc'],
    videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"', robustness }],
    audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
  }]).then(() => 'works', (e) => 'not available (' + e.name + ')');

  async function run() {
    verdict.textContent = '';
    rows.textContent = '';
    let st = null;
    try { st = await orbit.call('drm.status'); } catch (e) { /* ignore */ }
    const sw = await probe('SW_SECURE_CRYPTO');
    const any = await probe('');
    const ok = sw === 'works' || any === 'works';
    let why = '';
    if (!ok) {
      if (st && !st.ecs) why = 'This build of Orbit was made with the standard Electron, which has no Widevine. Install the .deb built from the latest code (it uses castLabs Electron).';
      else if (st && (st.state === 'failed' || st.state === 'retrying')) why = 'Widevine could not be downloaded yet' + (st.error ? ' (' + st.error + ')' : '') + '. Connect to the internet, then press the button below.';
      else if (st && st.state === 'starting') why = 'Widevine is still downloading. Wait a minute, then press the button below.';
      else why = 'Widevine is installed but this page cannot use it yet. Close and reopen Orbit once.';
    }
    verdict.append(el('h2', { text: ok ? 'Protected video: ready' : 'Protected video: not ready' }), el('div', { class: 'muted', text: ok ? 'Sites that need Widevine (software decryption, “L3”) can play. If a video still errors, reload the page.' : why }));
    row('Widevine key system', any);
    row('Software decryption (L3)', sw);
    if (st) {
      row('Orbit build', st.ecs ? 'castLabs Electron ' + st.electron : 'standard Electron ' + st.electron + ' (no Widevine)');
      row('Download state', st.state + (st.error ? ' — ' + st.error : ''));
      const comp = Object.entries(st.components || {}).map(([id, c]) => id + ': ' + ((c && (c.status || c.state)) || JSON.stringify(c)) + (c && c.version ? ' ' + c.version : '')).join('; ');
      if (comp) row('Components', comp);
    }
  }
  $('#drm-retry').addEventListener('click', async () => { try { await orbit.call('drm.retry'); } catch (e) { /* ignore */ } setTimeout(run, 1500); });
  run();
})();
