// overlay.js — Shadow DOM overlay for showing detection results
// Handles all state variants: KNOWN, UNKNOWN, POISONED, HIJACKED, SCAM,
// MALICIOUS, COMMUNITY_REPORTED, COMMUNITY_DISPUTED, FLAGGED

import { segmentAddress } from '../lib/address-validator.js';
import { addFlagged, addDisputedAddress, getSignInNudgeShown, setSignInNudgeShown } from '../lib/storage.js';

const STYLE_URL = chrome.runtime.getURL('overlay/overlay.css');
const STYLE = `@import url('${STYLE_URL}');`;

/**
 * Injects a Shadow DOM overlay and returns a promise that resolves to
 * { confirmed: boolean, address: string }
 */
export async function showOverlay(detectionResult, targetElement) {
  return new Promise((resolve) => {
    const { state, pastedAddress } = detectionResult;

    // Create host element
    const host = document.createElement('div');
    host.id = `zafu-overlay-${Math.random().toString(36).slice(2)}`;
    document.body.appendChild(host);

    // Attach shadow DOM
    const shadow = host.attachShadow({ mode: 'open' });

    // Add styles
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    // Build overlay based on state
    let element;
    let dismissAction;

    if (state === 'KNOWN' || state === 'KNOWN_PUBLIC') {
      element = buildBanner(detectionResult);
      dismissAction = () => {
        // Auto-confirm after 2s, or close on user action
        const dismissBanner = () => {
          element.classList.add('zafu-banner--exit');
          setTimeout(() => {
            host.remove();
            resolve({ confirmed: true, address: pastedAddress });
          }, 200);
        };
        const timer = setTimeout(dismissBanner, 2000);
        const closeBtn = element.querySelector('.zafu-banner-close');
        if (closeBtn) {
          closeBtn.addEventListener('click', () => {
            clearTimeout(timer);
            dismissBanner();
          });
        }
      };
    } else if (
      state === 'SUSPICIOUS_KNOWN' ||
      state === 'UNKNOWN'
    ) {
      element = buildConfirmModal(detectionResult, state);
      dismissAction = () => {
        const confirmBtn = element.querySelector('[data-action="confirm"]');
        const cancelBtn = element.querySelector('[data-action="cancel"]');
        const flagBtn = element.querySelector('[data-action="flag"]');
        const checkboxEl = element.querySelector('input[type="checkbox"]');

        confirmBtn.addEventListener('click', () => {
          if (checkboxEl && !checkboxEl.checked) return;
          host.remove();
          resolve({ confirmed: true, address: pastedAddress });
        });

        cancelBtn.addEventListener('click', () => {
          host.remove();
          resolve({ confirmed: false, address: pastedAddress });
        });

        if (flagBtn) {
          flagBtn.addEventListener('click', async () => {
            await addFlagged(pastedAddress, detectionResult.chainType || 'evm');
            chrome.runtime.sendMessage({
              type: 'SUBMIT_COMMUNITY_REPORT',
              address: pastedAddress,
              chain: detectionResult.chainType || 'evm',
              source: 'user_flag',
            }).catch(() => {});
            host.remove();
            resolve({ confirmed: false, address: pastedAddress });
            showFlagToast();
            maybeShowSignInNudge();
          });
        }

        // element IS the backdrop
        element.addEventListener('click', (e) => {
          if (e.target === element) {
            host.remove();
            resolve({ confirmed: false, address: pastedAddress });
          }
        });
      };
    } else if (state === 'POISONED') {
      element = buildPoisonedModal(detectionResult);
      dismissAction = () => {
        const markBtn = element.querySelector('[data-action="mark"]');
        const cancelBtn = element.querySelector('[data-action="cancel"]');

        markBtn.addEventListener('click', async () => {
          // Always-gated secondary confirmation — must never be a single click
          const certain = await showPoisonedOverrideConfirm(pastedAddress, detectionResult.realAddress);
          if (certain) {
            host.remove();
            resolve({ confirmed: true, address: pastedAddress });
          }
          // If not certain, keep POISONED modal visible
        });

        cancelBtn.addEventListener('click', () => {
          host.remove();
          resolve({ confirmed: false, address: pastedAddress });
        });

        element.addEventListener('click', (e) => {
          if (e.target === element) {
            host.remove();
            resolve({ confirmed: false, address: pastedAddress });
          }
        });
      };
    } else if (state === 'HIJACKED') {
      element = buildHijackedModal(detectionResult);
      dismissAction = () => {
        const cancelBtn = element.querySelector('[data-action="cancel"]');
        cancelBtn.addEventListener('click', () => {
          host.remove();
          resolve({ confirmed: false, address: pastedAddress });
        });

        element.addEventListener('click', (e) => {
          if (e.target === element) {
            host.remove();
            resolve({ confirmed: false, address: pastedAddress });
          }
        });
      };
    } else if (state === 'SCAM') {
      element = buildScamModal(detectionResult);
      dismissAction = () => {
        const cancelBtn = element.querySelector('[data-action="cancel"]');
        cancelBtn.addEventListener('click', () => {
          host.remove();
          resolve({ confirmed: false, address: pastedAddress });
        });

        element.addEventListener('click', (e) => {
          if (e.target === element) {
            host.remove();
            resolve({ confirmed: false, address: pastedAddress });
          }
        });
      };
    } else if (state === 'MALICIOUS') {
      element = buildMaliciousModal(detectionResult);
      dismissAction = () => {
        const cancelBtn = element.querySelector('[data-action="cancel"]');
        const proceedBtn = element.querySelector('[data-action="proceed"]');
        const checkboxEl = element.querySelector('input[type="checkbox"]');

        cancelBtn.addEventListener('click', () => {
          host.remove();
          resolve({ confirmed: false, address: pastedAddress });
        });

        if (proceedBtn) {
          proceedBtn.addEventListener('click', () => {
            if (checkboxEl && !checkboxEl.checked) return;
            host.remove();
            resolve({ confirmed: true, address: pastedAddress });
          });
          if (checkboxEl) {
            checkboxEl.addEventListener('change', () => {
              proceedBtn.disabled = !checkboxEl.checked;
            });
          }
        }

        element.addEventListener('click', (e) => {
          if (e.target === element) {
            host.remove();
            resolve({ confirmed: false, address: pastedAddress });
          }
        });
      };
    } else if (state === 'COMMUNITY_REPORTED' || state === 'COMMUNITY_DISPUTED') {
      element = buildCommunityReportedModal(detectionResult);
      dismissAction = () => {
        const cancelBtn = element.querySelector('[data-action="cancel"]');
        const proceedBtn = element.querySelector('[data-action="proceed"]');
        const checkboxEl = element.querySelector('input[type="checkbox"]');

        cancelBtn.addEventListener('click', () => {
          host.remove();
          resolve({ confirmed: false, address: pastedAddress });
        });

        if (proceedBtn && checkboxEl) {
          proceedBtn.addEventListener('click', () => {
            if (!checkboxEl.checked) return;
            host.remove();
            resolve({ confirmed: true, address: pastedAddress });
          });
          checkboxEl.addEventListener('change', () => {
            proceedBtn.disabled = !checkboxEl.checked;
          });
        }

        element.addEventListener('click', (e) => {
          if (e.target === element) {
            host.remove();
            resolve({ confirmed: false, address: pastedAddress });
          }
        });
      };
    } else if (state === 'FLAGGED') {
      element = buildFlaggedModal(detectionResult);
      dismissAction = () => {
        const cancelBtn = element.querySelector('[data-action="cancel"]');
        const proceedBtn = element.querySelector('[data-action="proceed"]');

        cancelBtn.addEventListener('click', () => {
          host.remove();
          resolve({ confirmed: false, address: pastedAddress });
        });

        if (proceedBtn) {
          proceedBtn.addEventListener('click', () => {
            host.remove();
            resolve({ confirmed: true, address: pastedAddress });
          });
        }

        element.addEventListener('click', (e) => {
          if (e.target === element) {
            host.remove();
            resolve({ confirmed: false, address: pastedAddress });
          }
        });
      };
    }

    shadow.appendChild(element);
    dismissAction();

    // Escape key dismisses any overlay (same as clicking cancel/close)
    const onEscape = (e) => {
      if (e.key !== 'Escape') return;
      document.removeEventListener('keydown', onEscape);
      const cancelBtn = shadow.querySelector('[data-action="cancel"]') ||
                        shadow.querySelector('.zafu-banner-close');
      if (cancelBtn) {
        cancelBtn.click();
      } else {
        host.remove();
        resolve({ confirmed: false, address: pastedAddress });
      }
    };
    document.addEventListener('keydown', onEscape);
  });
}

