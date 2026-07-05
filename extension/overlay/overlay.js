// overlay.js — Shadow DOM overlay for showing detection results
// Handles all state variants: KNOWN, UNKNOWN, CLIPBOARD_MISMATCH, POISONED, HIJACKED, SCAM,
// MALICIOUS, COMMUNITY_REPORTED, COMMUNITY_DISPUTED, FLAGGED

import { segmentAddress } from '../lib/address-validator.js';
import { addFlagged, addDisputedAddress, getSignInNudgeShown, setSignInNudgeShown } from '../lib/storage.js';
import { buildTransferEvidenceGroups, normalizeHelpMode, buildRecipientRitualLine } from '../lib/transfer-context.js';

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
            const report = await chrome.runtime.sendMessage({
              type: 'SUBMIT_COMMUNITY_REPORT',
              address: pastedAddress,
              chain: detectionResult.chainType || 'evm',
              source: 'user_flag',
            }).catch(() => null);
            host.remove();
            resolve({ confirmed: false, address: pastedAddress });
            showFlagToast(report?.submitted
              ? 'Report submitted for community review'
              : 'Flag saved locally — sign in to submit it');
            if (report?.reason === 'sign_in_required') maybeShowSignInNudge();
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
    } else if (state === 'CLIPBOARD_MISMATCH') {
      element = buildClipboardMismatchModal(detectionResult);
      dismissAction = () => {
        const cancelBtn = element.querySelector('[data-action="cancel"]');
        const proceedBtn = element.querySelector('[data-action="proceed"]');
        const checkboxEl = element.querySelector('input[type="checkbox"]');

        cancelBtn.addEventListener('click', () => {
          host.remove();
          resolve({ confirmed: false, address: pastedAddress });
        });

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
    : 'This address is new to you. Check it manually before confirming.';

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
        <label for="zafu-confirm-check" class="zafu-checkbox-label">I checked this address against a separate trusted source</label>
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

// --- Transfer Check (optional post-detection review for safe-ish states) ---

export async function showTransferCheck(result, targetElement, transferContext = {}, lastCopied = null, options = {}) {
  return new Promise((resolve) => {
    const { state, pastedAddress, label, etherscanLabel, ensName, realLabel } = result;
    const isUnknown = state === 'UNKNOWN';
    const helpMode = normalizeHelpMode(options.helpMode);
    const host = document.createElement('div');
    host.id = `zafu-transfer-check-${Math.random().toString(36).slice(2)}`;
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    const backdrop = document.createElement('div');
    backdrop.className = 'zafu-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = `zafu-modal zafu-state-transfer-check ${isUnknown ? 'zafu-state-transfer-check--unknown' : ''}`;

    const displayLabel = label || etherscanLabel || ensName || realLabel || '';
    // R: recipient-named paste ritual — name the person and the exact asset/network to confirm.
    const ritualLine = result.trustedEntry ? buildRecipientRitualLine(displayLabel, result.trustedEntry) : null;
    const copiedMatch = didCopiedAddressMatch(result, lastCopied);
    const evidenceGroups = buildTransferEvidenceGroups(result, transferContext, copiedMatch, helpMode);
    const saveSuggestion = buildSaveRecipientSuggestion(result, transferContext);
    const helpModeLabel = helpMode === 'guided'
      ? 'Guided detail'
      : helpMode === 'operator'
        ? 'Operator detail'
        : 'Standard detail';

    modal.innerHTML = `
      <div class="zafu-modal-header">
        <div class="zafu-state-badge zafu-state-badge--transfer">CHECK</div>
        <div>
          <div class="zafu-modal-title">Transfer Check</div>
          <div class="zafu-modal-subtitle">ZAFU checked available transfer evidence before paste. ${escapeHtml(helpModeLabel)}.</div>
        </div>
      </div>
      <div class="zafu-modal-body">
        ${ritualLine ? `<p class="zafu-modal-ritual">${escapeHtml(ritualLine)}</p>` : (displayLabel ? `<p class="zafu-modal-text">${escapeHtml(displayLabel)}</p>` : '')}
        <div class="zafu-evidence-groups">
          ${evidenceGroups.map((group) => `
            <section class="zafu-evidence-group">
              <div class="zafu-evidence-title">${escapeHtml(group.title)}</div>
              <ul class="zafu-checklist">
                ${group.rows.map((row) => `
                  <li class="zafu-checklist-row zafu-checklist-row--${row.kind}">
                    <span class="zafu-checklist-mark">${escapeHtml(row.mark)}</span>
                    <span>${escapeHtml(row.text)}</span>
                  </li>
                `).join('')}
              </ul>
            </section>
          `).join('')}
        </div>
        <div class="zafu-address-display">${escapeHtml(segmentAddress(pastedAddress))}</div>
        <p class="zafu-modal-text muted">Review the asset, network, memo/tag, amount, and final wallet or exchange confirmation before sending.</p>
        ${isUnknown ? `
          <div class="zafu-checkbox-group zafu-checkbox-required">
            <input type="checkbox" id="zafu-transfer-check-confirm" />
            <label for="zafu-transfer-check-confirm" class="zafu-checkbox-label">I checked this address against a trusted source</label>
          </div>
          ${saveSuggestion ? `
            <div class="zafu-checkbox-group zafu-save-recipient-option">
              <input type="checkbox" id="zafu-save-recipient-check" />
              <label for="zafu-save-recipient-check" class="zafu-checkbox-label">${escapeHtml(saveSuggestion.label)}</label>
            </div>
          ` : ''}
          <p class="zafu-confirm-hint">↑ Check the box to enable Paste address</p>
        ` : ''}
      </div>
      <div class="zafu-buttons">
        <button class="zafu-btn zafu-btn-secondary" data-action="cancel">Cancel</button>
        <button class="zafu-btn zafu-btn-transfer" data-action="proceed"${isUnknown ? ' disabled' : ''}>Paste address</button>
      </div>
      ${isUnknown ? `
        <div class="zafu-flag-row">
          <button class="zafu-flag-btn" data-action="flag">Report as malicious</button>
        </div>
      ` : ''}
    `;

    backdrop.appendChild(modal);
    shadow.appendChild(backdrop);

    const proceedBtn = modal.querySelector('[data-action="proceed"]');
    const cancelBtn = modal.querySelector('[data-action="cancel"]');
    const flagBtn = modal.querySelector('[data-action="flag"]');
    const checkbox = modal.querySelector('input[type="checkbox"]');
    const saveRecipientCheckbox = modal.querySelector('#zafu-save-recipient-check');
    const hint = modal.querySelector('.zafu-confirm-hint');

    proceedBtn.addEventListener('click', () => {
      if (checkbox && !checkbox.checked) return;
      cleanup();
      resolve({
        confirmed: true,
        address: pastedAddress,
        saveRecipient: saveRecipientCheckbox?.checked && saveSuggestion ? saveSuggestion.payload : null,
      });
    });

    cancelBtn.addEventListener('click', () => {
      cleanup();
      resolve({ confirmed: false, address: pastedAddress });
    });

    if (checkbox) {
      checkbox.addEventListener('change', () => {
        proceedBtn.disabled = !checkbox.checked;
        if (hint) hint.classList.toggle('zafu-hidden', checkbox.checked);
      });
    }

    if (flagBtn) {
      flagBtn.addEventListener('click', async () => {
        await addFlagged(pastedAddress, result.chainType || 'evm');
        const report = await chrome.runtime.sendMessage({
          type: 'SUBMIT_COMMUNITY_REPORT',
          address: pastedAddress,
          chain: result.chainType || 'evm',
          source: 'user_flag',
        }).catch(() => null);
        cleanup();
        resolve({ confirmed: false, address: pastedAddress });
        showFlagToast(report?.submitted
          ? 'Report submitted for community review'
          : 'Flag saved locally — sign in to submit it');
        if (report?.reason === 'sign_in_required') maybeShowSignInNudge();
      });
    }

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        cleanup();
        resolve({ confirmed: false, address: pastedAddress });
      }
    });

    const onEscape = (e) => {
      if (e.key !== 'Escape') return;
      cleanup();
      resolve({ confirmed: false, address: pastedAddress });
    };
    document.addEventListener('keydown', onEscape);

    function cleanup() {
      document.removeEventListener('keydown', onEscape);
      host.remove();
    }
  });
}

