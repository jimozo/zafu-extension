#!/usr/bin/env node
// Assert the fingerprint file-list array is identical across:
//   - scripts/fingerprint.js              (build-time, Node)
//   - scripts/generate-extension-sbom.js  (build-time, SBOM)
//   - extension/popup/popup.js            (runtime, browser)
//   - extension/book/book.js              (runtime, browser)
// Drift here means the fingerprint shown in the UI no longer matches the
// fingerprint published in release notes / SBOM — silent integrity hole.
//
// Also assert full-tree coverage: every *.js/*.html/*.css/*.json under
// extension/ must appear in the list, so a newly added code/markup file can
// never silently fall outside the published fingerprint.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const SOURCES = [
  { path: 'scripts/fingerprint.js', arrayName: 'FILES' },
  { path: 'scripts/generate-extension-sbom.js', arrayName: 'FILES' },
  { path: 'extension/popup/popup.js', arrayName: 'FINGERPRINT_FILES' },
  { path: 'extension/book/book.js', arrayName: 'FINGERPRINT_FILES' },
];

// Files matched by this glob must all be covered by the fingerprint list.
// Icons (.png/.svg) are intentionally excluded — they ride the per-file
// release manifest, not the runtime fingerprint.
const COVERED_EXT = /\.(js|html|css|json)$/;

function listExtensionTextFiles(dir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listExtensionTextFiles(abs, rel));
    } else if (COVERED_EXT.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

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
  console.error(`\nFingerprint file-list drift detected. Keep all ${lists.length} arrays in sync.`);
  process.exit(1);
}

// Full-tree coverage: nothing executable/markup in extension/ may be unlisted.
const listed = new Set(reference.files);
const treeFiles = listExtensionTextFiles(path.join(ROOT, 'extension'), '');
const uncovered = treeFiles.filter((f) => !listed.has(f)).sort();
if (uncovered.length) {
  console.error('\nFingerprint coverage gap: these extension/ files are not in the fingerprint list:');
  for (const f of uncovered) console.error(`  ${f}`);
  console.error('\nAdd them to the fingerprint list (all sources) or exclude them deliberately.');
  process.exit(1);
}

console.log(`Fingerprint file-list parity OK (${reference.files.length} files across ${lists.length} sources).`);
console.log(`Full-tree coverage OK (${treeFiles.length} extension/ *.js/*.html/*.css/*.json files all listed).`);
