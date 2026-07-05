// tronscan-client.js — Tronscan API wrapper for TRON (TRC-20) address history
//
// Powers stablecoin pre-flight on TRON: USDT/USDC TRC-20 transfer history drives
// per-contact network confirmation (enrichment) and wallet-history import
// counterparty discovery.
//
// Public tier (no key) is rate-limited; a user TRON-PRO-API-KEY raises limits and is
// passed via the `TRON-PRO-API-KEY` header. TRON base58 addresses are CASE-SENSITIVE —
// never lowercase them (normalizeKey() in storage.js already leaves non-EVM keys intact).

const BASE = 'https://apilist.tronscanapi.com/api';
const PAGE_SIZE = 50;
const MAX_PAGES = 10;

// Zafu-provided TRON-PRO-API-KEY. Used as a fallback ONLY for wallet-history upload/scan
// (so users can populate their book without their own key, mirroring the bundled Etherscan
// key). Per-address enrichment/review deliberately does NOT use this — it requires the
// user's own key — so bulk review never burns Zafu's quota. Extractable from the bundle,
// same risk profile as the Etherscan bundled key.
export const BUNDLED_TRON_KEY = '9f89f60b-3a10-4534-817b-32befd831b61';

// Canonical TRC-20 stablecoin contracts on TRON mainnet.
export const TRON_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const TRON_USDC_CONTRACT = 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithBackoff(url, headers = {}, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url, { headers });
    if (resp.status === 429) {
      if (attempt === retries) throw new Error('Tronscan rate limited after retries');
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    if (resp.status === 401 || resp.status === 403) throw new Error('Tronscan API key invalid or expired');
    if (!resp.ok) throw new Error(`Tronscan HTTP ${resp.status}`);
    return resp.json();
  }
}

// Normalize a Tronscan native-TRX transfer record → common index shape.
// The /transfer endpoint uses different field names than the TRC-20 endpoint.
function normalizeNativeTransfer(item) {
  return {
    from_address: item.transferFromAddress || item.ownerAddress || '',
    to_address: item.transferToAddress || item.toAddress || '',
    amount: item.amount != null ? item.amount : 0, // sun; only >0 vs 0 matters downstream
    contract_address: '',
    token_symbol: 'TRX',
    block_time: Number(item.timestamp || item.block_ts || item.block_timestamp || 0),
    tx_hash: item.transactionHash || item.hash || '',
  };
}

// Normalize a Tronscan TRC-20 transfer record → common index shape.
// block_time is normalized to milliseconds (Tronscan returns block_ts in ms).
function normalizeTransfer(item) {
  const info = item.tokenInfo || {};
  return {
    from_address: item.from_address || '',
    to_address: item.to_address || '',
    amount: item.quant != null ? item.quant : (item.amount || 0),
    contract_address: item.contract_address || info.tokenId || '',
    token_symbol: info.tokenAbbr || info.tokenName || '',
    block_time: Number(item.block_ts || item.block_timestamp || 0),
    tx_hash: item.transaction_id || item.hash || '',
  };
}

/**
 * Fetch TRC-20 transfers for a TRON address, optionally filtered to one contract.
 * `relatedAddress` returns transfers where the address is sender OR receiver, so the
 * caller can classify outgoing (trusted) vs inbound (suspicion).
 *
 * @returns {Promise<Array<{ from_address, to_address, amount, contract_address,
 *   token_symbol, block_time, tx_hash }>>} block_time in milliseconds.
 */
export async function fetchTronTrc20Transfers(address, apiKey, onProgress, contractAddress = null) {
  const headers = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {};
  const results = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * PAGE_SIZE;
    let url = `${BASE}/token_trc20/transfers?limit=${PAGE_SIZE}&start=${start}&relatedAddress=${address}&sort=-timestamp`;
    if (contractAddress) url += `&contract_address=${contractAddress}`;
    const json = await fetchWithBackoff(url, headers);
    const items = Array.isArray(json.token_transfers)
      ? json.token_transfers
      : (Array.isArray(json.data) ? json.data : []);
    results.push(...items.map(normalizeTransfer));
    if (onProgress) onProgress({ page: page + 1, count: results.length });
    if (items.length < PAGE_SIZE) break;
    await sleep(250);
  }
  return results;
}

