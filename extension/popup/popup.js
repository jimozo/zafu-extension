import {
  getWallets,
  addWallet,
  removeWallet,
  getTrusted,
  getSuspicion,
  promoteSuspicionToTrusted,
  setTrustedLabel,
  removeTrusted,
  removeSuspicion,
  getSettings,
  updateSettings,
  addManualContact,
  updateTrustedEntry,
  getCommunityList,
  getCommunityListSnapshots,
  getInstallId,
  getMetrics,
  bumpMetric,
  updateWallet,
} from '../lib/storage.js';
import { getPendingReportCount } from '../lib/community-client.js';
import {
  isEvmAddress,
  isSolanaAddress,
  detectChainType,
  segmentAddress,
} from '../lib/address-validator.js';
import { CHAIN_NATIVE, CHAIN_DISPLAY } from '../lib/etherscan-client.js';
import { getAuthState, signIn, signOut, upsertUserToSupabase } from '../lib/auth.js';

const CHAIN_NAMES = CHAIN_DISPLAY;

// --- Reason labels ---

const REASON_LABELS = {
  'inbound-or-zero-value': 'Sent funds to you',
  'zero-value-token':      'Sent spam/dust token to you',
  'token-transfer':        'Token transfer counterparty',
  'inbound':               'Sent funds to you',
};

function humanReason(reason) {
  return REASON_LABELS[reason] || reason || 'In your history';
}

// --- Tab navigation ---

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const tabId = btn.dataset.tab;

    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');

    if (tabId === 'book') await renderAddressBook();
    if (tabId === 'community') {
      loadCommunityPanel();
      renderCommunityAccountUI(await getAuthState());
      chrome.runtime.sendMessage({ type: 'REFRESH_COMMUNITY_LIST' }).catch(() => {});
    }
  });
});

// --- Add wallet toggle ---

function openAddWalletForm() {
  const container = document.getElementById('add-wallet-form-container');
  container.classList.remove('hidden');
  document.getElementById('toggle-add-btn').textContent = '− Cancel';
  document.getElementById('wallet-address').focus();
}

document.getElementById('toggle-add-btn').addEventListener('click', () => {
  const container = document.getElementById('add-wallet-form-container');
  const isHidden = container.classList.toggle('hidden');
  document.getElementById('toggle-add-btn').textContent = isHidden ? '+ Add' : '− Cancel';
});

document.getElementById('empty-add-wallet-btn').addEventListener('click', openAddWalletForm);
document.getElementById('empty-sync-wallet-btn').addEventListener('click', () => {
  document.querySelector('[data-tab="wallets"]').click();
  openAddWalletForm();
});
document.getElementById('empty-goto-wallets-btn').addEventListener('click', () => {
  document.querySelector('[data-tab="wallets"]').click();
});

// --- Add wallet form ---

document.getElementById('add-wallet-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const addrInput = document.getElementById('wallet-address');
  const labelInput = document.getElementById('wallet-label');
  const errorEl = document.getElementById('add-error');
  const statusEl = document.getElementById('probe-status');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const address = addrInput.value.trim();

  errorEl.classList.add('hidden');

  const chainType = detectChainType(address);
  if (chainType !== 'evm' && chainType !== 'solana') {
    errorEl.textContent = 'Not a valid EVM (0x…) or Solana (base58) address.';
    errorEl.classList.remove('hidden');
    return;
  }

  let activeChains;
  let primaryChainId;

  if (chainType === 'solana') {
    // Solana is single-chain; no probe needed.
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding…';
    statusEl.textContent = 'Detected Solana wallet. Adding…';
    statusEl.classList.remove('hidden');
    activeChains = ['solana'];
    primaryChainId = 'solana';
  } else {
    // EVM — probe chains for activity before adding
    submitBtn.disabled = true;
    submitBtn.textContent = 'Scanning networks…';
    statusEl.textContent = 'Detecting active networks across supported EVM chains…';
    statusEl.classList.remove('hidden');

    const probeResp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'PROBE_CHAINS', address }, resolve);
    });

    activeChains = [];
    primaryChainId = 1;
    if (probeResp && probeResp.ok) {
      activeChains = probeResp.results.filter((r) => r.hasActivity).map((r) => r.chainId);
      const active = probeResp.results.filter((r) => r.hasActivity);
      if (active.length) {
        active.sort((a, b) => (b.lastTxAt || 0) - (a.lastTxAt || 0));
        primaryChainId = active[0].chainId;
      }
    }
    if (activeChains.length === 0) activeChains = [1]; // default fallback

    statusEl.textContent = `Found activity on ${activeChains.length} network${activeChains.length > 1 ? 's' : ''}. Adding…`;
  }

  const added = await addWallet({
    address,
    label: labelInput.value.trim(),
    chains: activeChains,
    primaryChainId,
    chainId: primaryChainId,
  });

  addrInput.value = '';
  labelInput.value = '';
  submitBtn.disabled = false;
  submitBtn.textContent = 'Add & Scan';
  statusEl.classList.add('hidden');
  document.getElementById('add-wallet-form-container').classList.add('hidden');
  document.getElementById('toggle-add-btn').textContent = '+ Add';

  await renderWallets();
  if (added) handleFetch(added.id);
});

