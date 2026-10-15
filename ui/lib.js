/* Small helpers shared by Orbit's own pages. */
window.$ = (s, r) => (r || document).querySelector(s);
window.$$ = (s, r) => Array.from((r || document).querySelectorAll(s));
window.el = function (tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  kids.flat().forEach((c) => { if (c != null) n.append(c.nodeType ? c : document.createTextNode(c)); });
  return n;
};
(function () {
  const link = document.getElementById('theme');
  if (window.orbit && link) window.orbit.on('theme', (t) => { link.href = 'orbit://theme/current.css?t=' + t; });
})();
window.hue = function (s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
