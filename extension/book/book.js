import {
  getTrusted,
  getSuspicion,
  promoteSuspicionToTrusted,
  setTrustedLabel,
  updateTrustedEntry,
  removeTrusted,
  removeSuspicion,
  getWallets,
  addWallet,
  removeWallet,
  addManualContact,
  markTransferSent,
  getSettings,
  updateSettings,
  getAddressIntelIndex,
  getCommunityList,
  getCommunityListSnapshots,
  getReferralId,
  bumpMetric,
  updateWallet,
  clearAllLocalData,
  normalizeKey,
} from '../lib/storage.js';
import {
  segmentAddress,
  isEvmAddress,
  isSolanaAddress,
  isTronAddress,
  detectChainType,
} from '../lib/address-validator.js';
import { CHAIN_NATIVE, CHAIN_DISPLAY, BUNDLED_KEY } from '../lib/etherscan-client.js';
import { BUNDLED_TRON_KEY } from '../lib/tronscan-client.js';
import { getAuthState, signIn, signOut, upsertUserToSupabase } from '../lib/auth.js';
import { getPendingReportCount } from '../lib/community-client.js';
import { createQrSvg } from '../lib/qr.js';
import {
  buildLocalAddressProfile,
  enrichAddressProfile,
  estimateIntelCost,
  getCachedAddressProfile,
  persistAddressIntel,
  runBulkAddressIntel,
  setCachedAddressProfile,
} from '../lib/address-profile.js';
import {
  getContactStablecoinAsset,
  getContactStablecoinNetwork,
  getContactAssetType,
  getContactDisplayAsset,
  normalizeTokenSymbol,
  stablecoinConfidence,
  stablecoinInstructionLine,
  stablecoinNetworkAddressType,
  stablecoinNetworkLabel,
  stablecoinShortNetworkLabel,
  contactSourceLabel,
  normalizeHelpMode,
} from '../lib/transfer-context.js';
import { auditTrustedIndex } from '../lib/self-audit.js';

const PAGE_SIZE = 100;
const ZAFU_TEST_URL = 'https://stayzafu.com/test';

// C: addresses flagged by the cross-index lookalike scan; drives the "Review" card state.
let lookalikeSuspects = new Set();

const REASON_LABELS = {
  'inbound-or-zero-value': 'Sent funds to you',
  'zero-value-token':      'Spam / dust token',
  'token-transfer':        'Token transfer',
  'inbound':               'Inbound transfer',
};

// --- Recipient memory state ---
let allEntries = [];
let filtered = [];
let currentPage = 0;
let filterType = 'all';
let filterReason = 'all';
let filterReview = 'all';
let filterConfidence = 'all';
let filterByWalletId = null;
let sortKey = 'best';
let searchQuery = '';

// --- Tab navigation ---

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const tabId = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');
    // Reset scroll so the page-index and section top are visible when entering a tab.
    window.scrollTo({ top: 0 });

    if (tabId === 'wallets') await renderWallets();
    if (tabId === 'safety') await loadSafety();
    if (tabId === 'settings') await loadSettings();
    if (tabId === 'community') {
      await loadCommunityTab();
      chrome.runtime.sendMessage({ type: 'REFRESH_COMMUNITY_LIST' }).catch(() => {});
    }
  });
});

// Sticky page-index (How It Works, Security): highlight the section currently in view.
function setupPageIndexScrollspy() {
  const links = Array.from(document.querySelectorAll('.page-index a'));
  if (!links.length) return;
  const linkBySection = new Map();
  for (const link of links) {
    const id = link.getAttribute('href')?.slice(1);
    const section = id && document.getElementById(id);
    if (section) linkBySection.set(section, link);
  }
  if (!linkBySection.size) return;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const link = linkBySection.get(entry.target);
      if (!link) continue;
      link.closest('.page-index')?.querySelectorAll('a').forEach((a) => a.classList.remove('active'));
      link.classList.add('active');
    }
  }, { rootMargin: '-110px 0px -70% 0px', threshold: 0 });
  for (const section of linkBySection.keys()) observer.observe(section);
}
setupPageIndexScrollspy();

document.getElementById('receive-toggle-btn')?.addEventListener('click', () => {
  const body = document.getElementById('receive-body');
  const btn = document.getElementById('receive-toggle-btn');
  if (!body || !btn) return;
  const willShow = body.classList.contains('hidden');
  body.classList.toggle('hidden');
  btn.textContent = willShow ? 'Close' : 'Open';
  btn.setAttribute('aria-expanded', String(willShow));
  if (willShow) document.getElementById('receive-wallet')?.focus();
});

document.getElementById('receive-build-btn')?.addEventListener('click', buildReceiveSafelyInstruction);
document.getElementById('receive-copy-btn')?.addEventListener('click', async () => {
  const output = document.getElementById('receive-output');
  const btn = document.getElementById('receive-copy-btn');
  if (!output?.value) return;
  await navigator.clipboard.writeText(output.value).catch(() => {});
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'Copy instruction'; }, 1200);
});

function buildReceiveSafelyInstruction() {
  const asset = document.getElementById('receive-asset')?.value || 'USDT';
  const network = document.getElementById('receive-network')?.value || 'tron';
  const address = document.getElementById('receive-wallet')?.value.trim() || '';
  const error = document.getElementById('receive-error');
  const outputWrap = document.getElementById('receive-output-wrap');
  const output = document.getElementById('receive-output');
  const networkLabel = stablecoinNetworkLabel(network) || network;

  error.classList.add('hidden');
  outputWrap.classList.add('hidden');

  if (!addressMatchesReceiveNetwork(address, network)) {
    error.textContent = `${networkLabel} needs a ${receiveAddressFamilyLabel(network)} address. Check the address before sharing this instruction.`;
    error.classList.remove('hidden');
    return;
  }

  const notes = [
    `Please send ${asset} using the ${networkLabel} network only.`,
    '',
    'Address:',
    address,
    '',
    "If this is our first transfer, please send a small test amount first.",
    '',
    `Zafu checked the address format only. Confirm your wallet or exchange supports ${asset} on ${networkLabel}.`,
  ];
  if (stablecoinNetworkAddressType(network) === 'evm') {
    notes.push('This is an EVM-format address; the address alone does not prove the intended network.');
  }

  output.value = notes.join('\n');
  outputWrap.classList.remove('hidden');
}

function addressMatchesReceiveNetwork(address, network) {
  const expected = stablecoinNetworkAddressType(network);
  if (expected === 'evm') return isEvmAddress(address);
  if (expected === 'tron') return isTronAddress(address);
  if (expected === 'solana') return isSolanaAddress(address);
  return false;
}

function receiveAddressFamilyLabel(network) {
  const expected = stablecoinNetworkAddressType(network);
  if (expected === 'evm') return '0x/EVM-format';
  if (expected === 'tron') return 'TRON-format';
  if (expected === 'solana') return 'Solana-format';
  return 'supported';
}

// Receive instructions bind to a saved wallet so the offered networks always match an
// address the user actually controls — no insecure address/network combinations.
const RECEIVE_NETWORKS = {
  evm: [
    { value: '1', label: 'Ethereum/ERC-20' },
    { value: '8453', label: 'Base' },
    { value: '137', label: 'Polygon' },
    { value: '42161', label: 'Arbitrum' },
    { value: '10', label: 'Optimism' },
    { value: '56', label: 'BNB/BEP-20' },
  ],
  tron: [{ value: 'tron', label: 'TRON/TRC-20' }],
  solana: [{ value: 'solana', label: 'Solana' }],
};

function shortReceiveAddr(a) {
  const s = String(a || '');
  return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s;
}

// Restrict the network dropdown to those the selected wallet's address can actually use.
function populateReceiveNetworks(address) {
  const netSel = document.getElementById('receive-network');
  if (!netSel) return;
  const type = address ? detectChainType(address) : null;
  const opts = RECEIVE_NETWORKS[type] || [];
  netSel.innerHTML = opts.map((o, i) => `<option value="${o.value}"${i === 0 ? ' selected' : ''}>${o.label}</option>`).join('');
  netSel.disabled = opts.length === 0;
}

function populateReceiveWallets(wallets) {
  const sel = document.getElementById('receive-wallet');
  const buildBtn = document.getElementById('receive-build-btn');
  if (!sel) return;
  if (!wallets.length) {
    sel.innerHTML = '<option value="">No saved wallets — add one in the Wallets tab</option>';
    sel.disabled = true;
    if (buildBtn) buildBtn.disabled = true;
    populateReceiveNetworks('');
    return;
  }
  const prev = sel.value;
  sel.disabled = false;
  if (buildBtn) buildBtn.disabled = false;
  sel.innerHTML = wallets.map((w) => {
    const name = w.label ? `${w.label} · ` : '';
    return `<option value="${escHtml(w.address)}">${escHtml(name)}${escHtml(shortReceiveAddr(w.address))}</option>`;
  }).join('');
  if (prev && wallets.some((w) => w.address === prev)) sel.value = prev;
  populateReceiveNetworks(sel.value);
}

document.getElementById('receive-wallet')?.addEventListener('change', (e) => {
  populateReceiveNetworks(e.target.value);
});

// ===== ADDRESS BOOK TAB =====

let walletsMap = {};
let addressIntelRefreshTimer = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (
    area !== 'local' ||
    (!changes.addressIntel && !changes.trusted && !changes.suspicion && !changes.wallets)
  ) return;
  clearTimeout(addressIntelRefreshTimer);
  addressIntelRefreshTimer = setTimeout(() => {
    loadBookData().catch(() => {});
  }, 120);
});

async function loadBookData() {
  const [trusted, suspicion, wallets, intelIndex] = await Promise.all([
    getTrusted(),
    getSuspicion(),
    getWallets(),
    getAddressIntelIndex(),
  ]);
  const intelByAddress = groupIntelByAddress(intelIndex);
  walletsMap = Object.fromEntries(wallets.map((w) => [w.id, w.label || w.address.slice(0, 8) + '…']));
  lookalikeSuspects = new Set(auditTrustedIndex(trusted).map((f) => String(f.suspectAddress).toLowerCase()));

  renderWalletFilterButtons(wallets);
  populateReceiveWallets(wallets);

  const trustedEntries = Object.values(trusted).map((e) => ({
    ...e,
    _type: 'trusted',
    _intel: bestIntelForAddress(e.address, intelByAddress),
  }));
  const suspicionEntries = Object.values(suspicion).map((e) => ({
    ...e,
    _type: 'suspicious',
    _intel: bestIntelForAddress(e.address, intelByAddress),
  }));

  allEntries = [...trustedEntries, ...suspicionEntries];

  document.getElementById('count-all').textContent = allEntries.length;
  document.getElementById('count-trusted').textContent = trustedEntries.length;
  document.getElementById('count-suspicious').textContent = suspicionEntries.length;
  document.getElementById('count-favorites').textContent = trustedEntries.filter((e) => e.favourite === true).length;
  updateConfidenceFilterCounts(allEntries);
  updateReviewFilterCounts(allEntries);

  applyFilters();
}

function renderWalletFilterButtons(wallets) {
  const container = document.getElementById('wallet-filter-buttons');
  if (!container) return;
  container.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.className = 'filter-btn' + (filterByWalletId ? '' : ' active');
  allBtn.dataset.filterWallet = 'all';
  allBtn.textContent = 'All wallets';
  container.appendChild(allBtn);

  for (const w of wallets) {
    const btn = document.createElement('button');
    btn.className = 'filter-btn' + (filterByWalletId === w.id ? ' active' : '');
    btn.dataset.filterWallet = w.id;
    btn.textContent = w.label || w.address.slice(0, 8) + '…';
    btn.title = w.address;
    container.appendChild(btn);
  }

  container.querySelectorAll('[data-filter-wallet]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.filterWallet;
      filterByWalletId = id === 'all' ? null : id;
      container.querySelectorAll('[data-filter-wallet]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      applyFilters();
    });
  });
}

function groupIntelByAddress(intelIndex) {
  const grouped = {};
  for (const record of Object.values(intelIndex || {})) {
    if (!record?.address) continue;
    const key = normalizeKey(record.address);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(record);
  }
  return grouped;
}

function bestIntelForAddress(address, intelByAddress) {
  const records = intelByAddress[normalizeKey(address)] || [];
  if (!records.length) return null;
  return [...records].sort((a, b) => {
    if (a.status === 'risky' && b.status !== 'risky') return -1;
    if (a.status !== 'risky' && b.status === 'risky') return 1;
    return (b.reviewedAt || 0) - (a.reviewedAt || 0);
  })[0];
}

function reviewStatusForEntry(entry) {
  const intel = entry._intel;
  if (intel?.status === 'risky') return 'risk';
  if (intel?.status === 'error' || intel?.status === 'incomplete') return 'failed';
  if (intel?.reviewedAt) return 'reviewed';
  return 'needs-review';
}

function confidenceStateForEntry(entry) {
  if (entry._type === 'suspicious') return 'review';
  const key = normalizeKey(entry.address);
  const flaggedLookalike = lookalikeSuspects.has(String(key).toLowerCase());
  return stablecoinConfidence(entry, { flaggedLookalike }).state;
}

function updateConfidenceFilterCounts(entries) {
  const counts = {
    'known-recipient': 0,
    'checked-route': 0,
    'needs-test': 0,
    'saved-instruction': 0,
    review: 0,
    'not-checked': 0,
  };

  for (const entry of entries) {
    const state = confidenceStateForEntry(entry);
    if (state in counts) counts[state] += 1;
  }

  document.getElementById('count-confidence-known').textContent = counts['known-recipient'];
  document.getElementById('count-confidence-checked').textContent = counts['checked-route'];
  document.getElementById('count-confidence-needs-test').textContent = counts['needs-test'];
  document.getElementById('count-confidence-saved').textContent = counts['saved-instruction'];
  document.getElementById('count-confidence-review').textContent = counts.review;
  document.getElementById('count-confidence-not-checked').textContent = counts['not-checked'];
}

function updateReviewFilterCounts(entries) {
  const counts = {
    'needs-review': 0,
    reviewed: 0,
    risk: 0,
    failed: 0,
  };

  for (const entry of entries) {
    const status = reviewStatusForEntry(entry);
    if (status in counts) counts[status] += 1;
  }

  document.getElementById('count-review-needed').textContent = counts['needs-review'];
  document.getElementById('count-review-reviewed').textContent = counts.reviewed;
  document.getElementById('count-review-risk').textContent = counts.risk;
  document.getElementById('count-review-failed').textContent = counts.failed;
}

// Default "Best" ordering surfaces the recipients a user is most likely to reuse:
// starred first, then confirmed sends, then known/checked routes, then usage.
function trustScore(e) {
  let s = 0;
  if (e.favourite === true) s += 100000;
  if (e.lastConfirmedSendAt) s += 50000;
  const conf = confidenceStateForEntry(e);
  if (conf === 'known-recipient') s += 20000;
  else if (conf === 'checked-route') s += 10000;
  s += Math.min(Number(e.dominantStablecoinTransferCount || e.txCount || 0), 9999);
  return s;
}