// --- Add Contact toggle ---

document.getElementById('toggle-add-contact-btn').addEventListener('click', () => {
  const container = document.getElementById('add-contact-form-container');
  const isHidden = container.classList.toggle('hidden');
  document.getElementById('toggle-add-contact-btn').textContent = isHidden ? '+ Contact' : '− Cancel';
});

document.getElementById('add-contact-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const addrInput = document.getElementById('contact-address');
  const labelInput = document.getElementById('contact-label');
  const errorEl = document.getElementById('add-contact-error');
  const address = addrInput.value.trim();

  errorEl.classList.add('hidden');

  if (!isEvmAddress(address) && !isSolanaAddress(address)) {
    errorEl.textContent = 'Not a valid EVM (0x…) or Solana (base58) address.';
    errorEl.classList.remove('hidden');
    return;
  }

  const rawChain = document.getElementById('contact-chain').value;
  const chainId = rawChain === 'solana' ? 'solana' : (parseInt(rawChain, 10) || 1);
  const notes = document.getElementById('contact-notes').value.trim();
  await addManualContact({ address, label: labelInput.value.trim(), chainId, notes });

  addrInput.value = '';
  labelInput.value = '';
  document.getElementById('contact-notes').value = '';
  document.getElementById('contact-chain').value = '1';
  document.getElementById('add-contact-form-container').classList.add('hidden');
  document.getElementById('toggle-add-contact-btn').textContent = '+ Contact';

  await renderAddressBook();
});

// --- Guardian Mode toggle ---

const guardianToggle = document.getElementById('guardian-toggle');

guardianToggle.addEventListener('change', async () => {
  await updateSettings({ guardianMode: guardianToggle.checked });
});

async function loadGuardianToggle() {
  const settings = await getSettings();
  guardianToggle.checked = settings.guardianMode === true;
}

// --- Settings ---

async function loadSettings() {
  const settings = await getSettings();
  const keyInput = document.getElementById('api-key-input');
  const status = document.getElementById('api-key-status');
  if (settings.etherscanApiKey) {
    keyInput.placeholder = '••••••••••••••••';
    status.textContent = 'API key saved.';
    status.classList.remove('hidden');
  }
  const solInput = document.getElementById('solscan-key-input');
  const solStatus = document.getElementById('solscan-key-status');
  if (settings.solscanApiKey && solInput && solStatus) {
    solInput.placeholder = '••••••••••••••••';
    solStatus.textContent = 'Solscan key saved.';
    solStatus.classList.remove('hidden');
  }
}

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

const solscanSaveBtn = document.getElementById('save-solscan-key-btn');
if (solscanSaveBtn) {
  solscanSaveBtn.addEventListener('click', async () => {
    const key = document.getElementById('solscan-key-input').value.trim();
    const status = document.getElementById('solscan-key-status');
    if (!key) return;
    await updateSettings({ solscanApiKey: key });
    document.getElementById('solscan-key-input').value = '';
    document.getElementById('solscan-key-input').placeholder = '••••••••••••••••';
    status.textContent = 'Solscan key saved.';
    status.classList.remove('hidden');
  });
}

function openEtherscan() {
  chrome.tabs.create({ url: 'https://etherscan.io/apidashboard' });
}

document.getElementById('etherscan-link').addEventListener('click', (e) => {
  e.preventDefault(); openEtherscan();
});
const solscanLink = document.getElementById('solscan-link');
if (solscanLink) {
  solscanLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://pro-api.solscan.io' });
  });
}

// --- Wallet list ---

