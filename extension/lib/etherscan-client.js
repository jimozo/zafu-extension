// etherscan-client.js — Etherscan V2 API wrapper
//
// Fetches txlist (normal txs) and tokentx (token transfers) for an EVM address.
// Both are needed: txlist for trusted counterparties, tokentx to detect suspicion sources.
//
// Requires an Etherscan API key for reliable rate limits.
// Without a key, falls back to the public tier (very limited, may 429 frequently).

const BASE = 'https://api.etherscan.io/v2/api';
const PAGE_SIZE = 1000; // max per Etherscan page
const MAX_PAGES = 10;   // caps at 10,000 txs per action type

// Default key used when user hasn't set their own. Fill before publishing.
const BUNDLED_KEY = '96UQ29U72Z6J9BKJ2U2S9V1EXMVENNBY5G';

// Native-token and display maps — shared across popup/book UI + EVM fetch logic.
// Solana uses the string key 'solana' (not a numeric chainId). Solana is NOT in CHAIN_LIST
// because CHAIN_LIST drives EVM tx-fetch loops; Solana has no tx-fetch in v1.
export const CHAIN_NATIVE = { 1: 'ETH', 137: 'MATIC', 42161: 'ETH', 8453: 'ETH', 10: 'ETH', 56: 'BNB', solana: 'SOL' };

export const CHAIN_LIST = [1, 137, 42161, 8453, 10, 56];

export const CHAIN_DISPLAY = {
  1: 'Ethereum', 137: 'Polygon', 42161: 'Arbitrum',
  8453: 'Base', 10: 'Optimism', 56: 'BNB Chain',
  solana: 'Solana',
};

// CoinGecko ids for each native token
const CG_IDS = {
  1: 'ethereum', 137: 'matic-network', 42161: 'ethereum',
  8453: 'ethereum', 10: 'ethereum', 56: 'binancecoin',
  solana: 'solana',
};

async function fetchWithBackoff(url, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url);
    if (resp.status === 429) {
      if (attempt === retries) throw new Error('Rate limited after retries');
      await sleep(1200 * 2 ** attempt);
      continue;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    // Etherscan returns status "0" with message "No transactions found" when empty — that's fine
    if (json.status === '0') {
      if (json.message === 'No transactions found') return json.result || [];
      // Rate-limit NOTOK: Etherscan returns HTTP 200 with json-level rate error
      const result = String(json.result || '');
      if (result.toLowerCase().includes('rate limit') || result.toLowerCase().includes('max rate')) {
        if (attempt === retries) throw new Error(`Rate limited: ${result}`);
        await sleep(1200 * 2 ** attempt);
        continue;
      }
      throw new Error(`Etherscan error: ${json.message}${result ? ' — ' + result : ''}`);
    }
    return json.result || [];
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildUrl(action, address, page, apiKey, chainId = 1) {
  const key = apiKey || BUNDLED_KEY;
  const base = `${BASE}?chainid=${chainId}&module=account&action=${action}&address=${address}&sort=desc&page=${page}&offset=${PAGE_SIZE}`;
  return key ? `${base}&apikey=${key}` : base;
}

/**
 * Fetch all normal transactions for a wallet address.
 * Returns raw Etherscan tx objects.
 */
export async function fetchTxList(address, apiKey, onProgress, chainId = 1) {
  const results = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = buildUrl('txlist', address, page, apiKey, chainId);
    const rows = await fetchWithBackoff(url);
    results.push(...rows);
    if (onProgress) onProgress({ action: 'txlist', page, count: results.length });
    if (rows.length < PAGE_SIZE) break; // last page
    await sleep(250); // polite pacing between pages
  }
  return results;
}

/**
 * Fetch native token balance for a wallet address. Returns balance in native units (ETH, MATIC, etc).
 */
export async function fetchBalance(address, apiKey, chainId = 1) {
  const key = apiKey || BUNDLED_KEY;
  const base = `${BASE}?chainid=${chainId}&module=account&action=balance&address=${address}`;
  const url = key ? `${base}&apikey=${key}` : base;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.status === '0') throw new Error(`Etherscan balance error: ${json.message}`);
  return Number(BigInt(json.result || '0')) / 1e18;
}

/**
 * Fetch all ERC-20 token transfer events for a wallet address.
 * Critical for detecting poisoning via zero-value/dust token sends.
 */
/**
 * Probe all EVM chains to detect where the wallet has activity.
 * Single balance + 1-tx txlist call per chain in parallel.
 * Returns [{ chainId, balance, hasActivity, firstTxAt, lastTxAt }]
 */
export async function probeChains(address, apiKey) {
  const key = apiKey || BUNDLED_KEY;
  const results = [];

  for (const chainId of CHAIN_LIST) {
    try {
      // Sequential per chain + paced to stay within 5 req/sec free tier
      const balance = await fetchBalance(address, apiKey, chainId).catch(() => 0);
      await sleep(220);

      const url = `${BASE}?chainid=${chainId}&module=account&action=txlist&address=${address}&sort=desc&page=1&offset=1&apikey=${key}`;
      const resp = await fetch(url);
      const json = await resp.json().catch(() => ({}));
      await sleep(220);

      let lastTx = null;
      let firstTxAt = null;
      let lastTxAt = null;

      if (json.status === '1' && Array.isArray(json.result) && json.result.length) {
        lastTx = json.result[0];
        lastTxAt = parseInt(lastTx.timeStamp, 10) * 1000;
        // Approximate firstTxAt from blockNumber ordering (desc sort, last entry is oldest on page)
        const oldest = json.result[json.result.length - 1];
        firstTxAt = parseInt(oldest.timeStamp, 10) * 1000;
      }

      const hasActivity = balance > 0 || lastTx !== null;
      results.push({ chainId, balance, hasActivity, firstTxAt, lastTxAt });
    } catch {
      results.push({ chainId, balance: 0, hasActivity: false, firstTxAt: null, lastTxAt: null });
      await sleep(220);
    }
  }

  return results;
}

/**
 * Fetch USD prices for native tokens across chains. Cached by caller.
 * Returns { chainId: usdPricePerToken }
 */
export async function fetchPrices() {
  const ids = [...new Set(Object.values(CG_IDS))].join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return {};
    const json = await resp.json();
    const out = {};
    for (const [chainId, cgId] of Object.entries(CG_IDS)) {
      out[chainId] = json[cgId]?.usd || 0;
    }
    return out;
  } catch {
    return {};
  }
}

export async function fetchTokenTx(address, apiKey, onProgress, chainId = 1) {
  const results = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = buildUrl('tokentx', address, page, apiKey, chainId);
    const rows = await fetchWithBackoff(url);
    results.push(...rows);
    if (onProgress) onProgress({ action: 'tokentx', page, count: results.length });
    if (rows.length < PAGE_SIZE) break;
    await sleep(250);
  }
  return results;
}
