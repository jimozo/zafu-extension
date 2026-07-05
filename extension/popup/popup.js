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
  getAddressIntelIndex,
  addManualContact,
  updateTrustedEntry,
  markTransferSent,
  getCommunityList,
  getCommunityListSnapshots,
  getReferralId,
  getMetrics,
  bumpMetric,
  updateWallet,
  clearAllLocalData,
  normalizeKey,
} from '../lib/storage.js';
import { getPendingReportCount } from '../lib/community-client.js';
import {
  isEvmAddress,
  isSolanaAddress,
  isTronAddress,
  detectChainType,
  segmentAddress,
} from '../lib/address-validator.js';
import { CHAIN_NATIVE, CHAIN_DISPLAY, BUNDLED_KEY } from '../lib/etherscan-client.js';
import { BUNDLED_TRON_KEY } from '../lib/tronscan-client.js';
import { getAuthState, signIn, signOut, upsertUserToSupabase } from '../lib/auth.js';
import { createQrSvg } from '../lib/qr.js';
import {
  buildLocalAddressProfile,
  enrichAddressProfile,
  getCachedAddressProfile,
  persistAddressIntel,
  runBulkAddressIntel,
  setCachedAddressProfile,
} from '../lib/address-profile.js';
import {
  getContactStablecoinAsset,
  getContactStablecoinNetwork,
  getContactDisplayAsset,
  stablecoinConfidence,
  stablecoinInstructionLine,
  stablecoinNetworkAddressType,
  stablecoinNetworkLabel,
  stablecoinShortNetworkLabel,
  contactSourceLabel,
  normalizeHelpMode,
} from '../lib/transfer-context.js';
import { auditTrustedIndex } from '../lib/self-audit.js';

const CHAIN_NAMES = CHAIN_DISPLAY;

// C: addresses flagged by the cross-index lookalike scan; drives the "Review" card state.
let lookalikeSuspects = new Set();

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
  if (chainType !== 'evm' && chainType !== 'solana' && chainType !== 'tron') {
    errorEl.textContent = 'Not a valid EVM (0x…), Solana, or TRON address.';
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
  } else if (chainType === 'tron') {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding…';
    statusEl.textContent = 'Detected TRON wallet. Transfer Check is active. Review history imports in Full View.';
    statusEl.classList.remove('hidden');
    activeChains = ['tron'];
    primaryChainId = 'tron';
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
  if (added && chainType !== 'tron') handleFetch(added.id);
});

// --- Add Contact toggle ---

function openAddContactForm() {
  const container = document.getElementById('add-contact-form-container');
  container.classList.remove('hidden');
  document.getElementById('toggle-add-contact-btn').textContent = '− Cancel';
  document.getElementById('contact-address').focus();
}

document.getElementById('toggle-add-contact-btn').addEventListener('click', () => {
  const container = document.getElementById('add-contact-form-container');
  const isHidden = container.classList.toggle('hidden');
  document.getElementById('toggle-add-contact-btn').textContent = isHidden ? '+ Contact' : '− Cancel';
});

document.getElementById('empty-add-contact-btn').addEventListener('click', openAddContactForm);
document.getElementById('empty-trusted-add-contact-btn').addEventListener('click', openAddContactForm);

document.getElementById('add-contact-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const addrInput = document.getElementById('contact-address');
  const labelInput = document.getElementById('contact-label');
  const errorEl = document.getElementById('add-contact-error');
  const address = addrInput.value.trim();

  errorEl.classList.add('hidden');

  if (!isEvmAddress(address) && !isSolanaAddress(address) && !isTronAddress(address)) {
    errorEl.textContent = 'Not a valid EVM (0x…), Solana, or TRON address.';
    errorEl.classList.remove('hidden');
    return;
  }

  const detectedChain = detectChainType(address);
  const rawChain = document.getElementById('contact-chain').value;
  const selectedChain = rawChain === 'solana' || rawChain === 'tron' ? rawChain : (parseInt(rawChain, 10) || 1);
  const chainId = detectedChain === 'solana' || detectedChain === 'tron' ? detectedChain : selectedChain;
  const assetType = document.getElementById('contact-asset-type').value === 'token' ? 'token' : 'stablecoin';
  const asset = assetType === 'token'
    ? document.getElementById('contact-token-symbol').value.trim()
    : document.getElementById('contact-asset').value;
  const notes = document.getElementById('contact-notes').value.trim();
  await addManualContact({ address, label: labelInput.value.trim(), chainId, asset, assetType, notes });
  requestStablecoinContactEnrichment(address);

  addrInput.value = '';
  labelInput.value = '';
  document.getElementById('contact-asset-type').value = 'stablecoin';
  document.getElementById('contact-asset').value = 'USDT';
  document.getElementById('contact-token-symbol').value = '';
  syncContactAssetTypeFields();
  document.getElementById('contact-notes').value = '';
  document.getElementById('contact-chain').value = '1';
  document.getElementById('add-contact-form-container').classList.add('hidden');
  document.getElementById('toggle-add-contact-btn').textContent = '+ Contact';

  await renderAddressBook();
});