async function renderWallets() {
  const wallets = await getWallets();
  const list = document.getElementById('wallet-list');
  const empty = document.getElementById('no-wallets');
  list.innerHTML = '';

  if (wallets.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const settings = await getSettings();
  const prices = settings.prices || {};

  for (const wallet of wallets) {
    const li = document.createElement('li');
    li.className = 'wallet-item wallet-item--rich';
    li.dataset.walletId = wallet.id;

    const chains = wallet.chains && wallet.chains.length ? wallet.chains : [wallet.chainId || 1];
    const perChain = wallet.perChain || {};

    // Aggregate stats across chains
    let totalUsd = 0;
    let totalTx = 0;
    let totalTrusted = 0;
    let totalSuspicion = 0;
    let firstTxAt = null;
    let lastTxAt = null;
    let gasSpentTotal = 0;
    for (const cid of chains) {
      const pc = perChain[cid];
      if (!pc) continue;
      const bal = pc.balance || 0;
      const price = prices[cid] || 0;
      totalUsd += bal * price;
      totalTx += (pc.txCount || 0) + (pc.tokenTxCount || 0);
      totalTrusted += pc.trustedCount || 0;
      totalSuspicion += pc.suspicionCount || 0;
      gasSpentTotal += pc.gasSpent || 0;
      if (pc.firstTxAt && (!firstTxAt || pc.firstTxAt < firstTxAt)) firstTxAt = pc.firstTxAt;
      if (pc.lastTxAt && (!lastTxAt || pc.lastTxAt > lastTxAt)) lastTxAt = pc.lastTxAt;
    }

    const age = firstTxAt ? ageLabel(firstTxAt) : '—';
    const lastAct = lastTxAt ? timeAgo(lastTxAt) : '—';
    const usdStr = totalUsd > 0 ? `$${formatUsd(totalUsd)}` : '—';
    const isSolanaWallet = chains.length === 1 && chains[0] === 'solana';
    const chainBadges = chains.map((cid) => {
      const pc = perChain[cid];
      const sym = CHAIN_NATIVE[cid] || 'ETH';
      const name = CHAIN_NAMES[cid] || `Chain ${cid}`;
      const bal = pc?.balance ?? 0;
      return `<span class="chain-pill" title="${escHtml(name)}: ${bal.toFixed(4)} ${sym}">${escHtml(name)} · ${bal.toFixed(3)}</span>`;
    }).join('');

    const lastFetched = wallet.lastFetchedAt ? `Synced ${timeAgo(wallet.lastFetchedAt)}` : 'Not scanned yet';

    li.innerHTML = `
      <div class="wallet-info">
        <div class="wallet-head">
          <div class="wallet-label">${escHtml(wallet.label || 'Unlabeled wallet')}</div>
          <div class="wallet-usd">${usdStr}</div>
        </div>
        <div class="wallet-address">${shortAddress(wallet.address)}</div>
        <div class="chain-pills">${chainBadges}</div>
        <div class="wallet-stats">
          <div class="wstat"><span class="wstat-val">${totalTrusted}</span><span class="wstat-lbl">Trusted</span></div>
          <div class="wstat"><span class="wstat-val">${totalSuspicion}</span><span class="wstat-lbl">Suspicious</span></div>
          <div class="wstat"><span class="wstat-val">${totalTx}</span><span class="wstat-lbl">Txs</span></div>
          <div class="wstat"><span class="wstat-val">${gasSpentTotal > 0 ? gasSpentTotal.toFixed(3) : '—'}</span><span class="wstat-lbl">${isSolanaWallet ? 'Fees (SOL)' : 'Gas (ETH)'}</span></div>
        </div>
        <div class="wallet-timeline">
          <span>Age: <strong>${escHtml(age)}</strong></span>
          <span>Last tx: <strong>${escHtml(lastAct)}</strong></span>
        </div>
        <div class="wallet-meta"><span class="status-ok">${escHtml(lastFetched)}</span></div>
        <div class="fetch-progress hidden" id="progress-${wallet.id}"></div>
      </div>
      <div class="wallet-actions">
        <button class="btn-fetch" data-id="${wallet.id}" title="Re-scan">Sync</button>
        <button class="btn-edit-wallet" data-id="${wallet.id}" title="Rename protected wallet">Edit</button>
        <button class="btn-filter-book" data-id="${wallet.id}" title="Show contacts from this wallet">Contacts</button>
        <button class="btn-remove" data-id="${wallet.id}" title="Remove wallet">✕</button>
      </div>
    `;
    list.appendChild(li);
  }

  list.querySelectorAll('.btn-fetch').forEach((btn) => {
    btn.addEventListener('click', () => handleFetch(btn.dataset.id));
  });

  list.querySelectorAll('.btn-remove').forEach((btn) => {
    btn.addEventListener('click', () => handleRemoveWallet(btn.dataset.id));
  });

  list.querySelectorAll('.btn-edit-wallet').forEach((btn) => {
    btn.addEventListener('click', () => handleEditWallet(btn.dataset.id));
  });

  list.querySelectorAll('.btn-filter-book').forEach((btn) => {
    btn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL(`book/book.html?wallet=${btn.dataset.id}`) });
    });
  });
}

