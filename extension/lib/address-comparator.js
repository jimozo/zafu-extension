// address-comparator.js — chain-aware detection pipeline for pasted addresses
// EVM pipeline:
//   EXCEPTION → MALICIOUS(curated) → FLAGGED(user-reported) → COMMUNITY_REPORTED(cross-user) →
//   SCAM(static) → KNOWN → KNOWN_PUBLIC → SUSPICIOUS_KNOWN → POISONED → SCAM(GoPlus) → UNKNOWN
// Solana pipeline:
//   EXCEPTION → MALICIOUS(curated) → FLAGGED(user-reported) → COMMUNITY_REPORTED(cross-user) →
//   SCAM(blocklist) → SYS_IMPERSONATION → KNOWN_PUBLIC(solana) → KNOWN(trusted) → POISONED → UNKNOWN
// TRON pipeline:
//   EXCEPTION → MALICIOUS(curated) → FLAGGED(user-reported) → COMMUNITY_REPORTED(cross-user) →
//   KNOWN(trusted) → POISONED → UNKNOWN

import { normalizeAddress, detectChainType } from './address-validator.js';
import { getTrusted, getSuspicion, getExceptions, getFlagged, promoteFlaggedToMalicious, getCommunityList, getDisputedAddresses, getAddressIntel } from './storage.js';
import { checkSolanaImpersonation, solanaPoisonedMatch } from './solana-detector.js';
import { auditTrustedIndex } from './self-audit.js';

let knownGoodContractsData = { contracts: [] };
let knownGoodContractsSolanaData = { contracts: [] };
let scamAddressesData = { addresses: [] };
let scamAddressesSolanaData = { addresses: [] };
let maliciousConfirmedData = { addresses: [] };

const dataPromises = Promise.all([
  fetch(chrome.runtime.getURL('data/known-good-contracts.json'))
    .then((r) => r.json())
    .then((data) => { knownGoodContractsData = data; })
    .catch((err) => console.warn('[Zafu] failed to load known-good-contracts:', err)),
  fetch(chrome.runtime.getURL('data/known-good-contracts-solana.json'))
    .then((r) => r.json())
    .then((data) => { knownGoodContractsSolanaData = data; })
    .catch((err) => console.warn('[Zafu] failed to load known-good-contracts-solana:', err)),
  fetch(chrome.runtime.getURL('data/scam-addresses.json'))
    .then((r) => r.json())
    .then((data) => { scamAddressesData = data; })
    .catch((err) => console.warn('[Zafu] failed to load scam-addresses:', err)),
  fetch(chrome.runtime.getURL('data/scam-addresses-solana.json'))
    .then((r) => r.json())
    .then((data) => { scamAddressesSolanaData = data; })
    .catch((err) => console.warn('[Zafu] failed to load scam-addresses-solana:', err)),
  fetch(chrome.runtime.getURL('data/malicious-confirmed.json'))
    .then((r) => r.json())
    .then((data) => { maliciousConfirmedData = data; })
    .catch((err) => console.warn('[Zafu] failed to load malicious-confirmed:', err)),
]);

async function checkGoPlus(normalized) {
  try {
    const cacheKey = `goplus_${normalized}`;
    const cached = await chrome.storage.session.get(cacheKey);
    let flags;
    if (cached[cacheKey] !== undefined) {
      flags = cached[cacheKey];
    } else {
      const res = await fetch(
        `https://api.gopluslabs.io/api/v1/address_security/${normalized}?chain_id=1`
      );
      if (res.ok) {
        const json = await res.json();
        flags = json.result?.[normalized] || {};
        await chrome.storage.session.set({ [cacheKey]: flags });
      }
    }
    const SCAM_FLAGS = ['blacklist_doubt', 'stealing_attack', 'phishing_activities', 'cybercrime', 'sanctioned'];
    return flags && SCAM_FLAGS.some((f) => flags[f] === '1');
  } catch (err) {
    console.warn('[Zafu] GoPlus check failed, continuing:', err);
    return false;
  }
}

function hammingDistance(a, b) {
  if (a.length !== b.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) dist++;
  }
  return dist;
}

/**
 * EVM near-match (prefix6+suffix6 OR Hamming ≤ 2). Unchanged from v1.0.0.
 */
