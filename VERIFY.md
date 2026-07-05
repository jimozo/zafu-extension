# Verifying Zafu

Zafu intercepts clipboard paste events. A compromised version could replace addresses silently. This page explains how to confirm your installed extension is unmodified.

---

## Quick verification (30 seconds)

1. Open Chrome → click the Zafu icon → **Settings** tab
2. Under **Trust & Integrity**, copy the **Fingerprint** value (16 hex characters)
3. Go to the public Zafu Extension release page
4. Find your version (shown next to the fingerprint in the popup)
5. Compare the fingerprint listed in the release notes against what your popup shows

**They match → your install is unmodified.**
**They differ → remove the extension immediately and re-install from the Chrome Web Store.**

---

## How the fingerprint works

The fingerprint is a 16-character SHA-256 hash computed from **all** of Zafu's code, markup, style, and bundled risk data — every `*.js`, `*.html`, `*.css`, and `*.json` file that ships in the extension:

```
manifest.json
background/service-worker.js
content/content-script.js  content/contact-picker.js  content/contact-picker.css
popup/popup.js  popup/popup.html  popup/popup.css
book/book.js  book/book.html  book/book.css
onboarding/onboarding.js  onboarding/onboarding.html  onboarding/onboarding.css
overlay/overlay.js  overlay/overlay.css
shared/tokens.css
lib/*.js
data/*.json
```

This covers the UI logic where rendering, copy, the import picker, and address handling live — not just the background and library files. Icons (`*.png`, `*.svg`) are not in the fingerprint; they are covered by the per-file manifest below.

The exact file list is defined in `scripts/fingerprint.js` and must stay byte-identical across the popup, address book, and SBOM fingerprint code. `scripts/check-fingerprint-files-drift.js` enforces that parity **and** asserts full-tree coverage — it fails if any extension `*.js/*.html/*.css/*.json` file is left out of the list.

Older releases used only these four files:

```
background/service-worker.js
content/content-script.js
lib/address-comparator.js
lib/storage.js
```

Steps:
1. Each file is hashed individually with SHA-256
2. The file hashes are concatenated
3. That string is hashed again with SHA-256
4. The first 16 characters of the final hash are the fingerprint

The browser computes this live at popup load time using `SubtleCrypto`. The published fingerprint in each GitHub release is computed by `scripts/fingerprint.js` using the identical algorithm in Node.js.

If any security-critical extension file or bundled risk-data file is modified after install (malicious update, code injection), the fingerprint changes.

---

## Deep verification (rebuild from source)

For maximum assurance, rebuild the extension yourself and compare to the published ZIP.

**Requirements:** Node.js 20+, zip

```bash
# Clone the public extension audit repo
# (replace OWNER with the GitHub owner of the zafu-extension mirror)
git clone https://github.com/jimozo/zafu-extension.git
cd zafu-extension

# Verify the specific release tag shown in the Zafu popup
git checkout v1.1.7

# Confirm source fingerprint matches published release
node scripts/fingerprint.js --verbose

# Package
cd extension
zip -r ../zafu-v1.1.7-local.zip . --exclude ".DS_Store" "*/.DS_Store"

# Compare SHA-256 against the release artifact
sha256sum zafu-v1.1.7-local.zip
# Must match the ZIP SHA-256 in the GitHub release notes
```

If the SHA-256 matches the published release, the Chrome Web Store served you the exact same code that was tagged and released.

### Per-file manifest (reproducible anchor)

Each release also attaches `manifest-sha256.json` — a per-file SHA-256 of **every** shipped file (all 44, icons included), plus the version and full permission surface. Regenerate it from the tag and compare:

```bash
node scripts/release-manifest.js
# Each { path, sha256, bytes } entry must match manifest-sha256.json in the release.
```

The release also attaches `sbom.json` (CycloneDX SBOM of the fingerprinted source).

### Limitation: the installed `.crx` is not byte-identical to the ZIP

Chrome re-signs the package on install, so the installed `.crx` is **not** byte-for-byte identical to the uploaded ZIP. Verification therefore does **not** rely on a crx↔zip hash match. The real anchors are:

1. The runtime **fingerprint** (now covering all code + markup) matching the published value — checkable in Settings → Trust & Integrity in 30 seconds.
2. Building from the public tag and reproducing the published **per-file manifest** content hashes.

The ZIP SHA-256 is a convenience/self-attestation. A deterministic ZIP plus signed provenance (cosign/Sigstore) is planned but not yet shipped.

---

## Permissions

Zafu requests exactly **3 Chrome permissions**. The average extension requests 17.

| Permission | Why | What it cannot do |
|---|---|---|
| `storage` | Stores wallet addresses and trusted address index locally in your browser | Cannot access any other extension's storage |
| `alarms` | Schedules 24h refreshes for opted-in wallets and community intelligence | Cannot run outside the browser extension sandbox |
| `identity` | Optional Google Sign-In for address-book backup and restore | Cannot access passwords or sign transactions |

Zafu does **not** request:
- `webRequest` — cannot intercept or modify network traffic
- `nativeMessaging` — cannot communicate outside the browser sandbox
- `clipboardRead` — cannot read clipboard proactively (only on paste events you initiate)
- Any wallet or signing API access

---

## What a compromised Zafu could and could not do

**Could do (worst case):**
- Replace a pasted address with an attacker-controlled one
- Record which addresses you paste

**Could not do:**
- Sign transactions or move funds (no wallet API access — architecturally impossible)
- Access private keys or seed phrases
- Read browser history or other tabs
- Run code outside the extension sandbox

**This is why verification matters:** the threat is a modified paste, not a drained wallet. The fingerprint check lets you confirm in 30 seconds that the replacement can't happen.

---

## Trust principles

- **Public extension source** — the Chrome extension release source is public and auditable
- **No advertising telemetry** — optional Network Mode can share anonymous aggregate usage counts, never addresses, labels, clipboard text, chat text, URLs, balances, transaction hashes, Google ID, or email
- **No external dependencies** — no npm, no bundler, no CDN scripts
- **Strict CSP** — no `eval`, no remote scripts, no inline code execution
- **Offline-first detection** — POISONED and copy-mismatch checks run entirely locally
- **Reproducible builds** — same source → same ZIP, every time

---

## Reporting a security issue

Found a vulnerability? Email security@stayzafu.com before public disclosure.