function formatUsd(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
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

  const confirmed = await showInPageConfirm(
    'Remove wallet?',
    `Removing <strong>${escHtml(wallet.label || shortAddress(wallet.address))}</strong> stops protection for its address history.`,
    'Remove',
    'btn-ghost'
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

  // API-key intercept: if this wallet needs Etherscan (has any EVM chain)
  // and no key is set, prompt the user once before proceeding.
  const needsEtherscan = (wallet.chains || [wallet.chainId || 1]).some((c) => c !== 'solana');
  if (needsEtherscan) {
    const settings = await getSettings();
    const { apiKeyFreeTierAck } = await chrome.storage.local.get('apiKeyFreeTierAck');
    if (!settings.etherscanApiKey && !apiKeyFreeTierAck) {
      const choice = await showApiKeyPrompt();
      if (choice === 'cancel') return;
      if (choice === 'setup') {
        openPanel('settings');
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

      if (btn) { btn.disabled = false; btn.textContent = 'Fetch'; }
      if (progressEl) progressEl.classList.add('hidden');

      if (response && response.ok) {
        await renderWallets();
        await renderAuditAlert();
        const { trustedCount, suspicionCount, auditFlags } = response;
        if (progressEl) {
          progressEl.textContent = `Done — ${trustedCount} trusted, ${suspicionCount} suspicious${auditFlags ? `, ⚠ ${auditFlags} flagged pairs` : ''}`;
          progressEl.classList.remove('hidden');
          setTimeout(() => progressEl.classList.add('hidden'), 5000);
        }
      } else if (response && !response.ok) {
        if (progressEl) {
          progressEl.textContent = `Error: ${response.error || 'fetch failed'}.`;
          progressEl.classList.remove('hidden');
        }
      }
    }
  );
}

// --- Audit alert ---

async function renderAuditAlert() {
  const settings = await getSettings();
  const results = settings.auditResults || [];
  const section = document.getElementById('audit-section');
  const summary = document.getElementById('audit-summary');

  if (results.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  summary.textContent = `Found ${results.length} address pair${results.length > 1 ? 's' : ''} in your history that look almost identical — one may be a planted poisoning address.`;
}

document.getElementById('view-audit-btn').addEventListener('click', async () => {
  const settings = await getSettings();
  const results = settings.auditResults || [];
  alert(
    results
      .map(
        (r, i) =>
          `Pair ${i + 1}:\n  Suspect: ${r.suspectAddress} (${r.suspectTxCount} tx)\n  Real:    ${r.realAddress} (${r.realTxCount} tx)\n  Both share prefix "${r.sharedPrefix}" and suffix "${r.sharedSuffix}"`
      )
      .join('\n\n')
  );
});

// --- Open full view ---

document.getElementById('open-book-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('book/book.html') });
});

document.getElementById('open-book-btn-wallets').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('book/book.html') });
});

// --- Overlay panels ---

function openPanel(name) {
  document.querySelectorAll('.overlay-panel').forEach((p) => p.classList.remove('active'));
  document.getElementById(`panel-${name}`).classList.add('active');
  if (name === 'safety') loadSafety();
}

document.getElementById('open-guide-btn').addEventListener('click', () => openPanel('guide'));
document.getElementById('open-safety-btn').addEventListener('click', () => openPanel('safety'));
document.getElementById('open-settings-btn').addEventListener('click', () => openPanel('settings'));

document.querySelectorAll('.panel-close').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById(`panel-${btn.dataset.panel}`).classList.remove('active');
  });
});

// --- Address book ---

let contactsWalletFilter = 'all';

document.getElementById('search-input').addEventListener('input', renderAddressBook);
document.getElementById('contacts-wallet-filter').addEventListener('change', (e) => {
  contactsWalletFilter = e.target.value;
  renderAddressBook();
});

document.getElementById('show-suspicion-btn').addEventListener('click', (e) => {
  const list = document.getElementById('suspicion-list');
  const hidden = list.classList.toggle('hidden');
  e.currentTarget.textContent = hidden ? 'Show' : 'Hide';
});

function renderContactsWalletFilter(wallets) {
  const select = document.getElementById('contacts-wallet-filter');
  if (!select) return;
  const current = select.value || contactsWalletFilter;
  select.innerHTML = '<option value="all">All wallets</option>';
  for (const w of wallets) {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.label || shortAddress(w.address);
    select.appendChild(opt);
  }
  if ([...select.options].some((o) => o.value === current)) select.value = current;
  else select.value = 'all';
  contactsWalletFilter = select.value;
}

async function renderAddressBook() {
  const query = document.getElementById('search-input').value.toLowerCase().trim();
  const [trusted, suspicion, wallets] = await Promise.all([getTrusted(), getSuspicion(), getWallets()]);
  const walletsMap = Object.fromEntries(wallets.map((w) => [w.id, w.label || shortAddress(w.address)]));

  renderContactsWalletFilter(wallets);

  const trustedList = document.getElementById('trusted-list');
  const suspicionList = document.getElementById('suspicion-list');
  const empty = document.getElementById('no-addresses');
  const noTrusted = document.getElementById('no-trusted');

  trustedList.innerHTML = '';
  suspicionList.innerHTML = '';

  const matchesWallet = (e) => {
    if (contactsWalletFilter === 'all') return true;
    const origins = e.originWallets || [];
    return origins.includes(contactsWalletFilter);
  };

  const trustedEntries = Object.values(trusted).filter(
    (e) =>
      matchesWallet(e) &&
      (!query ||
        e.address.includes(query) ||
        (e.label || '').toLowerCase().includes(query) ||
        (e.etherscanLabel || '').toLowerCase().includes(query) ||
        (e.ensName || '').toLowerCase().includes(query))
  );
  const suspicionEntries = Object.values(suspicion).filter(
    (e) =>
      matchesWallet(e) &&
      (!query ||
        e.address.includes(query) ||
        (e.reason || '').toLowerCase().includes(query))
  );

  document.getElementById('trusted-count').textContent = `${trustedEntries.length}`;
  document.getElementById('suspicion-count').textContent = `${suspicionEntries.length}`;

  const hasAny = trustedEntries.length > 0 || suspicionEntries.length > 0;
  empty.classList.toggle('hidden', hasAny);
  noTrusted.classList.toggle('hidden', trustedEntries.length > 0);

  const sortedTrusted = trustedEntries.sort((a, b) => {
    if (b.favourite !== a.favourite) return (b.favourite ? 1 : 0) - (a.favourite ? 1 : 0);
    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });
  const hasStarred = sortedTrusted.some((e) => e.favourite);
  let shownStarredHeader = false;
  let shownAllHeader = false;
  for (const e of sortedTrusted) {
    if (hasStarred && e.favourite && !shownStarredHeader) {
      const header = document.createElement('li');
      header.className = 'addr-section-header';
      header.textContent = '★ Starred';
      trustedList.appendChild(header);
      shownStarredHeader = true;
    }
    if (hasStarred && !e.favourite && !shownAllHeader) {
      const header = document.createElement('li');
      header.className = 'addr-section-header';
      header.textContent = 'All contacts';
      trustedList.appendChild(header);
      shownAllHeader = true;
    }
    trustedList.appendChild(buildAddressItem(e, 'trusted', walletsMap));
  }
  for (const e of suspicionEntries.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))) {
    suspicionList.appendChild(buildAddressItem(e, 'suspicion', walletsMap));
  }
}

