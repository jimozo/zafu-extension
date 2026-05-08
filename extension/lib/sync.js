// sync.js — signed-in account sync for user-authored Zafu data.
// Syncs saved wallets and trusted-contact metadata only.

import { getAuthState, SUPABASE_ANON_KEY } from './auth.js';
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
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? 'evm' : 'solana';
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

async function pullRemote(googleId, since) {
  const body = { google_id: googleId };
  if (since) body.since = since;

  const res = await fetch(SYNC_PULL_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sync-pull failed (${res.status})`);
  return res.json();
}

async function pushRemote(googleId, payload) {
  const res = await fetch(SYNC_PUSH_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      google_id: googleId,
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
    nextTrusted[key] = {
      ...existing,
      address: key,
      chainId: existing.chainId || chain,
      chains: normalizeChains(existing.chains, chain),
      label: contact.label || '',
      notes: contact.notes || '',
      description: contact.description || '',
      email: contact.email || '',
      phone: contact.phone || '',
      tags: Array.isArray(contact.tags) ? contact.tags : [],
      favourite: contact.favourite === true,
      manuallyAdded: contact.manually_added === true || existing.manuallyAdded === true,
      txCount: existing.txCount || 0,
      firstSeen: existing.firstSeen || Date.now(),
      lastSeen: existing.lastSeen || Date.now(),
      etherscanLabel: existing.etherscanLabel || null,
      ensName: existing.ensName || null,
      updatedAt: Date.parse(contact.updated_at) || Date.now(),
    };
  }

  for (const wallet of data.wallets || []) {
    const key = normalizeKey(wallet.address);
    if (wallet.deleted_at) {
      nextWallets = nextWallets.filter((w) => normalizeKey(w.address) !== key);
      continue;
    }

    const existing = nextWallets.find((w) => normalizeKey(w.address) === key);
    const chains = normalizeChains(wallet.chains, detectChain(key) === 'evm' ? '1' : 'solana');
    const updates = {
      address: key,
      label: wallet.label || '',
      chains,
      chainId: chains[0],
      primaryChainId: wallet.primary_chain_id || chains[0],
      addedAt: wallet.added_at || Date.now(),
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
  if (!state.isAuthenticated || !state.googleId) return { skipped: 'signed_out' };

  const { syncMeta = {}, syncDirty = {}, syncDeletedContacts = {}, syncDeletedWallets = {} } =
    await getLocal(['syncMeta', 'syncDirty', 'syncDeletedContacts', 'syncDeletedWallets']);
  const since = reason === 'signin' ? null : syncMeta.lastPulledAt || null;

  const pulled = await pullRemote(state.googleId, since);
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
      pushed = await pushRemote(state.googleId, payload);
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
