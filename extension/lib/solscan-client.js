// solscan-client.js — Solscan API wrapper for Solana address history
//
// Routes between:
//   Public API (no key): https://public-api.solscan.io/v1.0
//   Pro API (with key):  https://pro-api.solscan.io/v2.0
//
// fetchSolanaTransfers: returns normalized transfer records for index building.
// fetchSolanaBalance:   returns SOL balance as float.
//
// Rate limits: public ~10 req/s; pro ~240 req/min.

const PUBLIC_BASE = 'https://public-api.solscan.io';
const PRO_BASE = 'https://pro-api.solscan.io/v2.0';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithBackoff(url, headers = {}, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url, { headers });
    if (resp.status === 429) {
      if (attempt === retries) throw new Error('Solscan rate limited after retries');
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    if (resp.status === 403) throw new Error('Solscan API key invalid or expired');
    if (!resp.ok) throw new Error(`Solscan HTTP ${resp.status}`);
    const json = await resp.json();
    if (json.success === false) throw new Error(`Solscan error: ${json.message || 'unknown'}`);
    return json;
  }
}

// Normalize public-API transfer record → common shape
function normalizePublicTransfer(item) {
  return {
    from_address: item.src || item.from_address || '',
    to_address: item.dst || item.to_address || '',
    amount: item.lamport || item.amount || 0,
    token_address: item.token?.tokenAddress || item.token_address || null,
    block_time: item.blockTime || item.block_time || 0,
    tx_hash: item.txHash || item.trans_id || '',
  };
}

// Normalize pro-API transfer record → common shape
function normalizeProTransfer(item) {
  return {
    from_address: item.from_address || item.src || '',
    to_address: item.to_address || item.dst || '',
    amount: item.amount || item.lamport || 0,
    token_address: item.token_address || null,
    block_time: item.block_time || item.blockTime || 0,
    tx_hash: item.trans_id || item.txHash || '',
  };
}

/**
 * Fetch all SOL + SPL token transfers for a Solana address.
 * Returns array of normalized { from_address, to_address, amount, token_address, block_time, tx_hash }.
 */
export async function fetchSolanaTransfers(address, apiKey, onProgress) {
  const results = [];

  if (apiKey) {
    // Pro API — paginated, header auth
    const headers = { token: apiKey };
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${PRO_BASE}/account/transfer?address=${address}&page=${page}&page_size=${PAGE_SIZE}&sort_by=block_time&sort_order=desc`;
      const json = await fetchWithBackoff(url, headers);
      const items = Array.isArray(json.data) ? json.data : [];
      results.push(...items.map(normalizeProTransfer));
      if (onProgress) onProgress({ page, count: results.length });
      if (items.length < PAGE_SIZE) break;
      await sleep(300);
    }
  } else {
    // Public API — offset-based pagination
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const url = `${PUBLIC_BASE}/account/transfer?account=${address}&limit=${PAGE_SIZE}&offset=${offset}`;
      const json = await fetchWithBackoff(url);
      const items = Array.isArray(json) ? json : (Array.isArray(json.data) ? json.data : []);
      results.push(...items.map(normalizePublicTransfer));
      if (onProgress) onProgress({ page: page + 1, count: results.length });
      if (items.length < PAGE_SIZE) break;
      await sleep(200);
    }
  }

  return results;
}

/**
 * Fetch SOL balance for a Solana address. Returns balance in SOL (not lamports).
 */
export async function fetchSolanaBalance(address, apiKey) {
  try {
    if (apiKey) {
      const headers = { token: apiKey };
      const url = `${PRO_BASE}/account/detail?address=${address}`;
      const json = await fetchWithBackoff(url, headers);
      const lamports = json.data?.lamports ?? json.lamports ?? 0;
      return lamports / 1e9;
    } else {
      const url = `${PUBLIC_BASE}/account/${address}`;
      const json = await fetchWithBackoff(url);
      const lamports = json.lamports ?? json.data?.lamports ?? 0;
      return lamports / 1e9;
    }
  } catch {
    return 0;
  }
}

/**
 * Fetch lightweight Solana activity metadata for address Intel.
 * Uses the transfer sample available through Solscan; txCount is capped at the fetched sample size.
 */
export async function fetchSolanaActivity(address, apiKey) {
  if (!apiKey) throw new Error('Solscan API key required');
  const transfers = await fetchSolanaTransfers(address, apiKey);
  const times = transfers
    .map((tx) => Number(tx.block_time || 0) * 1000)
    .filter((ts) => Number.isFinite(ts) && ts > 0);
  const now = Date.now();
  const recent24h = times.filter((ts) => now - ts <= 24 * 60 * 60 * 1000).length;
  const recent7d = times.filter((ts) => now - ts <= 7 * 24 * 60 * 60 * 1000).length;
  return {
    txCount: transfers.length,
    txCountCapped: transfers.length >= PAGE_SIZE * MAX_PAGES,
    firstSeen: times.length ? Math.min(...times) : null,
    lastSeen: times.length ? Math.max(...times) : null,
    recent24h,
    recent7d,
    activityLevel: activityLevel(transfers.length, recent7d),
    source: 'solscan',
  };
}

function activityLevel(txCount, recent7d) {
  if (recent7d >= 50) return 'high';
  if (recent7d >= 10 || txCount >= 100) return 'medium';
  if (txCount > 0) return 'low';
  return 'none';
}
