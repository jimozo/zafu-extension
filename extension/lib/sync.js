// sync.js — signed-in account sync for user-authored Zafu data.
// Syncs saved wallets and trusted-contact metadata only.

import { getAuthState, getGoogleAuthToken, SUPABASE_ANON_KEY } from './auth.js';
import { normalizeKey } from './storage.js';

const SYNC_PULL_URL = 'https://bluwylbyqpurcohvznxo.supabase.co/functions/v1/sync-pull';
const SYNC_PUSH_URL = 'https://bluwylbyqpurcohvznxo.supabase.co/functions/v1/sync-push';

const HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_ANON_KEY,
};

let activeSyncPromise = null;

function getLocal(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

function setLocal(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, resolve);
  });
}

function removeLocal(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, resolve);
  });
}

function detectChain(address) {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return 'evm';
  // TRON base58 (T + 33) would otherwise fall through to the Solana bucket and
  // misroute Intel/enrichment for TRON rows synced without a chain value.
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return 'tron';
  return 'solana';
}

function hasUserContactFields(entry) {
  return entry.manuallyAdded === true ||
    !!entry.label ||
    !!entry.notes ||
    !!entry.description ||
    !!entry.email ||
    !!entry.phone ||
    !!entry.favourite ||
    (Array.isArray(entry.tags) && entry.tags.length > 0);
}

function normalizeChains(chains, fallback) {
  const values = Array.isArray(chains) ? chains : [];
  const normalized = values.map((chain) => String(chain)).filter(Boolean);
  return normalized.length ? [...new Set(normalized)] : [fallback];
}

// C: history confirmation syncs across devices, but the *provenance* stays device-local.
// A local scan always wins; if only the remote carries 'history', this device adopts the
// route and (via historyFromSync in applyPull) labels it "confirmed on your other device"
// rather than claiming this device verified it.
function mergeConfidence(existingValue, remoteValue) {
  if (existingValue === 'history') return 'history';
  if (remoteValue === 'history') return 'history';
  return remoteValue || existingValue || null;
}

function authHeaders(token) {
  return {
    ...HEADERS,
    'Authorization': `Bearer ${token}`,
  };
}

