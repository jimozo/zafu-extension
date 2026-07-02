// transfer-context.js - scoped stablecoin transfer context helpers

export const TRANSFER_CONTEXT_SCHEMA_VERSION = 1;

const HELP_MODES = new Set(['guided', 'standard', 'operator']);

const ASSET_HINTS = [
  { asset: 'USDT', pattern: /\b(usdt|tether)\b/i },
  { asset: 'USDC', pattern: /\b(usdc|usd\s*coin)\b/i },
  { asset: 'ETH', pattern: /\b(eth|ethereum)\b/i },
  { asset: 'SOL', pattern: /\b(sol|solana)\b/i },
  { asset: 'TRX', pattern: /\b(trx|tron)\b/i },
];

const NETWORK_HINTS = [
  { selectedNetwork: 'tron', networkLabel: 'TRON/TRC-20', pattern: /\b(tron|trx|trc[-\s]?20)\b/i },
  { selectedNetwork: 'base', networkLabel: 'Base', pattern: /\bbase\b/i },
  { selectedNetwork: 'ethereum', networkLabel: 'Ethereum/ERC-20', pattern: /\b(ethereum|erc[-\s]?20|eth\s*mainnet)\b/i },
  { selectedNetwork: 'bnb', networkLabel: 'BNB/BEP-20', pattern: /\b(bnb|bsc|bep[-\s]?20|binance smart chain)\b/i },
  { selectedNetwork: 'polygon', networkLabel: 'Polygon', pattern: /\b(polygon|matic)\b/i },
  { selectedNetwork: 'arbitrum', networkLabel: 'Arbitrum', pattern: /\b(arbitrum|arb)\b/i },
  { selectedNetwork: 'optimism', networkLabel: 'Optimism', pattern: /\b(optimism|op mainnet)\b/i },
  { selectedNetwork: 'solana', networkLabel: 'Solana', pattern: /\b(solana|sol)\b/i },
];

const EVM_NETWORKS = new Set(['ethereum', 'base', 'bnb', 'polygon', 'arbitrum', 'optimism']);

const STABLECOIN_NETWORKS = {
  '1': { key: 'ethereum', label: 'Ethereum/ERC-20', shortLabel: 'Ethereum', addressType: 'evm' },
  '137': { key: 'polygon', label: 'Polygon', shortLabel: 'Polygon', addressType: 'evm' },
  '42161': { key: 'arbitrum', label: 'Arbitrum', shortLabel: 'Arbitrum', addressType: 'evm' },
  '8453': { key: 'base', label: 'Base', shortLabel: 'Base', addressType: 'evm' },
  '10': { key: 'optimism', label: 'Optimism', shortLabel: 'Optimism', addressType: 'evm' },
  '56': { key: 'bnb', label: 'BNB/BEP-20', shortLabel: 'BNB', addressType: 'evm' },
  tron: { key: 'tron', label: 'TRON/TRC-20', shortLabel: 'TRON', addressType: 'tron' },
  solana: { key: 'solana', label: 'Solana', shortLabel: 'Solana', addressType: 'solana' },
};

const NETWORK_ALIASES = {
  ethereum: '1',
  eth: '1',
  erc20: '1',
  'erc-20': '1',
  polygon: '137',
  matic: '137',
  arbitrum: '42161',
  arb: '42161',
  base: '8453',
  optimism: '10',
  op: '10',
  bnb: '56',
  bsc: '56',
  bep20: '56',
  'bep-20': '56',
  tron: 'tron',
  trx: 'tron',
  trc20: 'tron',
  'trc-20': 'tron',
  sol: 'solana',
  solana: 'solana',
};

export function normalizeHelpMode(value) {
  return HELP_MODES.has(value) ? value : 'standard';
}

export function createCoreTransferContext(input = {}) {
  const fieldContextText = String(input.fieldContextText || '');
  const asset = detectAssetHint(fieldContextText);
  const network = detectNetworkHint(fieldContextText);
  const flow = detectFlowHint(fieldContextText);
  const memo = detectMemoContext(fieldContextText);
  const addressType = normalizeAddressType(input.addressType);

  return {
    schemaVersion: TRANSFER_CONTEXT_SCHEMA_VERSION,
    surface: detectSurface(input),
    flow,
    asset,
    selectedNetwork: network.selectedNetwork,
    networkLabel: network.networkLabel,
    pastedAddress: input.address || null,
    addressType,
    memoRequired: memo.required,
    memoPresent: memo.present,
    finalConfirmationObserved: false,
    confidence: {
      asset: asset ? 'field' : 'unknown',
      selectedNetwork: network.selectedNetwork ? 'field' : 'unknown',
      flow: flow !== 'unknown' ? 'field' : 'unknown',
      memo: memo.confidence,
    },
    recipientFieldDetected: input.recipientFieldDetected === true,
    cryptoPageDetected: input.cryptoPageDetected === true,
    telegramWebDetected: input.telegramWebDetected === true,
  };
}

