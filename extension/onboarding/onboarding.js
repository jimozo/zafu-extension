import { addWallet, bumpMetric } from '../lib/storage.js';
import { detectChainType } from '../lib/address-validator.js';
import { signIn, upsertUserToSupabase } from '../lib/auth.js';

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

// --- Panel 3: Sign-in + Launch ---

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
    upsertUserToSupabase(state);
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

document.getElementById('skip-signin-btn').addEventListener('click', () => {
  window.close();
});

document.getElementById('launch-btn').addEventListener('click', async () => {
  try {
    await chrome.action.openPopup();
  } catch (_) {
    // openPopup unavailable (requires Chrome 99+ and user gesture) — no fallback needed
  }
  window.close();
});

document.getElementById('api-key-hint-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://etherscan.io/apidashboard' });
});

document.getElementById('skip-wallet-btn').addEventListener('click', () => {
  const successMsg = document.getElementById('success-msg');
  if (successMsg) successMsg.textContent = 'Zafu is active. Add a wallet later to unlock full address-history protection.';
  goToStep(2);
});

document.getElementById('try-zafu-onboarding-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://stayzafu.com/test' });
});

// --- Panel 1: chain-type detection pill ---

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
  } else {
    pill.className = 'chain-pill hidden';
    hint.textContent = 'EVM (Ethereum, Polygon, Arbitrum, Base, Optimism, BNB) and Solana supported.';
  }
});

// --- Panel 1: Add wallet + fetch ---

document.getElementById('add-wallet-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const addrInput = document.getElementById('wallet-address');
  const labelInput = document.getElementById('wallet-label');
  const errorEl = document.getElementById('wallet-error');
  const progressEl = document.getElementById('fetch-progress');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const doneBtn = document.getElementById('done-btn');

  const address = addrInput.value.trim();
  errorEl.classList.add('hidden');

  const chainType = detectChainType(address);
  if (!chainType || chainType === 'ens') {
    errorEl.textContent = 'Not a valid EVM (0x…) or Solana address.';
    errorEl.classList.remove('hidden');
    return;
  }

  submitBtn.disabled = true;

  let activeChains;
  let primaryChainId;

  if (chainType === 'solana') {
    activeChains = ['solana'];
    primaryChainId = 'solana';
    progressEl.textContent = 'Fetching Solana history via Solscan (~30s)…';
    progressEl.classList.remove('hidden');
    submitBtn.textContent = 'Fetching…';
  } else {
    submitBtn.textContent = 'Scanning networks…';
    progressEl.textContent = 'Detecting active networks across 6 EVM chains (~10s)…';
    progressEl.classList.remove('hidden');

    const probeResp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'PROBE_CHAINS', address }, resolve);
    });
    activeChains = [];
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

  const progressHandler = (msg) => {
    if (msg.type !== 'FETCH_PROGRESS' || msg.walletId !== wallet.id || !progressEl) return;
    if (msg.action === 'done') {
      progressEl.classList.add('hidden');
      return;
    }
    progressEl.textContent = formatFetchProgress(msg);
  };
  chrome.runtime.onMessage.addListener(progressHandler);

  chrome.runtime.sendMessage(
    { type: 'FETCH_HISTORY', walletId: wallet.id, address: wallet.address, chainIds: activeChains },
    (response) => {
      chrome.runtime.onMessage.removeListener(progressHandler);
      progressEl.classList.add('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add & Fetch History';

      if (response && response.ok) {
        const { trustedCount } = response;
        const successMsg = document.getElementById('success-msg');
        if (successMsg && trustedCount > 0) {
          successMsg.textContent = `${trustedCount} trusted addresses indexed from your history. Zafu is watching your clipboard.`;
        }
        doneBtn.classList.remove('hidden');
      } else {
        errorEl.textContent = `Fetch failed: ${(response && response.error) || 'unknown error'}. You can retry from the popup after setup.`;
        errorEl.classList.remove('hidden');
        doneBtn.classList.remove('hidden');
      }
    }
  );
});
