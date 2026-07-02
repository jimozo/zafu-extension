// service-worker.js — Zafu background worker
//
// Handles all API calls and storage orchestration.
// Content script and popup communicate via chrome.runtime.sendMessage.

import { fetchTxList, fetchTokenTx, fetchBalance, probeChains, fetchPrices, CHAIN_LIST } from '../lib/etherscan-client.js';
import { fetchSolanaTransfers, fetchSolanaBalance } from '../lib/solscan-client.js';
import { fetchTronStablecoinTransfers, fetchTronWalletTransfers, BUNDLED_TRON_KEY } from '../lib/tronscan-client.js';
import { buildIndex, buildIndexSolana, buildIndexTron, evmStablecoinAssetForTransfer } from '../lib/index-builder.js';
import { auditTrustedIndex } from '../lib/self-audit.js';
import {
  getWallets,
  updateWallet,
  getTrusted,
  addManualContact,
  updateTrustedEntry,
  mergeTrusted,
  mergeSuspicion,
  clearIndex,
  getSettings,
  updateSettings,
  addException,
  getInstallId,
  getCommunityList,
  setCommunityList,
  recordCommunityListSnapshot,
  bumpMetric,
  recordNetworkMetric,
  getNetworkMetricsDaily,
  sanitizeNetworkMetricsPayload,
  clearNetworkMetricsDaily,
  normalizeKey,
} from '../lib/storage.js';
import {
  normalizeStablecoinAsset,
  normalizeStablecoinNetwork,
  stablecoinNetworkAddressType,
} from '../lib/transfer-context.js';
import {
  submitReport,
  fetchCommunityList,
  submitDispute,
  queuePendingReport,
  flushPendingReports,
  submitNetworkMetrics,
} from '../lib/community-client.js';
import { syncNow } from '../lib/sync.js';

const SESSION_KEY_LAST_COPIED = 'lastCopiedAddress';
const SESSION_KEY_LEGACY_RECENT_SOURCES = 'recentCopySources';
const STABLECOIN_ASSETS = new Set(['USDT', 'USDC']);

// Open onboarding on first install; set up 24h auto-refresh alarm
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
  }
  // Pre-warm install ID on any install/update; fetch community list immediately
  getInstallId().catch(() => {});
  refreshCommunityList().catch(() => {});
  flushNetworkMetrics().catch(() => {});
  syncNow('install').catch(() => {});
  chrome.alarms.create('auto-refresh', { periodInMinutes: 1440 });
});

// Fetch community list on browser startup (service worker restart)
chrome.runtime.onStartup.addListener(() => {
  refreshCommunityList().catch(() => {});
  flushPendingReports().catch(() => {});
  flushNetworkMetrics().catch(() => {});
  syncNow('startup').catch(() => {});
});

// 24h auto-refresh: re-fetch all wallets that have been fetched before, then refresh community list
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'auto-refresh') return;
  const wallets = await getWallets();
  for (const wallet of wallets) {
    if (!wallet.lastFetchedAt) continue;
    await handleFetchHistory(wallet.id, wallet.address, wallet.chains || [wallet.chainId || 1]).catch(() => {});
  }
  await refreshCommunityList().catch(() => {});
  await flushPendingReports().catch(() => {});
  await flushNetworkMetrics().catch(() => {});
  await syncNow('alarm').catch(() => {});
});