// W7: toggle the add-contact asset input between the USDT/USDC select and a free token symbol.
function syncContactAssetTypeFields() {
  const isToken = document.getElementById('contact-asset-type').value === 'token';
  document.getElementById('contact-asset-field').classList.toggle('hidden', isToken);
  document.getElementById('contact-token-field').classList.toggle('hidden', !isToken);
  if (isToken) document.getElementById('contact-token-symbol').focus();
}
document.getElementById('contact-asset-type')?.addEventListener('change', syncContactAssetTypeFields);

document.getElementById('popup-receive-toggle')?.addEventListener('click', async () => {
  const panel = document.getElementById('popup-receive-panel');
  const hidden = panel.classList.toggle('hidden');
  if (!hidden) {
    populatePopupReceiveWallets(await getWallets());
    document.getElementById('popup-receive-wallet')?.focus();
  }
});

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

function populatePopupReceiveNetworks(address) {
  const netSel = document.getElementById('popup-receive-network');
  if (!netSel) return;
  const type = address ? detectChainType(address) : null;
  const opts = RECEIVE_NETWORKS[type] || [];
  netSel.replaceChildren(...opts.map((o, i) => {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (i === 0) opt.selected = true;
    return opt;
  }));
  netSel.disabled = opts.length === 0;
}

function populatePopupReceiveWallets(wallets) {
  const sel = document.getElementById('popup-receive-wallet');
  const buildBtn = document.getElementById('popup-receive-build');
  if (!sel) return;
  if (!wallets.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No saved wallets — add one in Wallets';
    sel.replaceChildren(opt);
    sel.disabled = true;
    if (buildBtn) buildBtn.disabled = true;
    populatePopupReceiveNetworks('');
    return;
  }
  const prev = sel.value;
  sel.disabled = false;
  if (buildBtn) buildBtn.disabled = false;
  sel.replaceChildren(...wallets.map((w) => {
    const opt = document.createElement('option');
    opt.value = w.address;
    opt.textContent = (w.label ? `${w.label} · ` : '') + shortReceiveAddr(w.address);
    return opt;
  }));
  if (prev && wallets.some((w) => w.address === prev)) sel.value = prev;
  populatePopupReceiveNetworks(sel.value);
}

document.getElementById('popup-receive-wallet')?.addEventListener('change', (e) => {
  populatePopupReceiveNetworks(e.target.value);
});

document.getElementById('popup-receive-build')?.addEventListener('click', buildPopupReceiveSafelyInstruction);
document.getElementById('popup-receive-copy')?.addEventListener('click', async () => {
  const output = document.getElementById('popup-receive-output');
  const btn = document.getElementById('popup-receive-copy');
  if (!output?.value) return;
  await navigator.clipboard.writeText(output.value).catch(() => {});
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'Copy instruction'; }, 1200);
});