// --- Segment diff helpers ---

/**
 * Normalize an address for diff/segmentation. EVM: strip 0x + lowercase (checksum-agnostic).
 * Solana (base58): no prefix to strip, preserve case (base58 is case-sensitive).
 */
function diffBody(address) {
  const s = String(address).trim();
  if (s.startsWith('0x') || s.startsWith('0X')) return s.slice(2).toLowerCase();
  return s;
}

/**
 * Returns an array of booleans indicating which 4-char chunks of addrA differ from addrB.
 */
function getSegmentDiffs(addrA, addrB) {
  const a = diffBody(addrA);
  const b = diffBody(addrB);
  const diffs = [];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 4) {
    diffs.push(a.slice(i, i + 4) !== b.slice(i, i + 4));
  }
  return diffs;
}

/**
 * Builds a <span class="zafu-segments"> element with individual segment spans.
 * Works for any address length (EVM 40, Solana 32–44).
 * Segments where diffs[i] is true get the "differ" class (red highlight).
 */
function buildSegmentedAddr(address, diffs) {
  const body = diffBody(address);
  const container = document.createElement('span');
  container.className = 'zafu-segments';
  for (let i = 0; i < body.length; i += 4) {
    const span = document.createElement('span');
    const segIndex = i / 4;
    span.className = 'zafu-segment' + (diffs[segIndex] ? ' differ' : '');
    span.textContent = body.slice(i, i + 4);
    container.appendChild(span);
  }
  return container;
}

