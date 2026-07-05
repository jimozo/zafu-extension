// content-script.js — Zafu paste interceptor with context awareness
// Stage 3 implementation: copy tracking, paste interception, context filtering, overlay

const SEND_LABEL_PATTERN = /recipient|send\s+to|address|withdraw|import\s+token|to\s+address/i;
const TELEGRAM_SOURCE_TTL_MS = 10 * 60 * 1000;
const ZAFU_CONTACT_SOURCE_TTL_MS = 10 * 60 * 1000;

// Import modules on startup (dynamic import to support MV3 content scripts)
let addressValidator, ensClient, overlay, transferContextHelper, walletDomains;
let addressComparatorPromise;

// After an extension reload/update, content scripts from the old context linger on already-open
// pages; their chrome.* calls reject with "Extension context invalidated". Treat that as a benign
// no-op (the page will pick up the fresh content script on its next load) instead of warning.
function isExtensionContextValid() {
  return Boolean(chrome.runtime?.id);
}

function isContextInvalidatedError(err) {
  return /Extension context invalidated|message port closed|receiving end does not exist/i.test(
    err?.message || ''
  );
}

(async () => {
  try {
    const results = await Promise.all([
      import('../lib/address-validator.js'),
      import('../lib/ens-client.js'),
      import('../overlay/overlay.js'),
      import('../lib/transfer-context.js'),
      fetch(chrome.runtime.getURL('data/wallet-exchange-domains.json')).then(
        (r) => r.json()
      ),
    ]);
    [addressValidator, ensClient, overlay, transferContextHelper, walletDomains] = results;

  // Inject ambient badge on crypto pages
  if (isCryptoPage()) {
    if (document.body) {
      injectBadge();
    } else {
      document.addEventListener('DOMContentLoaded', injectBadge, { once: true });
    }
  }
  } catch (err) {
    // "Failed to fetch" = page navigated away before imports completed — harmless
    if (!err?.message?.includes('Failed to fetch')) {
      console.error('[Zafu] failed to load modules:', err);
    }
    return;
  }

  // ===== CONTACT PICKER MESSAGE LISTENER =====
  // Fired when user presses Ctrl+Shift+Z (service-worker receives command, relays here)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'OPEN_CONTACT_PICKER') return;
    const target = document.activeElement;
    import(chrome.runtime.getURL('content/contact-picker.js'))
      .then(({ showContactPicker }) => showContactPicker(target))
      .then((address) => {
        if (address && target) replayPaste(target, address);
      })
      .catch((err) => console.warn('[Zafu] contact picker error:', err));
  });

  // ===== COPY EVENT LISTENER =====
  // Track most recent address-shaped copy for copy/paste mismatch detection
  document.addEventListener(
    'copy',
    (e) => {
      // Orphaned (post-reload) content script: skip — its chrome.* calls would just throw.
      if (!isExtensionContextValid()) return;

      const selected = getCopiedText(e.target) || getTelegramCopyCandidate(e.target);
      if (!selected) return;

      const copiedAddress = extractCryptoAddress(selected);
      if (copiedAddress) {
        if (!shouldTrackCopiedAddress(e.target)) {
          clearCopiedAddress().catch((err) => {
            if (!isContextInvalidatedError(err)) console.warn('[Zafu] copied address clearing failed:', err);
          });
          return;
        }
        recordCopiedAddress(copiedAddress).catch((err) => {
          if (!isContextInvalidatedError(err)) console.warn('[Zafu] copied address recording failed:', err);
        });
      } else {
        clearCopiedAddress().catch((err) => {
          if (!isContextInvalidatedError(err)) console.warn('[Zafu] copied address clearing failed:', err);
        });
      }
    },
    true
  );

  // ===== PASTE EVENT LISTENER =====
  // Intercept paste events on address-shaped content with context awareness
  document.addEventListener(
    'paste',
    async (e) => {
      // Orphaned (post-reload) content script: let the native paste through untouched.
      // preventDefault() without a working extension context would eat the paste — the
      // pipeline below needs chrome.runtime/storage and could never replay it.
      if (!isExtensionContextValid()) return;

      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!text) return;

      let extracted = null;
      let originalAddressForPaste = null;

      if (isTelegramWeb()) {
        originalAddressForPaste = getAddressOnlyPasteAddress(text);
        if (!originalAddressForPaste || !getFieldElement(e.target)) return;
        extracted = originalAddressForPaste;
      } else {
        // Extract address/ENS (could be embedded in text like "Send to 0x123..." or "vitalik.eth")
        extracted = extractCryptoAddress(text);
        if (!extracted) return;

        // Check intervention context
        if (!shouldIntervene(e.target)) {
          // Context check failed — let paste through normally
          return;
        }
      }

      e.preventDefault();

      // Notify service-worker to increment session badge counter
      chrome.runtime.sendMessage({ type: 'PASTE_INTERCEPTED' }).catch(() => {});

      // Get last copied address for hijack detection (cross-tab via service worker)
      let lastCopiedEntry = null;
      let lastCopied = null;
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'GET_LAST_COPIED' });
        lastCopiedEntry = resp && resp.lastCopied ? resp.lastCopied : null;
        lastCopied = lastCopiedEntry ? lastCopiedEntry.address : null;
      } catch (err) {
        if (!isContextInvalidatedError(err)) console.warn('[Zafu] GET_LAST_COPIED failed:', err);
      }
      const sourceEvidenceEntry = lastCopiedEntry;
      if (isExpiredCopySource(lastCopiedEntry)) {
        lastCopied = null;
      }

      // Resolve ENS if applicable
      let addressToUse = addressValidator.normalizeAddress(extracted);
      const originalEnsName = addressValidator.isEnsName(extracted) ? extracted : null;
      if (originalEnsName) {
        try {
          addressToUse = await ensClient.resolveEnsName(extracted);
        } catch (err) {
          console.warn('[Zafu] ENS resolution failed:', err.message);
          // Fall back to treating it as-is (might still be valid)
        }
      }

      const transferContext = collectTransferContext(e.target, addressToUse);

      // Run the detection pipeline
      const addressComparator = await loadAddressComparator();
      let result = await addressComparator.compareAddress(addressToUse);
      result.sourceEvidence = buildSourceEvidence(result, sourceEvidenceEntry);
      result = applyClipboardMismatchState(result, sourceEvidenceEntry);

      let transferCheckEnabled = false;
      let transferHelpMode = 'standard';
      try {
        const { settings } = await chrome.storage.local.get(['settings']);
        transferCheckEnabled = settings?.guardianMode !== false;
        transferHelpMode = transferContextHelper.normalizeHelpMode(settings?.transferHelpMode);
      } catch (err) {
        console.warn('[Zafu] transfer check settings lookup failed:', err);
      }

      // Show overlay and wait for user action
      const shouldShowTransferCheck = transferCheckEnabled &&
        (result.state === 'KNOWN' || result.state === 'KNOWN_PUBLIC' || result.state === 'UNKNOWN');
      if (shouldShowTransferCheck) {
        recordNetworkMetric('transfer_check_shown', { chainType: result.chainType }).catch(() => {});
      } else if (isWarningState(result.state)) {
        recordNetworkMetric('warning_state_shown', { state: result.state }).catch(() => {});
      }
      if (result.sourceEvidence?.sourceClass === 'telegram_web') {
        const metric = result.sourceEvidence.state === 'MATCHED_TELEGRAM_SOURCE'
          ? 'telegram_source_match'
          : result.sourceEvidence.state === 'MISMATCHED_TELEGRAM_SOURCE'
            ? 'telegram_source_mismatch'
            : null;
        if (metric) recordNetworkMetric(metric, { chainType: result.chainType }).catch(() => {});
      }
      const { confirmed, address, saveRecipient } = shouldShowTransferCheck
        ? await overlay.showTransferCheck(result, e.target, transferContext, lastCopied, { helpMode: transferHelpMode })
        : await overlay.showOverlay(result, e.target);

      if (shouldShowTransferCheck) {
        recordNetworkMetric(confirmed ? 'transfer_check_confirmed' : 'transfer_check_cancelled').catch(() => {});
      }

      if (confirmed) {
        const addressToPaste = originalAddressForPaste || address;
        // If user overrode a POISONED warning, persist as exception so future
          // pastes of this address are treated as KNOWN (manually checked).
        if (result.state === 'POISONED') {
          chrome.runtime
            .sendMessage({ type: 'MARK_SAFE', address })
            .catch((err) => console.warn('[Zafu] MARK_SAFE send failed:', err));
        }
        if (saveRecipient?.address) {
          chrome.runtime
            .sendMessage({ type: 'SAVE_STABLECOIN_CONTACT', contact: saveRecipient })
            .catch((err) => console.warn('[Zafu] SAVE_STABLECOIN_CONTACT send failed:', err));
        }
        replayPaste(e.target, addressToPaste);
        setTimeout(() => {
          if (!verifyPasteResult(e.target, addressToPaste)) {
            overlay.showPostPasteMismatch(addressToPaste).catch((err) => {
              console.warn('[Zafu] post-paste warning failed:', err);
            });
          }
        }, 0);
      }
    },
    true // capture phase to intercept before other handlers
  );
})();

