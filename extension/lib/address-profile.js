import {
  getAddressIntelIndex,
  getSuspicion,
  getTrusted,
  getWallets,
  normalizeKey,
  setAddressIntel,
} from './storage.js';
import { CHAIN_NATIVE, fetchAddressActivity, fetchBalance, fetchContractInfo } from './etherscan-client.js';
import { reverseResolveAddress } from './ens-client.js';
import { fetchSolanaActivity, fetchSolanaBalance } from './solscan-client.js';
import { fetchGoPlusAddressRisk } from './goplus-client.js';
import { fetchTronAccountIntel } from './tronscan-client.js';

const CACHE_KEY = 'addressProfileCache';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 250;
const EVM_CHAIN_ALIASES = {
  evm: 1,
  eth: 1,
  ethereum: 1,
  mainnet: 1,
  polygon: 137,
  matic: 137,
  arbitrum: 42161,
  'arbitrum one': 42161,
  base: 8453,
  optimism: 10,
  op: 10,
  bnb: 56,
  bsc: 56,
  'bnb chain': 56,
  tron: 'tron',
  trx: 'tron',
};

export function buildLocalAddressProfile({
  address,
  chainId = null,
  trustedEntry = null,
  suspicionEntry = null,
  protectedWallet = null,
  settings = {},
} = {}) {
  if (!address) throw new Error('address is required');

  const normalized = normalizeKey(address);
  const trust = protectedWallet
    ? 'protected_wallet'
    : trustedEntry
      ? 'trusted_contact'
      : suspicionEntry
        ? 'suspicious'
        : 'unknown';
  const sourceEntry = protectedWallet || trustedEntry || suspicionEntry || {};
  const labels = [];

  if (protectedWallet?.label) labels.push(sourceLabel(protectedWallet.label, 'local_wallet'));
  if (trustedEntry?.label) labels.push(sourceLabel(trustedEntry.label, 'local_contact'));
  if (trustedEntry?.ensName) labels.push(sourceLabel(trustedEntry.ensName, 'ens_cache'));
  if (trustedEntry?.etherscanLabel) labels.push(sourceLabel(trustedEntry.etherscanLabel, 'etherscan_history'));

  return {
    address: normalized,
    displayAddress: address,
    chainId: normalizeProfileChainId(chainId || sourceEntry.chainId || sourceEntry.primaryChainId || firstChain(sourceEntry.chains)),
    trust,
    labels,
    activity: {
      txCount: sourceEntry.txCount || null,
      firstSeen: sourceEntry.firstSeen || null,
      lastSeen: sourceEntry.lastSeen || protectedWallet?.lastFetchedAt || null,
      source: sourceEntry.txCount || sourceEntry.firstSeen || sourceEntry.lastSeen ? 'local_history' : null,
    },
    protectedWalletId: protectedWallet?.id || null,
    originWallets: trustedEntry?.originWallets || suspicionEntry?.originWallets || [],
    suspicionReason: suspicionEntry?.reason || null,
    manuallyAdded: sourceEntry.manuallyAdded === true,
    explorerKeyAvailability: {
      etherscan: !!settings.etherscanApiKey,
      solscan: !!settings.solscanApiKey,
      tron: !!settings.tronApiKey,
    },
    sources: ['local'],
    updatedAt: Date.now(),
  };
}

export async function getCachedAddressProfile(address, chainId = 'unknown') {
  const cache = await getCache();
  const entry = cache[cacheKey(address, chainId)];
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) return null;
  return entry.profile;
}

export async function setCachedAddressProfile(address, chainId = 'unknown', profile) {
  const cache = await getCache();
  cache[cacheKey(address, chainId)] = {
    profile,
    cachedAt: Date.now(),
  };
  await setCache(pruneCache(cache));
  return profile;
}