export function detectAssetHint(text) {
  const value = String(text || '');
  const hint = ASSET_HINTS.find((entry) => entry.pattern.test(value));
  return hint ? hint.asset : null;
}

export function detectNetworkHint(text) {
  const value = String(text || '');
  const hint = NETWORK_HINTS.find((entry) => entry.pattern.test(value));
  return hint
    ? { selectedNetwork: hint.selectedNetwork, networkLabel: hint.networkLabel }
    : { selectedNetwork: null, networkLabel: null };
}

export function normalizeStablecoinAsset(value) {
  const asset = String(value || '').trim().toUpperCase();
  return asset === 'USDT' || asset === 'USDC' ? asset : null;
}

export function normalizeStablecoinNetwork(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim().toLowerCase();
  if (STABLECOIN_NETWORKS[raw]) return raw;
  return NETWORK_ALIASES[raw] || null;
}

export function stablecoinNetworkLabel(value) {
  const network = normalizeStablecoinNetwork(value);
  return network ? STABLECOIN_NETWORKS[network]?.label || null : null;
}

export function stablecoinShortNetworkLabel(value) {
  const network = normalizeStablecoinNetwork(value);
  return network ? STABLECOIN_NETWORKS[network]?.shortLabel || stablecoinNetworkLabel(network) : null;
}

export function stablecoinNetworkKey(value) {
  const network = normalizeStablecoinNetwork(value);
  return network ? STABLECOIN_NETWORKS[network]?.key || network : null;
}

export function stablecoinNetworkAddressType(value) {
  const network = normalizeStablecoinNetwork(value);
  return network ? STABLECOIN_NETWORKS[network]?.addressType || 'unknown' : 'unknown';
}

export function getContactStablecoinAsset(entry = {}) {
  return normalizeStablecoinAsset(entry.asset || entry.dominantStablecoinAsset);
}

export function getContactStablecoinNetwork(entry = {}) {
  return normalizeStablecoinNetwork(
    entry.network ||
    entry.dominantStablecoinNetwork ||
    entry.chainId ||
    entry.primaryChainId ||
    entry.chains?.[0]
  );
}

export function isContactNetworkConfirmed(entry = {}) {
  // C: only a scan on THIS device counts as locally confirmed. A 'history' route adopted
  // from account sync (historyFromSync) is reported separately via isContactConfirmedElsewhere
  // so this device never claims the strong "Confirmed: N transfers" / "checked route".
  return entry.networkConfidence === 'history' &&
    entry.historyFromSync !== true &&
    !!getContactStablecoinAsset(entry) &&
    !!getContactStablecoinNetwork(entry) &&
    Number(entry.dominantStablecoinTransferCount || 0) > 0;
}

// C: 'history' confirmation that arrived via account sync, not a scan on this device.
export function isContactConfirmedElsewhere(entry = {}) {
  return entry.networkConfidence === 'history' &&
    entry.historyFromSync === true &&
    !!getContactStablecoinAsset(entry) &&
    !!getContactStablecoinNetwork(entry);
}

// W7: a contact is either a stablecoin (USDT/USDC, the loud default) or an arbitrary
// "other token". Token contacts get generic chain-activity confidence — never a
// token-specific "confirmed N USDT" claim.
export function getContactAssetType(entry = {}) {
  return entry.assetType === 'token' ? 'token' : 'stablecoin';
}

export function normalizeTokenSymbol(value) {
  const sym = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return sym ? sym.slice(0, 12) : null;
}

// Display asset for either type: USDT/USDC for stablecoins, the free symbol for tokens.
export function getContactDisplayAsset(entry = {}) {
  return getContactAssetType(entry) === 'token'
    ? normalizeTokenSymbol(entry.asset)
    : getContactStablecoinAsset(entry);
}