/**
 * Fetch USDT + USDC TRC-20 transfers for a TRON address (stablecoin-scoped).
 * token_symbol is forced to USDT/USDC so downstream merge keys cleanly.
 * USDT is the dominant TRON stablecoin route — its failure is surfaced; USDC failure is soft.
 */
export async function fetchTronStablecoinTransfers(address, apiKey, onProgress) {
  const out = [];
  for (const [symbol, contract] of [['USDT', TRON_USDT_CONTRACT], ['USDC', TRON_USDC_CONTRACT]]) {
    let rows = [];
    try {
      rows = await fetchTronTrc20Transfers(address, apiKey, onProgress, contract);
    } catch (err) {
      if (symbol === 'USDT') throw err;
      rows = [];
    }
    for (const r of rows) {
      r.token_symbol = symbol;
      out.push(r);
    }
  }
  return out;
}

/**
 * Fetch native-TRX transfers for a TRON address (general, non-stablecoin history).
 * Paginates the Tronscan /transfer endpoint the same way as the TRC-20 fetch.
 */
export async function fetchTronNativeTransfers(address, apiKey, onProgress) {
  const headers = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {};
  const results = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * PAGE_SIZE;
    const url = `${BASE}/transfer?sort=-timestamp&limit=${PAGE_SIZE}&start=${start}&address=${address}`;
    const json = await fetchWithBackoff(url, headers);
    const items = Array.isArray(json.data) ? json.data : [];
    results.push(...items.map(normalizeNativeTransfer));
    if (onProgress) onProgress({ page: page + 1, count: results.length });
    if (items.length < PAGE_SIZE) break;
    await sleep(250);
  }
  return results;
}

/**
 * Fetch general wallet history for a TRON address: native TRX + all TRC-20 transfers.
 * Used by wallet-history upload/scan so crypto-focused (non-stablecoin) wallets import
 * real counterparties. Throws only if BOTH sources fail and nothing was returned.
 */
export async function fetchTronWalletTransfers(address, apiKey, onProgress) {
  const settled = await Promise.allSettled([
    fetchTronNativeTransfers(address, apiKey, onProgress),
    fetchTronTrc20Transfers(address, apiKey, onProgress),
  ]);
  const out = [];
  for (const r of settled) if (r.status === 'fulfilled') out.push(...r.value);
  if (!out.length && settled.every((r) => r.status === 'rejected')) {
    throw settled[0].reason || new Error('Tronscan fetch failed');
  }
  return out;
}

/**
 * Fetch account intel for a single TRON address: TRX balance, total tx count,
 * account creation time, and contract-vs-EOA. Powers per-address TRON Intel/Review.
 * Field names are defensive — Tronscan's /account shape varies across addresses.
 */
export async function fetchTronAccountIntel(address, apiKey) {
  const headers = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {};
  const json = await fetchWithBackoff(`${BASE}/account?address=${address}`, headers);
  const balanceSun = Number(json.balance || 0);
  const txCount = Number(
    json.totalTransactionCount
    ?? ((Number(json.transactions_in) || 0) + (Number(json.transactions_out) || 0))
  );
  const created = Number(json.date_created || 0);
  // Tronscan marks contracts via accountType === 2 and/or a self-entry in contractMap.
  // (Verified against live /account responses for both a contract and an EOA.)
  const isContract = Boolean(
    json.accountType === 2
    || (json.contractMap && json.contractMap[address] === true)
  );
  return {
    balanceTrx: balanceSun / 1e6,
    txCount: Number.isFinite(txCount) && txCount >= 0 ? txCount : null,
    firstSeen: Number.isFinite(created) && created > 0 ? created : null,
    isContract,
  };
}