export async function enrichAddressProfile(profile, settings = {}) {
  const chainId = normalizeProfileChainId(profile.chainId) || 'unknown';
  const address = profile.displayAddress || profile.address;
  if (chainId === 'tron') {
    const tronKey = settings.tronApiKey;
    if (!tronKey) {
      return withExplorer(profile, {
        status: 'locked',
        source: 'tronscan',
        updatedAt: Date.now(),
      });
    }
    try {
      const acct = await fetchTronAccountIntel(address, tronKey);
      return withExplorer(profile, {
        status: 'ok',
        source: 'tronscan',
        balance: acct.balanceTrx,
        contract: {
          type: acct.isContract ? 'Contract' : 'EOA',
          isContract: acct.isContract,
          verified: null,
          contractName: null,
          source: 'tronscan',
        },
        risk: null,
        activity: {
          txCount: acct.txCount,
          firstSeen: acct.firstSeen,
          source: 'tronscan',
        },
        nativeSymbol: 'TRX',
        updatedAt: Date.now(),
      });
    } catch (err) {
      return withExplorer(profile, {
        status: 'error',
        source: 'tronscan',
        error: err?.message || 'Tronscan refresh failed',
        updatedAt: Date.now(),
      });
    }
  }
  const source = chainId === 'solana' ? 'solscan' : 'etherscan';
  const apiKey = source === 'solscan' ? settings.solscanApiKey : settings.etherscanApiKey;

  if (!apiKey) {
    return withExplorer(profile, {
      status: 'locked',
      source,
      updatedAt: Date.now(),
    });
  }

  try {
    const chain = chainId === 'unknown' ? 1 : chainId;
    const checks = source === 'solscan'
      ? await Promise.allSettled([
        fetchSolanaBalance(address, apiKey),
        fetchSolanaActivity(address, apiKey),
      ])
      : await Promise.allSettled([
        fetchBalance(address, apiKey, chain),
        fetchContractInfo(address, apiKey, chain),
        fetchGoPlusAddressRisk(address),
        fetchAddressActivity(address, apiKey, chain),
        chain === 1 ? reverseResolveAddress(address, apiKey) : Promise.resolve(null),
      ]);
    const balance = settledValue(checks[0], null);
    const contract = source === 'etherscan' ? settledValue(checks[1], null) : null;
    const risk = source === 'etherscan' ? settledValue(checks[2], null) : null;
    const activity = source === 'solscan' ? settledValue(checks[1], null) : settledValue(checks[3], null);
    const domain = source === 'etherscan' ? settledValue(checks[4], null) : null;
    if (balance === null && !contract && !risk && !activity && !domain) {
      throw new Error(checks.find((item) => item.status === 'rejected')?.reason?.message || 'Explorer refresh failed');
    }
    return withExplorer(profile, {
      status: 'ok',
      source,
      balance,
      contract,
      risk,
      activity,
      domain: domain ? { name: domain, protocol: 'ens', source: 'etherscan' } : null,
      nativeSymbol: source === 'solscan' ? 'SOL' : (CHAIN_NATIVE[chain] || 'ETH'),
      updatedAt: Date.now(),
    });
  } catch (err) {
    return withExplorer(profile, {
      status: 'error',
      source,
      error: err?.message || 'Explorer refresh failed',
      updatedAt: Date.now(),
    });
  }
}

export async function persistAddressIntel(profile) {
  if (!profile?.intel) return null;
  return setAddressIntel(profile.address, profile.chainId, profile.intel);
}

// Rough per-address API-call counts by chain family, from enrichAddressProfile:
// EVM ~6 (balance, contract code, getsourcecode, GoPlus, txlist×2, optional ENS),
// Solana ~2 (balance, transfers), TRON ~1 (account intel). Used only to show users the
// approximate cost of a run — not an exact accounting.
const PER_ADDRESS_CALLS = { solana: 2, tron: 1, evm: 6 };
// ~enrich latency + the 350ms inter-address throttle below.
const PER_ADDRESS_SECONDS = 1.1;

function callsForChain(chainId) {
  if (chainId === 'solana') return PER_ADDRESS_CALLS.solana;
  if (chainId === 'tron') return PER_ADDRESS_CALLS.tron;
  return PER_ADDRESS_CALLS.evm;
}

// Build the candidate Intel jobs for a source. `include` selects which address sets to pull:
// 'trusted' (saved recipients), 'wallets' (wallet-history), 'suspicious' (flagged inbound).
async function collectIntelJobs(source, include) {
  const wanted = new Set(include);
  const [intelIndex, trusted, wallets, suspicion] = await Promise.all([
    getAddressIntelIndex(),
    wanted.has('trusted') ? getTrusted() : Promise.resolve({}),
    wanted.has('wallets') ? getWallets() : Promise.resolve([]),
    wanted.has('suspicious') ? getSuspicion() : Promise.resolve({}),
  ]);
  const jobs = [];
  const seen = new Set();

  for (const entry of Object.values(trusted)) {
    addIntelJob(jobs, seen, {
      address: entry.address,
      chainId: entry.chainId || firstChain(entry.chains),
      trustedEntry: entry,
    }, source);
  }

  for (const wallet of wallets) {
    addIntelJob(jobs, seen, {
      address: wallet.address,
      chainId: wallet.primaryChainId || wallet.chainId || firstChain(wallet.chains),
      protectedWallet: wallet,
    }, source);
  }

  for (const entry of Object.values(suspicion)) {
    addIntelJob(jobs, seen, {
      address: entry.address,
      chainId: entry.chainId || firstChain(entry.chains),
      suspicionEntry: entry,
    }, source);
  }

  return { jobs, intelIndex };
}