function buildAddressItem(entry, type, walletsMap = {}) {
  const li = document.createElement('li');
  li.className = 'addr-item';

  const displayName = entry.label || entry.etherscanLabel || entry.ensName || null;
  const metaParts = [];
  if (entry.txCount) metaParts.push(`${entry.txCount} send${entry.txCount > 1 ? 's' : ''}`);
  if (entry.lastSeen) metaParts.push(`last seen ${timeAgo(entry.lastSeen)}`);

  if (displayName) {
    const labelEl = document.createElement('div');
    labelEl.className = 'addr-item-label';
    labelEl.textContent = displayName;
    li.appendChild(labelEl);
  }

  const addrEl = document.createElement('div');
  addrEl.className = 'addr-item-address';
  addrEl.textContent = segmentAddress(entry.address);
  li.appendChild(addrEl);

  if (type === 'suspicion' && entry.reason) {
    const metaEl = document.createElement('div');
    metaEl.className = 'addr-item-meta';
    metaEl.innerHTML = `<span class="reason-badge">${escHtml(humanReason(entry.reason))}</span>`;
    li.appendChild(metaEl);
  } else if (metaParts.length) {
    const metaEl = document.createElement('div');
    metaEl.className = 'addr-item-meta';
    metaEl.textContent = metaParts.join(' · ');
    li.appendChild(metaEl);
  }

  if (entry.originWallets && entry.originWallets.length > 0) {
    const labels = entry.originWallets.map((id) => walletsMap[id] || id.slice(0, 8) + '…').join(', ');
    const originEl = document.createElement('div');
    originEl.className = 'addr-item-meta';
    originEl.textContent = `From: ${labels}`;
    li.appendChild(originEl);
  }

  if (type === 'trusted') {
    const actions = document.createElement('div');
    actions.className = 'addr-item-actions';

    const starBtn = document.createElement('button');
    starBtn.className = 'btn-ghost small star-btn' + (entry.favourite ? ' starred' : '');
    starBtn.textContent = entry.favourite ? '★' : '☆';
    starBtn.title = entry.favourite ? 'Remove from starred' : 'Star this contact';
    starBtn.addEventListener('click', async () => {
      await updateTrustedEntry(entry.address, { favourite: !entry.favourite });
      await renderAddressBook();
    });
    actions.appendChild(starBtn);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-ghost small btn-copy';
    copyBtn.textContent = 'Copy';
    copyBtn.title = 'Copy address to clipboard';
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(entry.address);
      chrome.runtime.sendMessage({ type: 'COPY_ADDRESS', address: entry.address }).catch(() => {});
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    });
    actions.appendChild(copyBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-ghost small btn-edit-label';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => startLabelEdit(li, entry));
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-ghost small';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => handleDeleteContact(entry, 'trusted'));
    actions.appendChild(deleteBtn);

    li.appendChild(actions);
  }

  if (type === 'suspicion') {
    const rowActions = document.createElement('div');
    rowActions.className = 'addr-item-actions';
    rowActions.classList.add('addr-item-actions--mt');

    const promoteBtn = document.createElement('button');
    promoteBtn.className = 'btn-ghost small';
    promoteBtn.textContent = 'Mark trusted…';
    promoteBtn.addEventListener('click', () => handlePromoteToTrusted(entry));
    rowActions.appendChild(promoteBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-ghost small';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => handleDeleteContact(entry, 'suspicion'));
    rowActions.appendChild(deleteBtn);

    li.appendChild(rowActions);
  }

  return li;
}

async function handlePromoteToTrusted(entry) {
  const label = await showPromoteModal(entry.address);
  if (label === null) return;
  await promoteSuspicionToTrusted(entry.address);
  if (label) await setTrustedLabel(entry.address, label);
  await renderAddressBook();
}

