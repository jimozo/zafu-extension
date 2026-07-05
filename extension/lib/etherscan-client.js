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

// Default key used when user hasn't set their own. Public (ships in mirror) — stayzafu free tier.
// Exported so the settings UIs can reject it as a user-supplied key (shared quota).
export const BUNDLED_KEY = 'CTYNE21T46JEJWI78VZGMYIWIBJ57VNQ8P';

// Native-token and display maps — shared across popup/book UI + EVM fetch logic.
// Solana uses the string key 'solana' (not a numeric chainId). Solana is NOT in CHAIN_LIST
// because CHAIN_LIST drives EVM tx-fetch loops; Solana has no tx-fetch in v1.
export const CHAIN_NATIVE = { 1: 'ETH', 137: 'MATIC', 42161: 'ETH', 8453: 'ETH', 10: 'ETH', 56: 'BNB', solana: 'SOL', tron: 'TRX' };

export const CHAIN_LIST = [1, 137, 42161, 8453, 10, 56];

export const CHAIN_DISPLAY = {
  1: 'Ethereum', 137: 'Polygon', 42161: 'Arbitrum',
  8453: 'Base', 10: 'Optimism', 56: 'BNB Chain',
  solana: 'Solana',
  tron: 'TRON',
};

// CoinGecko ids for each native token
const CG_IDS = {
  1: 'ethereum', 137: 'matic-network', 42161: 'ethereum',
  8453: 'ethereum', 10: 'ethereum', 56: 'binancecoin',
  solana: 'solana',
  tron: 'tron',
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

function buildAccountUrl(action, address, { page = 1, offset = PAGE_SIZE, sort = 'desc', apiKey, chainId = 1 } = {}) {
  const key = apiKey || BUNDLED_KEY;
  const base = `${BASE}?chainid=${chainId}&module=account&action=${action}&address=${address}&sort=${sort}&page=${page}&offset=${offset}`;
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
  if (json.status === '0') {
    const detail = json.result ? ` — ${json.result}` : '';
    throw new Error(`Etherscan balance error: ${json.message}${detail}`);
  }
  return Number(BigInt(json.result || '0')) / 1e18;
}

/**
 * Fetch lightweight activity metadata for address Intel.
 * Etherscan does not return a total count, so txCount is exact up to sampleSize and then marked capped.
 */
export async function fetchAddressActivity(address, apiKey, chainId = 1, sampleSize = 1000) {
  if (!apiKey) throw new Error('Etherscan API key required');
  const [recentRows, firstRows] = await Promise.all([
    fetchWithBackoff(buildAccountUrl('txlist', address, { offset: sampleSize, sort: 'desc', apiKey, chainId }), 2),
    fetchWithBackoff(buildAccountUrl('txlist', address, { offset: 1, sort: 'asc', apiKey, chainId }), 2),
  ]);
  const recent = Array.isArray(recentRows) ? recentRows : [];
  const first = Array.isArray(firstRows) ? firstRows[0] : null;
  const last = recent[0] || null;
  const now = Date.now();
  const recent24h = recent.filter((tx) => toMs(tx.timeStamp) && now - toMs(tx.timeStamp) <= 24 * 60 * 60 * 1000).length;
  const recent7d = recent.filter((tx) => toMs(tx.timeStamp) && now - toMs(tx.timeStamp) <= 7 * 24 * 60 * 60 * 1000).length;

  return {
    txCount: recent.length,
    txCountCapped: recent.length >= sampleSize,
    firstSeen: toMs(first?.timeStamp),
    lastSeen: toMs(last?.timeStamp),
    recent24h,
    recent7d,
    activityLevel: activityLevel(recent.length, recent7d),
    source: 'etherscan',
  };
}

/**
 * Fetch contract/EOA metadata for an address using the caller-provided API key.
 * Returns source-labelled metadata only; API keys are never returned or cached.
 */
export async function fetchContractInfo(address, apiKey, chainId = 1) {
  if (!apiKey) throw new Error('Etherscan API key required');

  const codeUrl = `${BASE}?chainid=${chainId}&module=proxy&action=eth_getCode&address=${address}&tag=latest&apikey=${apiKey}`;
  const codeResp = await fetch(codeUrl);
  if (!codeResp.ok) throw new Error(`Etherscan code HTTP ${codeResp.status}`);
  const codeJson = await codeResp.json();
  if (codeJson.error) throw new Error(`Etherscan code error: ${codeJson.error.message || codeJson.error}`);
  const code = String(codeJson.result || '0x');
  const isContract = code !== '0x' && code !== '0x0';

  if (!isContract) {
    return {
      type: 'EOA',
      isContract: false,
      verified: null,
      contractName: null,
      source: 'etherscan',
    };
  }

  const sourceUrl = `${BASE}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`;
  const sourceResp = await fetch(sourceUrl);
  if (!sourceResp.ok) throw new Error(`Etherscan contract HTTP ${sourceResp.status}`);
  const sourceJson = await sourceResp.json();
  if (sourceJson.status === '0') throw new Error(`Etherscan contract error: ${sourceJson.message}`);
  const source = Array.isArray(sourceJson.result) ? sourceJson.result[0] || {} : {};
  const abi = String(source.ABI || '');
  const contractName = source.ContractName || null;
  const verified = abi !== 'Contract source code not verified' && (!!source.SourceCode || !!contractName);

  return {
    type: 'Contract',
    isContract: true,
    verified,
    contractName,
    source: 'etherscan',
  };
}

function toMs(timestamp) {
  const seconds = Number(timestamp || 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function activityLevel(txCount, recent7d) {
  if (recent7d >= 50) return 'high';
  if (recent7d >= 10 || txCount >= 100) return 'medium';
  if (txCount > 0) return 'low';
  return 'none';
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