async function pullRemote(token, since) {
  const body = {};
  if (since) body.since = since;

  const res = await fetch(SYNC_PULL_URL, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sync-pull failed (${res.status})`);
  return res.json();
}

async function pushRemote(token, payload) {
  const res = await fetch(SYNC_PUSH_URL, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      contacts: payload.contacts,
      wallets: payload.wallets,
    }),
  });
  if (!res.ok) throw new Error(`sync-push failed (${res.status})`);
  return res.json();
}

async function applyPull(data) {
  const { trusted = {}, wallets = [] } = await getLocal(['trusted', 'wallets']);
  const nextTrusted = { ...trusted };
  let nextWallets = [...wallets];

  for (const contact of data.contacts || []) {
    const key = normalizeKey(contact.address);
    if (contact.deleted_at) {
      delete nextTrusted[key];
      continue;
    }

    const existing = nextTrusted[key] || {};
    const chain = contact.chain || existing.chainId || detectChain(key);
    const networkConfidence = mergeConfidence(existing.networkConfidence, contact.network_confidence);
    // Provenance (device-local, never synced): true only when we adopt a remote 'history'
    // this device did not scan itself, so the card says "confirmed on your other device"
    // instead of claiming this device verified the route. A later local scan clears it.
    const historyFromSync = networkConfidence === 'history'
      ? (existing.networkConfidence === 'history' ? existing.historyFromSync === true : true)
      : false;
    // Conflict guard: pull runs before push, and a full pull (sign-in) returns rows this
    // device may have edited more recently — e.g. renames made while signed out. If the
    // local entry is newer than the remote row, keep the local user-authored fields; the
    // push that follows sends them up. Remote deletions still win (handled above).
    const remoteUpdatedAt = Date.parse(contact.updated_at) || 0;
    const localNewer = Number(existing.updatedAt || 0) > remoteUpdatedAt;
    nextTrusted[key] = {
      ...existing,
      address: key,
      chainId: existing.chainId || chain,
      chains: normalizeChains(existing.chains, chain),
      label: localNewer ? (existing.label || '') : (contact.label || ''),
      notes: localNewer ? (existing.notes || '') : (contact.notes || ''),
      description: localNewer ? (existing.description || '') : (contact.description || ''),
      email: localNewer ? (existing.email || '') : (contact.email || ''),
      phone: localNewer ? (existing.phone || '') : (contact.phone || ''),
      tags: localNewer
        ? (Array.isArray(existing.tags) ? existing.tags : [])
        : (Array.isArray(contact.tags) ? contact.tags : []),
      favourite: localNewer ? existing.favourite === true : contact.favourite === true,
      manuallyAdded: contact.manually_added === true || existing.manuallyAdded === true,
      // Stablecoin-route scalars: prefer a non-empty value either side so an empty
      // remote (a device that never enriched) never clobbers a confirmed local route.
      // The big activity maps survive via the `...existing` spread (not synced).
      asset: localNewer
        ? (existing.asset || contact.asset || null)
        : (contact.asset || existing.asset || null),
      assetType: localNewer
        ? (existing.assetType || (contact.asset_type === 'token' ? 'token' : 'stablecoin'))
        : (contact.asset_type === 'token' ? 'token' : (existing.assetType || 'stablecoin')),
      network: localNewer
        ? (existing.network || contact.network || null)
        : (contact.network || existing.network || null),
      networkConfidence,
      historyFromSync,
      dominantStablecoinAsset: contact.dominant_stablecoin_asset || existing.dominantStablecoinAsset || null,
      dominantStablecoinNetwork: contact.dominant_stablecoin_network || existing.dominantStablecoinNetwork || null,
      dominantStablecoinTransferCount: contact.dominant_stablecoin_transfer_count || existing.dominantStablecoinTransferCount || 0,
      enrichmentStatus: contact.enrichment_status || existing.enrichmentStatus || null,
      txCount: existing.txCount || 0,
      firstSeen: existing.firstSeen || Date.now(),
      lastSeen: existing.lastSeen || Date.now(),
      etherscanLabel: existing.etherscanLabel || null,
      ensName: existing.ensName || null,
      updatedAt: localNewer ? existing.updatedAt : (remoteUpdatedAt || Date.now()),
    };
  }

  for (const wallet of data.wallets || []) {
    const key = normalizeKey(wallet.address);
    if (wallet.deleted_at) {
      nextWallets = nextWallets.filter((w) => normalizeKey(w.address) !== key);
      continue;
    }

    const existing = nextWallets.find((w) => normalizeKey(w.address) === key);
    const fallbackChain = detectChain(key);
    const chains = normalizeChains(wallet.chains, fallbackChain === 'evm' ? '1' : fallbackChain);
    // Same conflict guard as contacts: a local wallet rename newer than the remote row
    // survives the pull and rides the following push.
    const remoteUpdatedAt = Date.parse(wallet.updated_at) || 0;
    const localNewer = !!existing && Number(existing.updatedAt || existing.addedAt || 0) > remoteUpdatedAt;
    const updates = {
      address: key,
      label: localNewer ? (existing.label || '') : (wallet.label || ''),
      chains: localNewer ? normalizeChains(existing.chains, chains[0]) : chains,
      chainId: localNewer ? (existing.chainId || chains[0]) : chains[0],
      primaryChainId: localNewer
        ? (existing.primaryChainId || chains[0])
        : (wallet.primary_chain_id || chains[0]),
      addedAt: wallet.added_at || existing?.addedAt || Date.now(),
      updatedAt: localNewer ? existing.updatedAt : (remoteUpdatedAt || Date.now()),
      lastFetchedAt: existing?.lastFetchedAt || null,
      perChain: existing?.perChain || {},
    };

    if (existing) {
      Object.assign(existing, updates);
    } else {
      nextWallets.push({ id: crypto.randomUUID(), ...updates });
    }
  }

  await setLocal({
    trusted: nextTrusted,
    wallets: nextWallets,
    syncMeta: {
      ...((await getLocal('syncMeta')).syncMeta || {}),
      lastPulledAt: data.serverTime || new Date().toISOString(),
    },
  });
}

async function buildPushPayload() {
  const {
    trusted = {},
    wallets = [],
    syncDeletedContacts = {},
    syncDeletedWallets = {},
  } = await getLocal(['trusted', 'wallets', 'syncDeletedContacts', 'syncDeletedWallets']);

  const contacts = Object.values(trusted)
    .filter(hasUserContactFields)
    .map((entry) => {
      const address = normalizeKey(entry.address);
      const chain = entry.chainId || entry.chains?.[0] || detectChain(address);
      // Sync the small stablecoin-route scalars so saved route + confidence survive to a
      // second device. 'history' rides sync (C); the receiving device records it as synced
      // provenance (historyFromSync) so it never claims it verified the route itself.
      const enrichmentStatus = entry.enrichmentStatus === 'checking' ? null : (entry.enrichmentStatus || null);
      const networkConfidence = entry.networkConfidence || null;
      return {
        address,
        chain: String(chain),
        label: entry.label || '',
        notes: entry.notes || '',
        description: entry.description || '',
        email: entry.email || '',
        phone: entry.phone || '',
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        favourite: entry.favourite === true,
        manuallyAdded: entry.manuallyAdded === true,
        asset: entry.asset || null,
        assetType: entry.assetType === 'token' ? 'token' : 'stablecoin',
        network: entry.network || null,
        networkConfidence,
        dominantStablecoinAsset: entry.dominantStablecoinAsset || null,
        dominantStablecoinNetwork: entry.dominantStablecoinNetwork || null,
        dominantStablecoinTransferCount: Number(entry.dominantStablecoinTransferCount) || 0,
        enrichmentStatus,
      };
    });

  for (const entry of Object.values(syncDeletedContacts)) {
    contacts.push({ address: normalizeKey(entry.address), deletedAt: entry.deletedAt || Date.now() });
  }

  const walletRows = wallets.map((wallet) => {
    const address = normalizeKey(wallet.address);
    const chains = normalizeChains(wallet.chains, wallet.chainId || detectChain(address));
    return {
      address,
      label: wallet.label || '',
      chains,
      primaryChainId: wallet.primaryChainId || chains[0],
      addedAt: wallet.addedAt || Date.now(),
    };
  });

  for (const entry of Object.values(syncDeletedWallets)) {
    walletRows.push({ address: normalizeKey(entry.address), deletedAt: entry.deletedAt || Date.now() });
  }

  return { contacts, wallets: walletRows };
}

async function runSync(reason) {
  const state = await getAuthState();
  if (!state.isAuthenticated) return { skipped: 'signed_out' };

  const token = await getGoogleAuthToken();
  if (!token) return { skipped: 'signed_out' };

  const { syncMeta = {}, syncDirty = {}, syncDeletedContacts = {}, syncDeletedWallets = {} } =
    await getLocal(['syncMeta', 'syncDirty', 'syncDeletedContacts', 'syncDeletedWallets']);
  const since = reason === 'signin' ? null : syncMeta.lastPulledAt || null;

  const pulled = await pullRemote(token, since);
  await applyPull(pulled);

  const shouldPush = reason === 'signin' ||
    syncDirty.contacts ||
    syncDirty.wallets ||
    Object.keys(syncDeletedContacts).length > 0 ||
    Object.keys(syncDeletedWallets).length > 0 ||
    !syncMeta.firstPushDone;

  let pushed = null;
  if (shouldPush) {
    const payload = await buildPushPayload();
    if (payload.contacts.length || payload.wallets.length) {
      pushed = await pushRemote(token, payload);
    }
    await removeLocal(['syncDirty', 'syncDeletedContacts', 'syncDeletedWallets']);
  }

  const serverTime = pushed?.serverTime || pulled.serverTime || new Date().toISOString();
  await setLocal({
    syncMeta: {
      lastPulledAt: pulled.serverTime || serverTime,
      lastSyncedAt: serverTime,
      lastReason: reason,
      firstPushDone: true,
    },
  });

  return { ok: true, pushed: !!pushed, serverTime };
}

export function syncNow(reason = 'manual') {
  if (activeSyncPromise) return activeSyncPromise;
  activeSyncPromise = runSync(reason)
    .catch(async (err) => {
      await setLocal({
        syncMeta: {
          ...((await getLocal('syncMeta')).syncMeta || {}),
          lastError: err.message,
          lastErrorAt: Date.now(),
        },
      });
      throw err;
    })
    .finally(() => {
      activeSyncPromise = null;
    });
  return activeSyncPromise;
}
