#!/usr/bin/env bash
# Builds orbit-browser_<version>_amd64.deb  (needs internet once, to download Electron)
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js 20+ first:  sudo apt install nodejs npm"; exit 1; }
npm install
npm test
npm run dist
echo
ls -1 dist/*.deb
echo "Install with:  sudo apt install ./dist/*.deb"