// --- Banner (KNOWN / KNOWN_PUBLIC) ---

function buildBanner(result) {
  const { state, label, etherscanLabel, ensName, realLabel, pastedAddress } = result;

  // Fallback: truncated address instead of generic "Address"
  const addrShort = pastedAddress
    ? pastedAddress.slice(0, 8) + '…' + pastedAddress.slice(-6)
    : '';
  const displayLabel = label || etherscanLabel || ensName || realLabel || addrShort || 'Unknown';

  const color = state === 'KNOWN' ? 'var(--success)' : 'var(--accent)';
  const metaText = state === 'KNOWN' ? 'In your trusted list' : 'Known public contract';

  // No dark backdrop for KNOWN — it's a safe notification, not a warning
  const banner = document.createElement('div');
  banner.className = `zafu-banner zafu-state-${state.toLowerCase()}`;

  banner.innerHTML = `
    <div class="zafu-state-badge zafu-state-badge--${state.toLowerCase()}" style="border-color: ${color}; color: ${color};">${state === 'KNOWN_PUBLIC' ? 'KNOWN' : state}</div>
    <div class="zafu-banner-content">
      <div class="zafu-banner-label">${escapeHtml(displayLabel)}</div>
      <div class="zafu-banner-meta">${metaText}${addrShort ? ' · ' + escapeHtml(addrShort) : ''}</div>
    </div>
    <button class="zafu-banner-close" title="Dismiss">✕</button>
  `;

  return banner;
}

// --- Confirm modal (UNKNOWN / SUSPICIOUS_KNOWN) ---

const SUSPICIOUS_REASON_TEXT = {
  'inbound-or-zero-value': 'You received funds from this address — never sent to it.',
  'zero-value-token': 'Received a zero-value / dust token from this address. Common scam setup.',
  'token-transfer': 'This address appeared in a token transfer you did not initiate.',
  'inbound': 'This address sent you funds. You never initiated a send to it.',
};

function buildConfirmModal(result, state) {
  const { pastedAddress, reason } = result;
  const isSuspicious = state === 'SUSPICIOUS_KNOWN';
  const title = state === 'UNKNOWN' ? 'Unfamiliar address' : 'Suspicious address in history';
  const badge = state === 'UNKNOWN' ? 'UNKNOWN' : 'SUSPICIOUS';
  const reasonText = isSuspicious
    ? (SUSPICIOUS_REASON_TEXT[reason] || "In your history but you never actively sent to it.")
    : 'This address is new to you. Verify it manually before confirming.';

  const backdrop = document.createElement('div');
  backdrop.className = 'zafu-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = `zafu-modal zafu-state-${state.toLowerCase()}`;

  modal.innerHTML = `
    <div class="zafu-modal-header">
      <div class="zafu-state-badge zafu-state-badge--${state.toLowerCase()}">${badge}</div>
      <div>
        <div class="zafu-modal-title">${title}</div>
      </div>
    </div>
    <div class="zafu-modal-body">
      <p class="zafu-modal-text">${escapeHtml(reasonText)}</p>
      <div class="zafu-address-display">${escapeHtml(segmentAddress(pastedAddress))}</div>
      <div class="zafu-info-box ${isSuspicious ? 'warn' : 'neutral'}">
        Confirm only after checking this address against a separate trusted source.
      </div>
      <div class="zafu-checkbox-group zafu-checkbox-required">
        <input type="checkbox" id="zafu-confirm-check"${isSuspicious ? ' checked' : ''} />
        <label for="zafu-confirm-check" class="zafu-checkbox-label">I've verified this address is correct</label>
      </div>
      <p class="zafu-confirm-hint${isSuspicious ? ' zafu-hidden' : ''}">↑ Check the box to enable the Confirm button</p>
    </div>
    <div class="zafu-buttons">
      <button class="zafu-btn zafu-btn-secondary" data-action="cancel">Cancel</button>
      <button class="zafu-btn zafu-btn-primary" data-action="confirm"${isSuspicious ? '' : ' disabled'}>Confirm</button>
    </div>
    <div class="zafu-flag-row">
      <button class="zafu-flag-btn" data-action="flag">Report as malicious</button>
    </div>
  `;

  // Enable confirm button only when checkbox is checked; hide hint once checked
  const checkbox = modal.querySelector('input[type="checkbox"]');
  const confirmBtn = modal.querySelector('[data-action="confirm"]');
  const hint = modal.querySelector('.zafu-confirm-hint');
  checkbox.addEventListener('change', () => {
    confirmBtn.disabled = !checkbox.checked;
    if (hint) hint.classList.toggle('zafu-hidden', checkbox.checked);
  });

  backdrop.appendChild(modal);
  return backdrop;
}

// --- Poisoned modal ---