// Only enrich addresses that don't already have successful Intel. Re-running the whole list
// every time wastes the user's explorer quota; the per-address "Refresh Intel" button still
// forces a redo when a specific address needs re-checking. Successful Intel is stored as
// 'clear' (or 'risky'); 'error'/'locked'/'needs_key' stay re-runnable.
function pendingIntelJobs(jobs, intelIndex) {
  return jobs.filter((job) => {
    const rec = intelIndex[`${normalizeKey(job.address)}:${String(job.chainId)}`];
    return !(rec && (rec.status === 'clear' || rec.status === 'risky'));
  });
}

// Estimate the cost of a run without launching it, so the run modal can show the user how many
// addresses would be reviewed, the approximate API calls, and the approximate time.
export async function estimateIntelCost(source = 'etherscan', { include = ['trusted', 'wallets'] } = {}) {
  const { jobs, intelIndex } = await collectIntelJobs(source, include);
  const pending = pendingIntelJobs(jobs, intelIndex);
  const calls = pending.reduce((sum, job) => sum + callsForChain(job.chainId), 0);
  const seconds = Math.ceil(pending.length * PER_ADDRESS_SECONDS);
  return { pending: pending.length, total: jobs.length, calls, seconds };
}

export async function runBulkAddressIntel(settings = {}, source = 'etherscan', onProgress = () => {}, { include = ['trusted', 'wallets'] } = {}) {
  const { jobs, intelIndex } = await collectIntelJobs(source, include);
  const pending = pendingIntelJobs(jobs, intelIndex);
  const skipped = jobs.length - pending.length;

  let completed = 0;
  let risky = 0;
  let failed = 0;

  for (const job of pending) {
    completed += 1;
    onProgress({ phase: 'running', completed, total: pending.length, address: job.address });
    const localProfile = buildLocalAddressProfile({ ...job, settings });
    const enriched = await enrichAddressProfile(localProfile, settings);
    await setCachedAddressProfile(job.address, localProfile.chainId, enriched);
    await persistAddressIntel(enriched);
    if (enriched.intel?.status === 'risky') risky += 1;
    if (enriched.intel?.status === 'error') failed += 1;
    await sleep(350);
  }

  onProgress({ phase: 'done', completed, total: pending.length, risky, failed, skipped });
  return { total: pending.length, completed, risky, failed, skipped };
}

function settledValue(result, fallback) {
  return result?.status === 'fulfilled' ? result.value : fallback;
}

export async function clearCachedAddressProfile(address, chainId = null) {
  const cache = await getCache();
  const normalized = normalizeKey(address);
  for (const key of Object.keys(cache)) {
    if (chainId === null ? key.startsWith(`${normalized}:`) : key === cacheKey(normalized, chainId)) {
      delete cache[key];
    }
  }
  await setCache(cache);
}

function sourceLabel(value, source) {
  return { value, source };
}

function withExplorer(profile, explorer) {
  const intel = buildIntelRecord(profile, explorer);
  return {
    ...profile,
    explorer,
    intel,
    sources: [...new Set([...(profile.sources || []), explorer.source])],
    updatedAt: Date.now(),
  };
}

function buildIntelRecord(profile, explorer) {
  const reviewedAt = explorer.updatedAt || Date.now();
  const chainId = normalizeProfileChainId(profile.chainId) || 'unknown';
  const risk = explorer.risk || null;
  const contract = explorer.contract || null;
  const activity = buildActivityIntel(profile, explorer);
  const identity = buildIdentityIntel(profile, explorer);
  const recipient = buildRecipientIntel(profile, activity);
  const status = explorer.status === 'error'
    ? 'error'
    : risk?.status === 'risky'
      ? 'risky'
      : 'clear';
  return {
    address: profile.address,
    chainId: String(chainId),
    reviewedAt,
    source: explorer.source,
    status,
    verdict: intelVerdict({ status, risk, contract, balance: explorer.balance }),
    risk,
    identity,
    activity,
    recipient,
    explorer: {
      balance: explorer.balance,
      nativeSymbol: explorer.nativeSymbol,
      contract,
      domain: explorer.domain || null,
      error: explorer.error || null,
    },
  };
}

