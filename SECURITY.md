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

---

## Coordinated disclosure

We ask reporters to give us a reasonable window to ship a fix before public disclosure — typically **30 days** for non-critical findings, **7 days** for actively exploited issues, negotiable on a per-case basis.

---

## Hall of fame

Acknowledged researchers will be listed here once we receive valid reports.

*(Empty until the first valid report.)*
