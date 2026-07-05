// self-audit.js — Cross-index near-match scan
//
// Runs the poisoning detection algorithm across the user's own trusted index.
// Chain-aware: EVM uses prefix6+suffix6; Solana uses prefix8+suffix8 (44-char base58,
// vanity-grind produces longer shared prefixes than 40-char hex).
//
// Called once after the first history fetch, surfaces findings in the onboarding screen.

import { isSolanaAddress } from './address-validator.js';
import { solanaPoisonedMatch } from './solana-detector.js';

const EVM_PREFIX_LEN = 6;
const EVM_SUFFIX_LEN = 6;

/**
 * Scan the trusted index for near-match pairs.
 *
 * @param {Object} trusted - The trusted index from storage: { [addr]: metadata }
 * @returns {Array} - Array of { suspectAddress, realAddress, sharedPrefix, sharedSuffix, ... }
 */
export function auditTrustedIndex(trusted) {
  const entries = Object.values(trusted);
  const flagged = [];
  const seen = new Set();

  // Split by chain to avoid cross-chain comparison noise
  const evmEntries = entries.filter((e) => !isSolanaAddress(e.address));
  const solanaEntries = entries.filter((e) => isSolanaAddress(e.address));

  // --- EVM pairs: prefix6+suffix6 ---
  for (let i = 0; i < evmEntries.length; i++) {
    for (let j = i + 1; j < evmEntries.length; j++) {
      const a = evmEntries[i].address.toLowerCase();
      const b = evmEntries[j].address.toLowerCase();
      if (a === b) continue;

      const aPrefix = a.slice(0, EVM_PREFIX_LEN);
      const aSuffix = a.slice(-EVM_SUFFIX_LEN);
      const bPrefix = b.slice(0, EVM_PREFIX_LEN);
      const bSuffix = b.slice(-EVM_SUFFIX_LEN);

      if (aPrefix === bPrefix && aSuffix === bSuffix) {
        const aTxCount = evmEntries[i].txCount || 0;
        const bTxCount = evmEntries[j].txCount || 0;
        const suspect = aTxCount <= bTxCount ? evmEntries[i] : evmEntries[j];
        const real = aTxCount <= bTxCount ? evmEntries[j] : evmEntries[i];
        const pairKey = [a, b].sort().join(':');
        if (!seen.has(pairKey)) {
          seen.add(pairKey);
          flagged.push({
            suspectAddress: suspect.address,
            realAddress: real.address,
            sharedPrefix: aPrefix,
            sharedSuffix: aSuffix,
            suspectTxCount: suspect.txCount || 0,
            realTxCount: real.txCount || 0,
            suspectLastSeen: suspect.lastSeen,
            chain: 'evm',
          });
        }
      }
    }
  }

  // --- Solana pairs: prefix8+suffix8 OR Hamming ≤ 3 (case-sensitive) ---
  const solanaKeys = solanaEntries.map((e) => e.address);
  for (let i = 0; i < solanaEntries.length; i++) {
    const address = solanaEntries[i].address;
    // Check this address against all others (solanaPoisonedMatch compares 1 vs many)
    const othersKeys = solanaKeys.filter((_, idx) => idx !== i);
    const match = solanaPoisonedMatch(address, othersKeys);
    if (match) {
      const pairKey = [address, match.realAddress].sort().join(':');
      if (!seen.has(pairKey)) {
        seen.add(pairKey);
        const realEntry = trusted[match.realAddress];
        const aTxCount = solanaEntries[i].txCount || 0;
        const bTxCount = (realEntry && realEntry.txCount) || 0;
        const suspect = aTxCount <= bTxCount ? solanaEntries[i] : realEntry;
        const real = aTxCount <= bTxCount ? realEntry : solanaEntries[i];
        flagged.push({
          suspectAddress: suspect ? suspect.address : address,
          realAddress: real ? real.address : match.realAddress,
          sharedPrefix: match.sharedPrefix,
          sharedSuffix: match.sharedSuffix,
          suspectTxCount: aTxCount,
          realTxCount: bTxCount,
          suspectLastSeen: solanaEntries[i].lastSeen,
          chain: 'solana',
        });
      }
    }
  }

  return flagged;
}