function applyFilters() {
  const q = searchQuery.toLowerCase();

  filtered = allEntries.filter((e) => {
    if (filterType === 'favorites' && !(e._type === 'trusted' && e.favourite === true)) return false;
    if (filterType !== 'all' && filterType !== 'favorites' && e._type !== filterType) return false;
    if (filterConfidence !== 'all' && confidenceStateForEntry(e) !== filterConfidence) return false;
    if (filterReview !== 'all' && reviewStatusForEntry(e) !== filterReview) return false;
    // Reason filter only applies to suspicious entries. Trusted entries pass through.
    if (filterReason !== 'all' && e._type === 'suspicious' && e.reason !== filterReason) return false;
    if (filterByWalletId) {
      const origins = e.originWallets || [];
      if (!origins.includes(filterByWalletId)) return false;
    }
    if (q) {
      const haystack = [
        e.address,
        e.label || '',
        e.etherscanLabel || '',
        e.ensName || '',
        e.reason || '',
        e.description || '',
        e.notes || '',
        e.email || '',
        e.phone || '',
      ].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    // Trusted recipients always rank above suspicious ones — those are what the user sends
    // to. The chosen sortKey only orders within each group.
    const typeDelta = (a._type === 'trusted' ? 0 : 1) - (b._type === 'trusted' ? 0 : 1);
    if (typeDelta !== 0) return typeDelta;
    if (sortKey === 'best') {
      if (a._type === 'trusted') {
        const d = trustScore(b) - trustScore(a);
        if (d !== 0) return d;
      }
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    }
    if (sortKey === 'reviewStatus') {
      const rank = {
        risk: 0,
        failed: 1,
        'needs-review': 2,
        reviewed: 3,
        'not-reviewable': 4,
      };
      const delta = (rank[reviewStatusForEntry(a)] ?? 5) - (rank[reviewStatusForEntry(b)] ?? 5);
      if (delta !== 0) return delta;
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    }
    if (sortKey === 'lastSeen') return (b.lastSeen || 0) - (a.lastSeen || 0);
    if (sortKey === 'txCount') return (b.txCount || 0) - (a.txCount || 0);
    if (sortKey === 'label') {
      const la = (a.label || a.etherscanLabel || a.ensName || '').toLowerCase();
      const lb = (b.label || b.etherscanLabel || b.ensName || '').toLowerCase();
      return la.localeCompare(lb);
    }
    return 0;
  });

  currentPage = 0;
  render();
}

function render() {
  const tbody = document.getElementById('table-body');
  const emptyMsg = document.getElementById('empty-msg');
  const resultsLabel = document.getElementById('results-label');
  const pageLabel = document.getElementById('page-label');
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const start = currentPage * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, filtered.length);
  const page = filtered.slice(start, end);

  resultsLabel.innerHTML = '';
  const baseText = filtered.length === allEntries.length
    ? `${allEntries.length} addresses`
    : `${filtered.length} of ${allEntries.length} addresses`;
  resultsLabel.appendChild(document.createTextNode(baseText));
  if (filterByWalletId) {
    const name = walletsMap[filterByWalletId] || 'wallet';
    const chip = document.createElement('span');
    chip.className = 'filter-chip';
    chip.innerHTML = `From <strong>${escHtml(name)}</strong> <button class="filter-chip-clear" title="Clear filter">✕</button>`;
    chip.querySelector('.filter-chip-clear').addEventListener('click', () => {
      filterByWalletId = null;
      document.querySelectorAll('[data-filter-wallet]').forEach((b) => b.classList.remove('active'));
      const allBtn = document.querySelector('[data-filter-wallet="all"]');
      if (allBtn) allBtn.classList.add('active');
      applyFilters();
    });
    resultsLabel.appendChild(chip);
  }

  pageLabel.textContent = filtered.length > PAGE_SIZE
    ? `Page ${currentPage + 1} of ${totalPages}`
    : '';

  prevBtn.disabled = currentPage === 0;
  nextBtn.disabled = currentPage >= totalPages - 1;

  tbody.innerHTML = '';

  if (filtered.length === 0) {
    renderEmptyBookMessage(emptyMsg);
    emptyMsg.classList.remove('hidden');
    return;
  }
  emptyMsg.classList.add('hidden');

  for (const entry of page) {
    tbody.appendChild(buildRow(entry));
  }
}

function renderEmptyBookMessage(emptyMsg) {
  if (allEntries.length > 0) {
    emptyMsg.textContent = 'No addresses match your filters.';
    return;
  }
  emptyMsg.innerHTML = `
    <div class="empty-msg-title">Start your recipient memory.</div>
    <p class="empty-msg-desc">Save a known recipient manually, or import wallet history to find recipients from your own sends.</p>
    <div class="empty-msg-actions">
      <button id="book-empty-add-contact-inline-btn" class="btn-primary" type="button">+ Add contact</button>
      <button id="book-empty-add-wallet-inline-btn" class="btn-primary" type="button">+ Import wallet history</button>
    </div>
  `;
  emptyMsg.querySelector('#book-empty-add-contact-inline-btn')?.addEventListener('click', handleAddManualContact);
  emptyMsg.querySelector('#book-empty-add-wallet-inline-btn')?.addEventListener('click', () => {
    document.querySelector('[data-tab="wallets"]').click();
    openBookAddWalletForm();
  });
}

function buildRow(entry) {
  const tr = document.createElement('tr');
  tr.dataset.address = entry.address;

  const displayLabel = entry.label || entry.etherscanLabel || entry.ensName || '';
  const txMeta = [
    entry.txCount ? `${entry.txCount} tx` : null,
    entry.lastSeen ? timeAgo(entry.lastSeen) : null,
  ].filter(Boolean).join(' · ');

  // Type badge
  const tdType = document.createElement('td');
  tdType.className = 'col-type';
  const badge = document.createElement('span');
  badge.className = `badge badge-${entry._type}`;
  badge.textContent = entry._type === 'trusted' ? 'Trusted' : 'Suspicious';
  tdType.appendChild(badge);
  tr.appendChild(tdType);

  // Address
  const tdAddr = document.createElement('td');
  tdAddr.className = 'col-address';
  const addrWrap = document.createElement('div');
  addrWrap.className = 'addr-cell';
  const addrMain = document.createElement('div');
  addrMain.className = 'addr-main';
  const addrSpan = document.createElement('span');
  addrSpan.className = 'addr-mono';
  addrSpan.textContent = segmentAddress(entry.address);
  addrSpan.title = entry.address;
  addrMain.appendChild(addrSpan);
  const copyAddrBtn = document.createElement('button');
  copyAddrBtn.className = 'copy-addr-btn';
  copyAddrBtn.title = entry._type === 'trusted' ? stablecoinInstructionLine(entry) : 'Copy address';
  copyAddrBtn.textContent = entry._type === 'trusted' ? '⧉ Copy' : '⧉';
  copyAddrBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(entry.address).catch(() => {});
    chrome.runtime.sendMessage({
      type: 'COPY_ADDRESS',
      address: entry.address,
      chainType: detectChainType(entry.address),
      source: entry._type === 'trusted' ? buildZafuContactCopySource(entry) : null,
    }).catch(() => {});
    if (entry._type === 'trusted') showPreflightCopyHelper(entry);
    copyAddrBtn.textContent = '✓';
    setTimeout(() => {
      copyAddrBtn.textContent = entry._type === 'trusted' ? '⧉ Copy' : '⧉';
    }, 1200);
  });
  addrMain.appendChild(copyAddrBtn);
  if (entry._type === 'trusted') {
    const qrInlineBtn = document.createElement('button');
    qrInlineBtn.className = 'copy-addr-btn qr-inline-btn';
    qrInlineBtn.title = 'Show address QR';
    qrInlineBtn.textContent = 'QR';
    qrInlineBtn.addEventListener('click', () => {
      showAddressQrModal({
        address: entry.address,
        label: displayLabel || shortAddress(entry.address),
        eyebrow: 'Trusted contact',
      });
    });
    addrMain.appendChild(qrInlineBtn);
  }
  // The Details button opens the detail/zoom view (full address, copy, rename, intel).
  const openDetail = () => showAddressProfileModal({
    address: entry.address,
    label: displayLabel || shortAddress(entry.address),
    eyebrow: entry._type === 'suspicious' ? 'Suspicious address' : 'Trusted contact',
    trustedEntry: entry._type === 'trusted' ? entry : null,
    suspicionEntry: entry._type === 'suspicious' ? entry : null,
    walletsMap,
  });
  const detailsBtn = document.createElement('button');
  detailsBtn.className = 'copy-addr-btn addr-details-btn';
  detailsBtn.title = 'View address details';
  detailsBtn.textContent = 'Details';
  detailsBtn.addEventListener('click', openDetail);
  addrMain.appendChild(detailsBtn);
  addrWrap.appendChild(addrMain);
  const intelSubline = document.createElement('div');
  intelSubline.className = 'addr-intel-meta';
  intelSubline.textContent = addressIntelSubline(entry);
  addrWrap.appendChild(intelSubline);
  if (entry._type === 'trusted') {
    addrWrap.appendChild(renderTransferCardSummary(entry));
  }
  tdAddr.appendChild(addrWrap);
  tr.appendChild(tdAddr);

  // Label (editable for trusted) + description secondary line
  const tdLabel = document.createElement('td');
  tdLabel.className = 'col-label';
  if (entry._type === 'trusted') {
    const labelSpan = document.createElement('span');
    labelSpan.className = displayLabel ? 'label-text' : 'label-none';
    labelSpan.textContent = displayLabel || 'Add name…';
    labelSpan.addEventListener('click', () => startLabelEdit(tdLabel, entry));
    tdLabel.appendChild(labelSpan);
  } else {
    const labelSpan = document.createElement('span');
    labelSpan.className = displayLabel ? 'label-text' : 'label-none';
    labelSpan.textContent = displayLabel || '—';
    tdLabel.appendChild(labelSpan);
  }
  if (entry.description) {
    const descSpan = document.createElement('div');
    descSpan.className = 'label-description';
    descSpan.textContent = entry.description.length > 45
      ? entry.description.slice(0, 45) + '…'
      : entry.description;
    descSpan.title = entry.description;
    tdLabel.appendChild(descSpan);
  }
  if (entry.originWallets && entry.originWallets.length > 0) {
    const originLabels = entry.originWallets.map((id) => walletsMap[id] || id.slice(0, 8) + '…').join(', ');
    const originSpan = document.createElement('div');
    originSpan.className = 'label-description';
    originSpan.textContent = `From: ${originLabels}`;
    tdLabel.appendChild(originSpan);
  }
  tr.appendChild(tdLabel);

  // Activity meta
  const tdMeta = document.createElement('td');
  tdMeta.className = 'col-meta';
  const metaSpan = document.createElement('span');
  metaSpan.className = 'meta-text';
  metaSpan.textContent = txMeta || '—';
  tdMeta.appendChild(metaSpan);
  tr.appendChild(tdMeta);

  // Intel
  const tdReason = document.createElement('td');
  tdReason.className = 'col-reason';
  if (entry._type === 'suspicious' && entry.reason) {
    const reasonBadge = document.createElement('span');
    reasonBadge.className = 'reason-badge';
    reasonBadge.textContent = REASON_LABELS[entry.reason] || entry.reason;
    tdReason.appendChild(reasonBadge);
  }
  tdReason.appendChild(renderIntelCell(entry, displayLabel));
  tr.appendChild(tdReason);

  // Actions
  const tdActions = document.createElement('td');
  tdActions.className = 'col-actions';
  const actions = document.createElement('div');
  actions.className = 'actions';

  if (entry._type === 'suspicious') {
    const promoteBtn = document.createElement('button');
    promoteBtn.className = 'btn-ghost promote';
    promoteBtn.textContent = 'Mark trusted…';
    promoteBtn.addEventListener('click', () => handlePromoteToTrusted(entry));
    actions.appendChild(promoteBtn);
  }

  if (entry._type === 'trusted') {
    const starBtn = document.createElement('button');
    starBtn.className = 'btn-ghost star-btn' + (entry.favourite ? ' starred' : '');
    starBtn.textContent = entry.favourite ? '★' : '☆';
    starBtn.title = entry.favourite ? 'Remove from Favorites' : 'Add to Favorites';
    starBtn.addEventListener('click', async () => {
      await updateTrustedEntry(entry.address, { favourite: !entry.favourite });
      await loadBookData();
    });
    actions.appendChild(starBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-ghost';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => handleEditContact(entry));
    actions.appendChild(editBtn);

  }

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-ghost btn-delete';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => handleDeleteContact(entry));
  actions.appendChild(deleteBtn);

  const explorerBtn = document.createElement('button');
  const chainType = detectChainType(entry.address);
  explorerBtn.className = 'btn-ghost';
  explorerBtn.textContent = chainType === 'tron' ? 'TronScan ↗' : chainType === 'solana' ? 'Solscan ↗' : 'Etherscan ↗';
  explorerBtn.addEventListener('click', () => {
    const url = chainType === 'tron'
      ? `https://tronscan.org/#/address/${entry.address}`
      : chainType === 'solana'
        ? `https://solscan.io/account/${entry.address}`
        : `https://etherscan.io/address/${entry.address}`;
    chrome.tabs.create({ url });
  });
  actions.appendChild(explorerBtn);

  tdActions.appendChild(actions);
  tr.appendChild(tdActions);

  return tr;
}

function renderTransferCardSummary(entry) {
  const flaggedLookalike = lookalikeSuspects.has(String(entry.address).toLowerCase());
  const model = stablecoinConfidence(entry, { flaggedLookalike });
  const wrap = document.createElement('div');
  wrap.className = `transfer-card-summary transfer-card-summary--${model.state}`;

  const badges = document.createElement('div');
  badges.className = 'transfer-card-badges';

  const assetValue = getContactDisplayAsset(entry);
  const asset = document.createElement('span');
  asset.className = assetValue ? 'transfer-card-asset' : 'transfer-card-asset transfer-card-asset--unset';
  asset.textContent = assetValue || '—';
  if (!assetValue) asset.title = 'Asset not set yet';
  badges.appendChild(asset);

  const network = document.createElement('span');
  const networkValue = getContactStablecoinNetwork(entry);
  const networkShort = stablecoinShortNetworkLabel(networkValue);
  network.className = networkShort ? 'transfer-card-network' : 'transfer-card-network transfer-card-network--unset';
  network.textContent = networkShort || '—';
  network.title = stablecoinNetworkLabel(networkValue) || 'Network not checked yet';
  badges.appendChild(network);

  const confidence = document.createElement('span');
  confidence.className = 'transfer-card-confidence';
  confidence.textContent = model.label;
  badges.appendChild(confidence);

  wrap.appendChild(badges);

  if (model.detail) {
    const detail = document.createElement('div');
    detail.className = 'transfer-card-detail';
    detail.textContent = model.detail;
    wrap.appendChild(detail);
  }

  const instruction = document.createElement('div');
  instruction.className = 'transfer-card-instruction';
  instruction.textContent = stablecoinInstructionLine(entry);
  wrap.appendChild(instruction);

  const source = contactSourceLabel(entry);
  if (source) {
    const sourceEl = document.createElement('div');
    sourceEl.className = 'transfer-card-source';
    sourceEl.textContent = source;
    wrap.appendChild(sourceEl);
  }

  // Only offer the self-attest CTA on contacts that aren't yet confirmed. Once a contact is
  // a Known recipient (action 'repeat'), re-logging adds no value and drifts the scan-derived
  // count, so the button is hidden.
  if (model.action && model.action !== 'repeat') {
    wrap.appendChild(buildMarkSentButton(entry));
  }

  return wrap;
}