function isEvmNearMatch(pastedAddr, targetAddr) {
  const p = pastedAddr.toLowerCase();
  const t = targetAddr.toLowerCase();

  const p6 = p.slice(0, 6);
  const t6 = t.slice(0, 6);
  const pSuf = p.slice(-6);
  const tSuf = t.slice(-6);
  if (p6 === t6 && pSuf === tSuf) {
    return { isMatch: true, sharedPrefix: p6, sharedSuffix: pSuf };
  }
  if (hammingDistance(p, t) <= 2) {
    return { isMatch: true };
  }
  return { isMatch: false };
}

/**
 * Main comparator. Routes by detected chain type.
 * Returns { state, label?, ensName?, etherscanLabel?, realAddress?, nearMatch?, error? }
 */
export async function compareAddress(pastedAddress) {
  await dataPromises;
  const chainType = detectChainType(pastedAddress);
  const normalized = normalizeAddress(pastedAddress, chainType);

  // 1. EXCEPTION — user manually verified.
  const exceptions = await getExceptions();
  if (exceptions[normalized]) {
    return {
      state: 'KNOWN',
      pastedAddress: normalized,
      label: 'Manually verified',
      ensName: null,
      chainType,
    };
  }

  // 2b. MALICIOUS — team-curated confirmed malicious list (EVM + Solana).
  const maliciousList = maliciousConfirmedData.addresses || [];
  if (maliciousList.includes(normalized)) {
    return { state: 'MALICIOUS', pastedAddress: normalized, source: 'confirmed', chainType };
  }

  // 2c. FLAGGED — user-reported address. Auto-promotes to MALICIOUS via GoPlus (EVM only).
  const flagged = await getFlagged();
  const flaggedEntry = flagged[normalized];
  if (flaggedEntry) {
    if (flaggedEntry.confirmed) {
      return { state: 'MALICIOUS', pastedAddress: normalized, source: 'flagged_confirmed', chainType };
    }
    if (chainType === 'evm') {
      const goPlusConfirms = await checkGoPlus(normalized);
      if (goPlusConfirms) {
        await promoteFlaggedToMalicious(normalized);
        return { state: 'MALICIOUS', pastedAddress: normalized, source: 'flagged_goplus', chainType };
      }
    }
    return { state: 'FLAGGED', pastedAddress: normalized, chainType };
  }

  // 2d. COMMUNITY_REPORTED — cross-user reported addresses above score threshold.
  // These are high-risk signals, not team-confirmed malicious verdicts.
  const communityList = await getCommunityList();
  if (communityList?.addresses?.includes(normalized)) {
    const disputed = await getDisputedAddresses();
    if (disputed[normalized]) {
      return { state: 'COMMUNITY_DISPUTED', pastedAddress: normalized, source: 'community_disputed', chainType };
    }
    return { state: 'COMMUNITY_REPORTED', pastedAddress: normalized, source: 'community', chainType };
  }

  // Branch on chain type for remaining steps.
  if (chainType === 'solana') {
    return compareSolana(normalized);
  }
  if (chainType === 'tron') {
    return compareTron(normalized);
  }
  return compareEvm(normalized);
}

