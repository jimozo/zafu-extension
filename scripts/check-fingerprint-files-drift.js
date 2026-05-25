#!/usr/bin/env node
// Assert the fingerprint file-list array is identical across:
//   - scripts/fingerprint.js              (build-time, Node)
//   - extension/popup/popup.js            (runtime, browser)
//   - extension/book/book.js              (runtime, browser)
// Drift here means the fingerprint shown in the UI no longer matches the
// fingerprint published in release notes — silent integrity hole.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const SOURCES = [
  { path: 'scripts/fingerprint.js', arrayName: 'FILES' },
  { path: 'extension/popup/popup.js', arrayName: 'FINGERPRINT_FILES' },
  { path: 'extension/book/book.js', arrayName: 'FINGERPRINT_FILES' },
];

function extractArray(filePath, arrayName) {
  const src = fs.readFileSync(path.join(ROOT, filePath), 'utf-8');
  const re = new RegExp(`const\\s+${arrayName}\\s*=\\s*\\[([\\s\\S]*?)\\];`, 'm');
  const m = src.match(re);
  if (!m) throw new Error(`No const ${arrayName} = [...] found in ${filePath}`);
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => l.replace(/^['"`]|['"`],?$/g, '').replace(/,$/, ''))
    .filter(Boolean);
}

const lists = SOURCES.map((s) => ({ ...s, files: extractArray(s.path, s.arrayName) }));

const reference = lists[0];
let drift = false;
for (const list of lists.slice(1)) {
  const a = reference.files.join('\n');
  const b = list.files.join('\n');
  if (a !== b) {
    drift = true;
    console.error(`\nDRIFT: ${reference.path} (${reference.arrayName}) vs ${list.path} (${list.arrayName})`);
    const setA = new Set(reference.files);
    const setB = new Set(list.files);
    const onlyA = reference.files.filter((f) => !setB.has(f));
    const onlyB = list.files.filter((f) => !setA.has(f));
    if (onlyA.length) console.error(`  Only in ${reference.path}:`, onlyA);
    if (onlyB.length) console.error(`  Only in ${list.path}:`, onlyB);
  }
}

if (drift) {
  console.error('\nFingerprint file-list drift detected. Keep all three arrays in sync.');
  process.exit(1);
}

console.log(`Fingerprint file-list parity OK (${reference.files.length} files across ${lists.length} sources).`);