function didCopiedAddressMatch(result, lastCopied) {
  if (!result?.pastedAddress || !lastCopied) return false;
  if (result.chainType === 'solana' || result.chainType === 'tron') {
    return String(result.pastedAddress) === String(lastCopied);
  }
  return String(result.pastedAddress).toLowerCase() === String(lastCopied).toLowerCase();
}

function buildSaveRecipientSuggestion(result, transferContext) {
  if (result.state !== 'UNKNOWN') return null;
  const asset = transferContext.asset === 'USDT' || transferContext.asset === 'USDC' ? transferContext.asset : null;
  const inferredNetwork = asset ? stablecoinNetworkFromAddressType(result.chainType || transferContext.addressType) : null;
  const network = transferContext.selectedNetwork || inferredNetwork;
  if (!asset && !network) return null;
  const networkLabel = transferContext.networkLabel ||
    (transferContext.selectedNetwork ? network : addressTypeLabel(result.chainType || transferContext.addressType)) ||
    network;
  const label = `Save this recipient${asset || networkLabel ? ` (${[asset, networkLabel].filter(Boolean).join(' · ')})` : ''}`;
  return {
    label,
    payload: {
      address: result.pastedAddress,
      asset,
      network,
      sourceNote: transferContext.telegramWebDetected ? 'Telegram' : 'saved from Transfer Check',
    },
  };
}