export function contactCopyCtaLabel(entry = {}) {
  return isContactNetworkConfirmed(entry) ? 'Copy checked route' : 'Copy saved address';
}

export function stablecoinInstructionLine(entry = {}) {
  const network = getContactStablecoinNetwork(entry);
  const label = stablecoinNetworkLabel(network);
  if (getContactAssetType(entry) === 'token') {
    const sym = normalizeTokenSymbol(entry.asset);
    if (sym && label) return `Send ${sym} on ${label}`;
    if (sym) return `Confirm the intended network before sending ${sym}`;
    if (label) return `Confirm the intended token for ${label}`;
    return 'Confirm token and network before sending';
  }
  const asset = getContactStablecoinAsset(entry);
  if (asset && label) return `Send ${asset} on ${label}`;
  if (asset) return `Confirm the intended network before sending ${asset}`;
  if (label) return `Confirm the intended asset for ${label}`;
  return 'Confirm asset and network before sending';
}

// C: one named confidence model on every card. `label` is the headline state; `detail`
// carries the specifics; raw Intel stays reachable on expand. `action` drives the post-send
// receipt CTA (S). States, most→least concern: review · known-recipient · checked-route ·
// needs-test · saved-instruction · not-checked.
const STALE_SEND_MS = 180 * 24 * 60 * 60 * 1000;

const CONFIDENCE_LABELS = {
  review: 'Review',
  'known-recipient': 'Known recipient',
  'checked-route': 'Checked route',
  'needs-test': 'Needs test',
  'saved-instruction': 'Saved instruction',
  'not-checked': 'Network not checked',
};

function confidence(state, detail, extra = {}) {
  return { state, label: CONFIDENCE_LABELS[state], detail: detail || null, action: extra.action || null };
}

export function stablecoinConfidence(entry = {}, opts = {}) {
  const assetType = getContactAssetType(entry);
  const asset = getContactStablecoinAsset(entry);
  const network = getContactStablecoinNetwork(entry);
  const shortLabel = stablecoinShortNetworkLabel(network);
  const count = Number(entry.dominantStablecoinTransferCount || 0);

  // Review overrides everything: a route conflict, or a saved lookalike of another contact.
  if (entry.networkConfidence === 'mismatch') {
    return confidence('review',
      asset && entry.dominantStablecoinNetwork
        ? `History differs: ${asset} activity on ${stablecoinShortNetworkLabel(entry.dominantStablecoinNetwork)}`
        : 'Saved route differs from on-chain history — re-check before sending');
  }
  if (opts.flaggedLookalike) {
    return confidence('review', 'Looks like another saved address — confirm before sending');
  }

  // Token contacts: lighter saved-instruction path; never a stablecoin "confirmed" claim.
  if (assetType === 'token') {
    const sym = normalizeTokenSymbol(entry.asset);
    if (entry.enrichmentStatus === 'checking') return confidence('saved-instruction', 'Checking chain activity');
    if (entry.enrichmentStatus === 'needs_key') return confidence('saved-instruction', 'Add an API key to check activity');
    if (entry.networkConfidence === 'active' && shortLabel) return confidence('checked-route', `Active on ${shortLabel}`);
    if (shortLabel) return confidence('saved-instruction', sym ? `Send ${sym} on ${stablecoinNetworkLabel(network)}` : null);
    return confidence('not-checked', null);
  }

  // Known recipient: a send confirmed on THIS device (the strong, retention state).
  // Checked before enrichment transients: a keyless or in-flight enrichment pass must not
  // demote an already-confirmed route back to "Needs test".
  if (isContactNetworkConfirmed(entry)) {
    const since = entry.lastConfirmedSendAt ? formatSince(entry.lastConfirmedSendAt) : null;
    const stale = entry.lastConfirmedSendAt
      ? (Date.now() - Number(entry.lastConfirmedSendAt)) > STALE_SEND_MS
      : false;
    const detail = `Sent ${count}×${asset ? ` ${asset}` : ''}${shortLabel ? ` on ${shortLabel}` : ''}` +
      (since ? ` · last ${since}` : '') + (stale ? ' · re-check' : '');
    return confidence('known-recipient', detail, { action: 'repeat' });
  }

  // Checked route: history adopted from another device via account sync.
  if (isContactConfirmedElsewhere(entry)) {
    return confidence('checked-route', 'Confirmed on your other device — send a test here to confirm', { action: 'test' });
  }

  // Stablecoin enrichment transient → still a first-timer until a send is confirmed.
  if (entry.enrichmentStatus === 'checking') return confidence('needs-test', 'Checking network history', { action: 'test' });
  if (entry.enrichmentStatus === 'needs_key') return confidence('needs-test', 'Add an API key to confirm history', { action: 'test' });

  // Needs test: a usable stablecoin route, but no confirmed send here yet → nudge a test.
  if (asset && network) {
    return confidence('needs-test', 'No confirmed send yet — send a small test first', { action: 'test' });
  }

  // Saved instruction: a partial note (asset, network, or memo only).
  if (asset || network || entry.memoNote) {
    const note = asset && !network ? `Saved ${asset} note`
      : network && !asset ? 'Saved network note'
      : 'Saved transfer note';
    return confidence('saved-instruction', note);
  }

  return confidence('not-checked', null);
}

