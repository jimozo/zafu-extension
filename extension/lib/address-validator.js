// address-validator.js — multi-chain address detection and normalization
// EVM + Solana + TRON + ENS

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const EVM_IN_TEXT_RE = /\b(0x[a-fA-F0-9]{40})\b/;
const ENS_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.eth$/i;

// Base58 alphabet used by Solana and TRON. Excludes 0, O, I, l.
const SOL_ALPHA = '[1-9A-HJ-NP-Za-km-z]';
const SOL_RE = new RegExp(`^${SOL_ALPHA}{32,44}$`);
const SOL_IN_TEXT_RE = new RegExp(`(?:^|[^1-9A-HJ-NP-Za-km-z])(${SOL_ALPHA}{32,44})(?:$|[^1-9A-HJ-NP-Za-km-z])`);
const TRON_RE = new RegExp(`^T${SOL_ALPHA}{33}$`);
const TRON_IN_TEXT_RE = new RegExp(`(?:^|[^1-9A-HJ-NP-Za-km-z])(T${SOL_ALPHA}{33})(?:$|[^1-9A-HJ-NP-Za-km-z])`, 'g');
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = Object.fromEntries([...BASE58_ALPHABET].map((ch, i) => [ch, i]));

export function isEvmAddress(str) {
  return EVM_RE.test(str.trim());
}

export function extractEvmAddress(text) {
  const m = text.match(EVM_IN_TEXT_RE);
  return m ? m[1] : null;
}

export function isEnsName(str) {
  return ENS_RE.test(str.trim());
}

export function isSolanaAddress(str) {
  return SOL_RE.test(str.trim());
}

export function extractSolanaAddress(text) {
  const m = text.match(SOL_IN_TEXT_RE);
  return m ? m[1] : null;
}

export function isTronAddress(str) {
  const s = str.trim();
  if (!TRON_RE.test(s)) return false;
  const decoded = base58Decode(s);
  if (!decoded || decoded.length !== 25 || decoded[0] !== 0x41) return false;
  const payload = decoded.slice(0, 21);
  const checksum = decoded.slice(21);
  return bytesEqual(checksum, sha256(sha256(payload)).slice(0, 4));
}

export function extractTronAddress(text) {
  const matches = String(text).matchAll(TRON_IN_TEXT_RE);
  for (const m of matches) {
    if (isTronAddress(m[1])) return m[1];
  }
  return null;
}

/**
 * Returns chain family for a given string, or null.
 * Order: ENS → EVM → TRON → Solana. TRON is checked before Solana because
 * TRON Base58Check addresses otherwise fit Solana's loose base58 shape.
 */
export function detectChainType(str) {
  const s = str.trim();
  if (isEnsName(s)) return 'ens';
  if (isEvmAddress(s)) return 'evm';
  if (isTronAddress(s)) return 'tron';
  if (isSolanaAddress(s)) return 'solana';
  return null;
}

/**
 * Normalize for lookup. EVM → lowercase (checksum-agnostic).
 * Solana/TRON → trim only (base58 is CASE-SENSITIVE — lowercasing corrupts keys).
 */
export function normalizeAddress(address, chainType) {
  const trimmed = address.trim();
  const chain = chainType || detectChainType(trimmed);
  if (chain === 'solana') return trimmed;
  if (chain === 'tron') return trimmed;
  return trimmed.toLowerCase();
}

/**
 * Format any address into 4-char segments joined with ' · '.
 * Preserves 0x prefix if present. Length-agnostic: works for EVM (40), Solana (32–44), or any string.
 */
export function segmentAddress(address) {
  const trimmed = String(address).trim();
  const hasPrefix = trimmed.startsWith('0x') || trimmed.startsWith('0X');
  const body = hasPrefix ? trimmed.slice(2) : trimmed;
  const segments = body.match(/.{1,4}/g) || [];
  return (hasPrefix ? '0x' : '') + segments.join(' · ');
}

// Backward-compat alias — do not remove; imported by overlay.js and legacy callers.
export const segmentEvmAddress = segmentAddress;

function base58Decode(value) {
  const bytes = [0];
  for (const ch of value) {
    const val = BASE58_MAP[ch];
    if (val === undefined) return null;
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of value) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sha256(input) {
  const bytes = Array.from(input);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  bytes.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
  bytes.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);

  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const w = new Array(64);

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + k[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = [];
  for (const word of h) {
    out.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
  }
  return Uint8Array.from(out);
}

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}