// S: post-send receipt CTA. Self-attestation only — confirm a transfer you already sent.
function buildMarkSentButton(entry) {
  const btn = document.createElement('button');
  btn.className = 'btn-ghost small transfer-card-marksent';
  btn.textContent = 'Mark transfer sent';
  btn.title = 'Only after your wallet or exchange confirms the transfer. Zafu records your note; it does not verify settlement.';
  btn.addEventListener('click', async () => {
    const ok = await showSimpleConfirm(
      'Mark transfer as sent?',
      'Do this only after your wallet or exchange confirms it. Zafu records your note; it does not verify settlement.'
    );
    if (!ok) return;
    await markTransferSent(entry.address);
    await loadBookData();
  });
  return btn;
}

function buildZafuContactCopySource(entry) {
  return {
    sourceClass: 'zafu_contact',
    contactLabel: entry.label || entry.etherscanLabel || entry.ensName || '',
    asset: getContactStablecoinAsset(entry),
    network: getContactStablecoinNetwork(entry),
    displayAddress: entry.address,
  };
}

function showPreflightCopyHelper(entry) {
  document.querySelector('.preflight-copy-helper')?.remove();
  const helper = document.createElement('div');
  helper.className = 'preflight-copy-helper';
  helper.setAttribute('role', 'status');
  helper.setAttribute('aria-live', 'polite');
  const steps = preflightCopySteps(entry);
  helper.innerHTML = `
    <div class="preflight-copy-title">Copied from Zafu</div>
    <ol>
      ${steps.map((step) => `<li>${escHtml(step)}</li>`).join('')}
    </ol>
  `;
  document.body.appendChild(helper);
  setTimeout(() => helper.remove(), 6500);
}

function preflightCopySteps(entry) {
  const asset = getContactStablecoinAsset(entry) || 'the asset';
  const network = stablecoinNetworkLabel(getContactStablecoinNetwork(entry));
  return [
    network ? `Select ${network} for ${asset}.` : `Confirm the intended network for ${asset}.`,
    'Paste the address you copied from Zafu.',
    'Wait for Transfer Check before sending.',
  ];
}

function requestStablecoinContactEnrichment(address) {
  chrome.runtime
    .sendMessage({ type: 'ENRICH_STABLECOIN_CONTACT', address })
    .catch(() => {});
}

function renderIntelCell(entry, displayLabel) {
  const wrap = document.createElement('div');
  wrap.className = 'intel-cell';
  const intel = entry._intel;

  if (!intel?.reviewedAt) {
    const reviewBtn = document.createElement('button');
    reviewBtn.className = 'btn-ghost small intel-review-btn';
    reviewBtn.textContent = 'Review';
    reviewBtn.title = 'Run address Intel with your local explorer key';
    reviewBtn.addEventListener('click', () => {
      runSingleAddressIntel(entry, reviewBtn).catch(() => {});
    });
    wrap.appendChild(reviewBtn);
    return wrap;
  }

  wrap.appendChild(renderIntelBadge(entry));

  const info = document.createElement('span');
  info.className = 'intel-info-dot';
  info.textContent = 'i';
  info.title = intelExplanation(entry);
  wrap.appendChild(info);

  const detailsBtn = document.createElement('button');
  detailsBtn.className = 'btn-ghost small intel-details-btn';
  detailsBtn.textContent = 'Intel';
  detailsBtn.title = 'Open full address Intel';
  detailsBtn.addEventListener('click', async () => {
    await showAddressProfileModal({
      address: entry.address,
      label: displayLabel || shortAddress(entry.address),
      eyebrow: entry._type === 'suspicious' ? 'Suspicious address' : 'Trusted contact',
      trustedEntry: entry._type === 'trusted' ? entry : null,
      suspicionEntry: entry._type === 'suspicious' ? entry : null,
      walletsMap,
    });
  });
  wrap.appendChild(detailsBtn);

  return wrap;
}

function renderIntelBadge(entry) {
  const badge = document.createElement('span');
  const intel = entry._intel;
  const label = intelBadgeLabel(entry);
  badge.className = `reason-badge intel-badge intel-badge--${intelBadgeTone(entry)}`;
  badge.textContent = label;
  badge.title = intel?.reviewedAt ? `Reviewed ${timeAgo(intel.reviewedAt)}` : label;
  return badge;
}

async function runSingleAddressIntel(entry, button) {
  const settings = await getSettings();
  const localProfile = buildLocalAddressProfile({
    address: entry.address,
    trustedEntry: entry._type === 'suspicious' ? null : entry,
    suspicionEntry: entry._type === 'suspicious' ? entry : null,
    settings,
  });
  const keyState = getProfileExplorerKeyState(localProfile, settings);
  if (!keyState.ready) {
    await openSettingsForExplorerKey(keyState);
    return;
  }
  button.disabled = true;
  button.textContent = 'Reviewing';
  const enriched = await enrichAddressProfile(localProfile, settings);
  await setCachedAddressProfile(entry.address, localProfile.chainId, enriched);
  await persistAddressIntel(enriched);
  await loadBookData();
}

function intelExplanation(entry) {
  const intel = entry._intel;
  if (intel?.status === 'risky') {
    return `Risk flagged by ${sourceName(intel.source)}${intel.risk?.summary ? `: ${intel.risk.summary}` : '.'}`;
  }
  if (intel?.status === 'error') return 'Intel review failed. Open Intel for details or run review again.';
  if (intel?.status === 'incomplete') return 'Risk check unavailable. Other explorer details may be current, but Zafu did not receive a reputation verdict; run review again.';
  const contract = intel?.explorer?.contract;
  if (contract?.isContract) {
    return contract.verified
      ? 'Verified contract means explorer source metadata is available for this contract.'
      : 'Unverified contract means this address has contract code but explorer source metadata is not verified.';
  }
  if (contract && contract.isContract === false) {
    return 'EOA means externally owned account: a normal wallet address, not contract code.';
  }
  if (intel?.verdict === 'Balance checked') return 'Balance checked means ZAFU refreshed explorer Intel but did not find contract code or risk flags.';
  if (intel?.verdict === 'No risk found') return 'No risk found means ZAFU refreshed available Intel and did not find a supported risk signal.';
  return 'This tag summarizes the most useful Intel ZAFU found for this address.';
}

function intelBadgeLabel(entry) {
  const intel = entry._intel;
  if (intel?.status === 'risky') return 'Risk flagged';
  if (intel?.status === 'error') return 'Review failed';
  if (intel?.status === 'incomplete') return 'Risk check incomplete';
  if (intel?.identity?.primaryLabel) return intel.identity.primaryLabel;
  if (intel?.verdict) return intel.verdict;
  if (entry.manuallyAdded) return 'Manual contact';
  return 'Not reviewed';
}

function intelBadgeTone(entry) {
  const intel = entry._intel;
  if (intel?.status === 'risky') return 'risk';
  if (intel?.status === 'error') return 'error';
  if (intel?.status === 'incomplete') return 'warning';
  if (intel?.reviewedAt) return 'ok';
  if (entry.manuallyAdded) return 'manual';
  return 'muted';
}

function addressIntelSubline(entry) {
  const parts = [chainName(entry.chainId || entry.primaryChainId || entry.chains?.[0])];
  const intel = entry._intel;
  if (intel?.reviewedAt) {
    const contract = intel.explorer?.contract;
    if (intel.status === 'risky') {
      parts.push('Risk flagged');
    } else if (intel.status === 'incomplete') {
      parts.push('Risk check incomplete');
    } else if (intel.identity?.primaryLabel) {
      parts.push(intel.identity.primaryLabel);
    } else if (contract?.isContract) {
      parts.push(contract.verified ? 'Verified contract' : 'Unverified contract');
    } else if (contract && contract.isContract === false) {
      parts.push('EOA');
    } else if (intel.verdict) {
      parts.push(intel.verdict);
    }
    parts.push(`Checked ${timeAgo(intel.reviewedAt)}`);
  } else if (entry._type === 'trusted' && entry.manuallyAdded) {
    parts.push('Manual contact');
  } else if (entry._type === 'trusted') {
    parts.push('Not reviewed');
  } else if (entry._type === 'suspicious') {
    parts.push('Suspicious');
  }
  return parts.filter(Boolean).join(' · ');
}

async function handlePromoteToTrusted(entry) {
  const label = await showPromoteModal(entry.address);
  if (label === null) return;
  await promoteSuspicionToTrusted(entry.address);
  if (label) await setTrustedLabel(entry.address, label);
  await loadBookData();
}

async function handleDeleteContact(entry) {
  const displayName = entry.label || entry.etherscanLabel || entry.ensName || shortAddress(entry.address);
  const confirmed = await showSimpleConfirm(
    `Delete "${displayName}"?`,
    'This address will be removed from your book. It may reappear if you re-fetch wallet history.'
  );
  if (!confirmed) return;
  if (entry._type === 'trusted') {
    await removeTrusted(entry.address);
  } else {
    await removeSuspicion(entry.address);
  }
  await loadBookData();
}

async function handleAddManualContact() {
  const contact = await showAddContactModal();
  if (!contact) return;
  await addManualContact(contact);
  requestStablecoinContactEnrichment(contact.address);
  await loadBookData();
}

async function handleExport() {
  const [trusted, suspicion] = await Promise.all([getTrusted(), getSuspicion()]);
  const data = { version: '1.0', exportedAt: new Date().toISOString(), trusted, suspicion };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `zafu-contacts-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function startLabelEdit(tdLabel, entry) {
  const existing = tdLabel.querySelector('input');
  if (existing) return;

  const labelSpan = tdLabel.querySelector('span');
  const currentLabel = entry.label || entry.etherscanLabel || entry.ensName || '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'label-edit-input';
  input.value = currentLabel;
  input.placeholder = 'Enter name…';

  if (labelSpan) labelSpan.replaceWith(input);
  input.focus();
  input.select();

  let saved = false;

  async function save() {
    if (saved) return;
    saved = true;
    const val = input.value.trim();
    await setTrustedLabel(entry.address, val);
    entry.label = val;
    await loadBookData();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { saved = true; loadBookData(); }
  });
  input.addEventListener('blur', save);
}

// --- Book filter/sort/pagination event listeners ---

document.getElementById('prev-btn').addEventListener('click', () => {
  if (currentPage > 0) { currentPage--; render(); window.scrollTo(0, 0); }
});

document.getElementById('next-btn').addEventListener('click', () => {
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  if (currentPage < totalPages - 1) { currentPage++; render(); window.scrollTo(0, 0); }
});

document.getElementById('search').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  applyFilters();
});

document.getElementById('add-contact-btn')?.addEventListener('click', handleAddManualContact);
document.getElementById('run-book-intel-btn')?.addEventListener('click', () => {
  showAddressBookIntelModal().catch(() => {});
});

document.getElementById('verify-history-btn')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('verify-history-status');
  const btn = document.getElementById('verify-history-btn');
  const settings = await getSettings();
  if (!settings.etherscanApiKey && !settings.solscanApiKey && !settings.tronApiKey) {
    statusEl.textContent = 'Add an API key in Settings to verify network history.';
    statusEl.classList.remove('hidden');
    return;
  }
  const confirmed = await showSimpleConfirm(
    'Verify network history?',
    'ZAFU re-checks saved contacts for USDT/USDC history using your local API keys. Contacts without a matching key stay saved.'
  );
  if (!confirmed) return;
  btn.disabled = true;
  statusEl.textContent = 'Verifying…';
  statusEl.classList.remove('hidden');
  const progressHandler = (msg) => {
    if (msg.type !== 'BATCH_ENRICH_PROGRESS') return;
    statusEl.textContent = `Verifying ${msg.done}/${msg.total}…`;
  };
  chrome.runtime.onMessage.addListener(progressHandler);
  const resp = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'BATCH_ENRICH_STABLECOIN' }, resolve);
  });
  chrome.runtime.onMessage.removeListener(progressHandler);
  btn.disabled = false;
  if (resp && resp.ok) {
    statusEl.textContent = `Done — ${resp.verified} confirmed${resp.needsKey ? `, ${resp.needsKey} need a key` : ''}.`;
    await loadBookData();
  } else {
    statusEl.textContent = `Error: ${(resp && resp.error) || 'verify failed'}`;
  }
});

document.querySelectorAll('[data-filter-type]').forEach((btn) => {
  btn.addEventListener('click', () => {
    filterType = btn.dataset.filterType;
    document.querySelectorAll('[data-filter-type]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    // Reset reason filter when type changes (avoids sticky reason excluding trusted)
    filterReason = 'all';
    document.querySelectorAll('[data-filter-reason]').forEach((b) => b.classList.remove('active'));
    const allReasonBtn = document.querySelector('[data-filter-reason="all"]');
    if (allReasonBtn) allReasonBtn.classList.add('active');

    const reasonGroup = document.getElementById('reason-group');
    reasonGroup.style.display = filterType === 'trusted' || filterType === 'favorites' ? 'none' : '';

    applyFilters();
  });
});

document.querySelectorAll('[data-filter-review]').forEach((btn) => {
  btn.addEventListener('click', () => {
    filterReview = btn.dataset.filterReview;
    document.querySelectorAll('[data-filter-review]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    applyFilters();
  });
});

document.querySelectorAll('[data-filter-confidence]').forEach((btn) => {
  btn.addEventListener('click', () => {
    filterConfidence = btn.dataset.filterConfidence;
    document.querySelectorAll('[data-filter-confidence]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    applyFilters();
  });
});

document.querySelectorAll('[data-filter-reason]').forEach((btn) => {
  btn.addEventListener('click', () => {
    filterReason = btn.dataset.filterReason;
    document.querySelectorAll('[data-filter-reason]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    applyFilters();
  });
});

document.querySelectorAll('[data-sort]').forEach((btn) => {
  btn.addEventListener('click', () => {
    sortKey = btn.dataset.sort;
    document.querySelectorAll('[data-sort]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    applyFilters();
  });
});

// ===== WALLETS TAB =====

async function renderWallets() {
  const wallets = await getWallets();
  const container = document.getElementById('wallet-cards');
  const empty = document.getElementById('no-wallets');
  container.innerHTML = '';

  if (wallets.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const settings = await getSettings();
  const prices = settings.prices || {};

  // Portfolio summary across all wallets
  const portfolio = aggregatePortfolio(wallets, prices);
  const summary = document.createElement('div');
  summary.className = 'portfolio-summary';
  summary.innerHTML = `
    <div class="psum-item"><div class="psum-val">$${formatUsd(portfolio.totalUsd)}</div><div class="psum-lbl">Total value</div></div>
    <div class="psum-item"><div class="psum-val">${portfolio.wallets}</div><div class="psum-lbl">Wallets</div></div>
    <div class="psum-item"><div class="psum-val">${portfolio.chains}</div><div class="psum-lbl">Networks</div></div>
    <div class="psum-item"><div class="psum-val">${portfolio.trusted}</div><div class="psum-lbl">Trusted contacts</div></div>
    <div class="psum-item"><div class="psum-val">${portfolio.suspicion}</div><div class="psum-lbl">Suspicious</div></div>
    <div class="psum-item"><div class="psum-val">${portfolio.totalTx}</div><div class="psum-lbl">Transactions</div></div>
  `;
  container.appendChild(summary);

  const grid = document.createElement('div');
  grid.className = 'wallet-cards-grid';

  for (const wallet of wallets) {
    const card = buildRichWalletCard(wallet, prices);
    grid.appendChild(card);
  }

  container.appendChild(grid);

  container.querySelectorAll('.btn-fetch').forEach((btn) => {
    btn.addEventListener('click', () => handleFetch(btn.dataset.id));
  });

  container.querySelectorAll('.btn-remove').forEach((btn) => {
    btn.addEventListener('click', () => handleRemoveWallet(btn.dataset.id));
  });

  container.querySelectorAll('.btn-edit-wallet').forEach((btn) => {
    btn.addEventListener('click', () => handleEditWallet(btn.dataset.id));
  });

  container.querySelectorAll('.btn-filter-book').forEach((btn) => {
    btn.addEventListener('click', async () => {
      filterByWalletId = btn.dataset.id;
      document.querySelector('[data-tab="book"]').click();
      await loadBookData();
    });
  });

  container.querySelectorAll('.btn-etherscan-wallet').forEach((btn) => {
    btn.addEventListener('click', () => {
      const url = btn.dataset.chain === 'solana'
        ? `https://solscan.io/account/${btn.dataset.address}`
        : btn.dataset.chain === 'tron'
          ? `https://tronscan.org/#/address/${btn.dataset.address}`
        : `https://etherscan.io/address/${btn.dataset.address}`;
      chrome.tabs.create({ url });
    });
  });

  container.querySelectorAll('.btn-wallet-qr').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const wallets = await getWallets();
      const wallet = wallets.find((w) => w.id === btn.dataset.id);
      if (!wallet) return;
      showAddressQrModal({
        address: wallet.address,
        label: wallet.label || 'Wallet import',
        eyebrow: 'Wallet history',
      });
    });
  });

  container.querySelectorAll('.btn-wallet-profile').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const wallets = await getWallets();
      const wallet = wallets.find((w) => w.id === btn.dataset.id);
      if (!wallet) return;
      await showAddressProfileModal({
        address: wallet.address,
        label: wallet.label || 'Wallet import',
        eyebrow: 'Wallet history',
        protectedWallet: wallet,
      });
    });
  });
}

