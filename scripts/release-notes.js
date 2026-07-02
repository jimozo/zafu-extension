#!/usr/bin/env node
// Generate the GitHub release body for a Zafu extension release.
//
// Single source of truth for both workflows (release.yml + sync-public-mirror.yml)
// so the published notes report the REAL permission surface — including
// host_permissions and a diff vs the previous tag — instead of a hardcoded
// `storage · alarms · identity` line that hid the host-permission changes.
//
// Usage:
//   node scripts/release-notes.js --prev-tag v1.1.7
//   node scripts/release-notes.js --prev-tag v1.1.7 --tag v1.1.8 \
//        --zip-sha <sha256> --repo jimozo/zafu-extension
//
// --prev-tag  previous release tag to diff against (omit for a first release)
// --tag       this release tag (default: vX.Y.Z from manifest.json)
// --zip-sha   SHA-256 of the uploaded zip (default: a release-time placeholder)
// --repo      owner/repo for doc links (default: jimozo/zafu-extension)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf-8'));

const tag = flag('tag', `v${manifest.version}`);
const prevTag = flag('prev-tag', null);
const zipSha = flag('zip-sha', '(computed during release)');
const repo = flag('repo', 'jimozo/zafu-extension');

const fingerprint = execFileSync('node', [path.join(root, 'scripts/fingerprint.js')], {
  encoding: 'utf-8',
}).trim();

const permissions = manifest.permissions || [];
const hostPermissions = manifest.host_permissions || [];
const connectSrc = (manifest.content_security_policy?.extension_pages || '')
  .match(/connect-src\s+([^;]+)/)?.[1]
  .trim()
  .split(/\s+/)
  .filter(Boolean) || [];

let prevManifest = null;
if (prevTag) {
  try {
    prevManifest = JSON.parse(
      execFileSync('git', ['show', `${prevTag}:extension/manifest.json`], { encoding: 'utf-8' })
    );
  } catch {
    prevManifest = null; // tag missing or file absent — treated as no previous record
  }
}

function diff(prevList, curList) {
  const prev = new Set(prevList || []);
  const cur = new Set(curList || []);
  return {
    added: [...cur].filter((x) => !prev.has(x)),
    removed: [...prev].filter((x) => !cur.has(x)),
  };
}

const permDiff = diff(prevManifest?.permissions, permissions);
const hostDiff = diff(prevManifest?.host_permissions, hostPermissions);
const hasPermChange = permDiff.added.length || permDiff.removed.length;
const hasHostChange = hostDiff.added.length || hostDiff.removed.length;

const lines = [];
lines.push(`## Zafu ${tag}`);
lines.push('');
lines.push('### Verify your installation');
lines.push('');
lines.push('Open Zafu → Settings → **Trust & Integrity**. The **Fingerprint** must match:');
lines.push('');
lines.push('```');
lines.push(fingerprint);
lines.push('```');
lines.push('');
lines.push('| Artifact | Hash |');
lines.push('|---|---|');
lines.push(`| Source fingerprint (all code + markup) | \`${fingerprint}\` |`);
lines.push(`| ZIP SHA-256 | \`${zipSha}\` |`);
lines.push('');
lines.push('Attached to this release:');
lines.push('- `sbom.json` — CycloneDX SBOM of the fingerprinted source files.');
lines.push('- `manifest-sha256.json` — per-file SHA-256 of **every** shipped file (icons included).');
lines.push('');
lines.push(`See [VERIFY.md](https://github.com/${repo}/blob/main/VERIFY.md) for the full verification protocol.`);
lines.push('');

lines.push('### Permissions');
lines.push('');
lines.push(`**Chrome permissions:** ${permissions.map((p) => `\`${p}\``).join(' · ') || '(none)'}`);
lines.push('');
lines.push('**Host permissions:**');
for (const h of hostPermissions) lines.push(`- \`${h}\``);
lines.push('');
lines.push('**CSP `connect-src`:**');
for (const c of connectSrc) lines.push(`- \`${c}\``);
lines.push('');

lines.push('### Permission diff');
lines.push('');
if (!prevManifest) {
  lines.push(prevTag
    ? `No previous manifest found for \`${prevTag}\` — full permission set listed above.`
    : 'No previous tag supplied — full permission set listed above.');
} else {
  lines.push(`Compared against \`${prevTag}\`:`);
  lines.push('');
  if (!hasPermChange && !hasHostChange) {
    lines.push('No permission or host-permission changes.');
  } else {
    if (hasHostChange) {
      lines.push('> ⚠️ **High-sensitivity: host-permission changes.**');
      lines.push('');
    }
    for (const p of permDiff.added) lines.push(`- **Added permission:** \`${p}\``);
    for (const p of permDiff.removed) lines.push(`- **Removed permission:** \`${p}\``);
    for (const h of hostDiff.added) lines.push(`- **Added host_permission:** \`${h}\``);
    for (const h of hostDiff.removed) lines.push(`- **Removed host_permission:** \`${h}\``);
  }
}
lines.push('');

lines.push('### Trust guarantees');
lines.push('- Local-first — community signals via Supabase edge functions; no advertising telemetry');
lines.push('- No private key access — architecturally impossible (no wallet API access)');
lines.push('- Strict CSP — no eval, no remote scripts, no inline code');
lines.push('- Public extension source — audit the code yourself');
lines.push('');
lines.push('> The installed Chrome `.crx` is re-signed by Google and is **not** byte-identical to the');
lines.push('> uploaded zip. The verifiable anchors are the runtime **fingerprint** (now covering all');
lines.push('> code + markup) and the reproducible **per-file manifest** — not a crx↔zip hash match.');

process.stdout.write(lines.join('\n') + '\n');