// Open contact picker on the active tab when keyboard shortcut fires
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'open-contact-picker') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'OPEN_CONTACT_PICKER' }).catch(() => {});
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH_HISTORY') {
    handleFetchHistory(msg.walletId, msg.address, msg.chainIds || msg.chainId || null, { preview: msg.preview === true })
      .then((result) => {
        if (result.fetchError && result.trustedCount === 0 && result.suspicionCount === 0) {
          sendResponse({ ok: false, error: result.fetchError });
        } else {
          sendResponse({ ok: true, ...result });
        }
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async response
  }

  if (msg.type === 'PROBE_CHAINS') {
    getSettings().then((s) => probeChains(msg.address, s.etherscanApiKey))
      .then((results) => sendResponse({ ok: true, results }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'ENRICH_STABLECOIN_CONTACT') {
    handleStablecoinContactEnrichment(msg.address)
      .then((entry) => sendResponse({ ok: true, entry }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'SAVE_STABLECOIN_CONTACT') {
    handleSaveStablecoinContact(msg.contact || {})
      .then((entry) => sendResponse({ ok: true, entry }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'SAVE_IMPORTED_CONTACTS') {
    handleSaveImportedContacts(msg.contacts || [])
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'BATCH_ENRICH_STABLECOIN') {
    handleBatchStablecoinEnrichment()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'REFRESH_PRICES') {
    refreshPrices()
      .then((prices) => sendResponse({ ok: true, prices }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'LOOKUP_ADDRESS') {
    // Stage 3: comparator lookup — stubbed here, wired in Stage 3
    sendResponse({ status: 'UNKNOWN' });
    return true;
  }

  if (msg.type === 'COPY_ADDRESS') {
    const entry = sanitizeCopiedAddressMessage(msg);
    chrome.storage.session
      .remove(SESSION_KEY_LEGACY_RECENT_SOURCES)
      .then(() => chrome.storage.session.set({ [SESSION_KEY_LAST_COPIED]: entry }))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'CLEAR_LAST_COPIED') {
    chrome.storage.session
      .remove([SESSION_KEY_LAST_COPIED, SESSION_KEY_LEGACY_RECENT_SOURCES])
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'GET_LAST_COPIED') {
    const COPY_TTL_MS = 10 * 60 * 1000; // 10 minutes — stale session data causes false mismatch warnings
    chrome.storage.session
      .get(SESSION_KEY_LAST_COPIED)
      .then((r) => {
        const entry = r[SESSION_KEY_LAST_COPIED];
        if (!entry) return sendResponse({ lastCopied: null });
        const expired = entry.ts && (Date.now() - entry.ts) > COPY_TTL_MS;
        sendResponse({ lastCopied: expired ? null : entry });
      })
      .catch(() => sendResponse({ lastCopied: null }));
    return true;
  }

  if (msg.type === 'PASTE_INTERCEPTED') {
    const key = 'pasteInterceptCount';
    chrome.storage.session.get(key).then((r) => {
      const count = (r[key] || 0) + 1;
      return chrome.storage.session.set({ [key]: count }).then(() => {
        chrome.action.setBadgeText({ text: String(count) });
        chrome.action.setBadgeBackgroundColor({ color: '#5b9cf6' });
      });
    }).catch(() => {});
    bumpMetric('paste').catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'RECORD_NETWORK_METRIC') {
    recordNetworkMetric(msg.name, msg.detail || {})
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'MARK_SAFE') {
    addException(msg.address)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'GET_AUDIT_RESULTS') {
    getSettings()
      .then((s) => sendResponse({ results: s.auditResults || [] }))
      .catch(() => sendResponse({ results: [] }));
    return true;
  }

  if (msg.type === 'SUBMIT_COMMUNITY_REPORT') {
    // Submit — on failure, queue for retry. Flush prior queue opportunistically.
    Promise.all([getInstallId(), chrome.storage.local.get('settings')])
      .then(async ([installId, stored]) => {
        const source = msg.source || 'user_flag';
        if (source !== 'user_flag' && stored.settings?.communityThreatSignals !== true) return;
        if (source === 'user_flag') bumpMetric('flag').catch(() => {});
        const ok = await submitReport(msg.address, msg.chain, source, installId);
        if (!ok) {
          await queuePendingReport({
            address: msg.address,
            chain: msg.chain,
            source,
            install_id: installId,
          });
        } else {
          await flushPendingReports().catch(() => {});
        }
      })
      .catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'SUBMIT_DISPUTE') {
    getInstallId()
      .then((installId) => submitDispute(msg.address, msg.chain, installId, msg.reason, msg.evidenceUrl || null))
      .catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'OPEN_SETTINGS_PANEL') {
    // Store intent so popup picks it up on next open; also try sending directly if popup is open
    chrome.storage.session.set({ openSettingsPanelIntent: true }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS_PANEL_NOW' }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'REFRESH_COMMUNITY_LIST') {
    refreshCommunityList()
      .then(() => chrome.runtime.sendMessage({ type: 'COMMUNITY_LIST_UPDATED' }).catch(() => {}))
      .catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'FLUSH_NETWORK_METRICS') {
    flushNetworkMetrics()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'SYNC_NOW') {
    syncNow(msg.reason || 'message')
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

function sanitizeCopiedAddressMessage(msg) {
  const source = sanitizeCopySource(msg);
  return {
    address: String(msg.address || ''),
    displayAddress: String(msg.displayAddress || msg.address || ''),
    chainType: ['evm', 'solana', 'tron', 'ens'].includes(msg.chainType) ? msg.chainType : null,
    ts: Date.now(),
    source,
  };
}

function sanitizeCopySource(msg) {
  if (msg.source?.sourceClass === 'telegram_web') {
    return {
      sourceClass: 'telegram_web',
      displayAddress: String(msg.source.displayAddress || msg.displayAddress || msg.address || ''),
      chainCandidates: Array.isArray(msg.source.chainCandidates)
        ? msg.source.chainCandidates.filter((chain) => ['evm', 'solana', 'tron', 'ens'].includes(chain)).slice(0, 3)
        : [],
    };
  }

  if (msg.source?.sourceClass === 'zafu_contact') {
    return {
      sourceClass: 'zafu_contact',
      contactLabel: String(msg.source.contactLabel || '').slice(0, 80),
      asset: normalizeStablecoinAsset(msg.source.asset) || null,
      network: normalizeStablecoinNetwork(msg.source.network),
      displayAddress: String(msg.source.displayAddress || msg.displayAddress || msg.address || ''),
    };
  }

  return null;
}

async function handleStablecoinContactEnrichment(address) {
  const key = normalizeKey(String(address || ''));
  if (!key) throw new Error('Missing address');

  const trusted = await getTrusted();
  const entry = trusted[key];
  if (!entry) throw new Error('Contact not found');

  // W7: "other token" contacts get generic chain-activity confidence only — never a
  // token-specific "confirmed N USDT" route. Diverts before the stablecoin paths.
  if (entry.assetType === 'token') {
    return await enrichTokenContactGeneric(key, entry);
  }

  const network = normalizeStablecoinNetwork(entry.network || entry.chainId || entry.chains?.[0]);
  const addressType = stablecoinNetworkAddressType(network);

  // --- TRON path (TRC-20 stablecoins via Tronscan) ---
  // Lets TRON contacts reach networkConfidence 'history' (EVM-only probeChains cannot).
  const isTronAddress = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(key);
  if (network === 'tron' || isTronAddress) {
    const settings = await getSettings();
    const tronKey = settings.tronApiKey || undefined;
    if (!tronKey) {
      // W4: TRON review/enrichment requires the user's own key — never the bundled upload
      // key — so bulk review can't burn Zafu's quota. Contact stays saved until a key is added.
      await updateTrustedEntry(key, {
        enrichmentStatus: 'needs_key',
        enrichedAt: Date.now(),
        networkConfidence: entry.networkConfidence === 'history' ? 'history' : 'saved',
      });
      return (await getTrusted())[key];
    }
    await updateTrustedEntry(key, { enrichmentStatus: 'checking' });
    const tokenActivity = { USDT: {}, USDC: {} };
    try {
      const rows = await fetchTronStablecoinTransfers(key, tronKey);
      mergeTronStablecoinActivity(tokenActivity, rows);
    } catch {
      tokenActivity.USDT.tron = emptyTokenActivity();
      tokenActivity.USDC.tron = emptyTokenActivity();
    }
    const dominant = chooseDominantStablecoinRoute(tokenActivity);
    const savedNetwork = normalizeStablecoinNetwork(entry.network) || 'tron';
    const nextNetwork = savedNetwork || dominant?.network || 'tron';
    const nextAsset = normalizeStablecoinAsset(entry.asset) || dominant?.asset || null;
    let networkConfidence = nextNetwork ? 'saved' : 'unknown';
    if (dominant?.network && nextNetwork === dominant.network) {
      networkConfidence = 'history';
    } else if (dominant?.network && nextNetwork && nextNetwork !== dominant.network) {
      networkConfidence = 'mismatch';
    }
    await updateTrustedEntry(key, {
      asset: nextAsset,
      network: nextNetwork,
      networkConfidence,
      historyFromSync: false, // confirmed by this device's own scan, not adopted from sync
      dominantStablecoinAsset: dominant?.asset || null,
      dominantStablecoinNetwork: dominant?.network || null,
      dominantStablecoinTransferCount: dominant?.count || 0,
      chainActivity: {},
      usdtActivityByChain: tokenActivity.USDT,
      usdcActivityByChain: tokenActivity.USDC,
      enrichmentStatus: 'complete',
      enrichedAt: Date.now(),
    });
    return (await getTrusted())[key];
  }

  if (addressType !== 'evm' && !/^0x[0-9a-f]{40}$/i.test(key)) {
    await updateTrustedEntry(key, {
      enrichmentStatus: 'local_only',
      enrichedAt: Date.now(),
      networkConfidence: network ? 'saved' : 'unknown',
    });
    return (await getTrusted())[key];
  }

  const settings = await getSettings();
  const apiKey = settings.etherscanApiKey || undefined;
  if (!apiKey) {
    // W4: EVM review/enrichment requires the user's own Etherscan key — never the bundled
    // key — so bulk review can't burn Zafu's quota. Contact stays saved until a key is added.
    await updateTrustedEntry(key, {
      enrichmentStatus: 'needs_key',
      enrichedAt: Date.now(),
      networkConfidence: entry.networkConfidence === 'history' ? 'history' : (network ? 'saved' : (entry.networkConfidence || 'unknown')),
    });
    return (await getTrusted())[key];
  }

  await updateTrustedEntry(key, { enrichmentStatus: 'checking' });
  const chainActivityRows = await probeChains(key, apiKey).catch(() => []);
  const chainActivity = {};
  for (const row of chainActivityRows) {
    chainActivity[String(row.chainId)] = {
      balance: row.balance || 0,
      hasActivity: row.hasActivity === true,
      firstTxAt: row.firstTxAt || null,
      lastTxAt: row.lastTxAt || null,
    };
  }

  const tokenActivity = {
    USDT: {},
    USDC: {},
  };

  for (const chainId of CHAIN_LIST) {
    try {
      const rows = await fetchTokenTx(key, apiKey, null, chainId);
      mergeStablecoinTokenActivity(tokenActivity, rows, chainId);
      await sleepBriefly(220);
    } catch {
      tokenActivity.USDT[String(chainId)] = tokenActivity.USDT[String(chainId)] || emptyTokenActivity();
      tokenActivity.USDC[String(chainId)] = tokenActivity.USDC[String(chainId)] || emptyTokenActivity();
    }
  }

  const dominant = chooseDominantStablecoinRoute(tokenActivity);
  const savedNetwork = normalizeStablecoinNetwork(entry.network || entry.chainId || entry.chains?.[0]);
  const nextNetwork = savedNetwork || dominant?.network || null;
  const nextAsset = normalizeStablecoinAsset(entry.asset) || dominant?.asset || null;
  let networkConfidence = nextNetwork ? 'saved' : 'unknown';
  if (dominant?.network && nextNetwork === dominant.network) {
    networkConfidence = 'history';
  } else if (dominant?.network && nextNetwork && nextNetwork !== dominant.network) {
    networkConfidence = 'mismatch';
  }

  await updateTrustedEntry(key, {
    asset: nextAsset,
    network: nextNetwork,
    networkConfidence,
    historyFromSync: false, // confirmed by this device's own scan, not adopted from sync
    dominantStablecoinAsset: dominant?.asset || null,
    dominantStablecoinNetwork: dominant?.network || null,
    dominantStablecoinTransferCount: dominant?.count || 0,
    chainActivity,
    usdtActivityByChain: tokenActivity.USDT,
    usdcActivityByChain: tokenActivity.USDC,
    enrichmentStatus: 'complete',
    enrichedAt: Date.now(),
  });

  return (await getTrusted())[key];
}

// W7: generic chain-activity confidence for non-stablecoin ("other token") contacts.
// Uses the same EVM probeChains signal as stablecoins, but makes no token-specific
// claim — only "active on <network>". Solana/TRON have no generic probe, so they stay
// local. Honest, weaker confidence; no per-token contract registry.
async function enrichTokenContactGeneric(key, entry) {
  const network = normalizeStablecoinNetwork(entry.network || entry.chainId || entry.chains?.[0]);

  if (!/^0x[0-9a-f]{40}$/i.test(key)) {
    await updateTrustedEntry(key, {
      enrichmentStatus: 'local_only',
      enrichedAt: Date.now(),
      networkConfidence: network ? 'saved' : 'unknown',
    });
    return (await getTrusted())[key];
  }

  const settings = await getSettings();
  const apiKey = settings.etherscanApiKey || undefined;
  if (!apiKey) {
    // W4: review/enrichment requires the user's own key — never the bundled key.
    await updateTrustedEntry(key, {
      enrichmentStatus: 'needs_key',
      enrichedAt: Date.now(),
      networkConfidence: network ? 'saved' : (entry.networkConfidence || 'unknown'),
    });
    return (await getTrusted())[key];
  }

  await updateTrustedEntry(key, { enrichmentStatus: 'checking' });
  const chainActivityRows = await probeChains(key, apiKey).catch(() => []);
  const chainActivity = {};
  for (const row of chainActivityRows) {
    chainActivity[String(row.chainId)] = {
      balance: row.balance || 0,
      hasActivity: row.hasActivity === true,
      firstTxAt: row.firstTxAt || null,
      lastTxAt: row.lastTxAt || null,
    };
  }
  // network normalizes to the chainId string (e.g. '8453'), which is the chainActivity key.
  const active = network ? chainActivity[String(network)]?.hasActivity === true : false;

  await updateTrustedEntry(key, {
    networkConfidence: active ? 'active' : (network ? 'saved' : 'unknown'),
    chainActivity,
    // tokens never borrow a stablecoin route
    dominantStablecoinAsset: null,
    dominantStablecoinNetwork: null,
    dominantStablecoinTransferCount: 0,
    enrichmentStatus: 'complete',
    enrichedAt: Date.now(),
  });
  return (await getTrusted())[key];
}

async function handleSaveStablecoinContact(contact) {
  const address = String(contact.address || '').trim();
  if (!address) throw new Error('Missing address');
  const key = normalizeKey(address);
  const asset = normalizeStablecoinAsset(contact.asset) || null;
  const network = normalizeStablecoinNetwork(contact.network);
  const sourceNote = String(contact.sourceNote || 'saved from Transfer Check').slice(0, 80);
  const trusted = await getTrusted();
  const existing = trusted[key];

  let saved;
  if (existing) {
    await updateTrustedEntry(key, {
      asset: asset || existing.asset || null,
      network: network || existing.network || null,
      networkConfidence: network ? 'saved' : (existing.networkConfidence || 'unknown'),
      sourceNote: existing.sourceNote || sourceNote,
      lastSeen: Date.now(),
      timesSeen: (existing.timesSeen || existing.txCount || 0) + 1,
    });
    saved = (await getTrusted())[key];
  } else {
    saved = await addManualContact({
      address: key,
      label: '',
      chainId: network || 1,
      asset: asset || 'USDT',
      sourceNote,
    });
  }

  handleStablecoinContactEnrichment(key).catch(() => {});
  return saved;
}

const IMPORT_ADDR_RE = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

// Defense-in-depth: rebuild each imported candidate from a known, typed field set before it
// reaches the trusted store. mergeTrusted already recomputes confidence + dominant route and
// never copies caller-supplied trust fields, but constructing the merge input explicitly
// drops any forged enrichment/confidence fields and keeps that guarantee even if the message
// source ever widens beyond the extension's own import UI.
function sanitizeImportCandidate(c) {
  const address = String(c?.address || '').trim();
  if (!IMPORT_ADDR_RE.test(address)) return null;
  const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    address,
    chains: Array.isArray(c.chains) ? c.chains.map(String).slice(0, 8) : [],
    txCount: Math.max(0, Math.trunc(toNum(c.txCount) || 0)),
    stablecoinTxCount: Math.max(0, Math.trunc(toNum(c.stablecoinTxCount) || 0)),
    firstSeen: toNum(c.firstSeen),
    lastSeen: toNum(c.lastSeen),
    originWallets: Array.isArray(c.originWallets) ? c.originWallets.map(String).slice(0, 16) : [],
    asset: typeof c.asset === 'string' ? (c.asset.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || null) : null,
    stablecoin: c.stablecoin === true,
  };
}

// Bulk-save user-confirmed wallet-history import candidates. mergeTrusted preserves the
// real send-history stats (txCount/first/last seen → networkConfidence 'history'); marking
// manuallyAdded promotes them to synced user contacts. Deep per-address enrichment is the
// heavy path, so it runs ONLY on the user's own key — never the bundled key — to avoid
// large bills on bulk import (keyless contacts stay saved with history confidence).
async function handleSaveImportedContacts(contacts) {
  if (!Array.isArray(contacts) || !contacts.length) return { saved: 0, enriched: 0 };
  const clean = contacts.map(sanitizeImportCandidate).filter(Boolean);
  if (!clean.length) return { saved: 0, enriched: 0 };
  await mergeTrusted(clean);
  const settings = await getSettings();
  let enriched = 0;
  for (const c of clean) {
    const key = normalizeKey(String(c.address || ''));
    if (!key) continue;
    await updateTrustedEntry(key, { manuallyAdded: true });
    const network = normalizeStablecoinNetwork(c.network || c.chains?.[0]);
    const hasUserKey = network === 'tron'
      ? !!settings.tronApiKey
      : network === 'solana'
        ? !!settings.solscanApiKey
        : !!settings.etherscanApiKey;
    if (hasUserKey) {
      await handleStablecoinContactEnrichment(key).catch(() => {});
      enriched += 1;
      await sleepBriefly(220);
    }
  }
  return { saved: clean.length, enriched };
}

// W3: batch-verify network history across all saved contacts. Reuses the per-contact
// enrichment (which is user-key-gated by W4 — contacts without a matching key bail to
// 'needs_key' without an API call). 220ms paced; progress is broadcast to the book UI.
async function handleBatchStablecoinEnrichment() {
  const trusted = await getTrusted();
  const addresses = Object.values(trusted).map((e) => e.address).filter(Boolean);
  let done = 0;
  let verified = 0;
  let needsKey = 0;
  for (const addr of addresses) {
    chrome.runtime.sendMessage({ type: 'BATCH_ENRICH_PROGRESS', done, total: addresses.length }).catch(() => {});
    const entry = await handleStablecoinContactEnrichment(addr).catch(() => null);
    done += 1;
    if (entry?.enrichmentStatus === 'complete') verified += 1;
    else if (entry?.enrichmentStatus === 'needs_key') needsKey += 1;
    await sleepBriefly(220);
  }
  chrome.runtime.sendMessage({ type: 'BATCH_ENRICH_PROGRESS', done, total: addresses.length }).catch(() => {});
  return { total: addresses.length, verified, needsKey };
}

function mergeStablecoinTokenActivity(activity, rows, chainId) {
  const chainKey = String(chainId);
  for (const row of rows || []) {
    const asset = evmStablecoinAssetForTransfer(row, chainId);
    if (!asset || !STABLECOIN_ASSETS.has(asset)) continue;
    const current = activity[asset][chainKey] || emptyTokenActivity();
    const timestamp = Number(row.timeStamp || 0) > 0 ? Number(row.timeStamp) * 1000 : null;
    current.count += 1;
    if (timestamp) {
      current.firstSeen = current.firstSeen ? Math.min(current.firstSeen, timestamp) : timestamp;
      current.lastSeen = Math.max(current.lastSeen || 0, timestamp);
    }
    const contract = String(row.contractAddress || '').toLowerCase();
    if (contract && !current.contracts.includes(contract)) current.contracts.push(contract);
    activity[asset][chainKey] = current;
  }
  activity.USDT[chainKey] = activity.USDT[chainKey] || emptyTokenActivity();
  activity.USDC[chainKey] = activity.USDC[chainKey] || emptyTokenActivity();
}

function mergeTronStablecoinActivity(activity, rows) {
  for (const row of rows || []) {
    const asset = normalizeStablecoinAsset(row.token_symbol);
    if (!asset || !STABLECOIN_ASSETS.has(asset)) continue;
    const current = activity[asset].tron || emptyTokenActivity();
    const timestamp = Number(row.block_time || 0) > 0 ? Number(row.block_time) : null;
    current.count += 1;
    if (timestamp) {
      current.firstSeen = current.firstSeen ? Math.min(current.firstSeen, timestamp) : timestamp;
      current.lastSeen = Math.max(current.lastSeen || 0, timestamp);
    }
    const contract = String(row.contract_address || '');
    if (contract && !current.contracts.includes(contract)) current.contracts.push(contract);
    activity[asset].tron = current;
  }
  activity.USDT.tron = activity.USDT.tron || emptyTokenActivity();
  activity.USDC.tron = activity.USDC.tron || emptyTokenActivity();
}

function emptyTokenActivity() {
  return { count: 0, firstSeen: null, lastSeen: null, contracts: [] };
}

function chooseDominantStablecoinRoute(activity) {
  const candidates = [];
  for (const asset of ['USDT', 'USDC']) {
    for (const [network, summary] of Object.entries(activity[asset] || {})) {
      if (!summary || !summary.count) continue;
      candidates.push({ asset, network, count: summary.count, lastSeen: summary.lastSeen || 0 });
    }
  }
  candidates.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.lastSeen - a.lastSeen;
  });
  return candidates[0] || null;
}

function sleepBriefly(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flushNetworkMetrics() {
  const settings = await getSettings();
  if (settings.networkMode !== true) return { sent: false, reason: 'disabled' };
  const store = await getNetworkMetricsDaily();
  const days = Object.keys(store.days || {}).sort();
  if (!days.length) return { sent: false, reason: 'empty' };
  const version = chrome.runtime.getManifest().version;
  let sentDays = 0;
  for (const day of days) {
    const payload = sanitizeNetworkMetricsPayload({ day, counts: store.days[day] }, version);
    const hasCounts = Object.entries(payload.counts).some(([, value]) => {
      if (typeof value === 'number') return value > 0;
      return Object.values(value || {}).some((count) => count > 0);
    });
    if (!hasCounts) {
      await clearNetworkMetricsDaily(day);
      continue;
    }
    const ok = await submitNetworkMetrics(payload);
    if (!ok) {
      return sentDays > 0 ? { sent: true, days: sentDays, reason: 'partial' } : { sent: false, reason: 'network' };
    }
    await clearNetworkMetricsDaily(day);
    sentDays++;
  }
  return { sent: sentDays > 0, days: sentDays };
}

async function handleFetchHistory(walletId, address, chainIdOrList = null, opts = {}) {
  // preview mode (wallet-history import): discover trusted counterparties and return them
  // for the user to confirm, instead of silently auto-trusting them. Suspicion signals
  // (poisoning) are still recorded — those are warnings, not trusted contacts.
  const preview = opts.preview === true;
  const candidates = [];
  const settings = await getSettings();
  const apiKey = settings.etherscanApiKey || undefined;
  const wallets = await getWallets();
  const wallet = wallets.find((w) => w.id === walletId);

  // Resolve chain list: explicit param → wallet.chains → wallet.chainId → [1]
  let chainIds;
  if (Array.isArray(chainIdOrList)) chainIds = chainIdOrList;
  else if (typeof chainIdOrList === 'number') chainIds = [chainIdOrList];
  else if (wallet && wallet.chains && wallet.chains.length) chainIds = wallet.chains;
  else if (wallet && wallet.chainId) chainIds = [wallet.chainId];
  else chainIds = [1];

  function onProgress(info) {
    chrome.runtime.sendMessage({ type: 'FETCH_PROGRESS', walletId, ...info }).catch(() => {});
  }

  onProgress({ action: 'starting', page: 0, count: 0 });

  let fetchError = null;
  let totalTrusted = 0;
  let totalSuspicion = 0;
  const perChain = (wallet && wallet.perChain) ? { ...wallet.perChain } : {};

  for (const chainId of chainIds) {
    onProgress({ action: `chain ${chainId}`, page: 0, count: 0 });

    if (chainId === 'tron') {
      // --- TRON path (native TRX + all TRC-20 via Tronscan) ---
      // General wallet history so crypto-focused (non-stablecoin) wallets import real
      // counterparties; stablecoin routes are still contract-tagged in buildIndexTron.
      // Upload/scan may use Zafu's bundled key (Tronscan now requires a key for all
      // requests); per-address enrichment stays user-key-only (see handleStablecoinContactEnrichment).
      const tronKey = settings.tronApiKey || BUNDLED_TRON_KEY;
      let transfers = [];

      try {
        transfers = await fetchTronWalletTransfers(address, tronKey, onProgress);
      } catch (err) {
        fetchError = err.message;
        console.warn('[Zafu] Tronscan fetch failed:', err.message);
        continue;
      }

      const { trusted, suspicion, stats } = buildIndexTron(address, transfers, walletId);
      if (preview) { for (const e of trusted) candidates.push(e); }
      else { await mergeTrusted(trusted); }
      await mergeSuspicion(suspicion);
      submitSuspicionSignals(suspicion).catch(() => {});

      totalTrusted += trusted.length;
      totalSuspicion += suspicion.length;

      perChain.tron = {
        trustedCount: trusted.length,
        suspicionCount: suspicion.length,
        txCount: stats.txCount,
        outgoingCount: stats.outgoingCount,
        incomingCount: stats.incomingCount,
        firstTxAt: stats.firstTxAt,
        lastTxAt: stats.lastTxAt,
        fetchedAt: Date.now(),
      };
      continue;
    }

    if (chainId === 'solana') {
      // --- Solana path ---
      const solscanKey = settings.solscanApiKey || undefined;
      let transfers = [];
      let balance = 0;

      try {
        [transfers, balance] = await Promise.all([
          fetchSolanaTransfers(address, solscanKey, onProgress),
          fetchSolanaBalance(address, solscanKey).catch(() => 0),
        ]);
      } catch (err) {
        fetchError = err.message;
        console.warn('[Zafu] Solscan fetch failed:', err.message);
        continue;
      }

      const { trusted, suspicion, stats } = buildIndexSolana(address, transfers, walletId);
      if (preview) { for (const e of trusted) candidates.push(e); }
      else { await mergeTrusted(trusted); }
      await mergeSuspicion(suspicion);
      submitSuspicionSignals(suspicion).catch(() => {});

      totalTrusted += trusted.length;
      totalSuspicion += suspicion.length;

      perChain['solana'] = {
        balance,
        trustedCount: trusted.length,
        suspicionCount: suspicion.length,
        txCount: stats.txCount,
        outgoingCount: stats.outgoingCount,
        incomingCount: stats.incomingCount,
        firstTxAt: stats.firstTxAt,
        lastTxAt: stats.lastTxAt,
        fetchedAt: Date.now(),
      };
    } else {
      // --- EVM path ---
      let txList = [];
      let tokenTxList = [];
      let balance = null;

      try {
        [txList, tokenTxList, balance] = await Promise.all([
          fetchTxList(address, apiKey, onProgress, chainId),
          fetchTokenTx(address, apiKey, onProgress, chainId),
          fetchBalance(address, apiKey, chainId).catch(() => null),
        ]);
      } catch (err) {
        fetchError = err.message;
        console.warn(`[Zafu] fetch failed chain ${chainId}:`, err.message);
        continue;
      }

      const { trusted, suspicion, stats } = buildIndex(address, txList, tokenTxList, chainId, walletId);
      if (preview) { for (const e of trusted) candidates.push(e); }
      else { await mergeTrusted(trusted); }
      await mergeSuspicion(suspicion);
      submitSuspicionSignals(suspicion).catch(() => {});

      totalTrusted += trusted.length;
      totalSuspicion += suspicion.length;

      perChain[chainId] = {
        balance: balance != null ? balance : (perChain[chainId]?.balance || 0),
        trustedCount: trusted.length,
        suspicionCount: suspicion.length,
        txCount: stats.txCount,
        tokenTxCount: stats.tokenTxCount,
        outgoingCount: stats.outgoingCount,
        incomingCount: stats.incomingCount,
        failedCount: stats.failedCount,
        firstTxAt: stats.firstTxAt,
        lastTxAt: stats.lastTxAt,
        gasSpent: stats.gasSpent,
        uniqueCounterparties: stats.uniqueCounterparties,
        fetchedAt: Date.now(),
      };
    }
  }

  // Aggregate primary balance from primary chain for back-compat display
  const primaryChain = (wallet && wallet.primaryChainId) || chainIds[0];
  const primaryBalance = perChain[primaryChain]?.balance ?? null;

  const walletUpdates = {
    lastFetchedAt: Date.now(),
    chains: chainIds,
    primaryChainId: primaryChain,
    perChain,
  };
  if (primaryBalance !== null) {
    walletUpdates.balance = primaryBalance;
    walletUpdates.balanceFetchedAt = Date.now();
  }
  await updateWallet(walletId, walletUpdates);

  const allTrusted = await getTrusted();
  const auditResults = auditTrustedIndex(allTrusted);
  await updateSettings({ auditResults, firstFetchDone: true });
  bumpMetric('fetch').catch(() => {});

  // Price refresh is best-effort, async cached
  refreshPrices().catch(() => {});

  onProgress({ action: 'done', page: 0, count: totalTrusted + totalSuspicion });

  // Rank import candidates: stablecoin sends first, then by frequency, then recency.
  let rankedCandidates = null;
  if (preview) {
    rankedCandidates = candidates.sort((a, b) => {
      const sa = a.stablecoin ? 1 : 0;
      const sb = b.stablecoin ? 1 : 0;
      if (sb !== sa) return sb - sa;
      if ((b.txCount || 0) !== (a.txCount || 0)) return (b.txCount || 0) - (a.txCount || 0);
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });
  }

  return {
    trustedCount: totalTrusted,
    suspicionCount: totalSuspicion,
    auditFlags: auditResults.length,
    perChain,
    chains: chainIds,
    fetchError,
    candidates: rankedCandidates,
  };
}

// Refresh community signal list from Supabase. Use a full replacement so
// removals after review/dispute clear from clients on the next refresh.
async function refreshCommunityList() {
  const result = await fetchCommunityList();
  if (!result) return;

  const addresses = Array.isArray(result.addresses) ? result.addresses : [];
  const finalCount = typeof result.count === 'number' ? result.count : addresses.length;
  await setCommunityList({ addresses, fetchedAt: Date.now(), count: finalCount });

  await recordCommunityListSnapshot(finalCount).catch(() => {});
}

// Submit high-signal suspicion entries from a wallet fetch to the community pool.
// Only submits entries with attacker-pattern reasons; cap at 50 to limit volume.
async function submitSuspicionSignals(suspicionEntries) {
  const settings = await getSettings();
  if (settings.communityThreatSignals !== true) return;

  const HIGH_SIGNAL_REASONS = new Set(['zero-value-token', 'solana-dust', 'inbound-or-zero-value']);
  const filtered = suspicionEntries
    .filter((e) => HIGH_SIGNAL_REASONS.has(e.reason))
    .slice(0, 50);
  if (!filtered.length) return;

  const installId = await getInstallId();

  // Paced sequentially — a big wallet import can produce up to 50 signals, and firing
  // them all at once needlessly bursts the community endpoint.
  for (const entry of filtered) {
    const chain = entry.chains?.[0] || 'evm';
    await submitReport(entry.address, String(chain), 'suspicion_signal', installId).catch(() => {});
    await sleepBriefly(150);
  }
}

// Cached USD prices refresh (10 min cache)
async function refreshPrices() {
  const settings = await getSettings();
  const ts = settings.pricesFetchedAt || 0;
  if (Date.now() - ts < 10 * 60 * 1000 && settings.prices) return settings.prices;
  const prices = await fetchPrices();
  if (Object.keys(prices).length) {
    await updateSettings({ prices, pricesFetchedAt: Date.now() });
  }
  return prices;
}

console.log('[Zafu] service worker started');
