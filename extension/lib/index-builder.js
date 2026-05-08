// index-builder.js — Two-tier trust classification
//
// TRUSTED: addresses the user actively sent value to (outgoing, value > 0, no error).
//   These are the only addresses we label KNOWN in the overlay.
//
// SUSPICION: everything else — inbound transfers, zero-value txs, all token transfer
//   counterparties. Stored separately; used for detection but never shown as KNOWN.
//   This prevents the address-book-poisoning paradox where importing tokentx blindly
//   would mark an attacker's planted address as trusted.

const CHAIN_NAMES = { 1: 'ethereum', 137: 'polygon', 42161: 'arbitrum', 8453: 'base', 10: 'optimism', 56: 'bnb' };

/**
 * Build trusted and suspicion entries from raw Etherscan data.
 *
 * @param {string} walletAddress - The wallet we fetched for (lowercase)
 * @param {Array}  txList        - Raw rows from fetchTxList()
 * @param {Array}  tokenTxList   - Raw rows from fetchTokenTx()
 * @param {number} chainId       - EVM chain ID (default: 1 = Ethereum)
 * @param {string|null} walletId - Wallet ID for origin tracking
 * @returns {{ trusted: Array, suspicion: Array }}
 */
export function buildIndex(walletAddress, txList, tokenTxList, chainId = 1, walletId = null) {
  const wallet = walletAddress.toLowerCase();
  const chain = CHAIN_NAMES[chainId] || 'ethereum';
  const origin = walletId ? [walletId] : [];

  // Map: address → aggregated metadata
  const trustedMap = new Map();
  const suspicionMap = new Map();

  // Stats aggregated for wallet-manager view
  const stats = {
    chainId,
    txCount: txList.length,
    tokenTxCount: tokenTxList.length,
    outgoingCount: 0,
    incomingCount: 0,
    failedCount: 0,
    firstTxAt: null,
    lastTxAt: null,
    gasSpentWei: 0n,
    uniqueCounterparties: 0,
  };

  const counterparties = new Set();

  // --- Normal transactions ---
  for (const tx of txList) {
    const from = (tx.from || '').toLowerCase();
    const to = (tx.to || '').toLowerCase();
    const value = BigInt(tx.value || '0');
    const isError = tx.isError === '1';
    const ts = parseInt(tx.timeStamp || '0', 10) * 1000;

    if (ts) {
      if (!stats.firstTxAt || ts < stats.firstTxAt) stats.firstTxAt = ts;
      if (ts > (stats.lastTxAt || 0)) stats.lastTxAt = ts;
    }
    if (isError) stats.failedCount++;
    if (from === wallet) {
      stats.outgoingCount++;
      // Gas paid by wallet on outgoing
      try {
        const gasUsed = BigInt(tx.gasUsed || '0');
        const gasPrice = BigInt(tx.gasPrice || '0');
        stats.gasSpentWei += gasUsed * gasPrice;
      } catch { /* ignore */ }
    } else if (to === wallet) {
      stats.incomingCount++;
    }

    if (from === wallet && to && value > 0n && !isError) {
      counterparties.add(to);
      upsertTrusted(trustedMap, to, ts, 1, [chain], origin);
    } else {
      const counterparty = from === wallet ? to : from;
      if (counterparty && counterparty !== wallet) {
        counterparties.add(counterparty);
        upsertSuspicion(suspicionMap, counterparty, ts, 'inbound-or-zero-value', [chain], origin);
      }
    }
  }

  // --- Token transfers ---
  for (const tx of tokenTxList) {
    const from = (tx.from || '').toLowerCase();
    const to = (tx.to || '').toLowerCase();
    const ts = parseInt(tx.timeStamp || '0', 10) * 1000;
    const reason = tx.value === '0' ? 'zero-value-token' : 'token-transfer';

    const counterparty = from === wallet ? to : from;
    if (counterparty && counterparty !== wallet) {
      counterparties.add(counterparty);
      if (!trustedMap.has(counterparty)) {
        upsertSuspicion(suspicionMap, counterparty, ts, reason, [chain], origin);
      }
    }
  }

  stats.uniqueCounterparties = counterparties.size;
  stats.trustedCount = trustedMap.size;
  stats.suspicionCount = suspicionMap.size;
  // Convert bigint to string for safe storage
  stats.gasSpent = Number(stats.gasSpentWei) / 1e18;
  delete stats.gasSpentWei;

  return {
    trusted: Array.from(trustedMap.values()),
    suspicion: Array.from(suspicionMap.values()),
    stats,
  };
}

