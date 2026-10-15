# Orbit

A browser whose whole interface (tabs, address bar, menus, new-tab page, settings) is plain HTML/CSS in `ui/`.
Pages are rendered by Chromium (Electron), so sites behave as they do in Chrome.

## Build the .deb (Ubuntu 22.04+)

    ./build.sh                          # needs internet once, to download Electron
    sudo apt install ./dist/orbit-browser_*_amd64.deb

Or push this folder to GitHub: the workflow in `.github/workflows/build-deb.yml` builds the .deb and attaches it to the run.

Run without installing: `npm install && npm start` (set `ORBIT_DEBUG=1` to open DevTools for the browser UI itself).

## "Linux not supported" video players

Some sites check the operating system and refuse to play on Linux. Orbit reports a Windows Chrome identity by default,
consistently in all three places a site can look:

1. the `User-Agent` request header
2. the `Sec-CH-UA-*` client-hint headers
3. `navigator.userAgent`, `navigator.platform`, `navigator.userAgentData` in JavaScript (patched before the page's own scripts, in every frame)

Open **Menu → What do websites see?** (`orbit://identity`) to check the values. Identity and per-site rules are in **Settings → Identity**.

Limits: this fixes platform checks. It cannot play content that requires Widevine DRM (stock Electron has no Widevine CDM),
and it cannot hide differences a site detects by other means (GPU strings, fonts, etc.).

## Customising

* **Look:** `~/.config/orbit-browser/custom.css` (or Settings → Appearance). It is applied last, to the browser UI and Orbit's pages.
  Colours/sizes are CSS variables (`--accent`, `--surface`, `--radius`, `--tabstrip-h` ...); any element can be restyled (`#tabs .tab`, `#omnibox` ...).
* **Themes:** drop a `.css` file in `~/.config/orbit-browser/themes/` (see `themes/dark.css`; the first line `/* scheme: dark */` or `light` sets the page colour scheme).
* **Extensions:** a folder in `~/.config/orbit-browser/extensions/` with a `manifest.json` and scripts/styles (see `extensions/night-pages`).
* **Bookmarks:** bar, folders, manager (Ctrl+Shift+O), import/export of the standard HTML bookmark file (Chrome, Firefox, Edge).
* The UI is in `ui/` (`chrome.html`, `chrome.css`, `chrome.js`); the browser logic is in `main.js`.

## Shortcuts

Ctrl+T new tab · Ctrl+W close · Ctrl+Shift+T reopen · Ctrl+L address bar · Ctrl+D bookmark · Ctrl+F find · Ctrl+H history ·
Ctrl+Shift+O bookmarks · Ctrl+Tab / Ctrl+PgUp/PgDn switch tabs · Ctrl+1…9 · Ctrl +/−/0 zoom · Alt+←/→ · F5/Ctrl+R · F11 · F12

## Not done yet

Multiple windows, private mode, ad blocking, a custom (non-system) title bar, extension popups / the Chrome extension API.
