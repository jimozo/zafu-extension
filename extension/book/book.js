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
  getSettings,
  updateSettings,
  getCommunityList,
  getCommunityListSnapshots,
  getInstallId,
  bumpMetric,
  updateWallet,
} from '../lib/storage.js';
import {
  segmentAddress,
  isEvmAddress,
  isSolanaAddress,
  detectChainType,
} from '../lib/address-validator.js';
import { CHAIN_NATIVE, CHAIN_DISPLAY } from '../lib/etherscan-client.js';
import { getAuthState, signIn, signOut, upsertUserToSupabase } from '../lib/auth.js';
import { getPendingReportCount } from '../lib/community-client.js';

const PAGE_SIZE = 100;

const REASON_LABELS = {
  'inbound-or-zero-value': 'Sent funds to you',
  'zero-value-token':      'Spam / dust token',
  'token-transfer':        'Token transfer',
  'inbound':               'Inbound transfer',
};

// --- Address Book state ---
let allEntries = [];
let filtered = [];
let currentPage = 0;
let filterType = 'all';
let filterReason = 'all';
let filterByWalletId = null;
let sortKey = 'lastSeen';
let searchQuery = '';

// --- Tab navigation ---

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const tabId = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');

    if (tabId === 'wallets') await renderWallets();
    if (tabId === 'safety') await loadSafety();
    if (tabId === 'settings') await loadSettings();
    if (tabId === 'community') {
      await loadCommunityTab();
      chrome.runtime.sendMessage({ type: 'REFRESH_COMMUNITY_LIST' }).catch(() => {});
    }
  });
});

// ===== ADDRESS BOOK TAB =====

let walletsMap = {};