function buildPopupReceiveSafelyInstruction() {
  const asset = document.getElementById('popup-receive-asset')?.value || 'USDT';
  const network = document.getElementById('popup-receive-network')?.value || 'tron';
  const address = document.getElementById('popup-receive-wallet')?.value.trim() || '';
  const error = document.getElementById('popup-receive-error');
  const outputWrap = document.getElementById('popup-receive-output-wrap');
  const output = document.getElementById('popup-receive-output');
  const networkLabel = stablecoinNetworkLabel(network) || network;

  error.classList.add('hidden');
  outputWrap.classList.add('hidden');

  if (!addressMatchesReceiveNetwork(address, network)) {
    error.textContent = `${networkLabel} needs a ${receiveAddressFamilyLabel(network)} address.`;
    error.classList.remove('hidden');
    return;
  }

  const lines = [
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
    lines.push('This is an EVM-format address; the address alone does not prove the intended network.');
  }

  output.value = lines.join('\n');
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

// --- Transfer Check toggle (stored as guardianMode for backwards compatibility) ---

const transferCheckToggle = document.getElementById('transfer-check-toggle');

transferCheckToggle.addEventListener('change', async () => {
  await updateSettings({ guardianMode: transferCheckToggle.checked });
});

async function loadTransferCheckToggle() {
  const settings = await getSettings();
  transferCheckToggle.checked = settings.guardianMode !== false;
}

// --- Settings ---

async function loadSettings() {
  const settings = await getSettings();
  const transferHelpMode = normalizeHelpMode(settings.transferHelpMode);
  document.querySelectorAll('input[name="transfer-help-mode"]').forEach((input) => {
    input.checked = input.value === transferHelpMode;
  });
  const networkToggle = document.getElementById('network-mode-toggle');
  const networkStatus = document.getElementById('network-mode-status');
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
  const solInput = document.getElementById('solscan-key-input');
  const solStatus = document.getElementById('solscan-key-status');
  if (settings.solscanApiKey && solInput && solStatus) {
    solInput.placeholder = '••••••••••••••••';
    solStatus.textContent = 'Solscan key saved.';
    solStatus.classList.remove('hidden');
  }
  const tronInput = document.getElementById('tron-key-input');
  const tronStatus = document.getElementById('tron-key-status');
  if (settings.tronApiKey && tronInput && tronStatus) {
    tronInput.placeholder = '••••••••••••••••';
    tronStatus.textContent = 'TronScan key saved.';
    tronStatus.classList.remove('hidden');
  }
}

document.getElementById('save-api-key-btn').addEventListener('click', async () => {
  const key = document.getElementById('api-key-input').value.trim();
  const status = document.getElementById('api-key-status');
  if (!key) return;
  if (key === BUNDLED_KEY) {
    status.textContent = "That's Zafu's shared demo key — create your own free Etherscan key (steps below).";
    status.classList.remove('hidden');
    return;
  }
  await updateSettings({ etherscanApiKey: key });
  document.getElementById('api-key-input').value = '';
  document.getElementById('api-key-input').placeholder = '••••••••••••••••';
  status.textContent = 'API key saved.';
  status.classList.remove('hidden');
  await maybePromptBulkIntel('etherscan', status);
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
    await maybePromptBulkIntel('solscan', status);
  });
}

const tronSaveBtn = document.getElementById('save-tron-key-btn');
if (tronSaveBtn) {
  tronSaveBtn.addEventListener('click', async () => {
    const key = document.getElementById('tron-key-input').value.trim();
    const status = document.getElementById('tron-key-status');
    if (!key) return;
    if (key === BUNDLED_TRON_KEY) {
      status.textContent = "That's Zafu's shared demo key — create your own free TronScan key (steps below).";
      status.classList.remove('hidden');
      return;
    }
    await updateSettings({ tronApiKey: key });
    document.getElementById('tron-key-input').value = '';
    document.getElementById('tron-key-input').placeholder = '••••••••••••••••';
    status.textContent = 'TronScan key saved.';
    status.classList.remove('hidden');
    await maybePromptBulkIntel('tronscan', status);
  });
}

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

async function maybePromptBulkIntel(source, statusEl) {
  const settings = await getSettings();
  const { flag, sourceName } = intelSourceMeta(source, settings);
  if (settings[flag]) return;
  await updateSettings({ [flag]: true });
  const confirmed = await showInPageConfirm(
    `Run ${sourceName} Intel now?`,
    `ZAFU can review eligible saved recipients and wallet-history entries with your local ${sourceName} key. Your key stays on this device.`,
    'Run Intel',
    'btn-confirm'
  );
  if (!confirmed) return;
  const latestSettings = await getSettings();
  statusEl.textContent = 'Running Intel assessment…';
  statusEl.classList.remove('hidden');
  const result = await runBulkAddressIntel(latestSettings, source, (progress) => {
    if (progress.phase === 'running') {
      statusEl.textContent = `Running Intel ${progress.completed}/${progress.total}…`;
    }
  });
  statusEl.textContent = result.total
    ? `Intel done — ${result.completed} reviewed${result.risky ? `, ${result.risky} risk flagged` : ''}${result.skipped ? ` · ${result.skipped} already current` : ''}.`
    : (result.skipped
      ? `All ${result.skipped} addresses already have Intel — nothing to update.`
      : 'No eligible addresses to review yet.');
  await Promise.all([renderAddressBook(), renderWallets()]);
}