export function stablecoinContactState(entry = {}, opts = {}) {
  return stablecoinConfidence(entry, opts).state;
}

export function stablecoinConfidenceLabel(entry = {}, opts = {}) {
  return stablecoinConfidence(entry, opts).label;
}

export function stablecoinConfidenceDetail(entry = {}, opts = {}) {
  return stablecoinConfidence(entry, opts).detail;
}

// P: normalized provenance label for the card, derived from the persisted sourceNote.
export function contactSourceLabel(entry = {}) {
  const note = String(entry.sourceNote || '').toLowerCase();
  if (note.includes('receive card')) return 'From receive card';
  if (note.includes('telegram')) return 'From Telegram';
  if (note.includes('transfer check') || note.includes('paste')) return 'From a paste check';
  if (note.includes('zafu')) return 'From a Zafu contact';
  if (note.includes('wallet') || note.includes('history')) return 'From wallet history';
  if (note.includes('manual')) return 'Added manually';
  if (entry.manuallyAdded) return 'Added manually';
  if (Number(entry.txCount || 0) > 0 || entry.networkConfidence === 'history') return 'From wallet history';
  return null;
}

// R: recipient-named paste ritual line, e.g. "Sending to Maria — confirm USDT on TRON/TRC-20."
export function buildRecipientRitualLine(label, entry = {}) {
  const who = String(label || '').trim();
  if (!who) return null;
  const asset = getContactDisplayAsset(entry);
  const network = getContactStablecoinNetwork(entry);
  const netLabel = stablecoinNetworkLabel(network);
  if (asset && netLabel) return `Sending to ${who} — confirm ${asset} on ${netLabel}.`;
  if (asset) return `Sending to ${who} — confirm the network for ${asset}.`;
  if (netLabel) return `Sending to ${who} — confirm the asset for ${netLabel}.`;
  return `Sending to ${who} — confirm the asset and network.`;
}