async function loadBookData() {
  const [trusted, suspicion, wallets] = await Promise.all([getTrusted(), getSuspicion(), getWallets()]);
  walletsMap = Object.fromEntries(wallets.map((w) => [w.id, w.label || w.address.slice(0, 8) + '…']));

  renderWalletFilterButtons(wallets);

  const trustedEntries = Object.values(trusted).map((e) => ({ ...e, _type: 'trusted' }));
  const suspicionEntries = Object.values(suspicion).map((e) => ({ ...e, _type: 'suspicious' }));

  allEntries = [...trustedEntries, ...suspicionEntries];

  document.getElementById('count-all').textContent = allEntries.length;
  document.getElementById('count-trusted').textContent = trustedEntries.length;
  document.getElementById('count-suspicious').textContent = suspicionEntries.length;

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

function applyFilters() {
  const q = searchQuery.toLowerCase();

  filtered = allEntries.filter((e) => {
    if (filterType === 'starred') return e._type === 'trusted' && e.favourite === true;
    if (filterType !== 'all' && e._type !== filterType) return false;
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
    emptyMsg.classList.remove('hidden');
    return;
  }
  emptyMsg.classList.add('hidden');

  for (const entry of page) {
    tbody.appendChild(buildRow(entry));
  }
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
  const addrSpan = document.createElement('span');
  addrSpan.className = 'addr-mono';
  addrSpan.textContent = segmentAddress(entry.address);
  addrSpan.title = entry.address;
  tdAddr.appendChild(addrSpan);
  const copyAddrBtn = document.createElement('button');
  copyAddrBtn.className = 'copy-addr-btn';
  copyAddrBtn.title = 'Copy address';
  copyAddrBtn.textContent = '⧉';
  copyAddrBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(entry.address).catch(() => {});
    chrome.runtime.sendMessage({ type: 'COPY_ADDRESS', address: entry.address }).catch(() => {});
    copyAddrBtn.textContent = '✓';
    setTimeout(() => { copyAddrBtn.textContent = '⧉'; }, 1200);
  });
  tdAddr.appendChild(copyAddrBtn);
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

  // Reason
  const tdReason = document.createElement('td');
  tdReason.className = 'col-reason';
  if (entry._type === 'suspicious' && entry.reason) {
    const reasonBadge = document.createElement('span');
    reasonBadge.className = 'reason-badge';
    reasonBadge.textContent = REASON_LABELS[entry.reason] || entry.reason;
    tdReason.appendChild(reasonBadge);
  } else {
    tdReason.textContent = '—';
  }
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
    starBtn.title = entry.favourite ? 'Remove from starred' : 'Star this contact';
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

  const ethBtn = document.createElement('button');
  ethBtn.className = 'btn-ghost';
  ethBtn.textContent = 'Etherscan ↗';
  ethBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: `https://etherscan.io/address/${entry.address}` });
  });
  actions.appendChild(ethBtn);

  tdActions.appendChild(actions);
  tr.appendChild(tdActions);

  return tr;
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
    reasonGroup.style.display = filterType === 'trusted' ? 'none' : '';

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
    btn.addEventListener('click', () => {
      filterByWalletId = btn.dataset.id;
      document.querySelector('[data-tab="book"]').click();
      document.querySelectorAll('[data-filter-wallet]').forEach((b) => {
        b.classList.toggle('active', b.dataset.filterWallet === filterByWalletId);
      });
      applyFilters();
    });
  });

  container.querySelectorAll('.btn-etherscan-wallet').forEach((btn) => {
    btn.addEventListener('click', () => {
      const url = btn.dataset.solana
        ? `https://solscan.io/account/${btn.dataset.address}`
        : `https://etherscan.io/address/${btn.dataset.address}`;
      chrome.tabs.create({ url });
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

  const isSolana = chains.includes('solana');

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
      <button class="btn-etherscan-wallet btn-ghost" data-address="${escHtml(wallet.address)}" data-solana="${isSolana ? '1' : ''}">${isSolana ? 'Solscan ↗' : 'Etherscan ↗'}</button>
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
    'Removing this wallet stops protection for its address history.'
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

async function handleFetch(walletId) {
  const btn = document.querySelector(`.btn-fetch[data-id="${walletId}"]`);
  const progressEl = document.getElementById(`progress-${walletId}`);

  const wallets = await getWallets();
  const wallet = wallets.find((w) => w.id === walletId);
  if (!wallet) return;

  const needsEtherscan = (wallet.chains || [wallet.chainId || 1]).some((c) => c !== 'solana');
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
    { type: 'FETCH_HISTORY', walletId, address: wallet.address, chainIds: wallet.chains || [wallet.chainId || 1] },
    async (response) => {
      chrome.runtime.onMessage.removeListener(progressHandler);
      if (btn) { btn.disabled = false; btn.textContent = 'Fetch history'; }
      if (progressEl) progressEl.classList.add('hidden');

      if (response && response.ok) {
        await renderWallets();
        // Refresh book if it was loaded
        if (allEntries.length > 0) await loadBookData();
        if (progressEl) {
          const { trustedCount, suspicionCount } = response;
          progressEl.textContent = `Done — ${trustedCount} trusted, ${suspicionCount} suspicious`;
          progressEl.classList.remove('hidden');
          setTimeout(() => progressEl.classList.add('hidden'), 5000);
        }
      } else if (response && !response.ok && progressEl) {
        progressEl.textContent = `Error: ${response.error || 'fetch failed'}`;
        progressEl.classList.remove('hidden');
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
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const address = addrInput.value.trim();

  errorEl.classList.add('hidden');

  const chainType = detectChainType(address);
  if (chainType !== 'evm' && chainType !== 'solana') {
    errorEl.textContent = 'Not a valid address (EVM 0x… or Solana base58).';
    errorEl.classList.remove('hidden');
    return;
  }

  submitBtn.disabled = true;

  let activeChains = [];
  let primaryChainId;

  if (chainType === 'solana') {
    activeChains = ['solana'];
    primaryChainId = 'solana';
  } else {
    submitBtn.textContent = 'Scanning networks…';
    const probeResp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'PROBE_CHAINS', address }, resolve);
    });
    primaryChainId = 1;
    if (probeResp && probeResp.ok) {
      const active = probeResp.results.filter((r) => r.hasActivity);
      activeChains = active.map((r) => r.chainId);
      if (active.length) {
        active.sort((a, b) => (b.lastTxAt || 0) - (a.lastTxAt || 0));
        primaryChainId = active[0].chainId;
      }
    }
    if (activeChains.length === 0) activeChains = [1];
  }

  await addWallet({
    address,
    label: labelInput.value.trim(),
    chains: activeChains,
    primaryChainId,
    chainId: primaryChainId,
  });
  addrInput.value = '';
  labelInput.value = '';
  submitBtn.disabled = false;
  submitBtn.textContent = 'Add & Fetch History';
  document.getElementById('add-wallet-form-container').classList.add('hidden');
  document.getElementById('toggle-add-btn').textContent = '+ Add wallet';

  await renderWallets();
  if (chainType === 'solana') return;
  const wallets = await getWallets();
  const added = wallets.find((w) => w.address.toLowerCase() === address.toLowerCase());
  if (added) handleFetch(added.id);
});

// ===== SAFETY TAB =====

const FINGERPRINT_FILES = [
  'manifest.json',
  'background/service-worker.js',
  'content/content-script.js',
  'content/contact-picker.js',
  'overlay/overlay.js',
  'overlay/overlay.css',
  'lib/address-validator.js',
  'lib/address-comparator.js',
  'lib/auth.js',
  'lib/community-client.js',
  'lib/ens-client.js',
  'lib/etherscan-client.js',
  'lib/index-builder.js',
  'lib/self-audit.js',
  'lib/solana-detector.js',
  'lib/solscan-client.js',
  'lib/storage.js',
  'lib/sync.js',
  'data/known-good-contracts.json',
  'data/known-good-contracts-solana.json',
  'data/malicious-confirmed.json',
  'data/scam-addresses.json',
  'data/scam-addresses-solana.json',
  'data/wallet-exchange-domains.json',
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

async function loadSafety() {
  const hashEl = document.getElementById('fp-hash');
  if (hashEl && hashEl.textContent === 'computing…') {
    const fp = await computeFingerprint();
    hashEl.textContent = fp;
  }
}

document.getElementById('verify-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://github.com/jimozo/zafu/releases' });
});

