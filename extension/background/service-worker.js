// service-worker.js — Zafu background worker
//
// Handles all API calls and storage orchestration.
// Content script and popup communicate via chrome.runtime.sendMessage.

import { fetchTxList, fetchTokenTx, fetchBalance, probeChains, fetchPrices } from '../lib/etherscan-client.js';
import { fetchSolanaTransfers, fetchSolanaBalance } from '../lib/solscan-client.js';
import { buildIndex, buildIndexSolana } from '../lib/index-builder.js';
import { auditTrustedIndex } from '../lib/self-audit.js';
import {
  getWallets,
  updateWallet,
  getTrusted,
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
} from '../lib/storage.js';
import {
  submitReport,
  fetchCommunityList,
  submitDispute,
  queuePendingReport,
  flushPendingReports,
} from '../lib/community-client.js';
import { syncNow } from '../lib/sync.js';

const SESSION_KEY_LAST_COPIED = 'lastCopiedAddress';

// Open onboarding on first install; set up 24h auto-refresh alarm
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
  }
  // Pre-warm install ID on any install/update; fetch community list immediately
  getInstallId().catch(() => {});
  refreshCommunityList().catch(() => {});
  syncNow('install').catch(() => {});
  chrome.alarms.create('auto-refresh', { periodInMinutes: 1440 });
});

// Fetch community list on browser startup (service worker restart)
chrome.runtime.onStartup.addListener(() => {
  refreshCommunityList().catch(() => {});
  flushPendingReports().catch(() => {});
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
    handleFetchHistory(msg.walletId, msg.address, msg.chainIds || msg.chainId || null)
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
    chrome.storage.session
      .set({ [SESSION_KEY_LAST_COPIED]: { address: msg.address, ts: Date.now() } })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'CLEAR_LAST_COPIED') {
    chrome.storage.session
      .remove(SESSION_KEY_LAST_COPIED)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'GET_LAST_COPIED') {
    const COPY_TTL_MS = 10 * 60 * 1000; // 10 minutes — stale session data causes false HIJACKED
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
    Promise.all([getInstallId(), chrome.storage.local.get('authState')])
      .then(async ([installId, stored]) => {
        const googleId = stored.authState?.googleId || null;
        const source = msg.source || 'user_flag';
        if (source === 'user_flag') bumpMetric('flag').catch(() => {});
        const ok = await submitReport(msg.address, msg.chain, source, installId, googleId);
        if (!ok) {
          await queuePendingReport({
            address: msg.address,
            chain: msg.chain,
            source,
            install_id: installId,
            google_id: googleId,
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
    Promise.all([getInstallId(), chrome.storage.local.get('authState')])
      .then(([installId, stored]) => {
        const googleId = stored.authState?.googleId || null;
        return submitDispute(msg.address, msg.chain, installId, msg.reason, googleId, msg.evidenceUrl || null);
      })
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

  if (msg.type === 'SYNC_NOW') {
    syncNow(msg.reason || 'message')
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

async function handleFetchHistory(walletId, address, chainIdOrList = null) {
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
      await mergeTrusted(trusted);
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
      await mergeTrusted(trusted);
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

  return {
    trustedCount: totalTrusted,
    suspicionCount: totalSuspicion,
    auditFlags: auditResults.length,
    perChain,
    chains: chainIds,
    fetchError,
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
  const HIGH_SIGNAL_REASONS = new Set(['zero-value-token', 'solana-dust', 'inbound-or-zero-value']);
  const filtered = suspicionEntries
    .filter((e) => HIGH_SIGNAL_REASONS.has(e.reason))
    .slice(0, 50);
  if (!filtered.length) return;

  const [installId, stored] = await Promise.all([
    getInstallId(),
    chrome.storage.local.get('authState'),
  ]);
  const googleId = stored.authState?.googleId || null;

  for (const entry of filtered) {
    const chain = entry.chains?.[0] || 'evm';
    submitReport(entry.address, String(chain), 'suspicion_signal', installId, googleId).catch(() => {});
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