function buildPoisonedModal(result) {
  const { pastedAddress, realAddress, realLabel } = result;
  const diffs = getSegmentDiffs(pastedAddress, realAddress);

  const backdrop = document.createElement('div');
  backdrop.className = 'zafu-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'zafu-modal zafu-state-poisoned';

  // Header
  const header = document.createElement('div');
  header.className = 'zafu-modal-header';
  header.innerHTML = `
    <div class="zafu-state-badge zafu-state-badge--poisoned">POISONED</div>
    <div><div class="zafu-modal-title">Possible address poisoning</div></div>
  `;
  modal.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'zafu-modal-body';

  const introText = document.createElement('p');
  introText.className = 'zafu-modal-text';
  introText.textContent = 'This address looks almost identical to a trusted address. This is a common scam technique.';
  body.appendChild(introText);

  // Diff container
  const diffContainer = document.createElement('div');
  diffContainer.className = 'zafu-diff-container';

  const pastedLabelEl = document.createElement('div');
  pastedLabelEl.className = 'zafu-diff-label zafu-diff-label--danger';
  pastedLabelEl.textContent = 'ADDRESS YOU PASTED';
  const pastedAddrEl = document.createElement('div');
  pastedAddrEl.className = 'zafu-diff-address';
  pastedAddrEl.appendChild(buildSegmentedAddr(pastedAddress, diffs));

  const realLabelEl = document.createElement('div');
  realLabelEl.className = 'zafu-diff-label zafu-diff-label--safe';
  realLabelEl.textContent = 'YOUR TRUSTED ADDRESS';
  const realAddrEl = document.createElement('div');
  realAddrEl.className = 'zafu-diff-address';
  realAddrEl.appendChild(buildSegmentedAddr(realAddress, diffs));

  diffContainer.appendChild(pastedLabelEl);
  diffContainer.appendChild(pastedAddrEl);
  diffContainer.appendChild(realLabelEl);
  diffContainer.appendChild(realAddrEl);
  body.appendChild(diffContainer);

  if (realLabel) {
    const metaText = document.createElement('p');
    metaText.className = 'zafu-modal-text muted';
    metaText.innerHTML = `Real address: <strong>${escapeHtml(realLabel)}</strong>`;
    body.appendChild(metaText);
  }

  // Explorer link — Etherscan for EVM, Solscan for Solana
  const isSolana = result.chainType === 'solana';
  const explorerUrl = isSolana
    ? `https://solscan.io/account/${pastedAddress}`
    : `https://etherscan.io/address/${pastedAddress}`;
  const explorerName = isSolana ? 'Solscan' : 'Etherscan';
  const explorerLink = document.createElement('a');
  explorerLink.className = 'zafu-etherscan-link';
  explorerLink.href = '#';
  explorerLink.textContent = `Verify on ${explorerName} ↗`;
  explorerLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.open(explorerUrl, '_blank');
  });
  body.appendChild(explorerLink);

  const infoBox = document.createElement('div');
  infoBox.className = 'zafu-info-box danger';
  infoBox.textContent = `Recommended action: don't send. Copy the trusted address again from a source you control, then verify on ${explorerName}.`;
  body.appendChild(infoBox);

  modal.appendChild(body);

  // Safe action prominent, risky override is subdued and smaller
  const buttons = document.createElement('div');
  buttons.className = 'zafu-buttons';
  buttons.innerHTML = `
    <button class="zafu-btn zafu-btn-safe" data-action="cancel">Don't Send</button>
    <button class="zafu-btn zafu-btn-secondary zafu-btn-sm" data-action="mark">I've verified it's safe ↗</button>
  `;
  modal.appendChild(buttons);

  backdrop.appendChild(modal);
  return backdrop;
}

// --- Hijacked modal ---

function buildHijackedModal(result) {
  const { pastedAddress, copiedAddress } = result;
  const diffs = getSegmentDiffs(copiedAddress, pastedAddress);

  const backdrop = document.createElement('div');
  backdrop.className = 'zafu-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'zafu-modal zafu-state-hijacked';

  // Header
  const header = document.createElement('div');
  header.className = 'zafu-modal-header';
  header.innerHTML = `
    <div class="zafu-state-badge zafu-state-badge--hijacked">HIJACKED</div>
    <div><div class="zafu-modal-title">Copied and pasted addresses don't match</div></div>
  `;
  modal.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'zafu-modal-body';

  const introText = document.createElement('p');
  introText.className = 'zafu-modal-text';
  introText.textContent = 'ZAFU expected the last copied crypto address, but the clipboard now contains a different one.';
  body.appendChild(introText);

  // Diff container
  const diffContainer = document.createElement('div');
  diffContainer.className = 'zafu-diff-container';

  const copiedLabelEl = document.createElement('div');
  copiedLabelEl.className = 'zafu-diff-label zafu-diff-label--safe';
  copiedLabelEl.textContent = 'WHAT YOU COPIED';
  const copiedAddrEl = document.createElement('div');
  copiedAddrEl.className = 'zafu-diff-address';
  copiedAddrEl.appendChild(buildSegmentedAddr(copiedAddress, diffs));

  const pastedLabelEl = document.createElement('div');
  pastedLabelEl.className = 'zafu-diff-label zafu-diff-label--danger';
  pastedLabelEl.textContent = 'WHAT WAS IN YOUR CLIPBOARD';
  const pastedAddrEl = document.createElement('div');
  pastedAddrEl.className = 'zafu-diff-address';
  // Pasted addr segments show "differ" styling too — highlight which chunks changed
  pastedAddrEl.appendChild(buildSegmentedAddr(pastedAddress, diffs));

  diffContainer.appendChild(copiedLabelEl);
  diffContainer.appendChild(copiedAddrEl);
  diffContainer.appendChild(pastedLabelEl);
  diffContainer.appendChild(pastedAddrEl);
  body.appendChild(diffContainer);

  const infoBox = document.createElement('div');
  infoBox.className = 'zafu-info-box danger';
  infoBox.innerHTML = '<strong>Recommended action:</strong> cancel this paste, copy the intended address again from the source, then paste again. If this repeats, scan your device and browser extensions.';
  body.appendChild(infoBox);

  modal.appendChild(body);

  const buttons = document.createElement('div');
  buttons.className = 'zafu-buttons';
  buttons.innerHTML = `
    <button class="zafu-btn zafu-btn-danger" data-action="cancel">Cancel paste</button>
  `;
  modal.appendChild(buttons);

  backdrop.appendChild(modal);
  return backdrop;
}