async function compareSolana(normalized) {
  // 3. SCAM — Solana static blocklist.
  const scamList = scamAddressesSolanaData.addresses || [];
  if (scamList.includes(normalized)) {
    return { state: 'SCAM', pastedAddress: normalized, chainType: 'solana' };
  }

  // 3b. SYS_IMPERSONATION — near-match against canonical Solana programs.
  const imp = checkSolanaImpersonation(normalized);
  if (imp) {
    return {
      state: 'POISONED',
      pastedAddress: normalized,
      realAddress: imp.program.id,
      realLabel: `Looks like ${imp.program.label}`,
      sharedPrefix: imp.sharedPrefix,
      sharedSuffix: imp.sharedSuffix,
      chainType: 'solana',
    };
  }

  // 4. KNOWN_PUBLIC — curated canonical Solana programs (case-sensitive match).
  const solanaKnownGood = knownGoodContractsSolanaData.contracts || [];
  const solanaPublicEntry = solanaKnownGood.find((c) => c.address === normalized);
  if (solanaPublicEntry) {
    return {
      state: 'KNOWN_PUBLIC',
      pastedAddress: normalized,
      label: solanaPublicEntry.label,
      chainType: 'solana',
    };
  }

  // 5. KNOWN — exact match in trusted index (from tx-fetch or manual contacts).
  const trusted = await getTrusted();
  const solanaTrustedKeys = Object.keys(trusted).filter((k) => detectChainType(k) === 'solana');

  const riskyIntel = await getAddressIntel(normalized, 'solana');
  if (riskyIntel?.status === 'risky') {
    return { state: 'SCAM', pastedAddress: normalized, source: 'intel', chainType: 'solana' };
  }

  if (trusted[normalized]) {
    const entry = trusted[normalized];
    return {
      state: 'KNOWN',
      pastedAddress: normalized,
      label: entry.label || null,
      etherscanLabel: entry.etherscanLabel || null,
      trustedEntry: trustedEntryEvidence(entry),
      flaggedLookalike: isTrustedLookalikeSuspect(normalized, trusted),
      chainType: 'solana',
    };
  }

  // 6. POISONED — Solana-tuned thresholds (prefix8+suffix8, Hamming ≤ 3).
  const poison = solanaPoisonedMatch(normalized, solanaTrustedKeys);
  if (poison) {
    const real = trusted[poison.realAddress];
    return {
      state: 'POISONED',
      pastedAddress: normalized,
      realAddress: poison.realAddress,
      realLabel: real?.label || real?.etherscanLabel || null,
      sharedPrefix: poison.sharedPrefix,
      sharedSuffix: poison.sharedSuffix,
      chainType: 'solana',
    };
  }

  // GoPlus skipped for Solana (EVM-only schema).

  return { state: 'UNKNOWN', pastedAddress: normalized, chainType: 'solana' };
}

async function compareTron(normalized) {
  const trusted = await getTrusted();
  const trustedEntry = trusted[normalized];
  if (trustedEntry) {
    return {
      state: 'KNOWN',
      pastedAddress: normalized,
      label: trustedEntry.label || null,
      etherscanLabel: trustedEntry.etherscanLabel || null,
      trustedEntry: trustedEntryEvidence(trustedEntry),
      flaggedLookalike: isTrustedLookalikeSuspect(normalized, trusted),
      chainType: 'tron',
    };
  }

  for (const addr of Object.keys(trusted)) {
    if (detectChainType(addr) !== 'tron') continue;
    const match = isBase58NearMatch(normalized, addr);
    if (match.isMatch) {
      return {
        state: 'POISONED',
        pastedAddress: normalized,
        realAddress: addr,
        realLabel: trusted[addr].label || trusted[addr].etherscanLabel,
        sharedPrefix: match.sharedPrefix,
        sharedSuffix: match.sharedSuffix,
        chainType: 'tron',
      };
    }
  }

  return { state: 'UNKNOWN', pastedAddress: normalized, chainType: 'tron' };
}

