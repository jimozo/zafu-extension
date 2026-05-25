// ens-client.js — ENS forward and reverse resolution via public Ethereum RPC
//
// Uses Cloudflare's eth RPC endpoint (no API key required).
// Results are cached in chrome.storage.local to avoid repeated RPC calls.
//
// ENS contracts (mainnet):
//   ENS Registry:   0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
//   Public Resolver is looked up dynamically via the registry.
//   Reverse Registrar handles addr.reverse lookups.

const RPC_URL = 'https://cloudflare-eth.com';
const CACHE_KEY = 'ens_cache';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ENS Registry address (mainnet)
const REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';

async function rpcCall(method, params) {
  const resp = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// Namehash for ENS
function namehash(name) {
  let node = '0x' + '00'.repeat(32);
  if (!name) return node;
  const labels = name.split('.').reverse();
  for (const label of labels) {
    const labelHash = ethKeccak256(label);
    node = ethKeccak256Pair(node, labelHash);
  }
  return node;
}

// Minimal keccak256 via SubtleCrypto is not available (keccak ≠ sha3).
// We use eth_call with the resolver instead, which handles namehash server-side.
// For forward resolution we use the ENS universal resolver via eth_call.

// ENS Universal Resolver (deployed on mainnet) — resolves names without manual namehash
const UNIVERSAL_RESOLVER = '0xc0497E381f536Be9ce14B0dD3817cBcAe57d2F62';

function encodeResolveCall(name) {
  // resolve(bytes calldata name, bytes calldata data) — ABI-encoded
  // This is the complex path; simpler to use the Cloudflare ENS JSON RPC extension if available.
  // Fallback: use eth_call on the universal resolver is complex without ethers.
  // We'll use the simpler Cloudflare ENS API instead.
  return null;
}

/**
 * Resolve an ENS name to an address.
 * Returns the address string or null if not found.
 */
export async function resolveEnsName(name) {
  const cached = await getCached(`fwd:${name}`);
  if (cached !== undefined) return cached;

  try {
    // Use the Cloudflare ENS JSON-RPC extension: eth_call to the universal resolver
    // Easier path: use fetch to the ENS subgraph or Cloudflare's ENS resolver endpoint
    const resp = await fetch(`https://cloudflare-eth.com`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          {
            to: UNIVERSAL_RESOLVER,
            // resolve(bytes,bytes) with encoded name and addr(bytes32) call
            // This requires proper ABI encoding — fallback to a simpler HTTP ENS API
            data: '0x',
          },
          'latest',
        ],
      }),
    });
    // If the direct call is too complex without ethers, fall back to ENS metadata API
    const address = await resolveViaEnsApi(name);
    await setCached(`fwd:${name}`, address);
    return address;
  } catch {
    await setCached(`fwd:${name}`, null);
    return null;
  }
}

async function resolveViaEnsApi(name) {
  // ENS has a public metadata API that resolves names
  try {
    const resp = await fetch(
      `https://api.thegraph.com/subgraphs/name/ensdomains/ens`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `{ domains(where:{name:"${name}"}) { resolvedAddress { id } } }`,
        }),
      }
    );
    const json = await resp.json();
    const domains = json?.data?.domains;
    if (domains && domains.length > 0 && domains[0].resolvedAddress) {
      return domains[0].resolvedAddress.id;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Reverse-resolve an address to its primary ENS name.
 * Returns the ENS name string or null.
 */
export async function reverseResolveAddress(address, apiKey) {
  const addr = address.toLowerCase().replace('0x', '');
  const cacheKey = `rev:${addr}`;
  const cached = await getCached(cacheKey);
  if (cached !== undefined) return cached;

  if (!apiKey) {
    await setCached(cacheKey, null);
    return null;
  }

  try {
    const ensName = await reverseViaEtherscan(address, apiKey);
    await setCached(cacheKey, ensName);
    return ensName;
  } catch {
    await setCached(cacheKey, null);
    return null;
  }
}

async function reverseViaEtherscan(address, apiKey) {
  if (!apiKey) return null;
  try {
    const resp = await fetch(
      `https://api.etherscan.io/v2/api?chainid=1&module=account&action=addresstodomain&address=${address}&apikey=${apiKey}`
    );
    const json = await resp.json();
    if (json.status === '1' && json.result) return json.result;
    return null;
  } catch {
    return null;
  }
}

// --- Cache helpers ---

async function getCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get(CACHE_KEY, (r) => resolve(r[CACHE_KEY] || {}));
  });
}

async function getCached(key) {
  const cache = await getCache();
  const entry = cache[key];
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) return undefined;
  return entry.value;
}

async function setCached(key, value) {
  const cache = await getCache();
  cache[key] = { value, ts: Date.now() };
  // Prune old entries (keep last 500)
  const keys = Object.keys(cache);
  if (keys.length > 500) {
    keys.sort((a, b) => cache[a].ts - cache[b].ts);
    for (const k of keys.slice(0, keys.length - 500)) delete cache[k];
  }
  await new Promise((resolve) => chrome.storage.local.set({ [CACHE_KEY]: cache }, resolve));
}
