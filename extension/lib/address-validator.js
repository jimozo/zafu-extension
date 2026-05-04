// address-validator.js — multi-chain address detection and normalization
// EVM + Solana + ENS

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const EVM_IN_TEXT_RE = /\b(0x[a-fA-F0-9]{40})\b/;
const ENS_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.eth$/i;

// Solana base58: alphabet excludes 0, O, I, l. Pubkey length 32–44 chars.
const SOL_ALPHA = '[1-9A-HJ-NP-Za-km-z]';
const SOL_RE = new RegExp(`^${SOL_ALPHA}{32,44}$`);
const SOL_IN_TEXT_RE = new RegExp(`(?:^|[^1-9A-HJ-NP-Za-km-z])(${SOL_ALPHA}{32,44})(?:$|[^1-9A-HJ-NP-Za-km-z])`);

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

/**
 * Returns chain family for a given string, or null.
 * Order: ENS → EVM → Solana. EVM checked before Solana because 0x prefix is stricter.
 */
export function detectChainType(str) {
  const s = str.trim();
  if (isEnsName(s)) return 'ens';
  if (isEvmAddress(s)) return 'evm';
  if (isSolanaAddress(s)) return 'solana';
  return null;
}

/**
 * Normalize for lookup. EVM → lowercase (checksum-agnostic).
 * Solana → trim only (base58 is CASE-SENSITIVE — lowercasing corrupts keys).
 */
export function normalizeAddress(address, chainType) {
  const trimmed = address.trim();
  const chain = chainType || detectChainType(trimmed);
  if (chain === 'solana') return trimmed;
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