/**
 * Check if the paste target is in an intervention context.
 * Returns true if:
 * - The current domain is in wallet-exchange-domains.json, OR
 * - The input is within N nodes of a label/placeholder/aria-label matching /send|recipient|address/i
 */
function shouldIntervene(target) {
  // Note: wallet-injected globals like window.ethereum are NOT visible here — content
  // scripts run in an isolated world. dApp detection rides the domain allowlist and the
  // field-label heuristics below instead.

  // Check domain allowlist
  const hostname = window.location.hostname;
  const domains = walletDomains.domains || [];
  if (domains.some((d) => hostname === d || hostname.endsWith('.' + d))) {
    return true;
  }

  const field = getFieldElement(target);
  if (!field) return false;

  // Check if input has a relevant placeholder or nearby label
  if (field.placeholder && SEND_LABEL_PATTERN.test(field.placeholder)) {
    return true;
  }

  if (field.getAttribute('aria-label')) {
    if (SEND_LABEL_PATTERN.test(field.getAttribute('aria-label'))) {
      return true;
    }
  }

  if (field.getAttribute('data-testid')) {
    if (SEND_LABEL_PATTERN.test(field.getAttribute('data-testid'))) {
      return true;
    }
  }

  // Check for nearby label element (up to 5 ancestors)
  let ancestor = field;
  for (let i = 0; i < 5; i++) {
    ancestor = ancestor.parentElement;
    if (!ancestor) break;

    // Look for associated label (e.g., <label for="field-id">)
    const inputId = field.id;
    if (inputId) {
      const label = ancestor.querySelector(`label[for="${inputId}"]`);
      if (label && SEND_LABEL_PATTERN.test(label.textContent)) {
        return true;
      }
    }

    // Check for label text in nearby divs/fieldsets
    const labelText = ancestor.querySelector('label')?.textContent || '';
    if (labelText && SEND_LABEL_PATTERN.test(labelText)) {
      return true;
    }
  }

  return false;
}