function aggregatePortfolio(wallets, prices) {
  let totalUsd = 0;
  let trusted = 0;
  let suspicion = 0;
  let totalTx = 0;
  const chainSet = new Set();
  for (const w of wallets) {
    const chains = w.chains && w.chains.length ? w.chains : [w.chainId || 1];
    for (const cid of chains) {
      chainSet.add(cid);
      const pc = (w.perChain || {})[cid];
      if (!pc) continue;
      totalUsd += (pc.balance || 0) * (prices[cid] || 0);
      trusted += pc.trustedCount || 0;
      suspicion += pc.suspicionCount || 0;
      totalTx += (pc.txCount || 0) + (pc.tokenTxCount || 0);
    }
  }
  return { totalUsd, wallets: wallets.length, chains: chainSet.size, trusted, suspicion, totalTx };
}

function buildRichWalletCard(wallet, prices) {
  const card = document.createElement('div');
  card.className = 'wallet-card wallet-card--rich';

  const chains = wallet.chains && wallet.chains.length ? wallet.chains : [wallet.chainId || 1];
  const perChain = wallet.perChain || {};

  let totalUsd = 0;
  let totalTx = 0;
  let totalTokenTx = 0;
  let totalTrusted = 0;
  let totalSuspicion = 0;
  let totalOutgoing = 0;
  let totalIncoming = 0;
  let gasSpentTotal = 0;
  let firstTxAt = null;
  let lastTxAt = null;

  for (const cid of chains) {
    const pc = perChain[cid];
    if (!pc) continue;
    totalUsd += (pc.balance || 0) * (prices[cid] || 0);
    totalTx += pc.txCount || 0;
    totalTokenTx += pc.tokenTxCount || 0;
    totalTrusted += pc.trustedCount || 0;
    totalSuspicion += pc.suspicionCount || 0;
    totalOutgoing += pc.outgoingCount || 0;
    totalIncoming += pc.incomingCount || 0;
    gasSpentTotal += pc.gasSpent || 0;
    if (pc.firstTxAt && (!firstTxAt || pc.firstTxAt < firstTxAt)) firstTxAt = pc.firstTxAt;
    if (pc.lastTxAt && (!lastTxAt || pc.lastTxAt > lastTxAt)) lastTxAt = pc.lastTxAt;
  }

  const age = firstTxAt ? ageLabel(firstTxAt) : '—';
  const lastAct = lastTxAt ? timeAgo(lastTxAt) : '—';
  const syncStatus = wallet.lastFetchedAt ? `Synced ${timeAgo(wallet.lastFetchedAt)}` : 'Not scanned yet';

  const primaryExplorerChain = chains.includes('tron') ? 'tron' : chains.includes('solana') ? 'solana' : 'evm';
  const explorerLabel = primaryExplorerChain === 'tron'
    ? 'TronScan ↗'
    : primaryExplorerChain === 'solana'
      ? 'Solscan ↗'
      : 'Etherscan ↗';

  const chainRows = chains.map((cid) => {
    const pc = perChain[cid];
    const bal = pc?.balance ?? 0;
    const sym = CHAIN_NATIVE[cid] || 'ETH';
    const name = CHAIN_DISPLAY[cid] || `Chain ${cid}`;
    const price = prices[cid] || 0;
    const usd = bal * price;
    if (cid === 'solana') {
      return `
        <div class="chain-row">
          <span class="chain-row-name">${escHtml(name)}</span>
          <span class="chain-row-bal">— ${sym}</span>
          <span class="chain-row-usd">—</span>
        </div>
      `;
    }
    return `
      <div class="chain-row">
        <span class="chain-row-name">${escHtml(name)}</span>
        <span class="chain-row-bal">${bal.toFixed(4)} ${sym}</span>
        <span class="chain-row-usd">${price ? '$' + formatUsd(usd) : '—'}</span>
      </div>
    `;
  }).join('');

  card.innerHTML = `
    <div class="wc-head">
      <div>
        <div class="wc-label">${escHtml(wallet.label || 'Unlabeled wallet')}</div>
        <div class="wc-address" title="${escHtml(wallet.address)}">${escHtml(wallet.address)}</div>
      </div>
      <div class="wc-value">
        <div class="wc-usd">$${formatUsd(totalUsd)}</div>
        <div class="wc-sync">${escHtml(syncStatus)}</div>
      </div>
    </div>

    <div class="wc-chains">${chainRows}</div>

    <div class="wc-stats-grid">
      <div class="wc-stat"><div class="wc-stat-val">${totalTrusted}</div><div class="wc-stat-lbl">Trusted</div></div>
      <div class="wc-stat"><div class="wc-stat-val">${totalSuspicion}</div><div class="wc-stat-lbl">Suspicious</div></div>
      <div class="wc-stat"><div class="wc-stat-val">${totalTx + totalTokenTx}</div><div class="wc-stat-lbl">Total tx</div></div>
      <div class="wc-stat"><div class="wc-stat-val">${totalOutgoing}</div><div class="wc-stat-lbl">Outgoing</div></div>
      <div class="wc-stat"><div class="wc-stat-val">${totalIncoming}</div><div class="wc-stat-lbl">Incoming</div></div>
      <div class="wc-stat"><div class="wc-stat-val">${gasSpentTotal > 0 ? gasSpentTotal.toFixed(4) : '—'}</div><div class="wc-stat-lbl">Gas (ETH)</div></div>
      <div class="wc-stat"><div class="wc-stat-val">${escHtml(age)}</div><div class="wc-stat-lbl">Wallet age</div></div>
      <div class="wc-stat"><div class="wc-stat-val">${escHtml(lastAct)}</div><div class="wc-stat-lbl">Last activity</div></div>
    </div>

    <div class="fetch-progress hidden" id="progress-${wallet.id}"></div>

    <div class="wc-actions">
      <button class="btn-fetch" data-id="${wallet.id}">Re-sync</button>
      <button class="btn-edit-wallet" data-id="${wallet.id}">Edit</button>
      <button class="btn-filter-book" data-id="${wallet.id}">View contacts</button>
      <button class="btn-wallet-profile btn-ghost" data-id="${wallet.id}">Intel</button>
      <button class="btn-wallet-qr btn-ghost" data-id="${wallet.id}">QR</button>
      <button class="btn-etherscan-wallet btn-ghost" data-address="${escHtml(wallet.address)}" data-chain="${primaryExplorerChain}">${explorerLabel}</button>
      <button class="btn-remove" data-id="${wallet.id}">Remove</button>
    </div>
  `;
  return card;
}

function formatUsd(n) {
  if (!n) return '0.00';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 10_000) return (n / 1_000).toFixed(2) + 'K';
  return n.toFixed(2);
}

function ageLabel(ts) {
  const days = Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

async function handleRemoveWallet(walletId) {
  const wallets = await getWallets();
  const wallet = wallets.find((w) => w.id === walletId);
  if (!wallet) return;

  const confirmed = await showSimpleConfirm(
    `Remove ${escHtml(wallet.label || shortAddress(wallet.address))}?`,
    'Removing this wallet removes its imported history from recipient memory.'
  );
  if (!confirmed) return;

  await removeWallet(walletId);
  await renderWallets();
}

async function handleEditWallet(walletId) {
  const wallets = await getWallets();
  const wallet = wallets.find((w) => w.id === walletId);
  if (!wallet) return;

  const saved = await showWalletEditModal(wallet);
  if (saved) await renderWallets();
}

function shortImportAddr(addr) {
  const s = String(addr || '');
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}

// Render the wallet-history import confirm step: a ranked, multi-select list of
// discovered outgoing counterparties. Nothing is trusted until the user saves.
function renderImportPicker(container, candidates, onSave, onSkip) {
  const rows = candidates.map((c, i) => {
    const net = stablecoinShortNetworkLabel(c.chains && c.chains[0]) || (c.chains && c.chains[0]) || '';
    const tag = [c.asset, net, `${c.txCount || 1}×`].filter(Boolean).join(' · ');
    return `<li class="import-row"><label><input type="checkbox" data-i="${i}"${c.stablecoin ? ' checked' : ''} /><span class="import-addr">${escHtml(shortImportAddr(c.address))}</span><span class="import-tag">${escHtml(tag)}</span></label></li>`;
  }).join('');
  container.innerHTML = `
    <p class="import-title">You sent to ${candidates.length} address${candidates.length === 1 ? '' : 'es'}. Save which as recipients?</p>
    <div class="import-bulk"><button type="button" class="link-text" data-act="all">Select all</button><button type="button" class="link-text" data-act="none">Select none</button></div>
    <ul class="import-list">${rows}</ul>
    <div class="import-actions"><button type="button" class="btn-primary import-save">Save selected</button><button type="button" class="btn-ghost import-skip">Skip for now</button></div>`;
  container.classList.remove('hidden');

  const boxes = () => Array.from(container.querySelectorAll('input[type="checkbox"]'));
  const saveBtn = container.querySelector('.import-save');
  const updateCount = () => {
    const n = boxes().filter((b) => b.checked).length;
    saveBtn.textContent = n ? `Save ${n} contact${n === 1 ? '' : 's'}` : 'Select contacts to save';
    saveBtn.disabled = n === 0;
  };
  container.querySelectorAll('.import-bulk .link-text').forEach((btn) => btn.addEventListener('click', () => {
    const check = btn.dataset.act === 'all';
    boxes().forEach((b) => { b.checked = check; });
    updateCount();
  }));
  container.querySelector('.import-list').addEventListener('change', updateCount);
  saveBtn.addEventListener('click', () => {
    const selected = boxes().filter((b) => b.checked).map((b) => candidates[Number(b.dataset.i)]);
    if (selected.length) onSave(selected);
  });
  container.querySelector('.import-skip').addEventListener('click', onSkip);
  updateCount();
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || 'Extension worker is not available.'));
          return;
        }
        if (!response) {
          reject(new Error('No response from the extension worker.'));
          return;
        }
        if (response.ok === false) {
          reject(new Error(response.error || 'Request failed.'));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function handleFetch(walletId, opts = {}) {
  const importMode = opts.import === true;
  const btn = document.querySelector(`.btn-fetch[data-id="${walletId}"]`);
  const progressEl = document.getElementById(`progress-${walletId}`);

  const wallets = await getWallets();
  const wallet = wallets.find((w) => w.id === walletId);
  if (!wallet) return;
  const walletChains = wallet.chains || [wallet.chainId || 1];

  const needsEtherscan = walletChains.some((c) => c !== 'solana' && c !== 'tron');
  if (needsEtherscan) {
    const settings = await getSettings();
    const { apiKeyFreeTierAck } = await chrome.storage.local.get('apiKeyFreeTierAck');
    if (!settings.etherscanApiKey && !apiKeyFreeTierAck) {
      const choice = await showApiKeyPrompt();
      if (choice === 'cancel') return;
      if (choice === 'setup') {
        document.querySelector('[data-tab="settings"]').click();
        const input = document.getElementById('api-key-input');
        if (input) { input.focus(); input.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        return;
      }
      await chrome.storage.local.set({ apiKeyFreeTierAck: true });
    }
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Fetching…'; }
  if (progressEl) { progressEl.textContent = 'Starting…'; progressEl.classList.remove('hidden'); }

  const progressHandler = (msg) => {
    if (msg.type !== 'FETCH_PROGRESS' || msg.walletId !== walletId || !progressEl) return;
    if (msg.action === 'done') {
      progressEl.classList.add('hidden');
      return;
    }
    progressEl.textContent = formatFetchProgress(msg);
  };
  chrome.runtime.onMessage.addListener(progressHandler);

  chrome.runtime.sendMessage(
    { type: 'FETCH_HISTORY', walletId, address: wallet.address, chainIds: walletChains, preview: true },
    async (response) => {
      chrome.runtime.onMessage.removeListener(progressHandler);
      if (btn) { btn.disabled = false; btn.textContent = 'Fetch history'; }
      if (progressEl) progressEl.classList.add('hidden');

      if (!response || !response.ok) {
        if (progressEl) {
          progressEl.textContent = `Error: ${(response && response.error) || 'fetch failed'}`;
          progressEl.classList.remove('hidden');
        }
        return;
      }

      if (importMode) {
        const candidates = Array.isArray(response.candidates) ? response.candidates : [];
        const picker = document.getElementById('import-candidates');
        if (!candidates.length || !picker) {
          await renderWallets();
          await loadBookData();
          if (progressEl) {
            progressEl.textContent = 'Done — wallet added. No prior sends to import.';
            progressEl.classList.remove('hidden');
            setTimeout(() => progressEl.classList.add('hidden'), 5000);
          }
          return;
        }
        renderImportPicker(picker, candidates, async (selected) => {
          const saveBtn = picker.querySelector('.import-save');
          if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving…';
          }
          try {
            const saveResp = await sendRuntimeMessage({ type: 'SAVE_IMPORTED_CONTACTS', contacts: selected });
            const n = Number.isFinite(Number(saveResp.saved)) ? Number(saveResp.saved) : selected.length;
            if (n <= 0) throw new Error('No valid recipient addresses were saved.');
            picker.innerHTML = '';
            picker.classList.add('hidden');
            await renderWallets();
            await loadBookData();
            if (progressEl) {
              progressEl.textContent = `Done — ${n} recipient${n === 1 ? '' : 's'} saved from your history.`;
              progressEl.classList.remove('hidden');
              setTimeout(() => progressEl.classList.add('hidden'), 6000);
            }
          } catch (err) {
            if (progressEl) {
              progressEl.textContent = `Could not save selected recipients: ${err.message || 'unknown error'}.`;
              progressEl.classList.remove('hidden');
            }
            if (saveBtn) {
              saveBtn.disabled = false;
              saveBtn.textContent = `Save ${selected.length} contact${selected.length === 1 ? '' : 's'}`;
            }
          }
        }, async () => {
          picker.innerHTML = '';
          picker.classList.add('hidden');
          await renderWallets();
        });
        return;
      }

      await renderWallets();
      await loadBookData();
      if (progressEl) {
        const { trustedCount, suspicionCount } = response;
        progressEl.textContent = `Done — ${trustedCount} recipients found for review, ${suspicionCount} suspicious flagged`;
        progressEl.classList.remove('hidden');
        setTimeout(() => progressEl.classList.add('hidden'), 5000);
      }
    }
  );
}

// Add wallet form (wallets tab)
function openBookAddWalletForm() {
  const container = document.getElementById('add-wallet-form-container');
  container.classList.remove('hidden');
  document.getElementById('toggle-add-btn').textContent = '− Cancel';
  document.getElementById('wallet-address').focus();
}

document.getElementById('toggle-add-btn').addEventListener('click', () => {
  const container = document.getElementById('add-wallet-form-container');
  const isHidden = container.classList.toggle('hidden');
  document.getElementById('toggle-add-btn').textContent = isHidden ? '+ Add wallet' : '− Cancel';
});

document.getElementById('book-empty-add-wallet-btn').addEventListener('click', openBookAddWalletForm);

document.getElementById('add-wallet-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const addrInput = document.getElementById('wallet-address');
  const labelInput = document.getElementById('wallet-label');
  const errorEl = document.getElementById('add-error');
  const submitBtn = e.currentTarget.querySelector('button[type="submit"]');
  const address = addrInput.value.trim();

  errorEl.classList.add('hidden');

  const chainType = detectChainType(address);
  if (chainType !== 'evm' && chainType !== 'solana' && chainType !== 'tron') {
    errorEl.textContent = 'Not a valid address (EVM 0x…, Solana base58, or TRON).';
    errorEl.classList.remove('hidden');
    return;
  }

  const restoreSubmit = () => {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Import wallet history';
  };

  submitBtn.disabled = true;

  try {
    let activeChains = [];
    let primaryChainId;

    if (chainType === 'solana') {
      activeChains = ['solana'];
      primaryChainId = 'solana';
    } else if (chainType === 'tron') {
      activeChains = ['tron'];
      primaryChainId = 'tron';
    } else {
      submitBtn.textContent = 'Scanning networks…';
      primaryChainId = 1;
      try {
        const probeResp = await sendRuntimeMessage({ type: 'PROBE_CHAINS', address });
        const active = Array.isArray(probeResp.results) ? probeResp.results.filter((r) => r.hasActivity) : [];
        activeChains = active.map((r) => r.chainId);
        if (active.length) {
          active.sort((a, b) => (b.lastTxAt || 0) - (a.lastTxAt || 0));
          primaryChainId = active[0].chainId;
        }
      } catch (_) {}
      if (activeChains.length === 0) activeChains = [1];
    }

    const wallet = await addWallet({
      address,
      label: labelInput.value.trim(),
      chains: activeChains,
      primaryChainId,
      chainId: primaryChainId,
    });
    addrInput.value = '';
    labelInput.value = '';
    restoreSubmit();
    document.getElementById('add-wallet-form-container').classList.add('hidden');
    document.getElementById('toggle-add-btn').textContent = '+ Add wallet';

    await renderWallets();
    if (wallet) handleFetch(wallet.id, { import: true });
  } catch (err) {
    restoreSubmit();
    errorEl.textContent = `Wallet import failed: ${err.message || 'unknown error'}. Try again, or add recipients manually.`;
    errorEl.classList.remove('hidden');
  }
});

// ===== SAFETY TAB =====

const FINGERPRINT_FILES = [
  'manifest.json',
  'background/service-worker.js',
  'content/content-script.js',
  'content/contact-picker.js',
  'overlay/overlay.js',
  'overlay/overlay.css',
  'lib/address-profile.js',
  'lib/address-validator.js',
  'lib/address-comparator.js',
  'lib/auth.js',
  'lib/community-client.js',
  'lib/ens-client.js',
  'lib/etherscan-client.js',
  'lib/goplus-client.js',
  'lib/index-builder.js',
  'lib/self-audit.js',
  'lib/solana-detector.js',
  'lib/solscan-client.js',
  'lib/qr.js',
  'lib/storage.js',
  'lib/sync.js',
  'lib/transfer-context.js',
  'lib/tronscan-client.js',
  'data/known-good-contracts.json',
  'data/known-good-contracts-solana.json',
  'data/malicious-confirmed.json',
  'data/scam-addresses.json',
  'data/scam-addresses-solana.json',
  'data/wallet-exchange-domains.json',
  'popup/popup.js',
  'popup/popup.html',
  'popup/popup.css',
  'book/book.js',
  'book/book.html',
  'book/book.css',
  'onboarding/onboarding.js',
  'onboarding/onboarding.html',
  'onboarding/onboarding.css',
  'content/contact-picker.css',
  'shared/tokens.css',
];

async function computeFingerprint() {
  try {
    const hashes = await Promise.all(
      FINGERPRINT_FILES.map(async (f) => {
        const resp = await fetch(chrome.runtime.getURL(f));
        const text = await resp.text();
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
      })
    );
    const combined = new TextEncoder().encode(hashes.join(''));
    const finalBuf = await crypto.subtle.digest('SHA-256', combined);
    return Array.from(new Uint8Array(finalBuf))
      .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch {
    return 'unavailable';
  }
}

function getVersionedReleaseUrl() {
  const version = chrome.runtime.getManifest().version;
  return `https://github.com/jimozo/zafu-extension/releases/tag/v${version}`;
}

async function loadSafety() {
  const hashEl = document.getElementById('fp-hash');
  if (hashEl && hashEl.textContent === 'computing…') {
    const fp = await computeFingerprint();
    hashEl.textContent = fp;
  }
}

document.getElementById('verify-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: getVersionedReleaseUrl() });
});

document.getElementById('github-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://github.com/jimozo/zafu-extension' });
});

