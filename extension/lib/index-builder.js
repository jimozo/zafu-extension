// index-builder.js — Two-tier trust classification
//
// TRUSTED: addresses the user actively sent value to (outgoing, value > 0, no error).
//   These are the only addresses we label KNOWN in the overlay.
//
// SUSPICION: everything else — inbound transfers, zero-value txs, all token transfer
//   counterparties. Stored separately; used for detection but never shown as KNOWN.
//   This prevents the address-book-poisoning paradox where importing tokentx blindly
//   would mark an attacker's planted address as trusted.

import { TRON_USDT_CONTRACT, TRON_USDC_CONTRACT } from './tronscan-client.js';

const CHAIN_NAMES = { 1: 'ethereum', 137: 'polygon', 42161: 'arbitrum', 8453: 'base', 10: 'optimism', 56: 'bnb' };

// TRON stablecoin detection by canonical TRC-20 contract address (base58, case-sensitive).
// Symbol is spoofable, so — like the EVM path — only a contract match tags a transfer as a
// stablecoin route. Native TRX and arbitrary TRC-20 tokens return null (plain trusted contact).
export function tronStablecoinAssetForTransfer(tx) {
  const contract = tx.contract_address || '';
  if (contract === TRON_USDT_CONTRACT) return 'USDT';
  if (contract === TRON_USDC_CONTRACT) return 'USDC';
  return null;
}

// Stablecoin detection for wallet-history import candidates. EVM matches by known
// USDT/USDC contract address and ONLY for outgoing sends, so a fake token named
// "USDT" or "USDC" can never become trusted just by spoofing its symbol. Solana
// matches canonical mints.
export const EVM_STABLECOIN_CONTRACTS = {
  1: {
    USDT: new Set(['0xdac17f958d2ee523a2206206994597c13d831ec7']),
    USDC: new Set(['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']),
  },
  137: {
    USDT: new Set(['0xc2132d05d31c914a87c6611c10748aeb04b58e8f']),
    USDC: new Set([
      '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
      '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
    ]),
  },
  42161: {
    USDT: new Set(['0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9']),
    USDC: new Set([
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
    ]),
  },
  8453: {
    USDT: new Set([]),
    USDC: new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']),
  },
  10: {
    USDT: new Set(['0x94b008aa00579c1307b0ef2c499ad98a8ce58e58']),
    USDC: new Set([
      '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
      '0x7f5c764cbc14f9669b88837ca1490cca17c31607',
    ]),
  },
  56: {
    USDT: new Set(['0x55d398326f99059ff775485246999027b3197955']),
    USDC: new Set(['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d']),
  },
};

export function evmStablecoinAssetForTransfer(tx = {}, chainId = 1) {
  const contract = String(tx.contractAddress || '').trim().toLowerCase();
  if (!contract) return null;
  const contracts = EVM_STABLECOIN_CONTRACTS[Number(chainId)] || {};
  if (contracts.USDT?.has(contract)) return 'USDT';
  if (contracts.USDC?.has(contract)) return 'USDC';
  return null;
}

const SOLANA_STABLECOIN_MINTS = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
};

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
    const asset = evmStablecoinAssetForTransfer(tx, chainId);
    const outgoing = from === wallet && to && to !== wallet;
    const hasValue = tx.value && tx.value !== '0';

    if (outgoing && hasValue && asset) {
      // Outgoing stablecoin send → trusted counterparty (tagged). Outgoing-only, so a
      // planted inbound token can never reach trusted — poisoning guard intact.
      counterparties.add(to);
      upsertTrusted(trustedMap, to, ts, 1, [chain], origin, asset);
    } else {
      const reason = tx.value === '0' ? 'zero-value-token' : 'token-transfer';
      const counterparty = from === wallet ? to : from;
      if (counterparty && counterparty !== wallet) {
        counterparties.add(counterparty);
        if (!trustedMap.has(counterparty)) {
          upsertSuspicion(suspicionMap, counterparty, ts, reason, [chain], origin);
        }
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
      // User sent — trusted counterparty; tag USDC/USDT sends for stablecoin ranking.
      stats.outgoingCount++;
      const asset = SOLANA_STABLECOIN_MINTS[tx.token_address] || null;
      upsertTrusted(trustedMap, to, ts, 1, ['solana'], origin, asset);
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

/**
 * Build trusted and suspicion entries from Tronscan TRC-20 transfer data.
 * TRON base58 addresses are case-sensitive — do NOT lowercase.
 *
 * @param {string} walletAddress - TRON base58 address
 * @param {Array}  transferList  - Normalized rows from fetchTronStablecoinTransfers()
 *                                 ({ from_address, to_address, amount, block_time(ms) })
 * @param {string|null} walletId - Wallet ID for origin tracking
 * @returns {{ trusted: Array, suspicion: Array, stats: Object }}
 */
export function buildIndexTron(walletAddress, transferList, walletId = null) {
  const origin = walletId ? [walletId] : [];
  const trustedMap = new Map();
  const suspicionMap = new Map();

  const stats = {
    chain: 'tron',
    txCount: transferList.length,
    outgoingCount: 0,
    incomingCount: 0,
    firstTxAt: null,
    lastTxAt: null,
  };

  for (const tx of transferList) {
    const from = tx.from_address || '';
    const to = tx.to_address || '';
    const ts = Number(tx.block_time || 0); // already milliseconds

    if (ts) {
      if (!stats.firstTxAt || ts < stats.firstTxAt) stats.firstTxAt = ts;
      if (ts > (stats.lastTxAt || 0)) stats.lastTxAt = ts;
    }

    const amount = Number(tx.amount || 0);
    if (from === walletAddress && to && to !== walletAddress) {
      // User sent — value transfer is a trusted counterparty; zero-value is suspicion.
      stats.outgoingCount++;
      if (amount > 0) {
        const asset = tronStablecoinAssetForTransfer(tx);
        upsertTrusted(trustedMap, to, ts, 1, ['tron'], origin, asset);
      } else if (!trustedMap.has(to)) {
        upsertSuspicion(suspicionMap, to, ts, 'tron-zero-value', ['tron'], origin);
      }
    } else if (to === walletAddress && from && from !== walletAddress) {
      stats.incomingCount++;
      if (amount === 0 && !trustedMap.has(from)) {
        // Zero-value inbound dust — classic address-poisoning bait.
        upsertSuspicion(suspicionMap, from, ts, 'tron-dust', ['tron'], origin);
      }
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

function upsertTrusted(map, address, ts, txCount, chains, originWallets, asset = null) {
  if (map.has(address)) {
    const e = map.get(address);
    e.txCount += txCount;
    // stablecoinTxCount counts only asset-tagged (USDT/USDC) sends, so a counterparty you
    // also sent native value to doesn't inflate the "Sent N× USDT" confidence label.
    if (asset) e.stablecoinTxCount = (e.stablecoinTxCount || 0) + txCount;
    e.firstSeen = Math.min(e.firstSeen, ts);
    e.lastSeen = Math.max(e.lastSeen, ts);
    for (const c of chains) if (!e.chains.includes(c)) e.chains.push(c);
    for (const w of originWallets) if (!e.originWallets.includes(w)) e.originWallets.push(w);
    if (asset && !e.asset) e.asset = asset;
    if (asset) e.stablecoin = true;
  } else {
    map.set(address, { address, chains, txCount, stablecoinTxCount: asset ? txCount : 0, firstSeen: ts, lastSeen: ts, originWallets: [...originWallets], asset: asset || null, stablecoin: !!asset });
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