function shouldTrackCopiedAddress(target) {
  return isTelegramWeb() || isCryptoPage() || shouldIntervene(target);
}

function collectTransferContext(target, address) {
  const field = getFieldElement(target);
  const contextText = field ? getFieldContextText(field) : '';
  return transferContextHelper.createCoreTransferContext({
    fieldContextText: contextText,
    address,
    recipientFieldDetected: SEND_LABEL_PATTERN.test(contextText),
    cryptoPageDetected: !isTelegramWeb() && isCryptoPage(),
    telegramWebDetected: isTelegramWeb(),
    addressType: addressValidator.detectChainType(address),
  });
}

function getFieldContextText(field) {
  const parts = [
    field.placeholder || '',
    field.getAttribute('aria-label') || '',
    field.getAttribute('data-testid') || '',
    field.getAttribute('name') || '',
  ];

  let ancestor = field;
  for (let i = 0; i < 5; i++) {
    ancestor = ancestor.parentElement;
    if (!ancestor) break;

    const inputId = field.id;
    if (inputId) {
      const label = ancestor.querySelector(`label[for="${inputId}"]`);
      if (label) parts.push(label.textContent || '');
    }

    const label = ancestor.querySelector('label');
    if (label) parts.push(label.textContent || '');

    const ancestorAria = ancestor.getAttribute?.('aria-label');
    if (ancestorAria) parts.push(ancestorAria);
  }

  return parts.join(' ');
}

