// storage.js — chrome.storage.local abstraction for Zafu
//
// Schema:
//   wallets: [{ id, address, label, addedAt, lastFetchedAt }]
//   trusted: { [normalizeKey(address)]: { address, label, chains, txCount, firstSeen, lastSeen, etherscanLabel, ensName } }
//   suspicion: { [normalizeKey(address)]: { address, reason, chains, firstSeen, lastSeen } }
//   exceptions: { [normalizeKey(address)]: { markedSafeAt } }
//   settings: { etherscanApiKey, solscanApiKey, firstFetchDone, guardianMode, communityThreatSignals } // guardianMode = Transfer Check toggle
//   flagged: { [normalizeKey(address)]: { chain, timestamp, confirmed } }
//   addressIntel: { [normalizeKey(address):chainId]: { address, chainId, reviewedAt, status, verdict, source, risk, explorer } } // local-only, never synced
//   networkMetricsDaily: { days: { [YYYY-MM-DD]: counts } } // anonymous aggregate counts; sent only when settings.networkMode === true. Multi-day so rollover does not lose unflushed buckets. Capped to NETWORK_METRICS_MAX_DAYS entries.

// EVM hex addresses are lowercased; Solana base58 keys are case-preserving.
export function normalizeKey(address) {
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : address;
}

const KEYS = {
  WALLETS: 'wallets',
  TRUSTED: 'trusted',
  SUSPICION: 'suspicion',
  EXCEPTIONS: 'exceptions',
  SETTINGS: 'settings',
  FLAGGED: 'flagged',
  ADDRESS_INTEL: 'addressIntel',
  NETWORK_METRICS_DAILY: 'networkMetricsDaily',
};

const SYNC_DIRTY_KEY = 'syncDirty';
const SYNC_DELETED_CONTACTS_KEY = 'syncDeletedContacts';
const SYNC_DELETED_WALLETS_KEY = 'syncDeletedWallets';

async function get(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result[key]));
  });
}