async function openZafuTestPage() {
  await chrome.storage.local.set({ triedZafuTest: true });
  document.getElementById('address-book-test-card')?.classList.add('hidden');
  chrome.tabs.create({ url: ZAFU_TEST_URL });
}

function bindZafuTestLinks() {
  document.querySelectorAll('[data-open-zafu-test]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openZafuTestPage().catch(() => {
        chrome.tabs.create({ url: ZAFU_TEST_URL });
      });
    });
  });
}

// ===== SETTINGS TAB =====

async function loadSettings() {
  const settings = await getSettings();

  const transferCheckToggle = document.getElementById('transfer-check-toggle');
  transferCheckToggle.checked = settings.guardianMode !== false;
  const transferHelpMode = normalizeHelpMode(settings.transferHelpMode);
  document.querySelectorAll('input[name="transfer-help-mode"]').forEach((input) => {
    input.checked = input.value === transferHelpMode;
  });
  const networkToggle = document.getElementById('book-network-mode-toggle');
  const networkStatus = document.getElementById('book-network-mode-status');
  if (networkToggle) networkToggle.checked = settings.networkMode === true;
  if (networkStatus) {
    networkStatus.textContent = settings.networkMode === true
      ? 'On — daily anonymous counts can be sent to Zafu.'
      : 'Off — usage counts stay local.';
    networkStatus.classList.remove('hidden');
  }

  const keyInput = document.getElementById('api-key-input');
  const status = document.getElementById('api-key-status');
  if (settings.etherscanApiKey) {
    keyInput.placeholder = '••••••••••••••••';
    status.textContent = 'API key saved.';
    status.classList.remove('hidden');
  }

  const solKeyInput = document.getElementById('solscan-key-input');
  const solStatus = document.getElementById('solscan-key-status');
  if (settings.solscanApiKey && solKeyInput && solStatus) {
    solKeyInput.placeholder = '••••••••••••••••';
    solStatus.textContent = 'Solscan key saved.';
    solStatus.classList.remove('hidden');
  }

  const tronKeyInput = document.getElementById('tron-key-input');
  const tronStatus = document.getElementById('tron-key-status');
  if (settings.tronApiKey && tronKeyInput && tronStatus) {
    tronKeyInput.placeholder = '••••••••••••••••';
    tronStatus.textContent = 'TronScan key saved.';
    tronStatus.classList.remove('hidden');
  }
}

document.getElementById('transfer-check-toggle').addEventListener('change', async (e) => {
  await updateSettings({ guardianMode: e.target.checked });
});

document.getElementById('book-network-mode-toggle')?.addEventListener('change', async (e) => {
  await updateSettings({ networkMode: e.target.checked });
  await loadSettings();
  if (e.target.checked) chrome.runtime.sendMessage({ type: 'FLUSH_NETWORK_METRICS' }).catch(() => {});
});

document.querySelectorAll('input[name="transfer-help-mode"]').forEach((input) => {
  input.addEventListener('change', async (e) => {
    if (!e.target.checked) return;
    await updateSettings({ transferHelpMode: normalizeHelpMode(e.target.value) });
    await loadSettings();
  });
});

// Visible save confirmation: flash the button + show a success-styled status line. The
// muted .hint text alone was too subtle to read as "saved".
function markKeySaved(btn, statusEl, text) {
  statusEl.textContent = text;
  statusEl.classList.remove('hidden');
  statusEl.classList.add('hint--ok');
  if (btn) {
    btn.textContent = 'Saved ✓';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1600);
  }
}

document.getElementById('save-api-key-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const key = document.getElementById('api-key-input').value.trim();
  const status = document.getElementById('api-key-status');
  if (!key) return;
  if (key === BUNDLED_KEY) {
    status.textContent = "That's Zafu's shared demo key — create your own free Etherscan key (steps below).";
    status.classList.remove('hidden', 'hint--ok');
    return;
  }
  await updateSettings({ etherscanApiKey: key });
  document.getElementById('api-key-input').value = '';
  document.getElementById('api-key-input').placeholder = '••••••••••••••••';
  markKeySaved(btn, status, '✓ Etherscan key saved.');
  await maybePromptBulkIntel('etherscan', status);
});

document.getElementById('save-solscan-key-btn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const key = document.getElementById('solscan-key-input').value.trim();
  const status = document.getElementById('solscan-key-status');
  if (!key) return;
  await updateSettings({ solscanApiKey: key });
  document.getElementById('solscan-key-input').value = '';
  document.getElementById('solscan-key-input').placeholder = '••••••••••••••••';
  markKeySaved(btn, status, '✓ Solscan key saved.');
  await maybePromptBulkIntel('solscan', status);
});

document.getElementById('save-tron-key-btn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const key = document.getElementById('tron-key-input').value.trim();
  const status = document.getElementById('tron-key-status');
  if (!key) return;
  if (key === BUNDLED_TRON_KEY) {
    status.textContent = "That's Zafu's shared demo key — create your own free TronScan key (steps below).";
    status.classList.remove('hidden', 'hint--ok');
    return;
  }
  await updateSettings({ tronApiKey: key });
  document.getElementById('tron-key-input').value = '';
  document.getElementById('tron-key-input').placeholder = '••••••••••••••••';
  markKeySaved(btn, status, '✓ TronScan key saved.');
  await maybePromptBulkIntel('tronscan', status);
});

function intelSourceMeta(source, settings = {}) {
  if (source === 'tronscan') {
    return {
      flag: 'tronIntelPrompted',
      sourceName: 'Tronscan',
      hasKey: !!settings.tronApiKey,
      statusId: 'tron-key-status',
    };
  }
  if (source === 'solscan') {
    return {
      flag: 'solscanIntelPrompted',
      sourceName: 'Solscan',
      hasKey: !!settings.solscanApiKey,
      statusId: 'solscan-key-status',
    };
  }
  return {
    flag: 'etherscanIntelPrompted',
    sourceName: 'Etherscan',
    hasKey: !!settings.etherscanApiKey,
    statusId: 'api-key-status',
  };
}

// All Intel entry points (settings buttons, post-save prompt, recipient-tab modal) funnel
// through startBookIntel + the shared bookIntelRun state, so a run started anywhere blocks
// and is reflected everywhere instead of spawning a second concurrent pass.
async function maybePromptBulkIntel(source) {
  const settings = await getSettings();
  const { flag, sourceName } = intelSourceMeta(source, settings);
  if (settings[flag]) return;
  await updateSettings({ [flag]: true });
  if (bookIntelRun.running) return;
  const confirmed = await showSimpleConfirm(
    `Run ${sourceName} Intel now?`,
    `ZAFU can review eligible saved recipients and wallet-history entries with your local ${sourceName} key. Your key stays on this device.`
  );
  if (!confirmed) return;
  await startBookIntel(source);
}

async function runManualBulkIntel(source) {
  const settings = await getSettings();
  const { hasKey, sourceName, statusId } = intelSourceMeta(source, settings);
  const statusEl = document.getElementById(statusId);
  if (!statusEl) return;
  if (bookIntelRun.running) {
    statusEl.textContent = 'An Intel run is already in progress…';
    statusEl.classList.remove('hidden', 'hint--ok');
    return;
  }
  if (!hasKey) {
    statusEl.textContent = `Add a ${sourceName} key before running Intel.`;
    statusEl.classList.remove('hidden');
    return;
  }
  const confirmed = await showSimpleConfirm(
    `Run ${sourceName} Intel?`,
    `Review eligible saved recipients and wallet-history entries with your local ${sourceName} key.`
  );
  if (!confirmed) return;
  await startBookIntel(source);
}

document.getElementById('run-etherscan-intel-btn')?.addEventListener('click', () => {
  runManualBulkIntel('etherscan').catch(() => {});
});

document.getElementById('run-solscan-intel-btn')?.addEventListener('click', () => {
  runManualBulkIntel('solscan').catch(() => {});
});

document.getElementById('run-tronscan-intel-btn')?.addEventListener('click', () => {
  runManualBulkIntel('tronscan').catch(() => {});
});

