#!/usr/bin/env bash
# Builds dist/crunchydub-firefox-<version>.zip and dist/crunchydub-chrome-<version>.zip
set -euo pipefail
cd "$(dirname "$0")"

version=$(node -p 'require("./manifest.json").version')
chrome_version=$(node -p 'require("./manifest.chrome.json").version')
if [ "$version" != "$chrome_version" ]; then
  echo "Version mismatch: manifest.json $version, manifest.chrome.json $chrome_version" >&2
  exit 1
fi

rm -rf dist
mkdir -p dist/firefox dist/chrome
common=(background.js shared.js content.js content.css)

cp "${common[@]}" manifest.json dist/firefox/
mkdir -p dist/firefox/icons && cp icons/icon.svg dist/firefox/icons/

cp "${common[@]}" dist/chrome/
cp manifest.chrome.json dist/chrome/manifest.json
mkdir -p dist/chrome/icons && cp icons/icon-*.png dist/chrome/icons/

for b in firefox chrome; do
  (cd "dist/$b" && zip -qrX "../crunchydub-$b-$version.zip" .)
  echo "dist/crunchydub-$b-$version.zip"
done