async function set(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

async function markSyncDirty(kind) {
  try {
    const dirty = (await get(SYNC_DIRTY_KEY)) || {};
    dirty[kind] = true;
    dirty.updatedAt = Date.now();
    await set(SYNC_DIRTY_KEY, dirty);
    chrome.runtime.sendMessage({ type: 'SYNC_NOW', reason: `local-${kind}` }).catch(() => {});
  } catch {
    // Sync is best-effort. Local storage remains the source of truth.
  }
}

async function recordSyncDeletion(key, address) {
  const deleted = (await get(key)) || {};
  const normalized = normalizeKey(address);
  deleted[normalized] = { address: normalized, deletedAt: Date.now() };
  await set(key, deleted);
}

// --- Wallets ---

export async function getWallets() {
  return (await get(KEYS.WALLETS)) || [];
}

export async function addWallet(wallet) {
  const wallets = await getWallets();
  const existing = wallets.find(
    (w) => normalizeKey(w.address) === normalizeKey(wallet.address)
  );
  if (existing) return existing;
  const chains = wallet.chains && wallet.chains.length ? wallet.chains : [wallet.chainId || 1];
  const entry = {
    id: crypto.randomUUID(),
    address: wallet.address,
    label: wallet.label || '',
    chainId: chains[0],
    chains,
    primaryChainId: wallet.primaryChainId || chains[0],
    perChain: {},
    addedAt: Date.now(),
    lastFetchedAt: null,
  };
  wallets.push(entry);
  await set(KEYS.WALLETS, wallets);
  await recordNetworkMetric('protected_wallet_added');
  await markSyncDirty('wallets');
  return entry;
}

export async function updateWallet(id, updates) {
  const wallets = await getWallets();
  const idx = wallets.findIndex((w) => w.id === id);
  if (idx === -1) return;
  wallets[idx] = { ...wallets[idx], ...updates };
  await set(KEYS.WALLETS, wallets);
  if (
    Object.prototype.hasOwnProperty.call(updates, 'label') ||
    Object.prototype.hasOwnProperty.call(updates, 'chains') ||
    Object.prototype.hasOwnProperty.call(updates, 'primaryChainId')
  ) {
    await markSyncDirty('wallets');
  }
}

export async function removeWallet(id) {
  const wallets = await getWallets();
  const wallet = wallets.find((w) => w.id === id);
  if (wallet) await recordSyncDeletion(SYNC_DELETED_WALLETS_KEY, wallet.address);
  await set(KEYS.WALLETS, wallets.filter((w) => w.id !== id));
  if (wallet) await markSyncDirty('wallets');
}

// --- Trusted index ---

export async function getTrusted() {
  return (await get(KEYS.TRUSTED)) || {};
}

export async function mergeTrusted(entries) {
  // entries: [{ address, chains, txCount, firstSeen, lastSeen, etherscanLabel, ensName }]
  const trusted = await getTrusted();
  for (const e of entries) {
    const key = normalizeKey(e.address);
    const existing = trusted[key];
    if (existing) {
      trusted[key] = {
        ...existing,
        chains: [...new Set([...(existing.chains || []), ...(e.chains || [])])],
        txCount: (existing.txCount || 0) + (e.txCount || 0),
        firstSeen: Math.min(existing.firstSeen || Infinity, e.firstSeen || Infinity),
        lastSeen: Math.max(existing.lastSeen || 0, e.lastSeen || 0),
        etherscanLabel: e.etherscanLabel || existing.etherscanLabel || null,
        ensName: e.ensName || existing.ensName || null,
        label: existing.label || '',
        originWallets: [...new Set([...(existing.originWallets || []), ...(e.originWallets || [])])],
        favourite: existing.favourite || false,
      };
    } else {
      trusted[key] = {
        address: key,
        label: '',
        chains: e.chains || [],
        txCount: e.txCount || 1,
        firstSeen: e.firstSeen || null,
        lastSeen: e.lastSeen || null,
        etherscanLabel: e.etherscanLabel || null,
        ensName: e.ensName || null,
        originWallets: e.originWallets || [],
      };
    }
  }
  await set(KEYS.TRUSTED, trusted);
}

export async function setTrustedLabel(address, label) {
  const trusted = await getTrusted();
  const key = normalizeKey(address);
  if (trusted[key]) {
    trusted[key].label = label;
    trusted[key].updatedAt = Date.now();
    await set(KEYS.TRUSTED, trusted);
    await markSyncDirty('contacts');
  }
}

// --- Suspicion index ---

export async function getSuspicion() {
  return (await get(KEYS.SUSPICION)) || {};
}

export async function mergeSuspicion(entries) {
  // entries: [{ address, reason, chains, firstSeen, lastSeen }]
  const suspicion = await getSuspicion();
  for (const e of entries) {
    const key = normalizeKey(e.address);
    if (suspicion[key]) {
      suspicion[key] = {
        ...suspicion[key],
        chains: [...new Set([...(suspicion[key].chains || []), ...(e.chains || [])])],
        lastSeen: Math.max(suspicion[key].lastSeen || 0, e.lastSeen || 0),
        originWallets: [...new Set([...(suspicion[key].originWallets || []), ...(e.originWallets || [])])],
      };
    } else {
      suspicion[key] = {
        address: key,
        reason: e.reason || 'inbound',
        chains: e.chains || [],
        firstSeen: e.firstSeen || null,
        lastSeen: e.lastSeen || null,
        originWallets: e.originWallets || [],
      };
    }
  }
  await set(KEYS.SUSPICION, suspicion);
}

export async function removeTrusted(address) {
  const trusted = await getTrusted();
  const key = normalizeKey(address);
  if (trusted[key]) await recordSyncDeletion(SYNC_DELETED_CONTACTS_KEY, address);
  delete trusted[key];
  await set(KEYS.TRUSTED, trusted);
  await markSyncDirty('contacts');
}

export async function removeSuspicion(address) {
  const suspicion = await getSuspicion();
  delete suspicion[normalizeKey(address)];
  await set(KEYS.SUSPICION, suspicion);
}

export async function promoteSuspicionToTrusted(address) {
  const trusted = await getTrusted();
  const suspicion = await getSuspicion();
  const key = normalizeKey(address);
  if (!suspicion[key]) return;
  trusted[key] = { ...suspicion[key], label: '', txCount: 0, manuallyAdded: true, updatedAt: Date.now() };
  delete suspicion[key];
  await Promise.all([set(KEYS.TRUSTED, trusted), set(KEYS.SUSPICION, suspicion)]);
  await markSyncDirty('contacts');
}

// --- User exceptions (Mark as Safe) ---

export async function getExceptions() {
  return (await get(KEYS.EXCEPTIONS)) || {};
}

export async function addException(address) {
  const exceptions = await getExceptions();
  exceptions[normalizeKey(address)] = { markedSafeAt: Date.now() };
  await set(KEYS.EXCEPTIONS, exceptions);
}

// --- Settings ---

export async function getSettings() {
  return (await get(KEYS.SETTINGS)) || {};
}

export async function updateSettings(updates) {
  const settings = await getSettings();
  await set(KEYS.SETTINGS, { ...settings, ...updates });
}

export async function clearAllLocalData() {
  await Promise.all([
    new Promise((resolve) => chrome.storage.local.clear(resolve)),
    new Promise((resolve) => chrome.storage.session.clear(resolve)),
  ]);
}

// --- Local-only address Intel ---

export async function getAddressIntelIndex() {
  return (await get(KEYS.ADDRESS_INTEL)) || {};
}

export async function getAddressIntel(address, chainId = null) {
  const intel = await getAddressIntelIndex();
  const normalized = normalizeKey(address);
  if (chainId !== null && chainId !== undefined) {
    return intel[addressIntelKey(normalized, chainId)] || null;
  }
  const entries = Object.entries(intel)
    .filter(([key]) => key.startsWith(`${normalized}:`))
    .map(([, value]) => value);
  if (!entries.length) return null;
  entries.sort((a, b) => {
    if (a.status === 'risky' && b.status !== 'risky') return -1;
    if (a.status !== 'risky' && b.status === 'risky') return 1;
    return (b.reviewedAt || 0) - (a.reviewedAt || 0);
  });
  return entries[0];
}

export async function setAddressIntel(address, chainId = 'unknown', record) {
  const intel = await getAddressIntelIndex();
  const normalized = normalizeKey(address);
  const key = addressIntelKey(normalized, chainId);
  intel[key] = {
    ...record,
    address: normalized,
    chainId: String(chainId || 'unknown'),
    updatedAt: Date.now(),
  };
  await set(KEYS.ADDRESS_INTEL, intel);
  await recordNetworkMetric('address_intel_action_run');
  return intel[key];
}

function addressIntelKey(address, chainId) {
  return `${normalizeKey(address)}:${String(chainId || 'unknown')}`;
}

// --- Manual contacts ---

export async function addManualContact({ address, label, chainId = 1, notes = '', tags = [], description = '', email = '', phone = '' }) {
  const trusted = await getTrusted();
  const key = normalizeKey(address);
  trusted[key] = {
    address: key,
    label,
    chainId,
    notes,
    tags,
    description,
    email,
    phone,
    manuallyAdded: true,
    chains: [String(chainId)],
    txCount: 0,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    etherscanLabel: null,
    ensName: null,
    updatedAt: Date.now(),
  };
  await set(KEYS.TRUSTED, trusted);
  await recordNetworkMetric('contact_saved');
  await markSyncDirty('contacts');
}

export async function updateTrustedEntry(address, fields) {
  const trusted = await getTrusted();
  const key = normalizeKey(address);
  if (!trusted[key]) return;
  trusted[key] = { ...trusted[key], ...fields, updatedAt: Date.now() };
  await set(KEYS.TRUSTED, trusted);
  await markSyncDirty('contacts');
}

// --- User-flagged addresses ---

export async function getFlagged() {
  return (await get(KEYS.FLAGGED)) || {};
}

export async function addFlagged(address, chain) {
  const flagged = await getFlagged();
  const key = normalizeKey(address);
  if (!flagged[key]) {
    flagged[key] = { chain, timestamp: Date.now(), confirmed: false };
    await set(KEYS.FLAGGED, flagged);
  }
}

export async function promoteFlaggedToMalicious(address) {
  const flagged = await getFlagged();
  const key = normalizeKey(address);
  if (flagged[key]) {
    flagged[key].confirmed = true;
    await set(KEYS.FLAGGED, flagged);
  }
}

export async function removeFlagged(address) {
  const flagged = await getFlagged();
  delete flagged[normalizeKey(address)];
  await set(KEYS.FLAGGED, flagged);
}

// --- Full index clear (for re-fetch) ---

export async function clearIndex() {
  await Promise.all([
    set(KEYS.TRUSTED, {}),
    set(KEYS.SUSPICION, {}),
  ]);
}

// --- Community detection ---

// Returns a stable anonymous UUID for this extension install.
// Generated once on first call and persisted in chrome.storage.local.
export async function getInstallId() {
  const stored = await get('installId');
  if (stored) return stored;
  const id = crypto.randomUUID();
  await set('installId', id);
  return id;
}

// Returns a public referral UUID for share links.
// Kept separate from installId so reporting identity stays private.
export async function getReferralId() {
  const stored = await get('referralId');
  if (stored) return stored;
  const id = crypto.randomUUID();
  await set('referralId', id);
  return id;
}

// communityList schema: { addresses: string[], fetchedAt: number, count: number }
export async function getCommunityList() {
  return (await get('communityList')) || { addresses: [], fetchedAt: 0, count: 0 };
}

export async function setCommunityList(data) {
  await set('communityList', data);
}

// Rolling daily snapshots of community-list size — used to compute a 7-day delta
// locally without requiring a server-side endpoint. Kept to 14 entries max.
export async function getCommunityListSnapshots() {
  return (await get('communityListSnapshots')) || [];
}

export async function recordCommunityListSnapshot(count) {
  const snapshots = await getCommunityListSnapshots();
  const now = Date.now();
  const last = snapshots[snapshots.length - 1];
  if (last && now - last.ts < 20 * 60 * 60 * 1000) return snapshots;
  const next = [...snapshots, { ts: now, count }].slice(-14);
  await set('communityListSnapshots', next);
  return next;
}

// metrics: lifetime local counters used for self-display social-proof and PLG funnel.
// Pure local; separate from opt-in Network Mode aggregates. Schema:
//   metrics: { paste: number, flag: number, share: number, signin: number, fetch: number,
//              first_paste_at, first_flag_at, ... }
export async function getMetrics() {
  return (await get('metrics')) || {};
}

export async function bumpMetric(name, delta = 1) {
  const metrics = (await get('metrics')) || {};
  metrics[name] = (metrics[name] || 0) + delta;
  const firstKey = `first_${name}_at`;
  if (!metrics[firstKey]) metrics[firstKey] = Date.now();
  await set('metrics', metrics);
  return metrics;
}

// --- Network Mode aggregate metrics ---

const NETWORK_COUNT_KEYS = new Set([
  'transfer_checks_shown',
  'transfer_checks_confirmed',
  'transfer_checks_cancelled',
  'telegram_web_copies_detected',
  'telegram_source_matches',
  'telegram_source_mismatches',
  'contacts_saved',
  'protected_wallets_added',
  'address_intel_actions_run',
]);

const NETWORK_WARNING_STATES = new Set([
  'SUSPICIOUS_KNOWN',
  'CLIPBOARD_MISMATCH',
  'POISONED',
  'HIJACKED',
  'SCAM',
  'MALICIOUS',
  'COMMUNITY_REPORTED',
  'COMMUNITY_DISPUTED',
  'FLAGGED',
]);

const NETWORK_CHAIN_TYPES = new Set(['evm', 'solana', 'tron']);

const NETWORK_METRIC_MAP = {
  transfer_check_shown: 'transfer_checks_shown',
  transfer_check_confirmed: 'transfer_checks_confirmed',
  transfer_check_cancelled: 'transfer_checks_cancelled',
  telegram_web_copy_detected: 'telegram_web_copies_detected',
  telegram_source_match: 'telegram_source_matches',
  telegram_source_mismatch: 'telegram_source_mismatches',
  contact_saved: 'contacts_saved',
  protected_wallet_added: 'protected_wallets_added',
  address_intel_action_run: 'address_intel_actions_run',
};

const NETWORK_METRICS_MAX_DAYS = 14;

export async function recordNetworkMetric(name, detail = {}) {
  const settings = await getSettings();
  if (settings.networkMode !== true) return null;

  const today = new Date().toISOString().slice(0, 10);
  const store = await getNetworkMetricsStore();
  const bucket = store.days[today] || emptyCounts();
  const mapped = NETWORK_METRIC_MAP[name];
  if (mapped && NETWORK_COUNT_KEYS.has(mapped)) {
    bucket[mapped] = (bucket[mapped] || 0) + 1;
  }
  if (name === 'warning_state_shown' && NETWORK_WARNING_STATES.has(detail.state)) {
    bucket.warning_states[detail.state] = (bucket.warning_states[detail.state] || 0) + 1;
  }
  if (detail.chainType && NETWORK_CHAIN_TYPES.has(detail.chainType)) {
    bucket.chain_type_counts[detail.chainType] = (bucket.chain_type_counts[detail.chainType] || 0) + 1;
  }
  store.days[today] = bucket;
  trimNetworkMetricsDays(store);
  await set(KEYS.NETWORK_METRICS_DAILY, store);
  return bucket;
}

export async function getNetworkMetricsDaily() {
  return getNetworkMetricsStore();
}

export async function clearNetworkMetricsDaily(day) {
  const store = await getNetworkMetricsStore();
  if (day) {
    delete store.days[day];
  } else {
    store.days = {};
  }
  await set(KEYS.NETWORK_METRICS_DAILY, store);
}

async function getNetworkMetricsStore() {
  const raw = await get(KEYS.NETWORK_METRICS_DAILY);
  if (raw && raw.days && typeof raw.days === 'object') return { days: { ...raw.days } };
  // Migrate pre-multi-day single-bucket shape { day, counts } if encountered.
  if (raw && typeof raw.day === 'string' && raw.counts && /^\d{4}-\d{2}-\d{2}$/.test(raw.day)) {
    return { days: { [raw.day]: raw.counts } };
  }
  return { days: {} };
}

function trimNetworkMetricsDays(store) {
  const days = Object.keys(store.days).sort();
  while (days.length > NETWORK_METRICS_MAX_DAYS) {
    delete store.days[days.shift()];
  }
}

export function sanitizeNetworkMetricsPayload(metrics, extensionVersion) {
  const counts = metrics?.counts || {};
  const sanitized = {
    extension_version: String(extensionVersion || 'unknown'),
    day: /^\d{4}-\d{2}-\d{2}$/.test(metrics?.day || '') ? metrics.day : new Date().toISOString().slice(0, 10),
    counts: {
      transfer_checks_shown: safeCount(counts.transfer_checks_shown),
      transfer_checks_confirmed: safeCount(counts.transfer_checks_confirmed),
      transfer_checks_cancelled: safeCount(counts.transfer_checks_cancelled),
      warning_states: sanitizeKeyedCounts(counts.warning_states, NETWORK_WARNING_STATES),
      telegram_web_copies_detected: safeCount(counts.telegram_web_copies_detected),
      telegram_source_matches: safeCount(counts.telegram_source_matches),
      telegram_source_mismatches: safeCount(counts.telegram_source_mismatches),
      chain_type_counts: sanitizeKeyedCounts(counts.chain_type_counts, NETWORK_CHAIN_TYPES),
      contacts_saved: safeCount(counts.contacts_saved),
      protected_wallets_added: safeCount(counts.protected_wallets_added),
      address_intel_actions_run: safeCount(counts.address_intel_actions_run),
    },
  };
  return sanitized;
}

function emptyCounts() {
  return {
    transfer_checks_shown: 0,
    transfer_checks_confirmed: 0,
    transfer_checks_cancelled: 0,
    warning_states: {},
    telegram_web_copies_detected: 0,
    telegram_source_matches: 0,
    telegram_source_mismatches: 0,
    chain_type_counts: {},
    contacts_saved: 0,
    protected_wallets_added: 0,
    address_intel_actions_run: 0,
  };
}

function sanitizeKeyedCounts(value, allowedKeys) {
  const out = {};
  for (const [key, count] of Object.entries(value || {})) {
    if (allowedKeys.has(key)) out[key] = safeCount(count);
  }
  return out;
}

function safeCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export async function getSignInNudgeShown() {
  return !!(await get('signInNudgeShown'));
}

export async function setSignInNudgeShown() {
  await set('signInNudgeShown', true);
}

// disputedAddresses schema: { [address]: { submittedAt: number } }
export async function getDisputedAddresses() {
  return (await get('disputedAddresses')) || {};
}

export async function addDisputedAddress(address) {
  const current = await getDisputedAddresses();
  current[address] = { submittedAt: Date.now() };
  await set('disputedAddresses', current);
}