// --- Scam modal ---

function buildScamModal(result) {
  const { pastedAddress } = result;

  const backdrop = document.createElement('div');
  backdrop.className = 'zafu-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'zafu-modal zafu-state-scam';

  modal.innerHTML = `
    <div class="zafu-modal-header">
      <div class="zafu-state-badge zafu-state-badge--scam">SCAM</div>
      <div>
        <div class="zafu-modal-title">Known scam address</div>
      </div>
    </div>
    <div class="zafu-modal-body">
      <p class="zafu-modal-text">
        This address is flagged in our scam blocklist. Do not send any funds to this address.
      </p>
      <div class="zafu-address-display">${escapeHtml(segmentAddress(pastedAddress))}</div>
      <div class="zafu-info-box danger">
        Blocked by ZAFU. Sending funds here may result in permanent loss.
      </div>
    </div>
    <div class="zafu-buttons">
      <button class="zafu-btn zafu-btn-primary" data-action="cancel">Close</button>
    </div>
  `;

  backdrop.appendChild(modal);
  return backdrop;
}

// --- Guardian Mode: pre-flight confirmation ---

/**
 * Shows a pre-flight "Review before pasting" modal.
 * If ensName is provided, shows "ensName → 0x..." to disclose ENS resolution.
 * Returns Promise<boolean> — true = proceed with paste, false = cancel.
 */
export async function showPreFlightConfirm(address, ensName) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.id = `zafu-preflight-${Math.random().toString(36).slice(2)}`;
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    const backdrop = document.createElement('div');
    backdrop.className = 'zafu-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'zafu-modal zafu-state-guardian';

    const header = document.createElement('div');
    header.className = 'zafu-modal-header';
    header.innerHTML = `
      <div class="zafu-state-badge zafu-state-badge--guardian">REVIEW</div>
      <div><div class="zafu-modal-title">${ensName ? 'ENS address resolved' : 'Review before pasting'}</div></div>
    `;
    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'zafu-modal-body';

    if (ensName) {
      const ensRow = document.createElement('p');
      ensRow.className = 'zafu-modal-text';
      ensRow.innerHTML = `<span class="zafu-ens-name">${escapeHtml(ensName)}</span><span class="zafu-ens-arrow"> → </span>`;
      body.appendChild(ensRow);
    } else {
      const text = document.createElement('p');
      text.className = 'zafu-modal-text';
      text.textContent = 'You\'re about to paste this address. Confirm it looks right.';
      body.appendChild(text);
    }

    const addrEl = document.createElement('div');
    addrEl.className = 'zafu-address-display zafu-address-guardian';
    addrEl.textContent = segmentAddress(address);
    body.appendChild(addrEl);

    modal.appendChild(body);

    const buttons = document.createElement('div');
    buttons.className = 'zafu-buttons';
    buttons.innerHTML = `
      <button class="zafu-btn zafu-btn-secondary" data-action="cancel">Cancel</button>
      <button class="zafu-btn zafu-btn-guardian" data-action="proceed">Paste it</button>
    `;
    modal.appendChild(buttons);

    backdrop.appendChild(modal);
    shadow.appendChild(backdrop);

    backdrop.querySelector('[data-action="proceed"]').addEventListener('click', () => {
      host.remove();
      resolve(true);
    });
    const cancelEl = backdrop.querySelector('[data-action="cancel"]');
    cancelEl.addEventListener('click', () => {
      host.remove();
      resolve(false);
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) { host.remove(); resolve(false); }
    });

    const onEscape = (e) => {
      if (e.key !== 'Escape') return;
      document.removeEventListener('keydown', onEscape);
      cancelEl.click();
    };
    document.addEventListener('keydown', onEscape);
  });
}

// --- Poisoned override secondary confirmation (always-on, not gated by Guardian Mode) ---