function loadAddressComparator() {
  if (!addressComparatorPromise) {
    addressComparatorPromise = import('../lib/address-comparator.js');
  }
  return addressComparatorPromise;
}

function getFieldElement(target) {
  if (!target) return null;
  const el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
  if (!el) return null;
  if (isTextInput(el) || el.isContentEditable || el.getAttribute('role') === 'textbox') return el;
  return el.closest('input, textarea, [contenteditable="true"], [role="textbox"]');
}

function getCopiedText(target) {
  if (target && isTextInput(target)) {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    if (typeof start === 'number' && typeof end === 'number' && end > start) {
      return target.value.slice(start, end).trim();
    }
  }

  return window.getSelection().toString().trim();
}

async function recordCopiedAddress(rawText) {
  let address = rawText;
  if (addressValidator.isEnsName(rawText)) {
    try {
      address = await ensClient.resolveEnsName(rawText);
    } catch (err) {
      console.warn('[Zafu] copied ENS resolution failed:', err.message);
      address = rawText;
    }
  }

  const chainType = addressValidator.detectChainType(address);
  const normalized = addressValidator.normalizeAddress(address, chainType);
  await chrome.runtime.sendMessage({
    type: 'COPY_ADDRESS',
    address: normalized,
    displayAddress: address,
    chainType,
    source: buildCopySourcePayload(address, chainType),
  });
  if (isTelegramWeb()) {
    recordNetworkMetric('telegram_web_copy_detected', { chainType }).catch(() => {});
    showTelegramCopyToast(chainType);
  }
}

async function clearCopiedAddress() {
  await chrome.runtime.sendMessage({ type: 'CLEAR_LAST_COPIED' });
}

