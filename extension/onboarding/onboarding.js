import { addWallet, bumpMetric, updateSettings } from '../lib/storage.js';
import { detectChainType } from '../lib/address-validator.js';
import { signIn, upsertUserToSupabase } from '../lib/auth.js';
import { stablecoinShortNetworkLabel } from '../lib/transfer-context.js';

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
    <div class="import-actions"><button type="button" class="btn-primary import-save">Save selected</button><button type="button" class="btn-skip import-skip">Skip for now</button></div>`;
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

// Setup shows a lightweight summary instead of a long per-row checklist: it reports what
// the scan found and offers a one-tap save of the stablecoin recipients (the product
// focus). Reviewing every counterparty individually stays opt-in via the full picker.
function renderImportSummary(container, candidates, meta, handlers) {
  const stablecoins = candidates.filter((c) => c.stablecoin);
  const netCount = Array.isArray(meta.chains) ? meta.chains.length : 0;
  const netText = netCount > 1 ? ` across ${netCount} networks` : '';
  const suspLine = meta.suspicionCount > 0
    ? `<li><strong>${meta.suspicionCount}</strong> flagged suspicious — not saved</li>`
    : '';
  const saveBtn = stablecoins.length
    ? `<button type="button" class="btn-primary import-save-stable">Save ${stablecoins.length} stablecoin recipient${stablecoins.length === 1 ? '' : 's'}</button>`
    : '';
  container.innerHTML = `
    <p class="import-title">You sent to ${candidates.length} address${candidates.length === 1 ? '' : 'es'}${netText}.</p>
    <ul class="import-summary-stats">
      <li><strong>${stablecoins.length}</strong> stablecoin recipient${stablecoins.length === 1 ? '' : 's'} (USDT/USDC)</li>
      ${suspLine}
    </ul>
    <div class="import-actions">
      ${saveBtn}
      <button type="button" class="btn-skip import-review-all">Review all ${candidates.length} individually</button>
    </div>`;
  container.classList.remove('hidden');
  const stableBtn = container.querySelector('.import-save-stable');
  if (stableBtn) stableBtn.addEventListener('click', () => handlers.onSaveStablecoins(stablecoins));
  container.querySelector('.import-review-all').addEventListener('click', handlers.onReviewAll);
}

function formatFetchProgress(msg) {
  const action = String(msg.action || '');
  const count = Number.isFinite(msg.count) ? msg.count : 0;
  if (action === 'starting') return 'Starting fetch…';
  if (action.startsWith('chain ')) return `Scanning chain ${action.slice(6)}…`;
  if (count > 0) {
    const eta = Math.max(1, Math.ceil(count / 250));
    return `Fetching ${count.toLocaleString()} transactions (~${eta}s)…`;
  }
  return `${action}…`;
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

// --- Step navigation ---

function goToStep(step) {
  const panels = document.querySelectorAll('.panel');
  const dots = document.querySelectorAll('.step');

  if (step >= panels.length) {
    window.close();
    return;
  }

  panels.forEach((p) => p.classList.remove('active'));
  document.getElementById(`panel-${step}`).classList.add('active');

  dots.forEach((d, i) => {
    d.classList.remove('active', 'done');
    if (i < step) d.classList.add('done');
    if (i === step) d.classList.add('active');
  });
}

document.querySelectorAll('[data-next]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const next = parseInt(btn.dataset.next, 10);
    goToStep(next);
  });
});

document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const previous = parseInt(btn.dataset.back, 10);
    goToStep(previous);
  });
});

// --- Network Mode: Sign-in + launch step navigation ---

const ONBOARDING_GOOGLE_BTN_INNER = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> Sign in with Google`;

document.getElementById('onboarding-sign-in-btn').addEventListener('click', async () => {
  const btn = document.getElementById('onboarding-sign-in-btn');
  const errorEl = document.getElementById('onboarding-signin-error');
  const successEl = document.getElementById('onboarding-signin-success');
  const nameEl = document.getElementById('onboarding-signed-name');
  const launchBtn = document.getElementById('launch-btn');
  const skipBtn = document.getElementById('skip-signin-btn');

  btn.disabled = true;
  btn.textContent = 'Signing in…';
  errorEl.classList.add('hidden');
  try {
    const state = await signIn();
    upsertUserToSupabase(state).catch(() => {});
    chrome.runtime.sendMessage({ type: 'SYNC_NOW', reason: 'signin' }).catch(() => {});
    bumpMetric('signin').catch(() => {});
    if (nameEl) nameEl.textContent = state.displayName || state.email;
    successEl.classList.remove('hidden');
    btn.classList.add('hidden');
    skipBtn.classList.add('hidden');
    launchBtn.classList.remove('hidden');
  } catch (err) {
    errorEl.textContent = err.message === 'Auth cancelled' ? 'Sign-in cancelled.' : 'Sign-in failed. Try again.';
    errorEl.classList.remove('hidden');
    btn.disabled = false;
    btn.innerHTML = ONBOARDING_GOOGLE_BTN_INNER;
  }
});

