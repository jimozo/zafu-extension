# Fork Recognition Protocol

ZAFU is MIT licensed. Forks are welcome.

At launch, this protocol is intentionally lightweight: build something real first, then tell us. There is no DAO, no voting, no token, and no automatic merge path.

## Recognition Principle

Signal from behavior beats stated preference.

A fork used by real people, deployed by a team, or proven to improve wallet safety is stronger evidence than a poll or comment thread.

## What May Qualify

A fork may be reviewed when it demonstrates value beyond cosmetic changes:

- Better address-poisoning or clipboard-hijack detection
- Meaningful false-positive or false-negative reduction
- Safer chain support
- Accessibility or UX improvements that help users verify addresses
- Security fixes or bypass reductions
- Responsible deployments with real users

## Signal Categories

Maintainers may consider:

- **Security impact:** does it make address verification safer?
- **Real-world usage:** are real users or teams relying on it?
- **Technical value:** is the delta useful, focused, and compatible with ZAFU?
- **Maintenance quality:** is the fork understandable, tested, and responsibly maintained?
- **Community signal:** are credible users, developers, or security teams discussing it?

Security impact and real usage weigh more than stars.

## Disqualifiers

A fork is not eligible for recognition if it:

- Adds undisclosed telemetry or tracking
- Expands permissions without strong justification
- Touches private keys, seed phrases, signing flows, or wallet APIs
- Obfuscates source
- Misrepresents itself as official ZAFU
- Publishes exploit details without coordinated disclosure
- Uses fake adoption metrics
- Encourages unsafe crypto behavior

## Review Path

1. Maintainers discover or receive a fork nomination.
2. Maintainers review the fork delta, not the whole codebase.
3. Security-sensitive changes may move to private review.
4. Maintainers may invite a focused upstream PR or patch.
5. If the upstream contribution merges, the author may be permanently recognized.

Recognition does not guarantee that all fork changes will merge.

## Hall of Zafuers

The Hall of Zafuers will start only after the first recognized fork or security contribution.

Entries will be chronological, not ranked:

```markdown
## YYYY-MM-DD — Contributor Name

**Fork:** owner/repo-name
**Contributor:** Name or handle
**What they built:** One-sentence description
**Why it mattered:** Short user or security impact
**Signal at recognition:** Evidence summary
**Upstreamed via:** PR or patch link
**Reviewed by:** Maintainer name
**Status:** Merged / Partially merged / Recognized security contribution

Short note describing the contribution in plain language.
```
