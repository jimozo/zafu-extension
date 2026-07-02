#!/usr/bin/env node
// Emit a full per-file release manifest for the Zafu extension to stdout.
//
// Unlike the fingerprint (code + markup only) this enumerates EVERY file that
// ships in the build — icons included — with its SHA-256 and byte size, plus
// the version and full permission surface from manifest.json. It is the
// reproducible "everything in this release" record: build from the public tag
// and the per-file content hashes reproduce, even though the installed Chrome
// .crx is re-signed by Google and is not byte-identical to the uploaded zip.
//
// Usage:
//   node scripts/release-manifest.js            # JSON to stdout
//   node scripts/release-manifest.js --verbose  # also log file count to stderr

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const extensionDir = path.join(__dirname, '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf-8'));
const verbose = process.argv.includes('--verbose');

// macOS / Windows metadata never ships; mirror the zip --exclude rules.
const SKIP = new Set(['.DS_Store', 'Thumbs.db']);

function listFiles(dir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFiles(abs, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

const files = listFiles(extensionDir, '')
  .sort()
  .map((rel) => {
    const buf = fs.readFileSync(path.join(extensionDir, rel));
    return {
      path: rel,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      bytes: buf.length,
    };
  });

const connectSrc = (manifest.content_security_policy?.extension_pages || '')
  .match(/connect-src\s+([^;]+)/)?.[1]
  .trim()
  .split(/\s+/)
  .filter(Boolean) || [];

const out = {
  name: manifest.name,
  version: manifest.version,
  manifest_version: manifest.manifest_version,
  permissions: manifest.permissions || [],
  host_permissions: manifest.host_permissions || [],
  csp_connect_src: connectSrc,
  fileCount: files.length,
  files,
};

if (verbose) console.error(`release-manifest: ${files.length} files, version ${manifest.version}`);
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