function openFullViewAndClose() {
  chrome.tabs.create({ url: chrome.runtime.getURL('book/book.html') });
  window.close();
}

document.getElementById('skip-signin-btn').addEventListener('click', () => {
  goToStep(5);
});

document.getElementById('launch-btn').addEventListener('click', async () => {
  goToStep(5);
});

document.getElementById('open-zafu-btn').addEventListener('click', async () => {
  openFullViewAndClose();
});

async function chooseNetworkMode(enabled) {
  await updateSettings({ networkMode: enabled });
  const status = document.getElementById('network-mode-status');
  const joinBtn = document.getElementById('network-mode-join-btn');
  const localBtn = document.getElementById('network-mode-local-btn');
  if (status) {
    status.textContent = enabled
      ? 'Network Mode on — only anonymous aggregate counts can be shared.'
      : 'Local-only mode on — anonymous counts stay on this device.';
    status.classList.remove('hidden');
  }
  if (joinBtn) joinBtn.disabled = enabled;
  if (localBtn) localBtn.disabled = !enabled;
}

document.getElementById('network-mode-join-btn')?.addEventListener('click', () => {
  chooseNetworkMode(true).catch(() => {});
});

document.getElementById('network-mode-local-btn')?.addEventListener('click', () => {
  chooseNetworkMode(false).catch(() => {});
});

document.getElementById('skip-wallet-btn').addEventListener('click', () => {
  const successMsg = document.getElementById('success-msg');
  if (successMsg) successMsg.textContent = 'Zafu is ready. Save your first recipient in the app, or import wallet history later.';
  goToStep(4);
});

document.getElementById('try-zafu-onboarding-link').addEventListener('click', async (e) => {
  e.preventDefault();
  await chrome.storage.local.set({ triedZafuTest: true });
  chrome.tabs.create({ url: 'https://stayzafu.com/test' });
});

// --- Panel 2: chain-type detection pill ---

document.getElementById('wallet-address').addEventListener('input', (e) => {
  const pill = document.getElementById('chain-pill');
  const hint = document.getElementById('wallet-hint');
  const chainType = detectChainType(e.target.value.trim());
  if (chainType === 'evm') {
    pill.textContent = 'ETH';
    pill.className = 'chain-pill chain-pill--evm';
    hint.textContent = 'Auto-detecting active chains (Ethereum, Polygon, Arbitrum, Base, Optimism, BNB)…';
  } else if (chainType === 'solana') {
    pill.textContent = 'SOL';
    pill.className = 'chain-pill chain-pill--sol';
    hint.textContent = 'Solana wallet — fetching history via Solscan.';
  } else if (chainType === 'tron') {
    pill.textContent = 'TRON';
    pill.className = 'chain-pill chain-pill--tron';
    hint.textContent = 'TRON wallet — history import uses Tronscan when you scan; Transfer Check stays local.';
  } else {
    pill.className = 'chain-pill hidden';
    hint.textContent = 'No wallet connection or seed phrase. Supports EVM (Ethereum, Polygon, Arbitrum, Base, Optimism, BNB), Solana, and TRON.';
  }
});

// --- Panel 3: Add wallet + fetch ---

