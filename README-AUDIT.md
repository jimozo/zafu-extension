# ZAFU Extension — Public Source for Audit

This repository contains the public source of the **ZAFU Chrome extension** so users and security researchers can verify what they install.

It is **not** the development repo. All development happens in a private monorepo. This mirror is updated automatically when a release is tagged.

---

## What is ZAFU?

ZAFU intercepts crypto-address pastes in your browser, compares the pasted address to what you copied, and warns you when something looks wrong (clipboard hijacking, address poisoning, known-malicious addresses).

Live site: https://stayzafu.com
Chrome Web Store listing: see https://stayzafu.com (link updated after Chrome Web Store approval)

---

## What this repo is for

- **Audit the extension code** before installing.
- **Verify the fingerprint** of your installed copy matches a published release.
- **Reproduce the build** from a release tag and compare ZIP hashes.

See [VERIFY.md](VERIFY.md) for the verification protocol.

---

## What this repo is *not*

- **Not accepting pull requests.** Read-only audit mirror. Submit changes via the private repo (request access if you have a security finding).
- **Not for feature requests.** Those go to https://zafu.canny.io.
- **Not the full project.** The website, Supabase backend, bots, MCP server, and internal tooling stay private. The trust surface is the extension you install — that's what's published here.
- **Not a general "open source" project.** The phrase is "public extension source." See "Why split this way" below.

---

## Repo contents

```
extension/                   complete extension source (verbatim from monorepo)
scripts/fingerprint.js       integrity tool — computes the 16-char fingerprint
LICENSE                      MIT
VERIFY.md                    how to verify your installed copy
SECURITY.md                  vulnerability disclosure policy
.github/workflows/           verify-fingerprint runs on every push
```

Anything outside that list does not belong here. If you see something extra in this repo, please open an issue.

---

## Verifying a release

Each tagged release publishes:

- The packaged extension `.zip` (same artifact submitted to the Chrome Web Store).
- The 16-character source fingerprint.
- The SHA-256 of the ZIP.

To check your installed copy:

1. Open the ZAFU popup → **Settings** → **Trust & Integrity** → copy the **Fingerprint**.
2. Open the matching release on this repo's Releases page.
3. Compare. They must match exactly.

For the deep-verify path (rebuild from source, compare ZIP hashes), see [VERIFY.md](VERIFY.md).

---

## Reporting issues

| Topic | Where |
|---|---|
| Security vulnerability | `security@stayzafu.com` — see [SECURITY.md](SECURITY.md) |
| Scam address report | Open an issue with the `scam-report` label |
| Feature request | https://zafu.canny.io |
| Bug in extension behavior | Open an issue with the `bug` label |
| Other | hello@stayzafu.com |

---

## Why this repo exists (and why the rest stays private)

The extension is the **trust surface**. Users install code that runs in their browser with access to clipboard events on every page they visit. That code must be auditable.

The backend (Supabase, bots, automations, build tooling) does not run in your browser. Its trust is established differently — through transparent edge function behavior, rate limits, and anonymous-by-default reporting. Publishing it would expose strategy, content, and ops without adding meaningful audit value.

That's why ZAFU is published as **public extension source** rather than "open source" — the framing matters. The thing you install is auditable. The company tooling is not.

---

## License

MIT. See [LICENSE](LICENSE).
