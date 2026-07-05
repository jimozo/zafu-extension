# Contributing to ZAFU Extension

Thanks for helping improve ZAFU. This repository is the public source for the Chrome extension trust surface. The full product is developed in a private monorepo, so contribution intake is intentionally narrow at launch.

## What We Review

Good launch-stage contributions are focused and easy to verify:

- Bug reports with exact reproduction steps
- Documentation fixes
- Scam address reports with external evidence
- Security findings sent privately to `security@stayzafu.com`
- Small patches that preserve the current extension architecture
- Forks that demonstrate real-world value and may justify an upstream invitation

Feature requests belong at https://stayzafu.com/feedback.

## Security First

Do not open public issues or PRs for vulnerabilities.

Email `security@stayzafu.com` with:

- Affected version or fingerprint
- Steps to reproduce
- Impact assessment
- Proof of concept, screenshots, or recording if available

Security-sensitive work may be reviewed privately before any public credit or upstream merge.

## Pull Request Rules

This repo is not broad PR intake. Maintainers may close PRs that are too large, speculative, or outside the extension trust surface.

If you open a PR:

- Keep it focused to one behavior or doc fix
- Explain the user/security impact
- Include tests or manual verification steps
- Do not add dependencies without maintainer approval
- Do not add telemetry, analytics, remote scripts, or tracking
- Do not expand Chrome permissions without strong justification
- Do not touch private keys, seed phrases, signing flows, wallet APIs, or proactive clipboard reads
- Preserve MV3, strict CSP, and zero-build vanilla JS constraints

Maintainers may decline technically valid changes to preserve product coherence or reduce security risk.

## Forks

Forks are allowed under MIT. A fork that proves real-world value may be recognized and may lead to an invitation for a focused upstream contribution.

Recognition is discretionary. Popularity is not merge approval. Security, user safety, maintainability, and architectural fit matter more than stars or social attention.

See [FORKS.md](FORKS.md) for the future recognition protocol.