async function runManualBulkIntel(source) {
  const settings = await getSettings();
  const { hasKey, sourceName, statusId } = intelSourceMeta(source, settings);
  const statusEl = document.getElementById(statusId);
  if (!statusEl) return;
  if (!hasKey) {
    statusEl.textContent = `Add a ${sourceName} key before running Intel.`;
    statusEl.classList.remove('hidden');
    return;
  }
  const confirmed = await showInPageConfirm(
    `Run ${sourceName} Intel?`,
    `Review eligible saved recipients and wallet-history entries with your local ${sourceName} key.`,
    'Run Intel',
    'btn-confirm'
  );
  if (!confirmed) return;
  statusEl.textContent = 'Running Intel assessment…';
  statusEl.classList.remove('hidden');
  const result = await runBulkAddressIntel(settings, source, (progress) => {
    if (progress.phase === 'running') {
      statusEl.textContent = `Running Intel ${progress.completed}/${progress.total}…`;
    }
  });
  statusEl.textContent = result.total
    ? `Intel done — ${result.completed} reviewed${result.risky ? `, ${result.risky} risk flagged` : ''}${result.skipped ? ` · ${result.skipped} already current` : ''}.`
    : (result.skipped
      ? `All ${result.skipped} addresses already have Intel — nothing to update.`
      : 'No eligible addresses to review yet.');
  await Promise.all([renderAddressBook(), renderWallets()]);
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
const tronLink = document.getElementById('tron-link');
if (tronLink) {
  tronLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://tronscan.org/#/myaccount/apiKeys/' });
  });
}

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
    const feeLabel = chains.length === 1 && chains[0] === 'solana'
      ? 'Fees (SOL)'
      : chains.length === 1 && chains[0] === 'tron'
        ? 'Fees (TRX)'
        : 'Gas (ETH)';
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
          <div class="wstat"><span class="wstat-val">${gasSpentTotal > 0 ? gasSpentTotal.toFixed(3) : '—'}</span><span class="wstat-lbl">${feeLabel}</span></div>
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
        <button class="btn-edit-wallet" data-id="${wallet.id}" title="Rename wallet import">Edit</button>
        <button class="btn-filter-book" data-id="${wallet.id}" title="Show contacts from this wallet">Contacts</button>
        <button class="btn-wallet-profile" data-id="${wallet.id}" title="View address Intel">Intel</button>
        <button class="btn-wallet-qr" data-id="${wallet.id}" title="Show address QR">QR</button>
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

  list.querySelectorAll('.btn-wallet-qr').forEach((btn) => {
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

  list.querySelectorAll('.btn-wallet-profile').forEach((btn) => {
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
    `Removing <strong>${escHtml(wallet.label || shortAddress(wallet.address))}</strong> removes its imported history from recipient memory.`,
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
  const walletChains = wallet.chains || [wallet.chainId || 1];
  if (walletChains.length === 1 && walletChains[0] === 'tron') {
    if (progressEl) {
      progressEl.textContent = 'TRON history import opens in Full View so you can review recipients before saving them.';
      progressEl.classList.remove('hidden');
      setTimeout(() => progressEl.classList.add('hidden'), 5000);
    }
    return;
  }

  // API-key intercept: if this wallet needs Etherscan (has any EVM chain)
  // and no key is set, prompt the user once before proceeding.
  const needsEtherscan = walletChains.some((c) => c !== 'solana' && c !== 'tron');
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
    { type: 'FETCH_HISTORY', walletId, address: wallet.address, chainIds: walletChains, preview: true },
    async (response) => {
      chrome.runtime.onMessage.removeListener(progressHandler);

      if (btn) { btn.disabled = false; btn.textContent = 'Fetch'; }
      if (progressEl) progressEl.classList.add('hidden');

      if (response && response.ok) {
        await renderWallets();
        await renderAuditAlert();
        const { trustedCount, suspicionCount, auditFlags } = response;
        if (progressEl) {
          progressEl.textContent = `Done — ${trustedCount} recipients found for review, ${suspicionCount} suspicious flagged${auditFlags ? `, ⚠ ${auditFlags} flagged pairs` : ''}`;
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

document.getElementById('open-full-view-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('book/book.html') });
});

// --- Overlay panels ---

function openPanel(name) {
  document.querySelectorAll('.overlay-panel').forEach((p) => p.classList.remove('active'));
  document.getElementById(`panel-${name}`).classList.add('active');
  if (name === 'safety') loadSafety();
  if (name === 'settings') loadSettings();
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
let addressIntelRefreshTimer = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.addressIntel) return;
  clearTimeout(addressIntelRefreshTimer);
  addressIntelRefreshTimer = setTimeout(() => {
    renderAddressBook().catch(() => {});
    renderWallets().catch(() => {});
  }, 120);
});

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

async function renderAddressBook() {
  const query = document.getElementById('search-input').value.toLowerCase().trim();
  const [trusted, suspicion, wallets, intelIndex] = await Promise.all([
    getTrusted(),
    getSuspicion(),
    getWallets(),
    getAddressIntelIndex(),
  ]);
  const walletsMap = Object.fromEntries(wallets.map((w) => [w.id, w.label || shortAddress(w.address)]));
  const intelByAddress = groupIntelByAddress(intelIndex);
  lookalikeSuspects = new Set(auditTrustedIndex(trusted).map((f) => String(f.suspectAddress).toLowerCase()));

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

  const trustedEntries = Object.values(trusted).map((entry) => ({
    ...entry,
    _intel: bestIntelForAddress(entry.address, intelByAddress),
  })).filter(
    (e) =>
      matchesWallet(e) &&
      (!query ||
        e.address.includes(query) ||
        (e.label || '').toLowerCase().includes(query) ||
        (e.etherscanLabel || '').toLowerCase().includes(query) ||
        (e.ensName || '').toLowerCase().includes(query))
  );
  const suspicionEntries = Object.values(suspicion).map((entry) => ({
    ...entry,
    _intel: bestIntelForAddress(entry.address, intelByAddress),
  })).filter(
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
  noTrusted.classList.toggle('hidden', !hasAny || trustedEntries.length > 0);

  const sortedTrusted = trustedEntries.sort((a, b) => {
    if (b.favourite !== a.favourite) return (b.favourite ? 1 : 0) - (a.favourite ? 1 : 0);
    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });
  const hasFavorites = sortedTrusted.some((e) => e.favourite);
  let shownFavoritesHeader = false;
  let shownAllHeader = false;
  for (const e of sortedTrusted) {
    if (hasFavorites && e.favourite && !shownFavoritesHeader) {
      const header = document.createElement('li');
      header.className = 'addr-section-header';
      header.textContent = '★ Favorites';
      trustedList.appendChild(header);
      shownFavoritesHeader = true;
    }
    if (hasFavorites && !e.favourite && !shownAllHeader) {
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
  li.className = type === 'trusted' ? 'addr-item addr-item--transfer-card' : 'addr-item';

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

  if (type === 'trusted') {
    li.appendChild(renderTransferCardSummary(entry));
  }

  // The Details button opens the detail/zoom view (full address, copy, rename, intel).
  const openDetail = () => showAddressProfileModal({
    address: entry.address,
    label: displayName || shortAddress(entry.address),
    eyebrow: type === 'trusted' ? 'Trusted contact' : 'Suspicious address',
    trustedEntry: type === 'trusted' ? entry : null,
    suspicionEntry: type === 'suspicion' ? entry : null,
    walletsMap,
  });

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

  if (type === 'trusted') {
    const intelEl = document.createElement('div');
    intelEl.className = `addr-item-meta addr-item-intel addr-item-intel--${intelTone(entry)}`;
    intelEl.textContent = addressIntelSubline(entry);
    li.appendChild(intelEl);
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
    starBtn.title = entry.favourite ? 'Remove from Favorites' : 'Add to Favorites';
    starBtn.addEventListener('click', async () => {
      await updateTrustedEntry(entry.address, { favourite: !entry.favourite });
      await renderAddressBook();
    });
    actions.appendChild(starBtn);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-ghost small btn-copy';
    copyBtn.textContent = '⧉ Copy address';
    copyBtn.title = stablecoinInstructionLine(entry);
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(entry.address);
      chrome.runtime.sendMessage({
        type: 'COPY_ADDRESS',
        address: entry.address,
        chainType: detectChainType(entry.address),
        source: buildZafuContactCopySource(entry),
      }).catch(() => {});
      showPreflightCopyHelper(entry);
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => { copyBtn.textContent = '⧉ Copy address'; }, 1500);
    });
    actions.appendChild(copyBtn);

    const qrBtn = document.createElement('button');
    qrBtn.className = 'btn-ghost small btn-qr';
    qrBtn.textContent = 'QR';
    qrBtn.title = 'Show address QR';
    qrBtn.addEventListener('click', () => {
      showAddressQrModal({
        address: entry.address,
        label: displayName || shortAddress(entry.address),
        eyebrow: 'Trusted contact',
      });
    });
    actions.appendChild(qrBtn);

    const detailsBtn = document.createElement('button');
    detailsBtn.className = 'btn-ghost small btn-details';
    detailsBtn.textContent = 'Details';
    detailsBtn.title = 'View address details';
    detailsBtn.addEventListener('click', openDetail);
    actions.appendChild(detailsBtn);

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

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-ghost small btn-copy';
    copyBtn.textContent = '⧉ Copy address';
    copyBtn.title = 'Copy address';
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(entry.address);
      chrome.runtime.sendMessage({
        type: 'COPY_ADDRESS',
        address: entry.address,
        chainType: detectChainType(entry.address),
      }).catch(() => {});
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => { copyBtn.textContent = '⧉ Copy address'; }, 1500);
    });
    rowActions.appendChild(copyBtn);

    const detailsBtn = document.createElement('button');
    detailsBtn.className = 'btn-ghost small btn-details';
    detailsBtn.textContent = 'Details';
    detailsBtn.title = 'View address details';
    detailsBtn.addEventListener('click', openDetail);
    rowActions.appendChild(detailsBtn);

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

function renderTransferCardSummary(entry) {
  const flaggedLookalike = lookalikeSuspects.has(String(entry.address).toLowerCase());
  const model = stablecoinConfidence(entry, { flaggedLookalike });
  const wrap = document.createElement('div');
  wrap.className = `transfer-card-summary transfer-card-summary--${model.state}`;

  const asset = getContactDisplayAsset(entry);
  const network = getContactStablecoinNetwork(entry);

  const badges = document.createElement('div');
  badges.className = 'transfer-card-badges';

  const assetBadge = document.createElement('span');
  assetBadge.className = asset ? 'transfer-card-asset' : 'transfer-card-asset transfer-card-asset--unset';
  assetBadge.textContent = asset || '—';
  if (!asset) assetBadge.title = 'Asset not set yet';
  badges.appendChild(assetBadge);

  const networkBadge = document.createElement('span');
  const networkShort = stablecoinShortNetworkLabel(network);
  networkBadge.className = networkShort ? 'transfer-card-network' : 'transfer-card-network transfer-card-network--unset';
  networkBadge.textContent = networkShort || '—';
  networkBadge.title = stablecoinNetworkLabel(network) || 'Network not checked yet';
  badges.appendChild(networkBadge);

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

  if (entry.memoNote) {
    const memo = document.createElement('div');
    memo.className = 'transfer-card-note';
    memo.textContent = `Memo/tag note: ${entry.memoNote}`;
    wrap.appendChild(memo);
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
    if (!window.confirm('Mark this transfer as sent? Do this only after your wallet or exchange confirms it. Zafu records your note; it does not verify settlement.')) return;
    await markTransferSent(entry.address);
    await renderAddressBook();
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

function addressIntelSubline(entry) {
  const intel = entry._intel;
  const parts = [chainName(entry.chainId || entry.primaryChainId || entry.chains?.[0])];
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
  } else if (entry.manuallyAdded) {
    parts.push('Manual contact');
  } else {
    parts.push('Not reviewed');
  }
  return parts.filter(Boolean).join(' · ');
}

function intelTone(entry) {
  if (entry._intel?.status === 'risky') return 'risk';
  if (entry._intel?.status === 'error') return 'error';
  if (entry._intel?.status === 'incomplete') return 'warning';
  if (entry._intel?.reviewedAt) return 'ok';
  return 'muted';
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

// --- Safety tab ---

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
  const fpEl = document.getElementById('ext-fingerprint');
  if (fpEl && fpEl.textContent === 'computing…') {
    const fp = await computeFingerprint();
    fpEl.textContent = fp;
    fpEl.classList.remove('muted');
  }
}

document.getElementById('verify-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: getVersionedReleaseUrl() });
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


async function loadCommunityPanel() {
  const locked = document.getElementById('community-locked');
  const unlocked = document.getElementById('community-unlocked');
  if (!locked || !unlocked) return;

  // Community warnings are anonymous — show count to all users.
  // Sign-in remains available in Settings for future network features.
  locked.classList.add('hidden');
  unlocked.classList.remove('hidden');

  const [communityList, snapshots, settings] = await Promise.all([
    getCommunityList(),
    getCommunityListSnapshots(),
    getSettings(),
  ]);
  const signalsToggle = document.getElementById('community-threat-signals-toggle');
  if (signalsToggle) signalsToggle.checked = settings.communityThreatSignals === true;

  const countEl = document.getElementById('community-list-count');
  const countLabelEl = document.getElementById('community-list-label');
  if (countEl) {
    const hasCount = communityList.count > 0;
    countEl.textContent = hasCount ? communityList.count.toLocaleString() : 'Not loaded yet';
    if (countLabelEl) {
      countLabelEl.textContent = hasCount
        ? 'addresses checked during Transfer Check'
        : 'community warning feed';
    }
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
      pendingEl.textContent = `${pending} report${pending > 1 ? 's' : ''} queued - retrying automatically when Zafu can reach the service.`;
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
      personalEl.textContent = `You've checked: ${parts.join(' · ')}.`;
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


document.getElementById('community-methodology-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://stayzafu.com/community-signals' });
});

document.getElementById('community-threat-signals-toggle')?.addEventListener('change', async (e) => {
  await updateSettings({ communityThreatSignals: e.target.checked });
});

document.getElementById('network-mode-toggle')?.addEventListener('change', async (e) => {
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

document.getElementById('github-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://github.com/jimozo/zafu-extension' });
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
        <div class="in-page-modal-title">Edit wallet import</div>
        <div class="in-page-modal-addr">${escHtml(shortAddress(wallet.address))}</div>
        <div class="field">
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

/**
 * Share modal — prefilled tweet + copy-link with public referral-id attribution.
 */
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
  const qrSvg = createQrSvg(address, { scale: 4 });
  const backdrop = document.createElement('div');
  backdrop.className = 'in-page-modal-backdrop';
  backdrop.innerHTML = `
    <div class="in-page-modal qr-modal">
      <div class="qr-modal-eyebrow">${escHtml(eyebrow)}</div>
      <div class="in-page-modal-title in-page-modal-title--neutral">${escHtml(label)}</div>
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
      <div class="in-page-modal-title in-page-modal-title--neutral">${escHtml(label)}</div>
      <div class="in-page-modal-addr">${escHtml(segmentAddress(address))}</div>
      <div class="profile-addr-actions">
        <button class="btn-ghost small btn-copy" id="profile-copy-btn" type="button">Copy address</button>
        ${suspicionEntry ? '<button class="btn-ghost small" id="profile-promote-btn" type="button">Mark trusted…</button>' : ''}
      </div>
      ${trustedEntry ? `
      <div class="profile-section">
        <div class="profile-section-title">Name &amp; note</div>
        <label class="profile-field"><span>Name</span>
          <input type="text" id="profile-name-input" class="profile-input" placeholder="Add a name…"></label>
        <label class="profile-field"><span>Note / tag</span>
          <input type="text" id="profile-note-input" class="profile-input" placeholder="e.g. exchange deposit, friend…"></label>
        <button class="btn-ghost small" id="profile-save-meta-btn" type="button">Save name &amp; note</button>
        <span id="profile-save-meta-status" class="profile-empty-row"></span>
      </div>` : ''}
      <div class="profile-section">
        <div class="profile-section-title">Local profile</div>
        <div class="profile-grid">
          <span>Trust</span><strong>${escHtml(trustName(profile.trust))}</strong>
          ${profile.suspicionReason ? `<span>Flagged</span><strong>${escHtml(humanReason(profile.suspicionReason))}</strong>` : ''}
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
  copyBtn.addEventListener('click', async () => {
    // Keep this detail modal local-only (no runtime messaging): the row Copy button arms the
    // clipboard-swap guard; here we just place the address and show local paste guidance.
    await navigator.clipboard.writeText(address);
    if (trustedEntry) showPreflightCopyHelper(trustedEntry);
    copyBtn.textContent = '✓ Copied';
    setTimeout(() => { copyBtn.textContent = 'Copy address'; }, 1500);
  });

  if (trustedEntry) {
    const nameInput = backdrop.querySelector('#profile-name-input');
    const noteInput = backdrop.querySelector('#profile-note-input');
    nameInput.value = trustedEntry.label || '';
    noteInput.value = trustedEntry.memoNote || '';
    backdrop.querySelector('#profile-save-meta-btn').addEventListener('click', async () => {
      const newName = nameInput.value.trim();
      const newNote = noteInput.value.trim();
      await setTrustedLabel(address, newName);
      await updateTrustedEntry(address, { memoNote: newNote });
      trustedEntry.label = newName;
      trustedEntry.memoNote = newNote;
      modalInput.label = newName || shortAddress(address);
      const titleEl = backdrop.querySelector('.in-page-modal-title');
      if (titleEl) titleEl.textContent = modalInput.label;
      await renderAddressBook();
      const status = backdrop.querySelector('#profile-save-meta-status');
      if (status) status.textContent = 'Saved ✓';
    });
  }

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
  openPanel('settings');
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
  return CHAIN_NAMES[chainId] || `Chain ${chainId}`;
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
  const hasFetched = walletList.some((w) => w.lastFetchedAt);
  const trusted = await getTrusted();
  const hasRecipient = Object.keys(trusted).length > 0;
  const hasTried = !!triedZafuTest;
  const authState = await getAuthState().catch(() => null);
  const hasSync = authState?.isAuthenticated === true;

  if (hasRecipient && hasTried) {
    await chrome.storage.local.set({ setupChecklistDone: true });
    return;
  }

  const el = document.getElementById('setup-checklist');
  el.classList.remove('hidden');

  if (hasRecipient) document.getElementById('step-wallet').classList.add('setup-step--done');

  const stepFetch = document.getElementById('step-fetch');
  if (hasFetched) {
    stepFetch.classList.add('setup-step--done');
  }
  stepFetch.classList.remove('setup-step--locked');

  if (hasTried) document.getElementById('step-try').classList.add('setup-step--done');
  if (hasSync) document.getElementById('step-sync')?.classList.add('setup-step--done');

  document.getElementById('step-wallet-btn').addEventListener('click', () => {
    document.querySelector('[data-tab="book"]')?.click();
    openAddContactForm();
  });

  document.getElementById('step-fetch-btn')?.addEventListener('click', () => {
    document.querySelector('[data-tab="wallets"]')?.click();
  });

  document.getElementById('step-sync-btn')?.addEventListener('click', () => {
    document.getElementById('open-settings-btn')?.click();
  });

  document.getElementById('step-try-link').addEventListener('click', async (e) => {
    e.preventDefault();
    await chrome.storage.local.set({ triedZafuTest: true });
    chrome.tabs.create({ url: 'https://stayzafu.com/test' });
  });
}

// --- Protection status ---

async function loadProtectionStatus() {
  const { wallets, settings = {} } = await chrome.storage.local.get(['wallets', 'settings']);
  const walletList = wallets || [];
  const hasFetched = walletList.some((w) => w.lastFetchedAt);
  const trusted = await getTrusted();
  const recipientCount = Object.keys(trusted).length;

  const el = document.getElementById('protection-status');
  if (!el) return;

  const network = settings.networkMode === true ? 'Network Mode on' : 'local-only';
  if (recipientCount || hasFetched) {
    el.textContent = `✓ Recipient Memory — Transfer Check active, ${recipientCount} recipient${recipientCount === 1 ? '' : 's'}, ${network}`;
    el.className = 'protection-status protection-status--full';
  } else {
    el.textContent = `Recipient Memory — Transfer Check active, save a recipient when you are ready, ${network}`;
    el.className = 'protection-status protection-status--base';
  }
  el.classList.remove('hidden');
}

// --- Test page links (guide panel + first-use-tip) ---

document.getElementById('try-zafu-link').addEventListener('click', async (e) => {
  e.preventDefault();
  await chrome.storage.local.set({ triedZafuTest: true });
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
    loadTransferCheckToggle(),
    loadAccount(),
    loadPinBanner(),
    loadSetupChecklist(),
    loadProtectionStatus(),
    renderWallets(),
    renderAddressBook(),
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