async function showAddressBookIntelModal() {
  const settings = await getSettings();
  const hasEvmKey = !!settings.etherscanApiKey;
  const hasSolKey = !!settings.solscanApiKey;
  const hasTronKey = !!settings.tronApiKey;
  const backdrop = document.createElement('div');
  backdrop.className = 'in-page-modal-backdrop';
  backdrop.innerHTML = `
    <div class="in-page-modal">
      <div class="in-page-modal-title">Run address-book Intel</div>
      <p class="in-page-modal-hint in-page-modal-hint--normal">
        Review saved recipients and wallet-history entries with your local explorer keys. Keys stay on this device.
      </p>
      <label class="intel-include-suspicious">
        <input type="checkbox" id="intel-include-suspicious"> Also review suspicious addresses
      </label>
      <div class="intel-run-grid">
        <div class="intel-run-row">
          <div>
            <strong>EVM Intel</strong>
            <span>${hasEvmKey ? 'Etherscan key ready' : 'Missing Etherscan key'}</span>
            <span class="intel-run-estimate" id="est-etherscan">Estimating…</span>
          </div>
          <button class="${hasEvmKey ? 'btn-confirm' : 'btn-ghost'} small" id="modal-run-evm-intel">${hasEvmKey ? 'Run' : 'Add key'}</button>
        </div>
        <div class="intel-run-row">
          <div>
            <strong>Solana Intel</strong>
            <span>${hasSolKey ? 'Solscan key ready' : 'Missing Solscan key'}</span>
            <span class="intel-run-estimate" id="est-solscan">Estimating…</span>
          </div>
          <button class="${hasSolKey ? 'btn-confirm' : 'btn-ghost'} small" id="modal-run-sol-intel">${hasSolKey ? 'Run' : 'Add key'}</button>
        </div>
        <div class="intel-run-row">
          <div>
            <strong>TRON Intel</strong>
            <span>${hasTronKey ? 'Tronscan key ready' : 'Missing Tronscan key'}</span>
            <span class="intel-run-estimate" id="est-tronscan">Estimating…</span>
          </div>
          <button class="${hasTronKey ? 'btn-confirm' : 'btn-ghost'} small" id="modal-run-tron-intel">${hasTronKey ? 'Run' : 'Add key'}</button>
        </div>
      </div>
      <p class="in-page-modal-hint in-page-modal-hint--sm">
        Estimates are approximate (~6 API calls per EVM address, ~1s each). A free Etherscan key allows 100k calls/day, so cost is mostly time. Runs use your own keys.
      </p>
      <p id="modal-intel-status" class="in-page-modal-hint in-page-modal-hint--normal"></p>
      <div class="in-page-modal-buttons">
        <button class="btn-ghost small" id="modal-intel-close" type="button">Done</button>
      </div>
    </div>
  `;
  const close = () => backdrop.remove();
  backdrop.querySelector('#modal-intel-close').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  const includeBox = backdrop.querySelector('#intel-include-suspicious');
  const currentInclude = () => includeBox.checked ? ['trusted', 'wallets', 'suspicious'] : ['trusted', 'wallets'];
  const sourceHasKey = { etherscan: hasEvmKey, solscan: hasSolKey, tronscan: hasTronKey };
  async function updateEstimates() {
    for (const source of ['etherscan', 'solscan', 'tronscan']) {
      const el = backdrop.querySelector(`#est-${source}`);
      if (!el) continue;
      if (!sourceHasKey[source]) { el.textContent = 'Add your key to run'; continue; }
      const est = await estimateIntelCost(source, { include: currentInclude() });
      el.textContent = formatIntelEstimate(est);
    }
  }
  includeBox.addEventListener('change', updateEstimates);

  backdrop.querySelector('#modal-run-evm-intel').addEventListener('click', async () => {
    if (!hasEvmKey) {
      close();
      document.querySelector('[data-tab="settings"]').click();
      document.getElementById('api-key-input')?.focus();
      return;
    }
    startBookIntel('etherscan', { include: currentInclude() });
  });

  backdrop.querySelector('#modal-run-sol-intel').addEventListener('click', async () => {
    if (!hasSolKey) {
      close();
      document.querySelector('[data-tab="settings"]').click();
      document.getElementById('solscan-key-input')?.focus();
      return;
    }
    startBookIntel('solscan', { include: currentInclude() });
  });

  backdrop.querySelector('#modal-run-tron-intel').addEventListener('click', async () => {
    if (!hasTronKey) {
      close();
      document.querySelector('[data-tab="settings"]').click();
      document.getElementById('tron-key-input')?.focus();
      return;
    }
    startBookIntel('tronscan', { include: currentInclude() });
  });

  document.body.appendChild(backdrop);
  // Reflect any in-progress run so reopening the modal shows live status, not a fresh slate.
  refreshIntelStatus();
  updateEstimates();
}

// "12 to review · ~72 API calls · ~14s" — the approximate cost line shown per source.
function formatIntelEstimate(est) {
  if (!est.pending) return est.total ? 'All reviewed — nothing new' : 'No addresses yet';
  const time = est.seconds >= 90 ? `~${Math.round(est.seconds / 60)} min` : `~${est.seconds}s`;
  return `${est.pending} to review · ~${est.calls} API calls · ${time}`;
}

// Bulk Intel can run for a while; keep its state at module scope so closing and reopening
// the modal never loses progress, and so a run started in Settings and one started in the
// recipient-tab modal are the same run. The async run continues regardless of the modal DOM.
let bookIntelRun = { running: false, source: null, message: '' };

// Reflect the single run state in every place it can be shown: the modal status line, the
// per-source Settings status line, and the modal run buttons.
function refreshIntelStatus() {
  const text = bookIntelRun.message;
  const modalEl = document.getElementById('modal-intel-status');
  if (modalEl) modalEl.textContent = text;
  if (bookIntelRun.source) {
    const { statusId } = intelSourceMeta(bookIntelRun.source);
    const settingsEl = document.getElementById(statusId);
    if (settingsEl) {
      settingsEl.textContent = text;
      settingsEl.classList.remove('hidden');
      settingsEl.classList.toggle('hint--ok', !bookIntelRun.running && /Intel done/.test(text));
    }
  }
  ['modal-run-evm-intel', 'modal-run-sol-intel', 'modal-run-tron-intel'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = bookIntelRun.running;
  });
}

async function startBookIntel(source, { include = ['trusted', 'wallets'] } = {}) {
  if (bookIntelRun.running) return;
  // Claim the run synchronously, before any await, so two fast triggers (settings + modal)
  // can't both pass the guard and launch concurrent bulk passes.
  bookIntelRun = { running: true, source, message: 'Running Intel assessment…' };
  refreshIntelStatus();
  const { sourceName } = intelSourceMeta(source);
  try {
    const settings = await getSettings();
    const result = await runBulkAddressIntel(settings, source, (progress) => {
      if (progress.phase === 'running') {
        bookIntelRun.message = `Running Intel ${progress.completed}/${progress.total}…`;
        refreshIntelStatus();
      }
    }, { include });
    bookIntelRun.message = result.total
      ? `Intel done — ${result.completed} reviewed${result.risky ? `, ${result.risky} risk flagged` : ''}${result.skipped ? ` · ${result.skipped} already current` : ''}.`
      : (result.skipped
        ? `All ${result.skipped} addresses already have Intel — nothing to update.`
        : `No eligible ${sourceName} addresses to review yet.`);
    await loadBookData();
    await renderWallets();
  } catch (err) {
    bookIntelRun.message = `Intel failed: ${err.message || 'unknown error'}. Check your ${sourceName} key and try again.`;
  } finally {
    bookIntelRun.running = false;
    refreshIntelStatus();
  }
}

document.getElementById('etherscan-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://etherscan.io/apidashboard' });
});
document.getElementById('solscan-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://pro-api.solscan.io' });
});
document.getElementById('tron-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://tronscan.org/#/myaccount/apiKeys/' });
});

document.getElementById('export-contacts-btn').addEventListener('click', handleExport);

document.getElementById('clear-local-data-btn')?.addEventListener('click', async () => {
  const confirmed = window.confirm(
    'Clear all local Zafu data on this device? This signs you out and removes wallets, contacts, settings, caches, pending reports, and local metrics. It will not delete already-submitted community reports or server-side synced backups.'
  );
  if (!confirmed) return;

  const btn = document.getElementById('clear-local-data-btn');
  const status = document.getElementById('clear-local-data-status');
  btn.disabled = true;
  if (status) {
    status.textContent = 'Clearing local data...';
    status.classList.remove('hidden');
  }

  try {
    await signOut().catch(() => {});
    await clearAllLocalData();
    if (status) status.textContent = 'Local data cleared. Reopen Zafu to start fresh.';
    setTimeout(() => window.location.reload(), 700);
  } catch {
    if (status) status.textContent = 'Could not clear local data. Try again.';
    btn.disabled = false;
  }
});

// ===== COMMUNITY TAB =====

const BOOK_GOOGLE_BTN_INNER = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> Sign in with Google`;

function renderBookCommunityAccountUI(state) {
  const signedOut = document.getElementById('book-community-signed-out');
  const signedIn = document.getElementById('book-community-signed-in');
  if (!signedOut || !signedIn) return;

  if (state.isAuthenticated) {
    signedOut.classList.add('hidden');
    signedIn.classList.remove('hidden');
    const avatarEl = document.getElementById('book-community-account-avatar');
    if (avatarEl && state.avatar) { avatarEl.src = state.avatar; avatarEl.alt = state.displayName; }
    const nameEl = document.getElementById('book-community-account-name');
    if (nameEl) nameEl.textContent = state.displayName;
    const emailEl = document.getElementById('book-community-account-email');
    if (emailEl) emailEl.textContent = state.email;
  } else {
    signedOut.classList.remove('hidden');
    signedIn.classList.add('hidden');
  }
}

async function loadCommunityTab() {
  const [state, communityList, snapshots, settings] = await Promise.all([
    getAuthState(),
    getCommunityList(),
    getCommunityListSnapshots(),
    getSettings(),
  ]);
  renderBookCommunityAccountUI(state);
  const signalsToggle = document.getElementById('book-community-threat-signals-toggle');
  if (signalsToggle) signalsToggle.checked = settings.communityThreatSignals === true;

  const countEl = document.getElementById('book-community-list-count');
  const countLabelEl = document.getElementById('book-community-list-label');
  if (countEl) {
    const hasCount = communityList.count > 0;
    countEl.textContent = hasCount ? communityList.count.toLocaleString() : 'Not loaded yet';
    if (countLabelEl) {
      countLabelEl.textContent = hasCount
        ? 'addresses checked during Transfer Check'
        : 'community warning feed';
    }
  }

  const deltaEl = document.getElementById('book-community-list-delta');
  if (deltaEl) {
    const delta = compute7dDeltaBook(snapshots, communityList.count);
    if (delta > 0) {
      deltaEl.textContent = `+${delta.toLocaleString()} added last 7 days`;
      deltaEl.classList.remove('hidden');
    } else {
      deltaEl.classList.add('hidden');
    }
  }

  const pendingEl = document.getElementById('book-community-pending-reports');
  if (pendingEl) {
    const pending = await getPendingReportCount().catch(() => 0);
    if (pending > 0) {
      pendingEl.textContent = `${pending} report${pending > 1 ? 's' : ''} queued - retrying automatically when Zafu can reach the service.`;
      pendingEl.classList.remove('hidden');
    } else {
      pendingEl.classList.add('hidden');
    }
  }
}

function compute7dDeltaBook(snapshots, currentCount) {
  if (!snapshots || snapshots.length === 0) return 0;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const baseline = [...snapshots].reverse().find((s) => s.ts <= weekAgo);
  if (!baseline) return 0;
  return Math.max(0, currentCount - baseline.count);
}

document.getElementById('book-community-sign-in-btn').addEventListener('click', async () => {
  const btn = document.getElementById('book-community-sign-in-btn');
  const errorEl = document.getElementById('book-community-sign-in-error');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  errorEl.classList.add('hidden');
  try {
    const state = await signIn();
    renderBookCommunityAccountUI(state);
    upsertUserToSupabase(state);
    chrome.runtime.sendMessage({ type: 'SYNC_NOW', reason: 'signin' }).catch(() => {});
    bumpMetric('signin').catch(() => {});
  } catch (err) {
    errorEl.textContent = err.message === 'Auth cancelled' ? 'Sign-in cancelled.' : 'Sign-in failed. Try again.';
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = BOOK_GOOGLE_BTN_INNER;
  }
});

document.getElementById('book-community-sign-out-btn').addEventListener('click', async () => {
  await signOut();
  renderBookCommunityAccountUI({ isAuthenticated: false });
});

document.getElementById('book-community-share-btn').addEventListener('click', (e) => {
  e.preventDefault();
  showShareModal();
});


document.getElementById('book-community-methodology-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://stayzafu.com/community-signals' });
});

document.getElementById('book-community-threat-signals-toggle')?.addEventListener('change', async (e) => {
  await updateSettings({ communityThreatSignals: e.target.checked });
});

async function handleEditContact(entry) {
  const saved = await showEditModal(entry);
  if (saved) await loadBookData();
}

function assetOptions(selected) {
  const value = getContactStablecoinAsset({ asset: selected }) || '';
  return [
    ['USDT', 'USDT'],
    ['USDC', 'USDC'],
    ['', 'Not sure yet'],
  ].map(([optionValue, label]) => (
    `<option value="${optionValue}"${value === optionValue ? ' selected' : ''}>${label}</option>`
  )).join('');
}

function networkOptions(selected) {
  const value = getContactStablecoinNetwork({ network: selected }) || '';
  return [
    ['1', 'Ethereum'],
    ['137', 'Polygon'],
    ['42161', 'Arbitrum One'],
    ['8453', 'Base'],
    ['10', 'Optimism'],
    ['56', 'BNB Chain'],
    ['solana', 'Solana'],
    ['tron', 'TRON'],
    ['', 'Not sure yet'],
  ].map(([optionValue, label]) => (
    `<option value="${optionValue}"${value === optionValue ? ' selected' : ''}>${label}</option>`
  )).join('');
}

function showEditModal(entry) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'in-page-modal-backdrop';

    const displayLabel = entry.label || entry.etherscanLabel || entry.ensName || '';

    backdrop.innerHTML = `
      <div class="in-page-modal in-page-modal--wide">
        <div class="in-page-modal-title">Edit contact</div>
        <div class="in-page-modal-addr">${escHtml(segmentAddress(entry.address))}</div>
        <div class="edit-field">
          <label for="edit-label">Name <span class="required-star">*</span></label>
          <input id="edit-label" type="text" value="${escHtml(displayLabel)}" placeholder="e.g. Alice, Binance deposit…" autocomplete="off" required />
        </div>
        <div class="edit-field">
          <label for="edit-description">Description</label>
          <input id="edit-description" type="text" value="${escHtml(entry.description || '')}" placeholder="e.g. Trading account, main personal wallet" autocomplete="off" />
        </div>
        <div class="edit-field">
          <label for="edit-asset-type">Asset type</label>
          <select id="edit-asset-type">
            <option value="stablecoin"${entry.assetType === 'token' ? '' : ' selected'}>Stablecoin (USDT/USDC)</option>
            <option value="token"${entry.assetType === 'token' ? ' selected' : ''}>Other token</option>
          </select>
        </div>
        <div class="edit-field${entry.assetType === 'token' ? ' hidden' : ''}" id="edit-asset-field">
          <label for="edit-asset">Asset</label>
          <select id="edit-asset">
            ${assetOptions(entry.asset || entry.dominantStablecoinAsset)}
          </select>
        </div>
        <div class="edit-field${entry.assetType === 'token' ? '' : ' hidden'}" id="edit-token-field">
          <label for="edit-token-symbol">Token symbol</label>
          <input id="edit-token-symbol" type="text" value="${escHtml(entry.assetType === 'token' ? (normalizeTokenSymbol(entry.asset) || '') : '')}" placeholder="e.g. ARB, PEPE" maxlength="12" autocomplete="off" />
        </div>
        <div class="edit-field">
          <label for="edit-network">Network</label>
          <select id="edit-network">
            ${networkOptions(entry.network || entry.chainId || entry.chains?.[0])}
          </select>
        </div>
        <div class="edit-field">
          <label for="edit-notes">Notes</label>
          <input id="edit-notes" type="text" value="${escHtml(entry.notes || '')}" placeholder="Any context…" autocomplete="off" />
        </div>
        <div class="edit-field">
          <label for="edit-email">Email</label>
          <input id="edit-email" type="email" value="${escHtml(entry.email || '')}" placeholder="contact@email.com" autocomplete="off" />
        </div>
        <div class="edit-field">
          <label for="edit-phone">Phone</label>
          <input id="edit-phone" type="tel" value="${escHtml(entry.phone || '')}" placeholder="+1 555-0100" autocomplete="off" />
        </div>
        <div class="in-page-modal-buttons">
          <button class="btn-ghost small" id="edit-cancel">Cancel</button>
          <button class="btn-confirm" id="edit-save">Save</button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);

    const labelInput = backdrop.querySelector('#edit-label');
    const saveBtn = backdrop.querySelector('#edit-save');
    const cancelBtn = backdrop.querySelector('#edit-cancel');
    const assetTypeInput = backdrop.querySelector('#edit-asset-type');

    // W7: toggle between the USDT/USDC select and a free token symbol.
    assetTypeInput.addEventListener('change', () => {
      const isToken = assetTypeInput.value === 'token';
      backdrop.querySelector('#edit-asset-field').classList.toggle('hidden', isToken);
      backdrop.querySelector('#edit-token-field').classList.toggle('hidden', !isToken);
      if (isToken) backdrop.querySelector('#edit-token-symbol').focus();
    });

    saveBtn.addEventListener('click', async () => {
      const newLabel = labelInput.value.trim();
      if (!newLabel) return;
      const assetType = assetTypeInput.value === 'token' ? 'token' : 'stablecoin';
      const asset = assetType === 'token'
        ? normalizeTokenSymbol(backdrop.querySelector('#edit-token-symbol').value)
        : (backdrop.querySelector('#edit-asset').value || null);
      const networkVal = backdrop.querySelector('#edit-network').value;
      await updateTrustedEntry(entry.address, {
        label: newLabel,
        description: backdrop.querySelector('#edit-description').value.trim(),
        assetType,
        asset,
        network: networkVal || null,
        networkConfidence: networkVal ? 'saved' : 'unknown',
        // W7: switching to a token clears any stale stablecoin route so it can never
        // resurface as a wrong "USDT" asset on this device or a synced one.
        ...(assetType === 'token'
          ? { dominantStablecoinAsset: null, dominantStablecoinNetwork: null, dominantStablecoinTransferCount: 0 }
          : {}),
        notes: backdrop.querySelector('#edit-notes').value.trim(),
        email: backdrop.querySelector('#edit-email').value.trim(),
        phone: backdrop.querySelector('#edit-phone').value.trim(),
      });
      backdrop.remove();
      resolve(true);
    });

    cancelBtn.addEventListener('click', () => {
      backdrop.remove();
      resolve(false);
    });

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) { backdrop.remove(); resolve(false); }
    });

    labelInput.focus();
  });
}