/**
 * Build trusted and suspicion entries from Solscan transfer data.
 *
 * @param {string} walletAddress - The Solana wallet address (case-sensitive base58)
 * @param {Array}  transferList  - Normalized rows from fetchSolanaTransfers()
 * @param {string|null} walletId - Wallet ID for origin tracking
 * @returns {{ trusted: Array, suspicion: Array, stats: Object }}
 */
export function buildIndexSolana(walletAddress, transferList, walletId = null) {
  const origin = walletId ? [walletId] : [];
  const trustedMap = new Map();
  const suspicionMap = new Map();

  const stats = {
    chain: 'solana',
    txCount: transferList.length,
    outgoingCount: 0,
    incomingCount: 0,
    firstTxAt: null,
    lastTxAt: null,
  };

  for (const tx of transferList) {
    const from = tx.from_address || '';
    const to = tx.to_address || '';
    const ts = (tx.block_time || 0) * 1000;

    if (ts) {
      if (!stats.firstTxAt || ts < stats.firstTxAt) stats.firstTxAt = ts;
      if (ts > (stats.lastTxAt || 0)) stats.lastTxAt = ts;
    }

    if (from === walletAddress && to && to !== walletAddress) {
      // User sent — trusted counterparty
      stats.outgoingCount++;
      upsertTrusted(trustedMap, to, ts, 1, ['solana'], origin);
    } else if (to === walletAddress && from && from !== walletAddress) {
      stats.incomingCount++;
      if (tx.amount === 0 || tx.amount === '0') {
        // Zero-value dust — suspicion
        if (!trustedMap.has(from)) {
          upsertSuspicion(suspicionMap, from, ts, 'solana-dust', ['solana'], origin);
        }
      }
      // Non-zero inbound from unknown: normal receive, skip (not suspicion, not trusted)
    }
  }

  stats.trustedCount = trustedMap.size;
  stats.suspicionCount = suspicionMap.size;

  return {
    trusted: Array.from(trustedMap.values()),
    suspicion: Array.from(suspicionMap.values()),
    stats,
  };
}

function upsertTrusted(map, address, ts, txCount, chains, originWallets) {
  if (map.has(address)) {
    const e = map.get(address);
    e.txCount += txCount;
    e.firstSeen = Math.min(e.firstSeen, ts);
    e.lastSeen = Math.max(e.lastSeen, ts);
    for (const c of chains) if (!e.chains.includes(c)) e.chains.push(c);
    for (const w of originWallets) if (!e.originWallets.includes(w)) e.originWallets.push(w);
  } else {
    map.set(address, { address, chains, txCount, firstSeen: ts, lastSeen: ts, originWallets: [...originWallets] });
  }
}

function upsertSuspicion(map, address, ts, reason, chains, originWallets) {
  if (map.has(address)) {
    const e = map.get(address);
    e.lastSeen = Math.max(e.lastSeen, ts);
    for (const c of chains) if (!e.chains.includes(c)) e.chains.push(c);
    for (const w of originWallets) if (!e.originWallets.includes(w)) e.originWallets.push(w);
  } else {
    map.set(address, { address, reason, chains, firstSeen: ts, lastSeen: ts, originWallets: [...originWallets] });
  }
}