async function showPoisonedOverrideConfirm(pastedAddress, realAddress) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.id = `zafu-override-${Math.random().toString(36).slice(2)}`;
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    const backdrop = document.createElement('div');
    backdrop.className = 'zafu-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'zafu-modal zafu-state-poisoned';

    modal.innerHTML = `
      <div class="zafu-modal-header">
        <div class="zafu-state-badge zafu-state-badge--poisoned">VERIFY</div>
        <div><div class="zafu-modal-title">Are you certain?</div></div>
      </div>
      <div class="zafu-modal-body">
        <p class="zafu-modal-text">
          You're whitelisting a near-identical address.
          Future pastes of this address will be treated as trusted.
        </p>
        <div class="zafu-address-display">${escapeHtml(segmentAddress(pastedAddress))}</div>
        <div class="zafu-info-box danger">
          Only proceed if you have independently verified this address on Etherscan.
        </div>
      </div>
      <div class="zafu-buttons">
        <button class="zafu-btn zafu-btn-secondary" data-action="cancel">Cancel</button>
        <button class="zafu-btn zafu-btn-danger" data-action="confirm">Yes, I'm certain</button>
      </div>
    `;

    backdrop.appendChild(modal);
    shadow.appendChild(backdrop);

    modal.querySelector('[data-action="confirm"]').addEventListener('click', () => {
      host.remove(); resolve(true);
    });
    const overrideCancelBtn = modal.querySelector('[data-action="cancel"]');
    overrideCancelBtn.addEventListener('click', () => {
      host.remove(); resolve(false);
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) { host.remove(); resolve(false); }
    });

    const onEscape = (e) => {
      if (e.key !== 'Escape') return;
      document.removeEventListener('keydown', onEscape);
      overrideCancelBtn.click();
    };
    document.addEventListener('keydown', onEscape);
  });
}

// --- Malicious modal (MALICIOUS — confirmed) ---

function buildMaliciousModal(result) {
  const { pastedAddress, source, chainType } = result;

  const isCommunity = source === 'community';
  const isCommunityDisputed = source === 'community_disputed';
  const sourceLabel = source === 'confirmed'
    ? 'Team-verified malicious address'
    : isCommunity
      ? 'Flagged by multiple Zafu users — not yet team-reviewed'
      : isCommunityDisputed
        ? 'Your dispute is under review — team will verify within 2–3 days'
        : 'Community-reported and independently verified';

  const backdrop = document.createElement('div');
  backdrop.className = 'zafu-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'zafu-modal zafu-state-malicious';

  modal.innerHTML = `
    <div class="zafu-modal-header">
      <div class="zafu-state-badge zafu-state-badge--malicious">MALICIOUS</div>
      <div>
        <div class="zafu-modal-title">Confirmed Malicious Address</div>
        <div class="zafu-modal-subtitle">${sourceLabel}</div>
      </div>
    </div>
    <div class="zafu-modal-body">
      <p class="zafu-modal-text">
        This address has been independently verified as malicious. Do not send funds or interact with it.
      </p>
      <div class="zafu-address-display">${escapeHtml(segmentAddress(pastedAddress))}</div>
      <div class="zafu-info-box malicious">
        Blocked by ZAFU. Sending funds here can result in permanent, unrecoverable loss.
      </div>
      <div class="zafu-checkbox-group zafu-checkbox-required">
        <input type="checkbox" id="zafu-malicious-check" />
        <label for="zafu-malicious-check" class="zafu-checkbox-label">I understand this is confirmed malicious and override at my own risk</label>
      </div>
    </div>
    <div class="zafu-buttons">
      <button class="zafu-btn zafu-btn-malicious-cancel" data-action="cancel">Cancel — Keep me safe</button>
      <button class="zafu-btn zafu-btn-secondary zafu-btn-sm" data-action="proceed" disabled>Proceed anyway</button>
    </div>
  `;

  const modalBody = modal.querySelector('.zafu-modal-body');

  // Community-flagged: add dispute link so legitimate addresses can be challenged
  if ((isCommunity || isCommunityDisputed) && modalBody) {
    const disputeWrap = document.createElement('div');
    disputeWrap.style.cssText = 'margin-top:8px;text-align:center;';
    if (isCommunityDisputed) {
      disputeWrap.innerHTML = '<div style="font-size:11px;color:#888;margin-top:4px;">✓ Dispute submitted — under review (2–3 days)</div>';
    } else {
      disputeWrap.innerHTML = '<button style="background:none;border:none;color:#888;font-size:11px;cursor:pointer;text-decoration:underline;padding:0;" data-action="dispute">I own this address — dispute this flag</button>';
    }
    modalBody.appendChild(disputeWrap);

    const disputeBtn = disputeWrap.querySelector('[data-action="dispute"]');
    if (!disputeBtn) return backdrop;
    disputeBtn.addEventListener('click', () => {
      disputeWrap.innerHTML = `
        <div style="background:#1e1e1e;border:1px solid #333;border-radius:6px;padding:10px;text-align:left;margin-top:4px;">
          <div style="font-size:11px;color:#aaa;margin-bottom:6px;">Why is this address safe?</div>
          <textarea id="zafu-dispute-reason" placeholder="e.g. This is my own wallet, Binance hot wallet, etc." style="width:100%;box-sizing:border-box;background:#111;border:1px solid #444;color:#eee;border-radius:4px;padding:6px;font-size:11px;resize:vertical;min-height:56px;"></textarea>
          <input id="zafu-dispute-url" type="url" placeholder="Evidence URL (optional)" style="width:100%;box-sizing:border-box;background:#111;border:1px solid #444;color:#eee;border-radius:4px;padding:6px;font-size:11px;margin-top:4px;" />
          <div style="display:flex;gap:6px;margin-top:6px;">
            <button data-action="dispute-submit" style="flex:1;background:#444;border:none;color:#fff;border-radius:4px;padding:5px;font-size:11px;cursor:pointer;">Submit dispute</button>
            <button data-action="dispute-cancel" style="background:none;border:none;color:#888;font-size:11px;cursor:pointer;">Cancel</button>
          </div>
        </div>
      `;

      disputeWrap.querySelector('[data-action="dispute-cancel"]').addEventListener('click', () => {
        disputeWrap.innerHTML = '<button style="background:none;border:none;color:#888;font-size:11px;cursor:pointer;text-decoration:underline;padding:0;" data-action="dispute">I own this address — dispute this flag</button>';
      });

      disputeWrap.querySelector('[data-action="dispute-submit"]').addEventListener('click', () => {
        const reason = disputeWrap.querySelector('#zafu-dispute-reason').value.trim();
        if (!reason) return;
        const evidenceUrl = disputeWrap.querySelector('#zafu-dispute-url').value.trim() || null;
        chrome.runtime.sendMessage({
          type: 'SUBMIT_DISPUTE',
          address: pastedAddress,
          chain: chainType || 'evm',
          reason,
          evidenceUrl,
        }).catch(() => {});
        addDisputedAddress(pastedAddress).catch(() => {});
        disputeWrap.innerHTML = '<div style="font-size:11px;color:#888;margin-top:4px;">✓ Dispute submitted — under review (2–3 days)</div>';
      });
    });
  }

  backdrop.appendChild(modal);
  return backdrop;
}

