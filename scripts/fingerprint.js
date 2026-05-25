#!/usr/bin/env node
/**
 * Zafu extension fingerprint generator.
 *
 * Computes a 16-char hex fingerprint from the SHA-256 of key source files,
 * using the exact same algorithm as the browser (popup.js → computeFingerprint).
 *
 * Published in each GitHub release so users can compare against the value
 * shown in Zafu's Settings → Trust & Integrity panel.
 *
 * Usage:
 *   node scripts/fingerprint.js
 *   node scripts/fingerprint.js --verbose
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Must stay in sync with FINGERPRINT_FILES in popup/popup.js and book/book.js
const FILES = [
  'manifest.json',
  'background/service-worker.js',
  'content/content-script.js',
  'content/contact-picker.js',
  'overlay/overlay.js',
  'overlay/overlay.css',
  'lib/address-profile.js',
  'lib/address-validator.js',
  'lib/address-comparator.js',
  'lib/auth.js',
  'lib/community-client.js',
  'lib/ens-client.js',
  'lib/etherscan-client.js',
  'lib/goplus-client.js',
  'lib/index-builder.js',
  'lib/self-audit.js',
  'lib/solana-detector.js',
  'lib/solscan-client.js',
  'lib/qr.js',
  'lib/storage.js',
  'lib/sync.js',
  'data/known-good-contracts.json',
  'data/known-good-contracts-solana.json',
  'data/malicious-confirmed.json',
  'data/scam-addresses.json',
  'data/scam-addresses-solana.json',
  'data/wallet-exchange-domains.json',
];

const verbose = process.argv.includes('--verbose');
const extensionDir = path.join(__dirname, '..', 'extension');

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

const fileHashes = FILES.map((f) => {
  const filepath = path.join(extensionDir, f);
  const content = fs.readFileSync(filepath, 'utf-8');
  const hash = sha256(content);
  if (verbose) console.error(`  ${f}\n    ${hash}`);
  return hash;
});

// Combine hashes exactly as the browser does: join → SHA-256 → first 16 chars
const combined = sha256(fileHashes.join(''));
const fingerprint = combined.slice(0, 16);

if (verbose) {
  console.error(`\nFingerprint: ${fingerprint}`);
} else {
  console.log(fingerprint);
}