function showAddContactModal() {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'in-page-modal-backdrop';
    backdrop.innerHTML = `
      <div class="in-page-modal in-page-modal--wide">
        <div class="in-page-modal-title">Add contact</div>
        <div class="edit-field">
          <label for="manual-contact-address">Address</label>
          <input id="manual-contact-address" type="text" placeholder="0x… Solana, or TRON address" spellcheck="false" autocomplete="off" required />
        </div>
        <div class="edit-field">
          <label for="manual-contact-label">Name <span class="required-star">*</span></label>
          <input id="manual-contact-label" type="text" placeholder="e.g. Alice, Binance deposit…" autocomplete="off" required />
        </div>
        <div class="edit-field">
          <label for="manual-contact-asset-type">Asset type</label>
          <select id="manual-contact-asset-type">
            <option value="stablecoin" selected>Stablecoin (USDT/USDC)</option>
            <option value="token">Other token</option>
          </select>
        </div>
        <div class="edit-field" id="manual-contact-asset-field">
          <label for="manual-contact-asset">Asset</label>
          <select id="manual-contact-asset">
            <option value="USDT" selected>USDT</option>
            <option value="USDC">USDC</option>
            <option value="">Not sure yet</option>
          </select>
        </div>
        <div class="edit-field hidden" id="manual-contact-token-field">
          <label for="manual-contact-token-symbol">Token symbol</label>
          <input id="manual-contact-token-symbol" type="text" placeholder="e.g. ARB, PEPE" maxlength="12" autocomplete="off" />
        </div>
        <div class="edit-field">
          <label for="manual-contact-chain">Network</label>
          <select id="manual-contact-chain">
            <option value="1">Ethereum</option>
            <option value="137">Polygon</option>
            <option value="42161">Arbitrum One</option>
            <option value="8453">Base</option>
            <option value="10">Optimism</option>
            <option value="56">BNB Chain</option>
            <option value="solana">Solana</option>
            <option value="tron">TRON</option>
          </select>
        </div>
        <div class="edit-field">
          <label for="manual-contact-notes">Notes</label>
          <input id="manual-contact-notes" type="text" placeholder="Any context…" autocomplete="off" />
        </div>
        <p id="manual-contact-error" class="error hidden"></p>
        <div class="in-page-modal-buttons">
          <button class="btn-ghost small" id="manual-contact-cancel" type="button">Cancel</button>
          <button class="btn-confirm" id="manual-contact-save" type="button">Save contact</button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);

    const addressInput = backdrop.querySelector('#manual-contact-address');
    const labelInput = backdrop.querySelector('#manual-contact-label');
    const assetTypeInput = backdrop.querySelector('#manual-contact-asset-type');
    const assetInput = backdrop.querySelector('#manual-contact-asset');
    const tokenInput = backdrop.querySelector('#manual-contact-token-symbol');
    const chainInput = backdrop.querySelector('#manual-contact-chain');
    const notesInput = backdrop.querySelector('#manual-contact-notes');
    const error = backdrop.querySelector('#manual-contact-error');
    const close = (value) => { backdrop.remove(); resolve(value); };

    // W7: toggle between the USDT/USDC select and a free token symbol.
    assetTypeInput.addEventListener('change', () => {
      const isToken = assetTypeInput.value === 'token';
      backdrop.querySelector('#manual-contact-asset-field').classList.toggle('hidden', isToken);
      backdrop.querySelector('#manual-contact-token-field').classList.toggle('hidden', !isToken);
      if (isToken) backdrop.querySelector('#manual-contact-token-symbol').focus();
    });

    const save = () => {
      const address = addressInput.value.trim();
      const label = labelInput.value.trim();
      error.classList.add('hidden');
      if (!isEvmAddress(address) && !isSolanaAddress(address) && !isTronAddress(address)) {
        error.textContent = 'Not a valid EVM (0x…), Solana, or TRON address.';
        error.classList.remove('hidden');
        return;
      }
      if (!label) {
        error.textContent = 'Name is required.';
        error.classList.remove('hidden');
        return;
      }
      const detectedChain = detectChainType(address);
      const rawChain = chainInput.value;
      const selectedChain = rawChain === 'solana' || rawChain === 'tron' ? rawChain : (parseInt(rawChain, 10) || 1);
      const assetType = assetTypeInput.value === 'token' ? 'token' : 'stablecoin';
      close({
        address,
        label,
        assetType,
        asset: assetType === 'token' ? tokenInput.value.trim() : assetInput.value,
        chainId: detectedChain === 'solana' || detectedChain === 'tron' ? detectedChain : selectedChain,
        notes: notesInput.value.trim(),
      });
    };

    backdrop.querySelector('#manual-contact-save').addEventListener('click', save);
    backdrop.querySelector('#manual-contact-cancel').addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });
    backdrop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
    });

    addressInput.focus();
  });
}

function showWalletEditModal(wallet) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'in-page-modal-backdrop';
    backdrop.innerHTML = `
      <div class="in-page-modal">
        <div class="in-page-modal-title">Edit wallet import</div>
        <div class="in-page-modal-addr">${escHtml(wallet.address)}</div>
        <div class="edit-field">
          <label for="wallet-edit-label">Name</label>
          <input id="wallet-edit-label" type="text" value="${escHtml(wallet.label || '')}" placeholder="e.g. Main MetaMask, Cold wallet" autocomplete="off" />
        </div>
        <p class="in-page-modal-hint">Public address only. ZAFU imports this wallet's history for recipient memory and cannot connect to it or move funds.</p>
        <div class="in-page-modal-buttons">
          <button class="btn-ghost small" id="wallet-edit-cancel">Cancel</button>
          <button class="btn-confirm" id="wallet-edit-save">Save</button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);

    const input = backdrop.querySelector('#wallet-edit-label');
    const close = (value) => { backdrop.remove(); resolve(value); };

    backdrop.querySelector('#wallet-edit-save').addEventListener('click', async () => {
      await updateWallet(wallet.id, { label: input.value.trim() });
      close(true);
    });
    backdrop.querySelector('#wallet-edit-cancel').addEventListener('click', () => close(false));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(false);
    });
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        await updateWallet(wallet.id, { label: input.value.trim() });
        close(true);
      }
      if (e.key === 'Escape') close(false);
    });

    input.focus();
    input.select();
  });
}

// ===== MODALS =====

function showPromoteModal(address) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'in-page-modal-backdrop';

    backdrop.innerHTML = `
      <div class="in-page-modal">
        <div class="in-page-modal-title">✓ Add to trusted contacts</div>
        <div class="in-page-modal-addr">${escHtml(segmentAddress(address))}</div>
        <div>
          <label for="promote-label-input">Name this address <span class="required-star">*</span></label>
          <input id="promote-label-input" type="text" placeholder="e.g. Friend's wallet, Binance deposit…" autocomplete="off" />
        </div>
        <p class="in-page-modal-hint">Required — a label helps you recognise this contact in future pastes.</p>
        <div class="in-page-modal-buttons">
          <button class="btn-ghost small" id="promote-cancel">Cancel</button>
          <button class="btn-confirm" id="promote-confirm" disabled>Save as trusted</button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);

    const input = backdrop.querySelector('#promote-label-input');
    const confirmBtn = backdrop.querySelector('#promote-confirm');
    const cancelBtn = backdrop.querySelector('#promote-cancel');

    input.addEventListener('input', () => {
      confirmBtn.disabled = input.value.trim().length === 0;
    });

    confirmBtn.addEventListener('click', () => {
      backdrop.remove();
      resolve(input.value.trim());
    });

    cancelBtn.addEventListener('click', () => {
      backdrop.remove();
      resolve(null);
    });

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) { backdrop.remove(); resolve(null); }
    });

    input.focus();
  });
}

async function showShareModal() {
  const referralId = await getReferralId().catch(() => null);
  const refSuffix = referralId ? `?ref=${referralId}` : '';
  const shareUrl = `https://stayzafu.com/${refSuffix}`;
  const tweetText = `Just installed @stayzafu — recipient memory and Transfer Check before stablecoins move. ${shareUrl}`;

  const backdrop = document.createElement('div');
  backdrop.className = 'in-page-modal-backdrop';
  backdrop.innerHTML = `
    <div class="in-page-modal">
      <div class="in-page-modal-title">Share Zafu</div>
      <p class="in-page-modal-hint in-page-modal-hint--sm">
        Help others check recipient routes before sending.
      </p>
      <textarea id="share-tweet-text" readonly class="share-tweet-text">${escHtml(tweetText)}</textarea>
      <div class="share-link-row">
        <input id="share-link-input" type="text" readonly value="${escHtml(shareUrl)}" />
        <button class="btn-ghost small" id="share-copy-btn" type="button">Copy</button>
      </div>
      <div class="in-page-modal-buttons">
        <button class="btn-ghost small" id="share-cancel-btn" type="button">Close</button>
        <button class="btn-confirm" id="share-tweet-btn" type="button">Tweet it</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('#share-cancel-btn').addEventListener('click', close);

  backdrop.querySelector('#share-tweet-btn').addEventListener('click', () => {
    const url = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(tweetText);
    chrome.tabs.create({ url });
    bumpMetric('share').catch(() => {});
    close();
  });

  const copyBtn = backdrop.querySelector('#share-copy-btn');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    } catch {
      copyBtn.textContent = 'Failed';
    }
  });
}

function showAddressQrModal({ address, label, eyebrow }) {
  const qrSvg = createQrSvg(address, { scale: 5 });
  const backdrop = document.createElement('div');
  backdrop.className = 'in-page-modal-backdrop';
  backdrop.innerHTML = `
    <div class="in-page-modal qr-modal">
      <div class="qr-modal-eyebrow">${escHtml(eyebrow)}</div>
      <div class="in-page-modal-title">${escHtml(label)}</div>
      <div class="in-page-modal-addr">${escHtml(segmentAddress(address))}</div>
      <div class="qr-code-wrap">${qrSvg}</div>
      <div class="qr-exact-label">Exact encoded address</div>
      <div class="qr-exact-address">${escHtml(address)}</div>
      <div class="in-page-modal-buttons">
        <button class="btn-ghost small" id="qr-close-btn" type="button">Close</button>
        <button class="btn-confirm" id="qr-copy-btn" type="button">Copy address</button>
      </div>
    </div>
  `;

  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('#qr-close-btn').addEventListener('click', close);
  const copyBtn = backdrop.querySelector('#qr-copy-btn');
  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(address);
    chrome.runtime.sendMessage({ type: 'COPY_ADDRESS', address }).catch(() => {});
    copyBtn.textContent = 'Copied';
    setTimeout(() => { copyBtn.textContent = 'Copy address'; }, 1500);
  });
  document.body.appendChild(backdrop);
}

async function showAddressProfileModal({
  address,
  label,
  eyebrow,
  trustedEntry = null,
  suspicionEntry = null,
  protectedWallet = null,
  walletsMap = {},
}) {
  const modalInput = { address, label, eyebrow, trustedEntry, suspicionEntry, protectedWallet, walletsMap };
  const settings = await getSettings();
  const localProfile = buildLocalAddressProfile({
    address,
    trustedEntry,
    suspicionEntry,
    protectedWallet,
    settings,
  });
  const cached = await getCachedAddressProfile(address, localProfile.chainId);
  const profile = mergeCachedProfile(localProfile, cached);
  const labelRows = profile.labels.length
    ? profile.labels.map((item) => `
      <div class="profile-source-row">
        <span>${escHtml(sourceName(item.source))}</span>
        <strong>${escHtml(item.value)}</strong>
      </div>
    `).join('')
    : '<div class="profile-empty-row">No local label saved yet.</div>';
  const origins = profile.originWallets || [];
  const originText = origins.length
    ? origins.map((id) => walletsMap[id] || id.slice(0, 8) + '…').join(', ')
    : '—';
  const keyState = getProfileExplorerKeyState(profile, settings);
  const canRefresh = keyState.ready;
  const reviewLabel = profile.intel?.reviewedAt ? 'Refresh Intel' : 'Review Intel';

  const backdrop = document.createElement('div');
  backdrop.className = 'in-page-modal-backdrop';
  backdrop.innerHTML = `
    <div class="in-page-modal profile-modal">
      <div class="qr-modal-eyebrow">${escHtml(eyebrow)}</div>
      <div class="in-page-modal-title">${escHtml(label)}</div>
      <div class="in-page-modal-addr">${escHtml(segmentAddress(address))}</div>
      <div class="profile-addr-actions">
        <button class="btn-ghost small" id="profile-copy-btn" type="button">Copy address</button>
        ${suspicionEntry ? '<button class="btn-ghost small" id="profile-promote-btn" type="button">Mark trusted…</button>' : ''}
      </div>
      <div class="profile-section">
        <div class="profile-section-title">Local profile</div>
        <div class="profile-grid">
          <span>Trust</span><strong>${escHtml(trustName(profile.trust))}</strong>
          ${profile.suspicionReason ? `<span>Flagged</span><strong>${escHtml(REASON_LABELS[profile.suspicionReason] || profile.suspicionReason)}</strong>` : ''}
          <span>Chain</span><strong>${escHtml(chainName(profile.chainId))}</strong>
          <span>Tx count</span><strong>${profile.activity.txCount || '—'}</strong>
          <span>First seen</span><strong>${profile.activity.firstSeen ? escHtml(timeAgo(profile.activity.firstSeen)) : '—'}</strong>
          <span>Last seen</span><strong>${profile.activity.lastSeen ? escHtml(timeAgo(profile.activity.lastSeen)) : '—'}</strong>
          <span>From wallet</span><strong>${escHtml(originText)}</strong>
        </div>
      </div>
      <div class="profile-section">
        <div class="profile-section-title">Labels</div>
        ${labelRows}
      </div>
      <div class="profile-section">
        <div class="profile-section-title">Address Intel</div>
        <div class="profile-empty-row">${escHtml(keyState.statusText)}</div>
        <div class="profile-grid profile-grid--mt">${explorerRows(profile, settings)}</div>
      </div>
      <div class="in-page-modal-buttons">
        <button class="btn-ghost small" id="profile-close-btn" type="button">Done</button>
        ${canRefresh
          ? `<button class="btn-confirm" id="profile-refresh-btn" type="button">${reviewLabel}</button>`
          : `<button class="btn-confirm" id="profile-setup-key-btn" type="button">${escHtml(keyState.actionText)}</button>`}
      </div>
    </div>
  `;

  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('#profile-close-btn').addEventListener('click', close);

  const copyBtn = backdrop.querySelector('#profile-copy-btn');
  copyBtn.addEventListener('click', () => {
    // Keep this detail modal local-only (no runtime messaging): the row Copy button arms the
    // clipboard-swap guard; here we just place the address and show local paste guidance.
    navigator.clipboard.writeText(address).catch(() => {});
    if (trustedEntry) showPreflightCopyHelper(trustedEntry);
    copyBtn.textContent = '✓ Copied';
    setTimeout(() => { copyBtn.textContent = 'Copy address'; }, 1200);
  });

  const promoteBtn = backdrop.querySelector('#profile-promote-btn');
  if (promoteBtn) {
    promoteBtn.addEventListener('click', async () => {
      close();
      await handlePromoteToTrusted(suspicionEntry);
    });
  }

  const refreshBtn = backdrop.querySelector('#profile-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Reviewing Intel…';
      const enriched = await enrichAddressProfile(profile, settings);
      await setCachedAddressProfile(address, profile.chainId, enriched);
      await persistAddressIntel(enriched);
      close();
      await showAddressProfileModal(modalInput);
    });
  }
  const setupKeyBtn = backdrop.querySelector('#profile-setup-key-btn');
  if (setupKeyBtn) {
    setupKeyBtn.addEventListener('click', async () => {
      close();
      await openSettingsForExplorerKey(keyState);
    });
  }
  document.body.appendChild(backdrop);
}

async function openSettingsForExplorerKey(keyState) {
  document.querySelector('[data-tab="settings"]').click();
  await loadSettings();
  const input = document.getElementById(keyState.inputId);
  const status = document.getElementById(keyState.statusId);
  if (status) {
    status.textContent = keyState.setupText;
    status.classList.remove('hidden');
  }
  if (input) {
    input.focus();
    input.select();
  }
}

function showApiKeyPrompt() {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'in-page-modal-backdrop';
    backdrop.innerHTML = `
      <div class="in-page-modal">
        <div class="in-page-modal-title">Faster fetches with a free Etherscan key</div>
        <p class="in-page-modal-hint in-page-modal-hint--normal">
          Takes 2 minutes. Without one, large wallets may rate-limit at ~10k tx.
        </p>
        <div class="in-page-modal-buttons">
          <button class="btn-ghost small" data-choice="cancel">Cancel</button>
          <button class="btn-ghost small" data-choice="free">Use free tier</button>
          <button class="btn-confirm" data-choice="setup">Set up key</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    const close = (c) => { backdrop.remove(); resolve(c); };
    backdrop.querySelector('[data-choice="setup"]').addEventListener('click', () => close('setup'));
    backdrop.querySelector('[data-choice="free"]').addEventListener('click', () => close('free'));
    backdrop.querySelector('[data-choice="cancel"]').addEventListener('click', () => close('cancel'));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close('cancel');
    });
  });
}