// --- Community reported modal (cross-user signal, not team-confirmed) ---

function buildCommunityReportedModal(result) {
  const { pastedAddress, chainType, state } = result;
  const isDisputed = state === 'COMMUNITY_DISPUTED';

  const backdrop = document.createElement('div');
  backdrop.className = 'zafu-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'zafu-modal zafu-state-flagged';

  modal.innerHTML = `
    <div class="zafu-modal-header">
      <div class="zafu-state-badge zafu-state-badge--flagged">${isDisputed ? 'DISPUTED' : 'FLAGGED'}</div>
      <div>
        <div class="zafu-modal-title">Community-reported address</div>
        <div class="zafu-modal-subtitle">${isDisputed ? 'Your dispute is under review' : 'Reported by multiple Zafu users or automated poisoning signals'}</div>
      </div>
    </div>
    <div class="zafu-modal-body">
      <p class="zafu-modal-text">
        This address crossed ZAFU's community signal threshold. It is community-reported, not team-confirmed, and should be treated as high risk until independently verified.
      </p>
      <div class="zafu-address-display">${escapeHtml(segmentAddress(pastedAddress))}</div>
      <div class="zafu-info-box warn">
        Cancel unless you can verify this address from a separate trusted source.
      </div>
      <div class="zafu-checkbox-group zafu-checkbox-required">
        <input type="checkbox" id="zafu-community-check" />
        <label for="zafu-community-check" class="zafu-checkbox-label">I understand this is community-reported and have verified it independently</label>
      </div>
    </div>
    <div class="zafu-buttons">
      <button class="zafu-btn zafu-btn-primary" data-action="cancel">Cancel</button>
      <button class="zafu-btn zafu-btn-secondary zafu-btn-sm" data-action="proceed" disabled>Proceed anyway</button>
    </div>
  `;

  const modalBody = modal.querySelector('.zafu-modal-body');
  if (modalBody) {
    const disputeWrap = document.createElement('div');
    disputeWrap.style.cssText = 'margin-top:8px;text-align:center;';
    if (isDisputed) {
      disputeWrap.innerHTML = '<div style="font-size:11px;color:#888;margin-top:4px;">✓ Dispute submitted — under review (2–3 days)</div>';
    } else {
      disputeWrap.innerHTML = '<button style="background:none;border:none;color:#888;font-size:11px;cursor:pointer;text-decoration:underline;padding:0;" data-action="dispute">I own this address — dispute this flag</button>';
    }
    modalBody.appendChild(disputeWrap);

    const disputeBtn = disputeWrap.querySelector('[data-action="dispute"]');
    if (disputeBtn) {
      disputeBtn.addEventListener('click', () => {
        disputeWrap.innerHTML = `
          <div style="background:#1e1e1e;border:1px solid #333;border-radius:6px;padding:10px;text-align:left;margin-top:4px;">
            <div style="font-size:11px;color:#aaa;margin-bottom:6px;">Why is this address safe?</div>
            <textarea id="zafu-dispute-reason" placeholder="e.g. This is my own wallet, Binance hot wallet, etc." style="width:100%;box-sizing:border-box;background:#111;border:1px solid #444;color:#eee;border-radius:4px;padding:6px;font-size:11px;resize:vertical;min-height:56px;"></textarea>
            <input id="zafu-dispute-url" type="url" placeholder="Evidence URL (optional)" style="width:100%;box-sizing:border-box;background:#111;border:1px solid #444;color:#eee;border-radius:4px;padding:6px;font-size:11px;margin-top:4px;" />
            <div style="display:flex;gap:6px;margin-top:6px;">
              <button data-action="dispute-submit" style="flex:1;background:#444;border:none;color:#fff;border-radius:4px;padding:5px;font-size:11px;cursor:pointer;">Submit dispute</button>
              <button data-action="dispute-cancel" style="background:none;border:none;color:#888;font-size:11px;cursor:pointer;">Cancel</button>
            </div>
          </div>
        `;

        disputeWrap.querySelector('[data-action="dispute-cancel"]').addEventListener('click', () => {
          disputeWrap.innerHTML = '<button style="background:none;border:none;color:#888;font-size:11px;cursor:pointer;text-decoration:underline;padding:0;" data-action="dispute">I own this address — dispute this flag</button>';
        });

        disputeWrap.querySelector('[data-action="dispute-submit"]').addEventListener('click', () => {
          const reason = disputeWrap.querySelector('#zafu-dispute-reason').value.trim();
          if (!reason) return;
          const evidenceUrl = disputeWrap.querySelector('#zafu-dispute-url').value.trim() || null;
          chrome.runtime.sendMessage({
            type: 'SUBMIT_DISPUTE',
            address: pastedAddress,
            chain: chainType || 'evm',
            reason,
            evidenceUrl,
          }).catch(() => {});
          addDisputedAddress(pastedAddress).catch(() => {});
          disputeWrap.innerHTML = '<div style="font-size:11px;color:#888;margin-top:4px;">✓ Dispute submitted — under review (2–3 days)</div>';
        });
      });
    }
  }

  backdrop.appendChild(modal);
  return backdrop;
}

