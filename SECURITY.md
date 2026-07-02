# Security Policy

## Reporting a vulnerability

Email **security@stayzafu.com** with details. Do **not** open a public GitHub issue for security findings.

Include:

- A description of the vulnerability.
- Steps to reproduce (proof-of-concept code, screenshots, or a recorded session is ideal).
- The affected version (extension fingerprint or release tag).
- Your assessment of impact.

PGP optional. If you'd like an encrypted channel, request our public key in your first email.

---

## What we commit to

| | |
|---|---|
| Acknowledge receipt | Within **48 hours** |
| Initial assessment | Within **7 days** |
| Status updates | Every **7 days** until resolved |
| Public disclosure | Coordinated with reporter, after a fix is shipped |

We do **not** currently run a paid bounty program. We will publicly credit reporters (with consent) in release notes and on stayzafu.com.

---

## In scope

- The ZAFU Chrome extension source published in this repository.
- Edge functions that the extension calls (`stayzafu.com/api/*` and Supabase function URLs).
- The website at `stayzafu.com` and `www.stayzafu.com`.

## Out of scope

- Findings that require physical access to a victim's device.
- Social-engineering attacks on ZAFU staff or users.
- Denial-of-service against `stayzafu.com` or Supabase functions (we rely on Cloudflare and Supabase rate limits).
- Vulnerabilities in third-party libraries with no demonstrated impact on ZAFU.
- Self-XSS or any issue requiring an attacker-controlled extension already installed.
- The private monorepo (not published — outside the audit surface).

---

## Threat model

ZAFU's worst-case compromise is a **modified paste** — an attacker-controlled build replacing the address you paste with one of theirs. ZAFU **cannot** sign transactions, access private keys, or read clipboard data outside paste events. See [VERIFY.md](VERIFY.md) for full detail.

Findings that demonstrate or extend that worst case (paste replacement, exfiltration of pasted addresses, bypass of detection state machine, fingerprint forgery) are highest priority.

A full STRIDE breakdown per component (content script, service worker, edge functions, mirror sync, extension UI) lives in `docs/security/threat-model.md` (added in security hardening Phase B).

---

## Vulnerability categories we track

Reports framed against one of these categories help us triage faster.

| Category | What it covers | Example |
|---|---|---|
| **Paste-replacement / overlay XSS** | Anything that lets an attacker page modify, suppress, or impersonate the ZAFU overlay or the address pasted by the user | Injecting markup into the overlay DOM, racing the paste event, hijacking the warning UI |
| **Address-comparator bypass** | Inputs that confuse `lib/address-comparator.js` into treating two different addresses as a match | Visually-similar Unicode, mixed-case EVM edge cases, base58/base32 collisions, normalization gaps |
| **Detection state-machine bypass** | Paths that suppress alerts that should fire, or trigger false positives that desensitize users | Storage corruption, alarm timing abuse, malformed sync payload tolerated by service worker |
| **Manifest permission creep** | Any change (in `extension/manifest.json` or PR diff) that broadens permissions, host permissions, or CSP beyond what `VERIFY.md` documents | New host permission not justified in [VERIFY.md](VERIFY.md), CSP relaxation, `<all_urls>` widening |
| **Edge-function auth / abuse** | Auth, rate-limit, or input-validation gaps in `stayzafu.com/api/*` and Supabase functions | Submitting community reports without auth, IDOR on `/community`, replay attacks on `/sync` |
| **Supply-chain / build-pipeline compromise** | Anything that lets a third party inject code into a published release | CWS account hijack, dependency typosquat, GitHub Actions secret leak, public-mirror sync tampering, fingerprint drift |
| **Secret / credential exposure** | Secrets accidentally committed or leaked through logs, error messages, or extension storage | API keys in repo, Google OAuth client secret in client code, sync tokens in `chrome.storage` |
| **Privacy regression** | Behaviour that contradicts `website/privacy-policy.html` (e.g. telemetry, third-party fetch on paste, identifier leakage) | Sending the full pasted address to a third-party origin, fingerprinting users by `chrome.storage.sync` content |

Findings outside these categories are still welcome — they just take longer to assess.

---

## Severity rubric

We classify reports on impact and exploitability, not CVSS score alone. Response SLAs are measured from acknowledgement.

| Severity | Definition | First fix-or-mitigation target | Public disclosure window |
|---|---|---|---|
| **Critical** | Unauthenticated paste replacement, address-comparator bypass that ships in CWS build, supply-chain compromise affecting a published release, credential leak with active exposure | **48 hours** to mitigation or kill-switch; **7 days** to fix in CWS | 7 days from acknowledgement |
| **High** | Authenticated paste manipulation, overlay XSS requiring user interaction, edge-function auth bypass, permission creep landing in main without justification | **7 days** to fix | 14 days from acknowledgement |
| **Medium** | Detection bypass requiring an unusual combination of conditions, privacy regression with limited blast radius, CI-only secret-scan miss | **30 days** to fix | 30 days from acknowledgement |
| **Low** | Hardening gap with no demonstrated impact (missing header, defensive-in-depth control), low-confidence false positives in detection | Next release; tracked in `docs/security/` | At reporter's discretion |

If a report falls between two bands we err on the higher one. We will publicly state the assigned severity when we acknowledge the report.

---

## Coordinated disclosure

We ask reporters to give us a reasonable window to ship a fix before public disclosure — typically **30 days** for non-critical findings, **7 days** for actively exploited issues, negotiable on a per-case basis.

---

## Hall of fame

Acknowledged researchers will be listed here once we receive valid reports.

*(Empty until the first valid report.)*