function stablecoinNetworkFromAddressType(addressType) {
  if (addressType === 'tron') return 'tron';
  if (addressType === 'solana') return 'solana';
  return null;
}

function addressTypeLabel(addressType) {
  if (addressType === 'evm') return 'EVM';
  if (addressType === 'solana') return 'Solana';
  if (addressType === 'tron') return 'TRON';
  return '';
}

function formatAge(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 10) return `${minutes}m`;
  return '10m+';
}

function buildClipboardMismatchModal(result) {
  const { pastedAddress, copiedAddress, copyMismatch } = result;
  const age = copyMismatch?.ageSeconds != null ? ` ${formatAge(copyMismatch.ageSeconds)} ago` : '';
  const sourceText = copyMismatch?.sourceClass === 'telegram_web'
    ? `Last browser copy: Telegram Web${age}`
    : `Last browser copy${age}`;

  const backdrop = document.createElement('div');
  backdrop.className = 'zafu-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'zafu-modal zafu-state-clipboard_mismatch';

  modal.innerHTML = `
    <div class="zafu-modal-header">
      <div class="zafu-state-badge zafu-state-badge--clipboard_mismatch">REVIEW</div>
      <div>
        <div class="zafu-modal-title">Possible Clipboard Mismatch</div>
        <div class="zafu-modal-subtitle">${escapeHtml(sourceText)}</div>
      </div>
    </div>
    <div class="zafu-modal-body">
      <p class="zafu-modal-text">This address is different from the last crypto address Zafu saw you copy in the browser. If you copied this address from another app, review it carefully and continue. If you expected the previous address, cancel and copy again.</p>
      <div class="zafu-diff-container">
        <div class="zafu-diff-label zafu-diff-label--warning">LAST BROWSER COPY</div>
        <div class="zafu-diff-address">${escapeHtml(segmentAddress(copiedAddress))}</div>
        <div class="zafu-diff-label zafu-diff-label--warning">CURRENT PASTE</div>
        <div class="zafu-diff-address">${escapeHtml(segmentAddress(pastedAddress))}</div>
      </div>
      <div class="zafu-checkbox-group zafu-checkbox-required zafu-checkbox-warning">
        <input type="checkbox" id="zafu-clipboard-mismatch-confirm" />
        <label for="zafu-clipboard-mismatch-confirm" class="zafu-checkbox-label">I copied this from another source or checked it manually.</label>
      </div>
    </div>
    <div class="zafu-buttons">
      <button class="zafu-btn zafu-btn-secondary" data-action="cancel">Cancel</button>
      <button class="zafu-btn zafu-btn-warning" data-action="proceed" disabled>Review and paste</button>
    </div>
  `;

  backdrop.appendChild(modal);
  return backdrop;
}