async function handleDeleteContact(entry, type) {
  const displayName = entry.label || entry.etherscanLabel || entry.ensName || shortAddress(entry.address);
  const confirmed = await showInPageConfirm(
    `Delete "${displayName}"?`,
    'Address removed from your book. May reappear if you re-fetch wallet history.',
    'Delete',
    'btn-ghost'
  );
  if (!confirmed) return;
  if (type === 'trusted') {
    await removeTrusted(entry.address);
  } else {
    await removeSuspicion(entry.address);
  }
  await renderAddressBook();
}

function startLabelEdit(li, entry) {
  const labelEl = li.querySelector('.addr-item-label');
  const editBtn = li.querySelector('.btn-edit-label');
  const currentLabel = entry.label || entry.etherscanLabel || entry.ensName || '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'edit-input';
  input.value = currentLabel;
  input.placeholder = 'Enter name…';

  if (labelEl) {
    labelEl.replaceWith(input);
  } else {
    li.prepend(input);
  }

  if (editBtn) editBtn.classList.add('hidden');
  input.focus();
  input.select();

  let saved = false;

  async function saveLabel() {
    if (saved) return;
    saved = true;
    const newLabel = input.value.trim();
    await setTrustedLabel(entry.address, newLabel);
    await renderAddressBook();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveLabel(); }
    if (e.key === 'Escape') { saved = true; renderAddressBook(); }
  });
  input.addEventListener('blur', saveLabel);
}

// --- Safety tab ---

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
  const fpEl = document.getElementById('ext-fingerprint');
  if (fpEl && fpEl.textContent === 'computing…') {
    const fp = await computeFingerprint();
    fpEl.textContent = fp;
    fpEl.classList.remove('muted');
  }
}

document.getElementById('verify-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://github.com/jimozo/zafu/releases' });
});

// --- Account (Google Sign-In) ---

function renderAccountUI(state) {
  const signedOut = document.getElementById('account-signed-out');
  const signedIn = document.getElementById('account-signed-in');
  if (!signedOut || !signedIn) return;

  if (state.isAuthenticated) {
    signedOut.classList.add('hidden');
    signedIn.classList.remove('hidden');
    const avatarEl = document.getElementById('account-avatar');
    if (avatarEl && state.avatar) {
      avatarEl.src = state.avatar;
      avatarEl.alt = state.displayName;
    }
    const nameEl = document.getElementById('account-name');
    if (nameEl) nameEl.textContent = state.displayName;
    const emailEl = document.getElementById('account-email');
    if (emailEl) emailEl.textContent = state.email;
  } else {
    signedOut.classList.remove('hidden');
    signedIn.classList.add('hidden');
  }
}

function renderCommunityAccountUI(state) {
  const signedOut = document.getElementById('community-signed-out');
  const signedIn = document.getElementById('community-signed-in');
  if (!signedOut || !signedIn) return;

  if (state.isAuthenticated) {
    signedOut.classList.add('hidden');
    signedIn.classList.remove('hidden');
    const avatarEl = document.getElementById('community-account-avatar');
    if (avatarEl && state.avatar) {
      avatarEl.src = state.avatar;
      avatarEl.alt = state.displayName;
    }
    const nameEl = document.getElementById('community-account-name');
    if (nameEl) nameEl.textContent = state.displayName;
    const emailEl = document.getElementById('community-account-email');
    if (emailEl) emailEl.textContent = state.email;
  } else {
    signedOut.classList.remove('hidden');
    signedIn.classList.add('hidden');
  }
}

async function loadAccount() {
  const state = await getAuthState();
  renderAccountUI(state);
}