function showSimpleConfirm(title, message) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'in-page-modal-backdrop';
    backdrop.innerHTML = `
      <div class="in-page-modal">
        <div class="in-page-modal-title">${escHtml(title)}</div>
        <p class="in-page-modal-hint in-page-modal-hint--wide">${escHtml(message)}</p>
        <div class="in-page-modal-buttons">
          <button class="btn-ghost small" id="sc-cancel">Cancel</button>
          <button class="btn-confirm" id="sc-confirm">Confirm</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    backdrop.querySelector('#sc-confirm').addEventListener('click', () => {
      backdrop.remove(); resolve(true);
    });
    backdrop.querySelector('#sc-cancel').addEventListener('click', () => {
      backdrop.remove(); resolve(false);
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) { backdrop.remove(); resolve(false); }
    });
  });
}

// ===== HELPERS =====

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function shortAddress(addr) {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function sourceName(source) {
  const names = {
    local_wallet: 'Wallet label',
    local_contact: 'Contact label',
    ens_cache: 'ENS cache',
    etherscan_history: 'Etherscan history',
    etherscan: 'Etherscan',
    solscan: 'Solscan',
    goplus: 'GoPlus',
    ens: 'ENS',
    domain: 'Domain',
    verified_contract: 'Verified contract',
  };
  return names[source] || source || 'Local';
}

function trustName(trust) {
  const names = {
    protected_wallet: 'Wallet history',
    trusted_contact: 'Trusted contact',
    suspicious: 'Suspicious',
    unknown: 'Unknown',
  };
  return names[trust] || trust || 'Unknown';
}

function chainName(chainId) {
  if (!chainId) return 'Unknown';
  return CHAIN_DISPLAY[chainId] || `Chain ${chainId}`;
}

function mergeCachedProfile(localProfile, cachedProfile) {
  if (!cachedProfile?.explorer) return localProfile;
  return {
    ...localProfile,
    explorer: cachedProfile.explorer,
    intel: cachedProfile.intel,
    sources: [...new Set([...(localProfile.sources || []), ...(cachedProfile.sources || [])])],
  };
}

function canRefreshProfile(profile, settings) {
  if (profile.chainId === 'tron') return !!settings.tronApiKey;
  return profile.chainId === 'solana'
    ? !!settings.solscanApiKey
    : !!settings.etherscanApiKey;
}

function getProfileExplorerKeyState(profile, settings) {
  if (profile.chainId === 'tron') {
    const ready = !!settings.tronApiKey;
    return {
      ready,
      source: 'Tronscan',
      inputId: 'tron-key-input',
      statusId: 'tron-key-status',
      actionText: ready ? 'Tronscan key ready' : 'Add Tronscan key',
      statusText: ready
        ? 'Tronscan key ready. TRON Intel uses your locally saved key for balance and activity. Wallet history import uses Tronscan in the review flow.'
        : 'Add a local Tronscan key to run TRON Intel with balance and activity. Wallet history import uses Tronscan in the review flow. Keys stay on this device and are never synced, logged, or sent to Zafu.',
      setupText: 'Tronscan key is saved only in chrome.storage.local on this device. Zafu uses it directly with Tronscan and never syncs, logs, or sends the key to Zafu.',
    };
  }
  const isSolana = profile.chainId === 'solana';
  const source = isSolana ? 'Solscan' : 'Etherscan';
  const ready = isSolana ? !!settings.solscanApiKey : !!settings.etherscanApiKey;
  return {
    ready,
    source,
    inputId: isSolana ? 'solscan-key-input' : 'api-key-input',
    statusId: isSolana ? 'solscan-key-status' : 'api-key-status',
    actionText: `Add ${source} key`,
    statusText: ready
      ? `${source} key ready. Intel uses your locally saved key.`
      : `Add a local ${source} key to run Intel${isSolana ? '' : ' with balance, EOA/contract, and risk status'}. Keys stay on this device and are never synced, logged, or sent to Zafu.`,
    setupText: `${source} key is saved only in chrome.storage.local on this device. Zafu uses it directly with ${source} and never syncs, logs, or sends the key to Zafu.`,
  };
}

function explorerRows(profile, settings) {
  const source = profile.chainId === 'tron' ? 'Tronscan' : profile.chainId === 'solana' ? 'Solscan' : 'Etherscan';
  const intel = profile.intel || {};
  const rows = [
    ['Source', source],
    ['Key', canRefreshProfile(profile, settings) ? 'Ready' : 'Missing'],
  ];
  const explorer = profile.explorer;
  if (explorer?.status === 'ok') {
    if (intel.identity?.primaryLabel) rows.push(['Known label', intel.identity.primaryLabel]);
    if (intel.identity?.domain?.name) rows.push(['Domain', intel.identity.domain.name]);
    if (intel.identity?.entityType) rows.push(['Entity type', entityTypeName(intel.identity.entityType)]);
    if (explorer.riskUnavailable === true) {
      rows.push(['Risk', 'Check unavailable — retry review']);
    } else if (explorer.risk?.status === 'risky') {
      rows.push(['Risk', explorer.risk.summary || 'Risk flagged']);
    } else if (explorer.risk?.status === 'clear') {
      rows.push(['Risk', 'Clear']);
    }
    rows.push(['Sanctions/scam', sanctionsScamSummary(explorer.risk)]);
    rows.push(['Tx count', formatTxCount(intel.activity)]);
    if (intel.activity?.firstSeen) rows.push(['First seen', timeAgo(intel.activity.firstSeen)]);
    if (intel.activity?.activityLevel) rows.push(['Activity', activityLevelName(intel.activity.activityLevel)]);
    rows.push(['Recent velocity', formatVelocity(intel.activity)]);
    if (intel.recipient?.summary) rows.push(['Recipient', intel.recipient.summary]);
    rows.push(['Balance', formatExplorerBalance(explorer.balance, explorer.nativeSymbol)]);
    if (explorer.contract) {
      rows.push(['Type', explorer.contract.type || 'Unknown']);
      if (explorer.contract.isContract) {
        rows.push(['Verified', explorer.contract.verified ? 'Yes' : 'No']);
        if (explorer.contract.contractName) rows.push(['Name', explorer.contract.contractName]);
      }
    }
    rows.push(['Updated', explorer.updatedAt ? timeAgo(explorer.updatedAt) : '—']);
  } else if (explorer?.status === 'error') {
    rows.push(['Status', explorer.error || 'Refresh failed']);
  } else {
    rows.push(['Status', 'Not refreshed']);
  }
  return rows
    .map(([name, value]) => `<span>${escHtml(name)}</span><strong>${escHtml(value)}</strong>`)
    .join('');
}

function formatTxCount(activity = {}) {
  if (!Number.isFinite(activity.txCount)) return '—';
  return `${activity.txCount.toLocaleString()}${activity.txCountCapped ? '+' : ''}`;
}

function formatVelocity(activity = {}) {
  if (!activity || (!Number.isFinite(activity.recent24h) && !Number.isFinite(activity.recent7d))) return '—';
  const daily = Number.isFinite(activity.recent24h) ? `${activity.recent24h}/24h` : '—/24h';
  const weekly = Number.isFinite(activity.recent7d) ? `${activity.recent7d}/7d` : '—/7d';
  return `${daily}, ${weekly}`;
}

function activityLevelName(level) {
  return { none: 'None', low: 'Low', medium: 'Medium', high: 'High' }[level] || 'Unknown';
}

function entityTypeName(type) {
  return { eoa: 'EOA wallet', contract: 'Contract', unknown: 'Unknown' }[type] || 'Unknown';
}

function sanctionsScamSummary(risk = {}) {
  if (!risk) return 'Not checked';
  if (risk.status === 'clear') return 'No supported flags';
  const parts = [];
  if (risk.sanctionsFlags?.length) parts.push('Sanctions');
  if (risk.scamFlags?.length) parts.push('Scam list');
  return parts.length ? parts.join(', ') : (risk.summary || 'Risk flagged');
}

function formatExplorerBalance(value, symbol) {
  if (!Number.isFinite(value)) return '—';
  const amount = value === 0 ? '0' : (value >= 1 ? value.toFixed(4) : value.toPrecision(4));
  return `${amount} ${symbol || ''}`.trim();
}

function formatFetchProgress(msg) {
  const action = String(msg.action || '');
  const count = Number.isFinite(msg.count) ? msg.count : 0;
  if (action === 'starting') return 'Starting fetch…';
  if (action.startsWith('chain ')) return `Scanning chain ${action.slice(6)}…`;
  if (count > 0) {
    const eta = Math.max(1, Math.ceil(count / 250));
    return `Fetching ${count.toLocaleString()} tx (~${eta}s)…`;
  }
  return `${action}…`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadAddressBookPrimer() {
  const primer = document.getElementById('address-book-primer');
  if (!primer) return;

  const { addressBookPrimerDismissed } = await chrome.storage.local.get('addressBookPrimerDismissed');
  if (addressBookPrimerDismissed) return;

  primer.classList.remove('hidden');
  document.getElementById('address-book-primer-dismiss')?.addEventListener('click', async () => {
    await chrome.storage.local.set({ addressBookPrimerDismissed: true });
    primer.classList.add('hidden');
  });
  document.getElementById('address-book-primer-guide')?.addEventListener('click', async () => {
    await chrome.storage.local.set({ addressBookPrimerDismissed: true });
    primer.classList.add('hidden');
    document.querySelector('[data-tab="guide"]')?.click();
    window.scrollTo(0, 0);
  });
}

async function loadAddressBookTestCard() {
  const card = document.getElementById('address-book-test-card');
  if (!card) return;

  const { triedZafuTest } = await chrome.storage.local.get('triedZafuTest');
  if (!triedZafuTest) card.classList.remove('hidden');
}

// ===== INIT =====

(async () => {
  bindZafuTestLinks();

  const manifest = chrome.runtime.getManifest();
  const versionEl = document.getElementById('fp-version');
  if (versionEl) versionEl.textContent = `v${manifest.version}`;

  // URL param: ?wallet=<id> pre-filters book to that wallet's contacts
  const urlParams = new URLSearchParams(window.location.search);
  const walletParam = urlParams.get('wallet');
  if (walletParam) filterByWalletId = walletParam;

  await Promise.all([
    loadBookData(),
    loadAddressBookPrimer(),
    loadAddressBookTestCard(),
  ]);
})();
