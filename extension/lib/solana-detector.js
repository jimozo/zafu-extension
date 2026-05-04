// solana-detector.js — Solana-specific paste-time heuristics.
//
// Covers two attack classes from SolPhishHunter (arxiv 2505.04094):
//   (1) System-account impersonation (41% of phishing in H1 2024) — vanity-grind addresses
//       resembling canonical Solana programs.
//   (2) Generic address poisoning via vanity grind — tighter thresholds than EVM because
//       base58 entropy per char is higher (58 vs 16) and solana-keygen grind routinely
//       produces 8+ char prefix collisions.
//
// Pure functions, no I/O. Case-sensitive throughout (base58 must not be lowercased).

/**
 * Canonical Solana programs commonly impersonated by vanity-grind attacks.
 * Kept small and stable — these program IDs do not change across mainnet upgrades.
 */
export const SYSTEM_PROGRAMS = [
  { id: '11111111111111111111111111111111', label: 'System Program' },
  { id: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', label: 'SPL Token' },
  { id: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', label: 'SPL Token-2022' },
  { id: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', label: 'Associated Token Account' },
  { id: 'ComputeBudget111111111111111111111111111111', label: 'Compute Budget' },
  { id: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', label: 'Memo' },
  { id: 'Stake11111111111111111111111111111111111111', label: 'Stake Program' },
  { id: 'Vote111111111111111111111111111111111111111', label: 'Vote Program' },
  { id: 'BPFLoaderUpgradeab1e11111111111111111111111', label: 'BPF Loader Upgradeable' },
  { id: 'SysvarRent111111111111111111111111111111111', label: 'Rent Sysvar' },
];

/**
 * Hamming distance between two equal-length strings. Infinity if lengths differ.
 * Case-sensitive — safe for base58.
 */
export function hammingDistance(a, b) {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/**
 * Near-match for Solana addresses. Tighter thresholds than EVM:
 *   - prefix8 + suffix8 collision (vanity grinders produce 8-char prefixes routinely)
 *   - Hamming distance ≤ 3 on same-length addresses
 */
export function isSolanaNearMatch(a, b) {
  if (a === b) return { isMatch: false };

  const pPre = a.slice(0, 8);
  const tPre = b.slice(0, 8);
  const pSuf = a.slice(-8);
  const tSuf = b.slice(-8);
  if (pPre === tPre && pSuf === tSuf) {
    return { isMatch: true, sharedPrefix: pPre, sharedSuffix: pSuf };
  }

  if (hammingDistance(a, b) <= 3) {
    return { isMatch: true };
  }

  return { isMatch: false };
}

/**
 * Check whether a pasted address impersonates a canonical system program.
 * Returns { match, program, sharedPrefix?, sharedSuffix? } or null.
 *
 * Exact match returns null — exact system programs are legitimate; only near-matches
 * are phishing.
 */
export function checkSolanaImpersonation(address) {
  for (const prog of SYSTEM_PROGRAMS) {
    if (address === prog.id) return null; // exact = legit
    const m = isSolanaNearMatch(address, prog.id);
    if (m.isMatch) {
      return {
        match: true,
        program: prog,
        sharedPrefix: m.sharedPrefix,
        sharedSuffix: m.sharedSuffix,
      };
    }
  }
  return null;
}

/**
 * Near-match the pasted address against a list of trusted addresses (book + exceptions).
 * Returns { match, realAddress, sharedPrefix?, sharedSuffix? } or null.
 */
export function solanaPoisonedMatch(pastedAddress, trustedAddrList) {
  for (const addr of trustedAddrList) {
    const m = isSolanaNearMatch(pastedAddress, addr);
    if (m.isMatch) {
      return {
        match: true,
        realAddress: addr,
        sharedPrefix: m.sharedPrefix,
        sharedSuffix: m.sharedSuffix,
      };
    }
  }
  return null;
}