const GOOGLE_BTN_INNER = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> Sign in with Google`;

async function handleSignIn(btnId, errorId) {
  const btn = document.getElementById(btnId);
  const errorEl = document.getElementById(errorId);
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  errorEl.classList.add('hidden');
  try {
    const state = await signIn();
    renderAccountUI(state);
    renderCommunityAccountUI(state);
    upsertUserToSupabase(state);
    chrome.runtime.sendMessage({ type: 'SYNC_NOW', reason: 'signin' }).catch(() => {});
    bumpMetric('signin').catch(() => {});
  } catch (err) {
    errorEl.textContent = err.message === 'Auth cancelled' ? 'Sign-in cancelled.' : 'Sign-in failed. Try again.';
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = GOOGLE_BTN_INNER;
  }
}

document.getElementById('sign-in-btn').addEventListener('click', () => handleSignIn('sign-in-btn', 'sign-in-error'));
document.getElementById('community-sign-in-btn').addEventListener('click', () => handleSignIn('community-sign-in-btn', 'community-sign-in-error'));

document.getElementById('sign-out-btn').addEventListener('click', async () => {
  await signOut();
  renderAccountUI({ isAuthenticated: false });
  renderCommunityAccountUI({ isAuthenticated: false });
});

document.getElementById('community-sign-out-btn').addEventListener('click', async () => {
  await signOut();
  renderAccountUI({ isAuthenticated: false });
  renderCommunityAccountUI({ isAuthenticated: false });
});

// --- Community panel ---

const CANNY_BOARD_URL = 'https://zafu.canny.io';

async function loadCommunityPanel() {
  const locked = document.getElementById('community-locked');
  const unlocked = document.getElementById('community-unlocked');
  if (!locked || !unlocked) return;

  // Community protection is anonymous — show count to all users.
  // Sign-in remains available in Settings for future network features.
  locked.classList.add('hidden');
  unlocked.classList.remove('hidden');

  const [communityList, snapshots] = await Promise.all([getCommunityList(), getCommunityListSnapshots()]);
  const countEl = document.getElementById('community-list-count');
  if (countEl) {
    countEl.textContent = communityList.count > 0 ? communityList.count.toLocaleString() : '—';
  }

  const deltaEl = document.getElementById('community-list-delta');
  if (deltaEl) {
    const delta = compute7dDelta(snapshots, communityList.count);
    if (delta > 0) {
      deltaEl.textContent = `+${delta.toLocaleString()} added last 7 days`;
      deltaEl.classList.remove('hidden');
    } else {
      deltaEl.classList.add('hidden');
    }
  }

  const pendingEl = document.getElementById('community-pending-reports');
  if (pendingEl) {
    const pending = await getPendingReportCount().catch(() => 0);
    if (pending > 0) {
      pendingEl.textContent = `${pending} report${pending > 1 ? 's' : ''} queued — retrying on next sync.`;
      pendingEl.classList.remove('hidden');
    } else {
      pendingEl.classList.add('hidden');
    }
  }

  const personalEl = document.getElementById('community-personal-stat');
  if (personalEl) {
    const metrics = await getMetrics();
    const parts = [];
    if (metrics.paste > 0) parts.push(`${metrics.paste.toLocaleString()} paste${metrics.paste > 1 ? 's' : ''} checked`);
    if (metrics.flag > 0) parts.push(`${metrics.flag} flagged`);
    if (parts.length) {
      personalEl.textContent = `You've protected: ${parts.join(' · ')}.`;
      personalEl.classList.remove('hidden');
    } else {
      personalEl.classList.add('hidden');
    }
  }
}

function compute7dDelta(snapshots, currentCount) {
  if (!snapshots || snapshots.length === 0) return 0;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const baseline = [...snapshots].reverse().find((s) => s.ts <= weekAgo);
  if (!baseline) return 0;
  return Math.max(0, currentCount - baseline.count);
}


document.getElementById('community-share-btn').addEventListener('click', (e) => {
  e.preventDefault();
  showShareModal();
});

document.getElementById('community-feedback-btn').addEventListener('click', async (e) => {
  e.preventDefault();
  const state = await getAuthState();
  let url = CANNY_BOARD_URL;
  if (state.isAuthenticated) {
    url += '?email=' + encodeURIComponent(state.email) + '&name=' + encodeURIComponent(state.displayName);
  }
  chrome.tabs.create({ url });
});

document.getElementById('github-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://github.com/jimozo/zafu' });
});

// --- Modals ---

/**
 * Shows promote-to-trusted modal. Returns the label string (possibly empty)
 * or null if cancelled.
 */
function showPromoteModal(address) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'in-page-modal-backdrop';

    backdrop.innerHTML = `
      <div class="in-page-modal">
        <div class="in-page-modal-title">✓ Add to trusted contacts</div>
        <div class="in-page-modal-addr">${escHtml(segmentAddress(address))}</div>
        <div class="field">
          <label for="promote-label-input">Name this address <span class="required-star">*</span></label>
          <input id="promote-label-input" type="text" placeholder="e.g. Friend's wallet, Binance deposit…" autocomplete="off" />
        </div>
        <p class="in-page-modal-hint">Required — helps you recognise this contact in future pastes.</p>
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

function showWalletEditModal(wallet) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'in-page-modal-backdrop';
    backdrop.innerHTML = `
      <div class="in-page-modal">
        <div class="in-page-modal-title">Edit protected wallet</div>
        <div class="in-page-modal-addr">${escHtml(shortAddress(wallet.address))}</div>
        <div class="field">
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

/**
 * Share modal — prefilled tweet + copy-link with install-id ref for attribution.
 */
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

/**
 * Shows API-key prompt modal. Returns 'setup' | 'free' | 'cancel'.
 */
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

    const close = (choice) => { backdrop.remove(); resolve(choice); };
    backdrop.querySelector('[data-choice="setup"]').addEventListener('click', () => close('setup'));
    backdrop.querySelector('[data-choice="free"]').addEventListener('click', () => close('free'));
    backdrop.querySelector('[data-choice="cancel"]').addEventListener('click', () => close('cancel'));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close('cancel');
    });
  });
}

/**
 * Simple yes/no confirm modal. Returns boolean.
 */