function formatSince(ts) {
  const ms = Date.now() - Number(ts);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const days = Math.floor(ms / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

export function buildTransferEvidenceGroups(result = {}, transferContext = {}, copiedMatch = false, helpMode = 'standard') {
  const mode = normalizeHelpMode(helpMode);
  const observed = observedRows(result, transferContext, mode);
  const checked = checkedRows(result, transferContext, copiedMatch, mode);
  const warned = warnedRows(result, transferContext, mode);
  const notChecked = notCheckedRows(result, transferContext, mode);
  if (shouldShowAffirmingState(result, transferContext, warned)) {
    checked.unshift({
      kind: 'ok',
      mark: '✓',
      text: 'Address and instruction are consistent. No warnings from checked sources.',
    });
  }
  const groups = [
    { title: 'Observed', rows: observed },
    { title: 'Checked', rows: checked },
    { title: 'Warned', rows: warned },
    { title: 'Not checked', rows: notChecked },
  ];
  return groups.filter((group) => group.rows.length > 0);
}

function observedRows(result, transferContext, mode) {
  const rows = [];
  const source = result.sourceEvidence;
  const sourceAge = source?.ageSeconds != null ? ` ${formatAge(source.ageSeconds)} ago` : '';

  if (source?.sourceClass === 'telegram_web' && source.state !== 'NO_RECENT_SOURCE') {
    rows.push({ kind: 'ok', mark: '+', text: `Recent source observed: Telegram Web${sourceAge}.` });
  } else if (source?.sourceClass === 'zafu_contact' && source.state !== 'NO_RECENT_SOURCE') {
    const contactLabel = source.contactLabel ? ` (${source.contactLabel})` : '';
    rows.push({ kind: 'ok', mark: '+', text: `Recent source observed: Zafu contact${contactLabel}${sourceAge}.` });
  }

  const savedContact = result.trustedEntry;
  if (savedContact) {
    rows.push({ kind: 'ok', mark: '+', text: `Saved recipient observed: ${savedRecipientLabel(savedContact)}.` });
    rows.push({ kind: 'neutral', mark: '-', text: `Saved instruction: ${stablecoinInstructionLine(savedContact)}.` });
  }

  if (transferContext.asset) {
    rows.push({ kind: 'ok', mark: '+', text: `Asset hint observed: ${transferContext.asset}.` });
  }

  if (transferContext.selectedNetwork) {
    rows.push({ kind: 'ok', mark: '+', text: `Network hint observed: ${transferContext.networkLabel || transferContext.selectedNetwork}.` });
  }

  if (transferContext.addressType && transferContext.addressType !== 'unknown') {
    rows.push({ kind: 'ok', mark: '+', text: `Address family observed: ${addressTypeLabel(transferContext.addressType)}.` });
  }

  if (transferContext.recipientFieldDetected) {
    rows.push({ kind: 'ok', mark: '+', text: 'Recipient/address field context observed.' });
  } else if (mode !== 'operator') {
    rows.push({ kind: 'neutral', mark: '-', text: 'Address field context was unclear.' });
  }

  if (transferContext.telegramWebDetected) {
    rows.push({ kind: 'ok', mark: '+', text: 'Telegram Web address-only paste context observed.' });
  } else if (transferContext.cryptoPageDetected && mode !== 'operator') {
    rows.push({ kind: 'ok', mark: '+', text: 'Crypto page context observed.' });
  }

  return rows;
}

function checkedRows(result, transferContext, copiedMatch, mode) {
  const rows = [];
  const addressType = transferContext.addressType || result.chainType || 'unknown';
  const savedContact = result.trustedEntry;
  const flaggedLookalike = result.flaggedLookalike === true || savedContact?.flaggedLookalike === true;

  if (addressType !== 'unknown') {
    rows.push({ kind: 'ok', mark: '✓', text: 'Address format recognized.' });
  }

  const source = result.sourceEvidence;
  if (source?.state === 'MATCHED_TELEGRAM_SOURCE') {
    rows.push({ kind: 'ok', mark: '✓', text: 'Pasted address matches the recent Telegram-copied address.' });
  } else if (source?.state === 'MATCHED_ZAFU_CONTACT_SOURCE') {
    rows.push({ kind: 'ok', mark: '✓', text: 'Pasted address matches the address copied from Zafu.' });
  } else if (copiedMatch) {
    rows.push({ kind: 'ok', mark: '✓', text: 'Pasted address matches the last browser-observed copy.' });
  } else if (mode === 'guided') {
    rows.push({ kind: 'neutral', mark: '-', text: 'Copied-address match was unavailable.' });
  }

  if (!flaggedLookalike) {
    rows.push({ kind: 'ok', mark: '✓', text: 'No poisoned lookalike detected.' });
  }
  rows.push({ kind: 'ok', mark: '✓', text: 'No known threat signal found from checked sources.' });

  if (result.state === 'KNOWN_PUBLIC') {
    rows.push({ kind: 'ok', mark: '✓', text: 'Known public contract.' });
  } else if (result.state === 'KNOWN') {
    rows.push({ kind: 'ok', mark: '✓', text: 'Known trusted address.' });
  }

  if (isContactNetworkConfirmed(savedContact)) {
    const detail = stablecoinConfidenceDetail(savedContact);
    rows.push({
      kind: 'ok',
      mark: '✓',
      text: `Known recipient${detail ? `: ${detail}` : ''}.`,
    });
  } else if (isContactConfirmedElsewhere(savedContact)) {
    const detail = stablecoinConfidenceDetail(savedContact);
    rows.push({
      kind: 'neutral',
      mark: '-',
      text: `Checked route${detail ? `: ${detail}` : ''}.`,
    });
  }

  if (savedContact && savedNetworkMatchesVisibleHint(savedContact, transferContext)) {
    rows.push({ kind: 'ok', mark: '✓', text: 'Visible network hint matches the saved contact network.' });
  }

  if (transferContext.selectedNetwork && !networkAddressMismatch(transferContext)) {
    rows.push({ kind: 'ok', mark: '✓', text: 'Visible network hint is consistent with the address family.' });
  }

  return rows;
}

function warnedRows(result, transferContext, mode) {
  const rows = [];
  const source = result.sourceEvidence;
  const savedContact = result.trustedEntry;
  const flaggedLookalike = result.flaggedLookalike === true || savedContact?.flaggedLookalike === true;

  if (source?.state === 'MISMATCHED_TELEGRAM_SOURCE') {
    rows.push({ kind: 'warn', mark: '!', text: 'Pasted address does not match the recent Telegram-copied address.' });
  }

  if (source?.state === 'MISMATCHED_ZAFU_CONTACT_SOURCE') {
    rows.push({ kind: 'warn', mark: '!', text: 'Pasted address does not match the address copied from Zafu.' });
  }

  if (source?.state === 'SOURCE_EXPIRED') {
    const sourceLabel = source.sourceClass === 'zafu_contact' ? 'Zafu contact copy' : 'Telegram copy';
    rows.push({ kind: 'neutral', mark: '-', text: `${sourceLabel} context expired.` });
  }

  if (networkAddressMismatch(transferContext)) {
    rows.push({
      kind: 'warn',
      mark: '!',
      text: `Visible network hint says ${transferContext.networkLabel || transferContext.selectedNetwork}, but the address family is ${addressTypeLabel(transferContext.addressType)}.`,
    });
  }

  if (flaggedLookalike) {
    rows.push({ kind: 'warn', mark: '!', text: 'Saved recipient looks like another saved address. Confirm before sending.' });
  }

  if (savedNetworkMismatchesVisibleHint(savedContact, transferContext)) {
    rows.push({
      kind: 'warn',
      mark: '!',
      text: `Saved contact says ${stablecoinNetworkLabel(getContactStablecoinNetwork(savedContact))}, but the visible network hint says ${transferContext.networkLabel || transferContext.selectedNetwork}.`,
    });
  }

  if (transferContext.memoRequired === true) {
    rows.push({ kind: 'warn', mark: '!', text: 'Visible context mentions a required memo/tag. ZAFU did not check memo presence.' });
  }

  if (result.state === 'UNKNOWN') {
    rows.push({ kind: mode === 'operator' ? 'neutral' : 'warn', mark: mode === 'operator' ? '-' : '!', text: 'Recipient is not in your trusted address book.' });
  }

  if (mode === 'guided' && (result.state === 'UNKNOWN' || transferContext.memoRequired === true)) {
    rows.push({ kind: 'neutral', mark: '-', text: 'For first-time stablecoin recipients, consider a small test transfer before moving meaningful value.' });
  }

  return rows;
}

function notCheckedRows(result, transferContext, mode) {
  if (mode === 'operator') {
    const rows = [{
      kind: 'neutral',
      mark: '-',
      text: 'Not checked: recipient identity, account ownership, platform support, compliance eligibility, recoverability, or signing chain.',
    }];
    appendNetworkReminder(rows, result, transferContext);
    return rows;
  }

  const rows = [
    { kind: 'neutral', mark: '-', text: 'Recipient identity or ownership.' },
    { kind: 'neutral', mark: '-', text: 'Exchange account ownership.' },
    { kind: 'neutral', mark: '-', text: 'Receiving platform support for this exact asset and network.' },
    { kind: 'neutral', mark: '-', text: 'Legal, compliance, sanctions, KYC, or Travel Rule eligibility.' },
    { kind: 'neutral', mark: '-', text: 'Recoverability if the transfer is sent incorrectly.' },
    { kind: 'neutral', mark: '-', text: 'Actual wallet signing chain ID or final exchange submission.' },
  ];

  if (transferContext.memoRequired !== true) {
    rows.push({ kind: 'neutral', mark: '-', text: 'Memo/tag requirement unless visible near the transfer field.' });
  }

  if (transferContext.addressType === 'evm' && !transferContext.selectedNetwork && !getContactStablecoinNetwork(result.trustedEntry)) {
    rows.push({ kind: 'neutral', mark: '-', text: 'Intended EVM network. The address alone does not prove Ethereum, Base, Arbitrum, BNB, Polygon, or another EVM network.' });
  }

  appendNetworkReminder(rows, result, transferContext);

  return rows;
}

function detectFlowHint(text) {
  const value = String(text || '').toLowerCase();
  if (/\b(withdraw|withdrawal)\b/.test(value)) return 'withdraw';
  if (/\b(send|send to|recipient)\b/.test(value)) return 'send';
  if (/\b(deposit|receive)\b/.test(value)) return 'deposit';
  return 'unknown';
}

function detectMemoContext(text) {
  const value = String(text || '').toLowerCase();
  const memoPattern = /\b(memo|destination\s+tag|tag)\b/;
  if (!memoPattern.test(value)) {
    return { required: null, present: null, confidence: 'unknown' };
  }

  if (/\b(no|not|without)\s+(memo|destination\s+tag|tag)\s+(required|needed)?\b/.test(value) ||
      /\b(memo|destination\s+tag|tag)\s+(not\s+required|optional)\b/.test(value)) {
    return { required: false, present: null, confidence: 'field' };
  }

  if (/\b(memo|destination\s+tag|tag)\b.{0,40}\b(required|needed|must)\b/.test(value) ||
      /\b(required|needed|must)\b.{0,40}\b(memo|destination\s+tag|tag)\b/.test(value)) {
    return { required: true, present: null, confidence: 'field' };
  }

  return { required: null, present: null, confidence: 'heuristic' };
}

function detectSurface(input) {
  if (input.telegramWebDetected === true) return 'telegram_web';
  if (input.cryptoPageDetected === true || input.recipientFieldDetected === true) return 'wallet_exchange_page';
  return 'unknown';
}

function networkAddressMismatch(transferContext) {
  const network = transferContext.selectedNetwork;
  const addressType = transferContext.addressType;
  if (!network || !addressType || addressType === 'unknown') return false;
  if (network === 'tron') return addressType !== 'tron';
  if (network === 'solana') return addressType !== 'solana';
  if (EVM_NETWORKS.has(network)) return addressType !== 'evm';
  return false;
}

function savedNetworkMatchesVisibleHint(entry, transferContext) {
  const savedNetwork = getContactStablecoinNetwork(entry);
  const visibleNetwork = normalizeStablecoinNetwork(transferContext.selectedNetwork);
  return !!savedNetwork && !!visibleNetwork && savedNetwork === visibleNetwork;
}

function savedNetworkMismatchesVisibleHint(entry, transferContext) {
  const savedNetwork = getContactStablecoinNetwork(entry);
  const visibleNetwork = normalizeStablecoinNetwork(transferContext.selectedNetwork);
  return !!savedNetwork && !!visibleNetwork && savedNetwork !== visibleNetwork;
}

function appendNetworkReminder(rows, result, transferContext) {
  const contact = result.trustedEntry;
  const network = getContactStablecoinNetwork(contact);
  const asset = getContactStablecoinAsset(contact);
  if (!contact || !network || transferContext.selectedNetwork) return;
  rows.push({
    kind: 'neutral',
    mark: '-',
    text: `Actual wallet or exchange network selection. Confirm you selected ${stablecoinNetworkLabel(network)}${asset ? ` for this ${asset} transfer` : ''}.`,
  });
}

function shouldShowAffirmingState(result, transferContext, warnedRowsList) {
  if (!['KNOWN', 'KNOWN_PUBLIC'].includes(result.state)) return false;
  if (warnedRowsList.some((row) => row.kind === 'warn')) return false;
  if (networkAddressMismatch(transferContext)) return false;
  if (savedNetworkMismatchesVisibleHint(result.trustedEntry, transferContext)) return false;
  return !!transferContext.selectedNetwork || !!getContactStablecoinNetwork(result.trustedEntry);
}

function savedRecipientLabel(entry) {
  return entry.label || entry.etherscanLabel || entry.ensName || 'saved contact';
}

function normalizeAddressType(addressType) {
  if (addressType === 'evm' || addressType === 'solana' || addressType === 'tron') return addressType;
  return 'unknown';
}

function addressTypeLabel(addressType) {
  if (addressType === 'evm') return 'EVM';
  if (addressType === 'solana') return 'Solana';
  if (addressType === 'tron') return 'TRON';
  return 'unknown';
}

function formatAge(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 10) return `${minutes}m`;
  return '10m+';
}