async function runWalletImport() {
  const addrInput = document.getElementById('wallet-address');
  const labelInput = document.getElementById('wallet-label');
  const errorEl = document.getElementById('wallet-error');
  const progressEl = document.getElementById('fetch-progress');
  const submitBtn = document.getElementById('build-list-btn');
  const doneBtn = document.getElementById('done-btn');
  const inlineMsg = document.getElementById('fetch-success-msg');
  const picker = document.getElementById('import-candidates');

  const address = addrInput.value.trim();
  errorEl.classList.add('hidden');
  if (inlineMsg) inlineMsg.classList.add('hidden');
  if (picker) {
    picker.innerHTML = '';
    picker.classList.add('hidden');
  }
  doneBtn.classList.add('hidden');

  const chainType = detectChainType(address);
  if (!chainType || chainType === 'ens') {
    errorEl.textContent = 'Not a valid EVM (0x…), Solana, or TRON address.';
    errorEl.classList.remove('hidden');
    return;
  }

  const restoreSubmit = () => {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Import wallet history';
  };
  const showError = (text) => {
    errorEl.textContent = text;
    errorEl.classList.remove('hidden');
  };
  const finishWith = (text) => {
    if (inlineMsg) {
      inlineMsg.textContent = text;
      inlineMsg.classList.remove('hidden');
    }
    doneBtn.classList.remove('hidden');
  };

  submitBtn.disabled = true;
  let progressHandler = null;
  const removeProgressHandler = () => {
    if (!progressHandler) return;
    chrome.runtime.onMessage.removeListener(progressHandler);
    progressHandler = null;
  };

  try {
    let activeChains;
    let primaryChainId;

    if (chainType === 'solana') {
      activeChains = ['solana'];
      primaryChainId = 'solana';
      progressEl.textContent = 'Fetching Solana history via Solscan (~30s)…';
      progressEl.classList.remove('hidden');
      submitBtn.textContent = 'Fetching…';
    } else if (chainType === 'tron') {
      activeChains = ['tron'];
      primaryChainId = 'tron';
      progressEl.textContent = 'Scanning TRON USDT/USDC history via Tronscan…';
      progressEl.classList.remove('hidden');
      submitBtn.textContent = 'Scanning…';
    } else {
      submitBtn.textContent = 'Scanning networks…';
      progressEl.textContent = 'Detecting active networks across 6 EVM chains (~10s)…';
      progressEl.classList.remove('hidden');

      activeChains = [];
      primaryChainId = 1;
      try {
        const probeResp = await sendRuntimeMessage({ type: 'PROBE_CHAINS', address });
        const active = Array.isArray(probeResp.results) ? probeResp.results.filter((r) => r.hasActivity) : [];
        activeChains = active.map((r) => r.chainId);
        if (active.length) {
          active.sort((a, b) => (b.lastTxAt || 0) - (a.lastTxAt || 0));
          primaryChainId = active[0].chainId;
        }
      } catch (_) {
        progressEl.textContent = 'Could not detect active EVM networks. Trying Ethereum history…';
      }
      if (activeChains.length === 0) activeChains = [1];
      submitBtn.textContent = 'Fetching…';
      progressEl.textContent = `Active on ${activeChains.length} network${activeChains.length > 1 ? 's' : ''}. Fetching history (~30s)…`;
    }

    const wallet = await addWallet({
      address,
      label: labelInput.value.trim(),
      chains: activeChains,
      primaryChainId,
      chainId: primaryChainId,
    });

    progressHandler = (msg) => {
      if (msg.type !== 'FETCH_PROGRESS' || msg.walletId !== wallet.id || !progressEl) return;
      if (msg.action === 'done') {
        progressEl.classList.add('hidden');
        return;
      }
      progressEl.textContent = formatFetchProgress(msg);
    };
    chrome.runtime.onMessage.addListener(progressHandler);

    const response = await sendRuntimeMessage({
      type: 'FETCH_HISTORY',
      walletId: wallet.id,
      address: wallet.address,
      chainIds: activeChains,
      preview: true,
    });
    removeProgressHandler();
    progressEl.classList.add('hidden');
    // Scan finished. Hide the import button so a second click can't re-run the whole
    // fetch; the user now proceeds via the picker (save/skip) and the Continue button.
    submitBtn.classList.add('hidden');

    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    if (!candidates.length || !picker) {
      finishWith('Done — wallet history is ready. You can save recipients manually any time.');
      return;
    }

    const saveSelected = async (selected, btn, restoreLabel) => {
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Saving…';
      }
      errorEl.classList.add('hidden');
      try {
        const saveResp = await sendRuntimeMessage({ type: 'SAVE_IMPORTED_CONTACTS', contacts: selected });
        const n = Number.isFinite(Number(saveResp.saved)) ? Number(saveResp.saved) : selected.length;
        if (n <= 0) throw new Error('No valid recipient addresses were saved.');
        picker.innerHTML = '';
        picker.classList.add('hidden');
        finishWith(`Done — ${n} recipient${n === 1 ? '' : 's'} saved from your history.`);
      } catch (err) {
        showError(`Could not save selected recipients: ${err.message || 'unknown error'}. Try again, or skip wallet import for now.`);
        if (btn) {
          btn.disabled = false;
          btn.textContent = restoreLabel;
        }
      }
    };

    const skipImport = () => {
      picker.innerHTML = '';
      picker.classList.add('hidden');
      finishWith('Done — wallet history imported. Save recipients manually any time.');
    };

    const showFullPicker = () => renderImportPicker(picker, candidates, (selected) => {
      saveSelected(selected, picker.querySelector('.import-save'), `Save ${selected.length} contact${selected.length === 1 ? '' : 's'}`);
    }, skipImport);

    renderImportSummary(picker, candidates, {
      suspicionCount: response.suspicionCount || 0,
      chains: response.chains || [],
    }, {
      onSaveStablecoins: (stablecoins) => {
        saveSelected(stablecoins, picker.querySelector('.import-save-stable'), `Save ${stablecoins.length} stablecoin recipient${stablecoins.length === 1 ? '' : 's'}`);
      },
      onReviewAll: showFullPicker,
    });
  } catch (err) {
    removeProgressHandler();
    progressEl.classList.add('hidden');
    restoreSubmit();
    showError(`Wallet import failed: ${err.message || 'unknown error'}. Stay here and retry, or skip wallet import for now.`);
    doneBtn.classList.remove('hidden');
  }
}

document.getElementById('build-list-btn').addEventListener('click', () => {
  runWalletImport();
});

// Defensive: a single-input form still submits on Enter; never let that reload the page.
document.getElementById('add-wallet-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runWalletImport();
});