function showInPageConfirm(title, bodyHtml, confirmLabel, confirmClass = 'btn-primary') {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'in-page-modal-backdrop';
    backdrop.innerHTML = `
      <div class="in-page-modal">
        <div class="in-page-modal-title in-page-modal-title--neutral">${escHtml(title)}</div>
        <p class="in-page-modal-hint in-page-modal-hint--normal">${bodyHtml}</p>
        <div class="in-page-modal-buttons">
          <button class="btn-ghost small" id="ipc-cancel">Cancel</button>
          <button class="${confirmClass} small" id="ipc-confirm">${escHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    backdrop.querySelector('#ipc-confirm').addEventListener('click', () => {
      backdrop.remove(); resolve(true);
    });
    backdrop.querySelector('#ipc-cancel').addEventListener('click', () => {
      backdrop.remove(); resolve(false);
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) { backdrop.remove(); resolve(false); }
    });
  });
}

// --- Helpers ---

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

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Pin banner ---

document.getElementById('pin-banner-dismiss').addEventListener('click', async () => {
  document.getElementById('pin-banner').classList.add('hidden');
  // Snooze 3 days; we re-check pin state on next open
  await updateSettings({ pinBannerSnoozedUntil: Date.now() + 3 * 24 * 60 * 60 * 1000 });
});

async function loadPinBanner() {
  // Chrome 91+: detect actual pin state
  try {
    if (chrome.action && chrome.action.getUserSettings) {
      const s = await chrome.action.getUserSettings();
      if (s && s.isOnToolbar) {
        document.getElementById('pin-banner').classList.add('hidden');
        return;
      }
    }
  } catch { /* fall through */ }

  const settings = await getSettings();
  const snoozedUntil = settings.pinBannerSnoozedUntil || 0;
  if (Date.now() < snoozedUntil) {
    document.getElementById('pin-banner').classList.add('hidden');
    return;
  }
  document.getElementById('pin-banner').classList.remove('hidden');
}

async function refreshPricesBg() {
  try {
    chrome.runtime.sendMessage({ type: 'REFRESH_PRICES' }, () => {});
  } catch { /* ignore */ }
}

// --- Setup checklist ---

async function loadSetupChecklist() {
  const { wallets, setupChecklistDone, triedZafuTest } = await chrome.storage.local.get([
    'wallets', 'setupChecklistDone', 'triedZafuTest',
  ]);

  if (setupChecklistDone) return;

  const walletList = wallets || [];
  const hasWallet = walletList.length > 0;
  const hasFetched = walletList.some((w) => w.lastFetchedAt);
  const hasTried = !!triedZafuTest;

  if (hasWallet && hasFetched && hasTried) {
    await chrome.storage.local.set({ setupChecklistDone: true });
    return;
  }

  const el = document.getElementById('setup-checklist');
  el.classList.remove('hidden');

  if (hasWallet) document.getElementById('step-wallet').classList.add('setup-step--done');

  const stepFetch = document.getElementById('step-fetch');
  if (hasFetched) {
    stepFetch.classList.add('setup-step--done');
    stepFetch.classList.remove('setup-step--locked');
  } else if (hasWallet) {
    stepFetch.classList.remove('setup-step--locked');
  }

  if (hasTried) document.getElementById('step-try').classList.add('setup-step--done');

  document.getElementById('step-wallet-btn').addEventListener('click', () => {
    document.querySelector('[data-tab="wallets"]')?.click();
  });

  document.getElementById('step-try-link').addEventListener('click', async (e) => {
    e.preventDefault();
    await chrome.storage.local.set({ triedZafuTest: true });
    chrome.tabs.create({ url: 'https://stayzafu.com/test.html' });
  });
}

// --- Protection status ---

async function loadProtectionStatus() {
  const { wallets } = await chrome.storage.local.get('wallets');
  const walletList = wallets || [];
  const hasFetched = walletList.some((w) => w.lastFetchedAt);

  const el = document.getElementById('protection-status');
  if (!el) return;

  if (hasFetched) {
    el.textContent = '✓ Full protection — all detection layers active';
    el.className = 'protection-status protection-status--full';
  } else {
    el.textContent = '⚠ Base protection — sync a wallet to enable address-history checks';
    el.className = 'protection-status protection-status--base';
  }
  el.classList.remove('hidden');
}

// --- Test page links (guide panel + first-use-tip) ---

document.getElementById('try-zafu-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://stayzafu.com/test' });
});

// --- Sign-in nudge: open Settings panel when nudge toast was tapped ---

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'OPEN_SETTINGS_PANEL_NOW') openPanel('settings');
  if (msg.type === 'COMMUNITY_LIST_UPDATED') {
    const tab = document.getElementById('tab-community');
    if (tab?.classList.contains('active')) loadCommunityPanel();
  }
});

// --- Init ---

(async () => {
  const manifest = chrome.runtime.getManifest();
  const versionEl = document.getElementById('ext-version');
  if (versionEl) versionEl.textContent = `v${manifest.version}`;

  await Promise.all([
    loadSettings(),
    loadGuardianToggle(),
    loadAccount(),
    loadPinBanner(),
    loadSetupChecklist(),
    loadProtectionStatus(),
    renderWallets(),
    renderAuditAlert(),
    refreshPricesBg(),
  ]);

  // If overlay nudge was tapped while popup was closed, open Settings on first load
  const { openSettingsPanelIntent } = await chrome.storage.session.get('openSettingsPanelIntent');
  if (openSettingsPanelIntent) {
    chrome.storage.session.remove('openSettingsPanelIntent').catch(() => {});
    openPanel('settings');
  }

  // Re-render once prices arrive (best-effort)
  setTimeout(renderWallets, 1500);
})();