// --- Flagged modal (FLAGGED — user-reported, unconfirmed) ---

function buildFlaggedModal(result) {
  const { pastedAddress } = result;

  const backdrop = document.createElement('div');
  backdrop.className = 'zafu-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'zafu-modal zafu-state-flagged';

  modal.innerHTML = `
    <div class="zafu-modal-header">
      <div class="zafu-state-badge zafu-state-badge--flagged">FLAGGED</div>
      <div>
        <div class="zafu-modal-title">Community-flagged address</div>
        <div class="zafu-modal-subtitle">Community-reported, not team-confirmed</div>
      </div>
    </div>
    <div class="zafu-modal-body">
      <p class="zafu-modal-text">
        This address has been flagged as malicious by a Zafu user. This report has not been independently verified.
        Verify carefully before proceeding.
      </p>
      <div class="zafu-address-display">${escapeHtml(segmentAddress(pastedAddress))}</div>
      <div class="zafu-info-box warn">
        Proceed only if you have independently verified this address is safe.
      </div>
    </div>
    <div class="zafu-buttons">
      <button class="zafu-btn zafu-btn-primary" data-action="cancel">Cancel</button>
      <button class="zafu-btn zafu-btn-secondary zafu-btn-sm" data-action="proceed">Proceed anyway</button>
    </div>
  `;

  backdrop.appendChild(modal);
  return backdrop;
}

// --- Flag toast (shown after flagging an address) ---

function showFlagToast() {
  const toast = document.createElement('div');
  toast.textContent = '🚩 Flagged — contributing to community protection';
  toast.style.cssText = [
    'position:fixed', 'bottom:24px', 'right:24px', 'z-index:2147483647',
    'background:#1a1a1a', 'color:#fff', 'font:13px/1 -apple-system,sans-serif',
    'padding:10px 16px', 'border-radius:6px', 'box-shadow:0 4px 16px rgba(0,0,0,.4)',
    'pointer-events:none', 'opacity:1', 'transition:opacity .3s',
  ].join(';');
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; }, 2000);
  setTimeout(() => { toast.remove(); }, 2400);
}

// Show a one-time nudge to sign in after first user_flag, if not already signed in
async function maybeShowSignInNudge() {
  const [nudgeShown, stored] = await Promise.all([
    getSignInNudgeShown(),
    chrome.storage.local.get('authState'),
  ]);
  if (nudgeShown || stored.authState?.isAuthenticated) return;

  await setSignInNudgeShown();

  const nudge = document.createElement('div');
  nudge.textContent = '✨ Sign in to make your flags count more →';
  nudge.style.cssText = [
    'position:fixed', 'bottom:64px', 'right:24px', 'z-index:2147483647',
    'background:#1a1a1a', 'color:#5b9cf6', 'font:13px/1 -apple-system,sans-serif',
    'padding:10px 16px', 'border-radius:6px', 'box-shadow:0 4px 16px rgba(0,0,0,.4)',
    'cursor:pointer', 'opacity:1', 'transition:opacity .3s',
  ].join(';');
  document.body.appendChild(nudge);

  nudge.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS_PANEL' }).catch(() => {});
    nudge.remove();
  });

  setTimeout(() => { nudge.style.opacity = '0'; }, 5000);
  setTimeout(() => { nudge.remove(); }, 5400);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