function buildIdentityIntel(profile, explorer) {
  const contract = explorer.contract || null;
  const domain = explorer.domain || null;
  const labels = [...(profile.labels || [])];
  if (domain?.name) labels.push(sourceLabel(domain.name, domain.protocol || 'domain'));
  if (contract?.contractName) labels.push(sourceLabel(contract.contractName, 'verified_contract'));
  return {
    labels,
    primaryLabel: labels[0]?.value || contract?.contractName || domain?.name || null,
    domain,
    entityType: contract?.isContract ? 'contract' : contract && contract.isContract === false ? 'eoa' : 'unknown',
    contractName: contract?.contractName || null,
    contractVerified: contract?.verified ?? null,
  };
}

function buildActivityIntel(profile, explorer) {
  const local = profile.activity || {};
  const remote = explorer.activity || {};
  const txCount = firstNumber(local.txCount, remote.txCount);
  return {
    txCount,
    txCountCapped: !!remote.txCountCapped,
    firstSeen: firstTimestamp(local.firstSeen, remote.firstSeen),
    lastSeen: firstTimestamp(local.lastSeen, remote.lastSeen),
    recent24h: firstNumber(remote.recent24h, null),
    recent7d: firstNumber(remote.recent7d, null),
    activityLevel: remote.activityLevel || localActivityLevel(txCount),
    source: remote.source || local.source || null,
  };
}

function buildRecipientIntel(profile, activity) {
  const knownLocally = profile.trust === 'trusted_contact' || profile.trust === 'protected_wallet';
  const hasLocalHistory = !!(profile.activity?.txCount || profile.activity?.firstSeen || profile.activity?.lastSeen);
  return {
    firstTimeRecipient: !knownLocally && !hasLocalHistory,
    locallyKnown: knownLocally,
    localHistory: hasLocalHistory,
    manuallyAdded: profile.manuallyAdded === true,
    summary: knownLocally
      ? 'Known in your Zafu recipient memory'
      : hasLocalHistory
        ? 'Seen in your wallet history'
        : 'First-time recipient in this Zafu profile',
    ageDays: activity.firstSeen ? Math.max(0, Math.floor((Date.now() - activity.firstSeen) / (24 * 60 * 60 * 1000))) : null,
  };
}

function intelVerdict({ status, risk, contract, balance }) {
  if (status === 'risky') return risk?.summary || 'Risk flagged';
  if (status === 'error') return 'Review failed';
  if (contract?.isContract) return contract.verified ? 'Verified contract' : 'Unverified contract';
  if (contract && contract.isContract === false) return 'EOA';
  if (typeof balance === 'number') return 'Balance checked';
  return 'No risk found';
}

function firstNumber(...values) {
  return values.find((value) => Number.isFinite(value)) ?? null;
}

function firstTimestamp(...values) {
  return values.find((value) => Number.isFinite(value) && value > 0) ?? null;
}

function localActivityLevel(txCount) {
  if (!Number.isFinite(txCount) || txCount <= 0) return 'none';
  if (txCount >= 50) return 'high';
  if (txCount >= 10) return 'medium';
  return 'low';
}

function addIntelJob(jobs, seen, job, source) {
  const chainId = normalizeProfileChainId(job.chainId) || 'unknown';
  if (source === 'solscan' && chainId !== 'solana') return;
  if (source === 'tronscan' && chainId !== 'tron') return;
  if (source === 'etherscan' && (chainId === 'solana' || chainId === 'tron')) return;
  const key = `${normalizeKey(job.address)}:${String(chainId)}`;
  if (seen.has(key)) return;
  seen.add(key);
  jobs.push({ ...job, chainId });
}

function firstChain(chains) {
  return Array.isArray(chains) && chains.length ? chains[0] : null;
}

function normalizeProfileChainId(chainId) {
  if (!chainId) return null;
  if (chainId === 'solana') return 'solana';
  if (typeof chainId === 'number' && Number.isFinite(chainId)) return chainId;
  const raw = String(chainId).trim();
  if (!raw) return null;
  if (raw.toLowerCase() === 'solana') return 'solana';
  if (/^\d+$/.test(raw)) return Number(raw);
  return EVM_CHAIN_ALIASES[raw.toLowerCase()] || raw;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheKey(address, chainId) {
  return `${normalizeKey(address)}:${String(chainId || 'unknown')}`;
}

async function getCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get(CACHE_KEY, (result) => resolve(result[CACHE_KEY] || {}));
  });
}

async function setCache(cache) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CACHE_KEY]: cache }, resolve);
  });
}

function pruneCache(cache) {
  const entries = Object.entries(cache);
  if (entries.length <= CACHE_MAX_ENTRIES) return cache;
  entries.sort((a, b) => (a[1].cachedAt || 0) - (b[1].cachedAt || 0));
  for (const [key] of entries.slice(0, entries.length - CACHE_MAX_ENTRIES)) {
    delete cache[key];
  }
  return cache;
}
