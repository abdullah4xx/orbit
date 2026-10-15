'use strict';
/* Runs in every frame of every tab, before the page's own scripts. */
const { contextBridge, ipcRenderer, webFrame } = require('electron');

let isTop = false;
try { isTop = window.top === window; } catch (e) { isTop = false; }

// 1. Identity: make this frame look like the configured browser/OS.
try {
  const code = ipcRenderer.sendSync('orbit:identity', location.hostname);
  if (code) webFrame.executeJavaScript(code);
} catch (e) { /* never break a page because of this */ }

// 2. Extensions.
try {
  const ext = ipcRenderer.sendSync('orbit:ext-scripts', location.href, isTop);
  if (ext) {
    ext.css.forEach((c) => { try { webFrame.insertCSS(c); } catch (e) { /* ignore */ } });
    const run = (item) => { try { webFrame.executeJavaScript(item.code); } catch (e) { /* ignore */ } };
    ext.js.filter((j) => j.runAt === 'start').forEach(run);
    const late = ext.js.filter((j) => j.runAt !== 'start');
    if (late.length) {
      const go = () => late.forEach(run);
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
      else go();
    }
  }
} catch (e) { /* ignore */ }

// 3. Orbit's own pages get a small API; websites never do.
if (isTop && location.protocol === 'orbit:') {
  contextBridge.exposeInMainWorld('orbit', {
    call: (cmd, args) => ipcRenderer.invoke('orbit:call', cmd, args || {}),
    on: (evt, fn) => { ipcRenderer.on('orbit:push', (_e, name, data) => { if (name === evt) fn(data); }); },
  });
}
