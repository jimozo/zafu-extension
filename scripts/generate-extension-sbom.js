#!/usr/bin/env node
// Emit a CycloneDX 1.5 SBOM for the Zafu extension to stdout.
// Extension is vanilla JS with zero runtime third-party dependencies, so the
// SBOM is intentionally minimal: one component (the extension) with file
// hashes for every fingerprinted source file.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const extensionDir = path.join(__dirname, '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf-8'));

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
  'lib/transfer-context.js',
  'lib/tronscan-client.js',
  'data/known-good-contracts.json',
  'data/known-good-contracts-solana.json',
  'data/malicious-confirmed.json',
  'data/scam-addresses.json',
  'data/scam-addresses-solana.json',
  'data/wallet-exchange-domains.json',
  'popup/popup.js',
  'popup/popup.html',
  'popup/popup.css',
  'book/book.js',
  'book/book.html',
  'book/book.css',
  'onboarding/onboarding.js',
  'onboarding/onboarding.html',
  'onboarding/onboarding.css',
  'content/contact-picker.css',
  'shared/tokens.css',
];

const files = FILES.map((f) => {
  const buf = fs.readFileSync(path.join(extensionDir, f));
  return {
    name: f,
    hashes: [{ alg: 'SHA-256', content: crypto.createHash('sha256').update(buf).digest('hex') }],
  };
});

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'Zafu', name: 'generate-extension-sbom.js', version: '1.0.0' }],
    component: {
      type: 'application',
      'bom-ref': `pkg:generic/zafu-extension@${manifest.version}`,
      name: 'zafu-extension',
      version: manifest.version,
      description: manifest.description,
      licenses: [{ license: { id: 'MIT' } }],
      properties: [
        { name: 'manifest_version', value: String(manifest.manifest_version) },
        { name: 'permissions', value: (manifest.permissions || []).join(',') },
        { name: 'host_permissions_count', value: String((manifest.host_permissions || []).length) },
      ],
    },
  },
  components: [],
  dependencies: [
    { ref: `pkg:generic/zafu-extension@${manifest.version}`, dependsOn: [] },
  ],
  files,
};

process.stdout.write(JSON.stringify(sbom, null, 2) + '\n');