document.getElementById('github-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://github.com/jimozo/zafu' });
});

// ===== SETTINGS TAB =====

async function loadSettings() {
  const settings = await getSettings();

  const guardianToggle = document.getElementById('guardian-toggle');
  guardianToggle.checked = settings.guardianMode === true;

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
}

document.getElementById('guardian-toggle').addEventListener('change', async (e) => {
  await updateSettings({ guardianMode: e.target.checked });
});

document.getElementById('save-api-key-btn').addEventListener('click', async () => {
  const key = document.getElementById('api-key-input').value.trim();
  const status = document.getElementById('api-key-status');
  if (!key) return;
  await updateSettings({ etherscanApiKey: key });
  document.getElementById('api-key-input').value = '';
  document.getElementById('api-key-input').placeholder = '••••••••••••••••';
  status.textContent = 'API key saved.';
  status.classList.remove('hidden');
});

document.getElementById('save-solscan-key-btn')?.addEventListener('click', async () => {
  const key = document.getElementById('solscan-key-input').value.trim();
  const status = document.getElementById('solscan-key-status');
  if (!key) return;
  await updateSettings({ solscanApiKey: key });
  document.getElementById('solscan-key-input').value = '';
  document.getElementById('solscan-key-input').placeholder = '••••••••••••••••';
  status.textContent = 'Solscan key saved.';
  status.classList.remove('hidden');
});

document.getElementById('etherscan-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://etherscan.io/apidashboard' });
});
document.getElementById('solscan-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://pro-api.solscan.io' });
});

document.getElementById('export-contacts-btn').addEventListener('click', handleExport);

// ===== COMMUNITY TAB =====

const BOOK_GOOGLE_BTN_INNER = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> Sign in with Google`;
const CANNY_BOARD_URL = 'https://zafu.canny.io';

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
  const [state, communityList, snapshots] = await Promise.all([
    getAuthState(),
    getCommunityList(),
    getCommunityListSnapshots(),
  ]);
  renderBookCommunityAccountUI(state);
  const countEl = document.getElementById('book-community-list-count');
  if (countEl) countEl.textContent = communityList.count > 0 ? communityList.count.toLocaleString() : '—';

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
      pendingEl.textContent = `${pending} report${pending > 1 ? 's' : ''} queued — retrying on next sync.`;
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

document.getElementById('book-community-feedback-btn').addEventListener('click', async (e) => {
  e.preventDefault();
  const state = await getAuthState();
  let url = CANNY_BOARD_URL;
  if (state.isAuthenticated) {
    url += '?email=' + encodeURIComponent(state.email) + '&name=' + encodeURIComponent(state.displayName);
  }
  chrome.tabs.create({ url });
});

async function handleEditContact(entry) {
  const saved = await showEditModal(entry);
  if (saved) await loadBookData();
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

    saveBtn.addEventListener('click', async () => {
      const newLabel = labelInput.value.trim();
      if (!newLabel) return;
      await updateTrustedEntry(entry.address, {
        label: newLabel,
        description: backdrop.querySelector('#edit-description').value.trim(),
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

function showWalletEditModal(wallet) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'in-page-modal-backdrop';
    backdrop.innerHTML = `
      <div class="in-page-modal">
        <div class="in-page-modal-title">Edit protected wallet</div>
        <div class="in-page-modal-addr">${escHtml(wallet.address)}</div>
        <div class="edit-field">
          <label for="wallet-edit-label">Name</label>
          <input id="wallet-edit-label" type="text" value="${escHtml(wallet.label || '')}" placeholder="e.g. Main MetaMask, Cold wallet" autocomplete="off" />
        </div>
        <p class="in-page-modal-hint">Public address only. ZAFU watches this wallet's history for protection and cannot connect to it or move funds.</p>
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
  const installId = await getInstallId().catch(() => null);
  const refSuffix = installId ? `?ref=${installId}` : '';
  const shareUrl = `https://stayzafu.com/${refSuffix}`;
  const tweetText = `Just installed @stayzafu — catches address poisoning and clipboard hijacking before you send. ${shareUrl}`;

  const backdrop = document.createElement('div');
  backdrop.className = 'in-page-modal-backdrop';
  backdrop.innerHTML = `
    <div class="in-page-modal">
      <div class="in-page-modal-title">Share Zafu</div>
      <p class="in-page-modal-hint in-page-modal-hint--sm">
        Help others catch address poisoning. Your link tracks who you protected.
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
        <div class="in-page-modal-title">${title}</div>
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

// ===== INIT =====

(async () => {
  const manifest = chrome.runtime.getManifest();
  const versionEl = document.getElementById('fp-version');
  if (versionEl) versionEl.textContent = `v${manifest.version}`;

  // URL param: ?wallet=<id> pre-filters book to that wallet's contacts
  const urlParams = new URLSearchParams(window.location.search);
  const walletParam = urlParams.get('wallet');
  if (walletParam) filterByWalletId = walletParam;

  await loadBookData();
})();