function extractEnsName(text) {
  const candidates = String(text).match(/\b[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.eth\b/gi) || [];
  return candidates.find((candidate) => addressValidator.isEnsName(candidate)) || null;
}

function isTextInput(target) {
  if (!target) return false;
  if (target.tagName === 'TEXTAREA') return true;
  if (target.tagName !== 'INPUT') return false;
  const textLikeTypes = new Set(['', 'text', 'search', 'url', 'tel', 'email']);
  return textLikeTypes.has((target.type || '').toLowerCase());
}

/**
 * Replay a paste event using the native input setter approach from Stage 0 spike.
 * Works on React-controlled inputs.
 */
function replayPaste(target, address) {
  const field = getFieldElement(target);
  if (!field) return;

  // For contenteditable divs, use insertText
  if (field.contentEditable === 'true' || field.isContentEditable) {
    field.focus();
    document.execCommand('insertText', false, address);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  // For textarea and text-like inputs.
  if (isTextInput(field)) {
    // Use the native input setter (bypasses React's change tracking)
    const proto = field.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const nativeInputSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const start = typeof field.selectionStart === 'number' ? field.selectionStart : field.value.length;
    const end = typeof field.selectionEnd === 'number' ? field.selectionEnd : field.value.length;
    const nextValue = field.value.slice(0, start) + address + field.value.slice(end);

    if (nativeInputSetter) {
      nativeInputSetter.call(field, nextValue);
    } else {
      field.value = nextValue; // fallback
    }

    const caret = start + address.length;
    if (typeof field.setSelectionRange === 'function') {
      field.setSelectionRange(caret, caret);
    }

    // Trigger input event (which React listens to)
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  // Fallback: execCommand insertText (works on most inputs)
  field.focus();
  document.execCommand('insertText', false, address);
}

function verifyPasteResult(target, address) {
  const value = getEditableValue(target);
  if (value === null) return true;
  return String(value).includes(address);
}

function getEditableValue(target) {
  const field = getFieldElement(target);
  if (!field) return null;
  if (field.contentEditable === 'true' || field.isContentEditable) {
    return field.textContent || '';
  }
  if (isTextInput(field)) return field.value || '';
  return null;
}

function isCryptoPage() {
  const hostname = window.location.hostname;
  const domains = walletDomains ? (walletDomains.domains || []) : [];
  return domains.some((d) => hostname === d || hostname.endsWith('.' + d));
}

function isTelegramWeb() {
  return window.location.hostname === 'web.telegram.org';
}

function getAddressOnlyPasteAddress(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const chainType = addressValidator.detectChainType(value);
  return isSupportedAddressChain(chainType) ? value : null;
}

function isSupportedAddressChain(chainType) {
  return chainType === 'evm' || chainType === 'solana' || chainType === 'tron';
}

function getTelegramCopyCandidate(target) {
  if (!isTelegramWeb()) return '';
  const el = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  const message = el?.closest?.('[data-message-id], [class*="message"], [class*="Message"]');
  const text = message?.textContent || el?.textContent || '';
  const extracted = extractCryptoAddress(text);
  return extracted || '';
}

function extractCryptoAddress(text) {
  const value = String(text || '').trim();
  return addressValidator.extractEvmAddress(value) ||
    addressValidator.extractTronAddress(value) ||
    addressValidator.extractSolanaAddress(value) ||
    extractEnsName(value);
}

function buildCopySourcePayload(address, chainType) {
  if (!isTelegramWeb()) return null;
  return {
    sourceClass: 'telegram_web',
    displayAddress: address,
    chainCandidates: chainType ? [chainType] : [],
  };
}

function buildSourceEvidence(result, lastCopiedEntry) {
  const source = lastCopiedEntry?.source;
  if (source?.sourceClass === 'zafu_contact') {
    return buildZafuContactSourceEvidence(result, lastCopiedEntry);
  }
  if (source?.sourceClass !== 'telegram_web') {
    return { state: 'NO_RECENT_SOURCE' };
  }
  const ageMs = lastCopiedEntry.ts ? Date.now() - lastCopiedEntry.ts : null;
  const ageSeconds = ageMs != null ? Math.max(0, Math.round(ageMs / 1000)) : null;
  if (ageMs != null && ageMs > TELEGRAM_SOURCE_TTL_MS) {
    return {
      state: 'SOURCE_EXPIRED',
      sourceClass: 'telegram_web',
      ageSeconds,
      chainCandidates: Array.isArray(source.chainCandidates) ? source.chainCandidates : [],
    };
  }
  const copiedAddress = lastCopiedEntry.address;
  const copiedChain = lastCopiedEntry.chainType || addressValidator.detectChainType(copiedAddress);
  const pastedChain = result.chainType || addressValidator.detectChainType(result.pastedAddress);
  if (copiedChain !== pastedChain) {
    return { state: 'NO_RECENT_SOURCE' };
  }
  const normalizedCopied = addressValidator.normalizeAddress(copiedAddress, copiedChain);
  const normalizedPasted = addressValidator.normalizeAddress(result.pastedAddress, pastedChain);
  const matches = normalizedCopied === normalizedPasted;
  return {
    state: matches ? 'MATCHED_TELEGRAM_SOURCE' : 'MISMATCHED_TELEGRAM_SOURCE',
    sourceClass: 'telegram_web',
    ageSeconds,
    displayAddress: source.displayAddress || copiedAddress,
    copiedAddress: normalizedCopied,
    chainCandidates: Array.isArray(source.chainCandidates) ? source.chainCandidates : [],
  };
}

function buildZafuContactSourceEvidence(result, lastCopiedEntry) {
  const source = lastCopiedEntry.source || {};
  const ageMs = lastCopiedEntry.ts ? Date.now() - lastCopiedEntry.ts : null;
  const ageSeconds = ageMs != null ? Math.max(0, Math.round(ageMs / 1000)) : null;
  if (ageMs != null && ageMs > ZAFU_CONTACT_SOURCE_TTL_MS) {
    return {
      state: 'SOURCE_EXPIRED',
      sourceClass: 'zafu_contact',
      ageSeconds,
      contactLabel: source.contactLabel || null,
      asset: source.asset || null,
      network: source.network || null,
    };
  }
  const copiedAddress = lastCopiedEntry.address;
  const copiedChain = lastCopiedEntry.chainType || addressValidator.detectChainType(copiedAddress);
  const pastedChain = result.chainType || addressValidator.detectChainType(result.pastedAddress);
  if (copiedChain !== pastedChain) {
    return { state: 'NO_RECENT_SOURCE' };
  }
  const normalizedCopied = addressValidator.normalizeAddress(copiedAddress, copiedChain);
  const normalizedPasted = addressValidator.normalizeAddress(result.pastedAddress, pastedChain);
  const matches = normalizedCopied === normalizedPasted;
  return {
    state: matches ? 'MATCHED_ZAFU_CONTACT_SOURCE' : 'MISMATCHED_ZAFU_CONTACT_SOURCE',
    sourceClass: 'zafu_contact',
    ageSeconds,
    contactLabel: source.contactLabel || null,
    asset: source.asset || null,
    network: source.network || null,
    displayAddress: source.displayAddress || copiedAddress,
    copiedAddress: normalizedCopied,
  };
}

function applyClipboardMismatchState(result, lastCopiedEntry) {
  if (!isClipboardMismatchCandidateState(result?.state)) return result;
  const mismatch = getCopyMismatchEvidence(result, lastCopiedEntry);
  if (!mismatch) return result;
  return {
    ...result,
    state: 'CLIPBOARD_MISMATCH',
    originalState: result.state,
    copiedAddress: mismatch.copiedAddress,
    copyMismatch: mismatch,
  };
}

function isClipboardMismatchCandidateState(state) {
  return state === 'KNOWN' || state === 'KNOWN_PUBLIC' || state === 'UNKNOWN';
}

function getCopyMismatchEvidence(result, lastCopiedEntry) {
  if (!result?.pastedAddress || !lastCopiedEntry?.address) return null;
  if (isExpiredCopySource(lastCopiedEntry)) return null;
  const copiedAddress = lastCopiedEntry.address;
  const copiedChain = lastCopiedEntry.chainType || addressValidator.detectChainType(copiedAddress);
  const pastedChain = result.chainType || addressValidator.detectChainType(result.pastedAddress);
  if (copiedChain !== pastedChain) return null;
  const normalizedCopied = addressValidator.normalizeAddress(copiedAddress, copiedChain);
  const normalizedPasted = addressValidator.normalizeAddress(result.pastedAddress, pastedChain);
  if (normalizedCopied === normalizedPasted) return null;
  const ageMs = lastCopiedEntry.ts ? Date.now() - lastCopiedEntry.ts : null;
  return {
    state: 'MISMATCHED_BROWSER_COPY',
    sourceClass: lastCopiedEntry.source?.sourceClass || 'browser_copy',
    copiedAddress: normalizedCopied,
    pastedAddress: normalizedPasted,
    ageSeconds: ageMs != null ? Math.max(0, Math.round(ageMs / 1000)) : null,
  };
}

function isExpiredTelegramSource(lastCopiedEntry) {
  if (lastCopiedEntry?.source?.sourceClass !== 'telegram_web') return false;
  return !!lastCopiedEntry.ts && (Date.now() - lastCopiedEntry.ts) > TELEGRAM_SOURCE_TTL_MS;
}

function isExpiredZafuContactSource(lastCopiedEntry) {
  if (lastCopiedEntry?.source?.sourceClass !== 'zafu_contact') return false;
  return !!lastCopiedEntry.ts && (Date.now() - lastCopiedEntry.ts) > ZAFU_CONTACT_SOURCE_TTL_MS;
}

function isExpiredCopySource(lastCopiedEntry) {
  return isExpiredTelegramSource(lastCopiedEntry) || isExpiredZafuContactSource(lastCopiedEntry);
}

function showTelegramCopyToast(chainType) {
  const chainLabel = telegramCopyToastChainLabel(chainType);
  if (!chainLabel || !isTelegramWeb()) return;

  const existing = document.getElementById('zafu-telegram-copy-toast');
  if (existing) existing.remove();

  const host = document.createElement('div');
  host.id = 'zafu-telegram-copy-toast';
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    div {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483647;
      max-width: min(340px, calc(100vw - 36px));
      padding: 11px 13px;
      border: 1px solid rgba(77, 134, 207, 0.28);
      border-radius: 8px;
      background: rgba(16, 24, 39, 0.96);
      color: #f8fafc;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.22);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      line-height: 1.35;
      font-weight: 500;
      pointer-events: none;
    }
  `;

  const toast = document.createElement('div');
  toast.textContent = `${chainLabel} address captured from Telegram. Zafu will check it on paste.`;

  shadow.appendChild(style);
  shadow.appendChild(toast);
  document.documentElement.appendChild(host);

  setTimeout(() => {
    host.remove();
  }, 3500);
}

function telegramCopyToastChainLabel(chainType) {
  if (chainType === 'evm') return 'EVM';
  if (chainType === 'solana') return 'Solana';
  if (chainType === 'tron') return 'TRON';
  return null;
}

function isWarningState(state) {
  return [
    'SUSPICIOUS_KNOWN',
    'CLIPBOARD_MISMATCH',
    'POISONED',
    'HIJACKED',
    'SCAM',
    'MALICIOUS',
    'COMMUNITY_REPORTED',
    'COMMUNITY_DISPUTED',
    'FLAGGED',
  ].includes(state);
}

async function recordNetworkMetric(name, detail = {}) {
  await chrome.runtime.sendMessage({ type: 'RECORD_NETWORK_METRIC', name, detail });
}

function injectBadge() {
  if (document.getElementById('zafu-badge-host')) return;
  const host = document.createElement('div');
  host.id = 'zafu-badge-host';
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    a {
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 5px 10px 5px 7px;
      background: rgba(255,255,255,0.93);
      border: 1px solid rgba(77,134,207,0.25);
      border-radius: 20px;
      text-decoration: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 11px;
      font-weight: 500;
      color: #4d86cf;
      box-shadow: 0 2px 6px rgba(0,0,0,0.10);
      opacity: 0.65;
      transition: opacity 0.2s;
      cursor: pointer;
      user-select: none;
    }
    a:hover { opacity: 1; }
    @media (prefers-color-scheme: dark) {
      a {
        background: rgba(18,18,28,0.90);
        border-color: rgba(77,134,207,0.35);
        color: #6fa3e0;
      }
    }
  `;

  const link = document.createElement('a');
  link.href = 'https://stayzafu.com';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', 'Protected by Zafu');
  link.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Protected by Zafu`;

  shadow.appendChild(style);
  shadow.appendChild(link);
  document.documentElement.appendChild(host);
}