export async function showPostPasteMismatch(expectedAddress) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.id = `zafu-post-paste-${Math.random().toString(36).slice(2)}`;
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    const backdrop = document.createElement('div');
    backdrop.className = 'zafu-modal-backdrop';
    backdrop.innerHTML = `
      <div class="zafu-modal zafu-state-hijacked">
        <div class="zafu-modal-header">
          <div class="zafu-state-badge zafu-state-badge--hijacked">WARNING</div>
          <div><div class="zafu-modal-title">Address changed after paste</div></div>
        </div>
        <div class="zafu-modal-body">
          <p class="zafu-modal-text">ZAFU inserted the reviewed address, but the field no longer appears to contain that exact value.</p>
          <div class="zafu-address-display">${escapeHtml(segmentAddress(expectedAddress))}</div>
          <div class="zafu-info-box danger">Recommended action: cancel this transfer, clear the field, copy the intended address again, and paste again.</div>
        </div>
        <div class="zafu-buttons">
          <button class="zafu-btn zafu-btn-danger" data-action="cancel">I understand</button>
        </div>
      </div>
    `;

    shadow.appendChild(backdrop);
    const closeBtn = backdrop.querySelector('[data-action="cancel"]');
    closeBtn.addEventListener('click', () => {
      host.remove();
      resolve();
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        host.remove();
        resolve();
      }
    });
  });
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

  // Explorer link — Etherscan for EVM, Solscan for Solana, TronScan for TRON.
  const isSolana = result.chainType === 'solana';
  const isTron = result.chainType === 'tron';
  const explorerUrl = isSolana
    ? `https://solscan.io/account/${pastedAddress}`
    : isTron
      ? `https://tronscan.org/#/address/${pastedAddress}`
      : `https://etherscan.io/address/${pastedAddress}`;
  const explorerName = isSolana ? 'Solscan' : isTron ? 'TronScan' : 'Etherscan';
  const explorerLink = document.createElement('a');
  explorerLink.className = 'zafu-etherscan-link';
  explorerLink.href = '#';
  explorerLink.textContent = `Check on ${explorerName} ↗`;
  explorerLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.open(explorerUrl, '_blank');
  });
  body.appendChild(explorerLink);

  const infoBox = document.createElement('div');
  infoBox.className = 'zafu-info-box danger';
  infoBox.textContent = `Recommended action: don't send. Copy the trusted address again from a source you control, then check on ${explorerName}.`;
  body.appendChild(infoBox);

  modal.appendChild(body);

  // Safe action prominent, risky override is subdued and smaller
  const buttons = document.createElement('div');
  buttons.className = 'zafu-buttons';
  buttons.innerHTML = `
    <button class="zafu-btn zafu-btn-safe" data-action="cancel">Don't Send</button>
    <button class="zafu-btn zafu-btn-secondary zafu-btn-sm" data-action="mark">I checked this independently ↗</button>
  `;
  modal.appendChild(buttons);

  backdrop.appendChild(modal);
  return backdrop;
}

// --- Hijacked modal ---

function buildHijackedModal(result) {
  const { pastedAddress, copiedAddress, sourceEvidence } = result;
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
  introText.textContent = sourceEvidence?.sourceClass === 'telegram_web'
    ? 'ZAFU expected the address copied from Telegram Web, but the clipboard now contains a different one.'
    : 'ZAFU expected the last copied crypto address, but the clipboard now contains a different one.';
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

// --- Poisoned override secondary confirmation (always-on, independent of Transfer Check) ---

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
          Only proceed if you checked this address independently on Etherscan.
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
    ? 'Team-confirmed malicious address'
    : isCommunity
      ? 'Flagged by multiple Zafu users — not yet team-reviewed'
      : isCommunityDisputed
        ? 'Your dispute is under review — team will review within 2–3 days'
        : 'Community-reported and independently checked';

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
        This address has been independently confirmed as malicious. Do not send funds or interact with it.
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
      <button class="zafu-btn zafu-btn-malicious-cancel" data-action="cancel">Cancel transfer</button>
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
          <div style="font-size:11px;color:#aaa;margin-bottom:6px;">Why should this flag be disputed?</div>
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
        This address crossed ZAFU's community signal threshold. It is community-reported, not team-confirmed, and should be treated as high risk until independently checked.
      </p>
      <div class="zafu-address-display">${escapeHtml(segmentAddress(pastedAddress))}</div>
      <div class="zafu-info-box warn">
        Cancel unless you can check this address against a separate trusted source.
      </div>
      <div class="zafu-checkbox-group zafu-checkbox-required">
        <input type="checkbox" id="zafu-community-check" />
        <label for="zafu-community-check" class="zafu-checkbox-label">I understand this is community-reported and checked it independently</label>
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
            <div style="font-size:11px;color:#aaa;margin-bottom:6px;">Why should this flag be disputed?</div>
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
        This address has been flagged as malicious by a Zafu user. This report has not been independently confirmed.
        Check carefully before proceeding.
      </p>
      <div class="zafu-address-display">${escapeHtml(segmentAddress(pastedAddress))}</div>
      <div class="zafu-info-box warn">
        Proceed only if you checked this address against a separate trusted source.
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

function showFlagToast(message = 'Flag saved locally') {
  const toast = document.createElement('div');
  toast.textContent = message;
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

// Show a one-time nudge when a locally saved flag could not enter the shared pool.
async function maybeShowSignInNudge() {
  const [nudgeShown, stored] = await Promise.all([
    getSignInNudgeShown(),
    chrome.storage.local.get('authState'),
  ]);
  if (nudgeShown || stored.authState?.isAuthenticated) return;

  await setSignInNudgeShown();

  const nudge = document.createElement('div');
  nudge.textContent = 'Sign in to submit this report to the community pool';
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