async function compareEvm(normalized) {
  // 3. SCAM — bundled EVM scam list.
  const scamList = scamAddressesData.addresses || [];
  if (scamList.includes(normalized)) {
    return { state: 'SCAM', pastedAddress: normalized, chainType: 'evm' };
  }

  const [trusted, suspicion] = await Promise.all([getTrusted(), getSuspicion()]);

  const riskyIntel = await getAddressIntel(normalized);
  if (riskyIntel?.status === 'risky') {
    return { state: 'SCAM', pastedAddress: normalized, source: 'intel', chainType: 'evm' };
  }

  // 4. KNOWN — exact match in trusted index.
  const trustedEntry = trusted[normalized];
  if (trustedEntry) {
    return {
      state: 'KNOWN',
      pastedAddress: normalized,
      label: trustedEntry.label || null,
      etherscanLabel: trustedEntry.etherscanLabel || null,
      ensName: trustedEntry.ensName || null,
      txCount: trustedEntry.txCount,
      trustedEntry: trustedEntryEvidence(trustedEntry),
      flaggedLookalike: isTrustedLookalikeSuspect(normalized, trusted),
      chainType: 'evm',
    };
  }

  // 5. KNOWN_PUBLIC — curated major DeFi contracts.
  const knownGood = knownGoodContractsData.contracts || [];
  const publicEntry = knownGood.find((c) => c.address === normalized);
  if (publicEntry) {
    return {
      state: 'KNOWN_PUBLIC',
      pastedAddress: normalized,
      label: publicEntry.label,
      chainType: 'evm',
    };
  }

  // 6. SUSPICIOUS_KNOWN.
  const suspicionEntry = suspicion[normalized];
  if (suspicionEntry) {
    return {
      state: 'SUSPICIOUS_KNOWN',
      pastedAddress: normalized,
      reason: suspicionEntry.reason,
      chainType: 'evm',
    };
  }

  // 7. POISONED — EVM near-match against trusted + known-good.
  for (const addr of Object.keys(trusted)) {
    // Skip non-EVM keys; different thresholds + case rules apply.
    if (detectChainType(addr) !== 'evm') continue;
    const match = isEvmNearMatch(normalized, addr);
    if (match.isMatch) {
      return {
        state: 'POISONED',
        pastedAddress: normalized,
        realAddress: addr,
        realLabel: trusted[addr].label || trusted[addr].etherscanLabel,
        sharedPrefix: match.sharedPrefix,
        sharedSuffix: match.sharedSuffix,
        chainType: 'evm',
      };
    }
  }

  for (const contract of knownGood) {
    const match = isEvmNearMatch(normalized, contract.address);
    if (match.isMatch) {
      return {
        state: 'POISONED',
        pastedAddress: normalized,
        realAddress: contract.address,
        realLabel: contract.label,
        sharedPrefix: match.sharedPrefix,
        sharedSuffix: match.sharedSuffix,
        chainType: 'evm',
      };
    }
  }

  // 8. GoPlus runtime check — EVM only.
  const goPlusConfirms = await checkGoPlus(normalized);
  if (goPlusConfirms) {
    // Auto-report to community pool: GoPlus confirmation = 10pts, instant threshold breach.
    chrome.runtime.sendMessage({
      type: 'SUBMIT_COMMUNITY_REPORT',
      address: normalized,
      chain: 'evm',
      source: 'goplus_autoconfirm',
    }).catch(() => {});
    return { state: 'SCAM', pastedAddress: normalized, source: 'goplus', chainType: 'evm' };
  }

  return { state: 'UNKNOWN', pastedAddress: normalized, chainType: 'evm' };
}

function trustedEntryEvidence(entry = {}) {
  return {
    address: entry.address || null,
    label: entry.label || null,
    etherscanLabel: entry.etherscanLabel || null,
    ensName: entry.ensName || null,
    asset: entry.asset || null,
    network: entry.network || null,
    chainId: entry.chainId || null,
    chains: Array.isArray(entry.chains) ? entry.chains.slice(0, 8) : [],
    networkConfidence: entry.networkConfidence || 'unknown',
    dominantStablecoinAsset: entry.dominantStablecoinAsset || null,
    dominantStablecoinNetwork: entry.dominantStablecoinNetwork || null,
    dominantStablecoinTransferCount: Number(entry.dominantStablecoinTransferCount || 0),
    historyFromSync: entry.historyFromSync === true,
    lastConfirmedSendAt: entry.lastConfirmedSendAt || null,
    enrichmentStatus: entry.enrichmentStatus || null,
    sourceNote: entry.sourceNote || '',
    memoNote: entry.memoNote || '',
    timesSeen: Number(entry.timesSeen || entry.txCount || 0),
  };
}

function isTrustedLookalikeSuspect(address, trusted) {
  const key = String(address || '').toLowerCase();
  return auditTrustedIndex(trusted).some((flag) => String(flag.suspectAddress || '').toLowerCase() === key);
}

function isBase58NearMatch(pastedAddr, targetAddr) {
  const p6 = pastedAddr.slice(0, 6);
  const t6 = targetAddr.slice(0, 6);
  const pSuf = pastedAddr.slice(-6);
  const tSuf = targetAddr.slice(-6);
  if (p6 === t6 && pSuf === tSuf) {
    return { isMatch: true, sharedPrefix: p6, sharedSuffix: pSuf };
  }
  if (hammingDistance(pastedAddr, targetAddr) <= 2) {
    return { isMatch: true };
  }
  return { isMatch: false };
}
