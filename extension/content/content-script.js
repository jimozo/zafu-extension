// content-script.js — Zafu paste interceptor with context awareness
// Stage 3 implementation: copy tracking, paste interception, context filtering, overlay

const SEND_LABEL_PATTERN = /recipient|send\s+to|address|withdraw|import\s+token|to\s+address/i;

// Import modules on startup (dynamic import to support MV3 content scripts)
let addressValidator, ensClient, overlay, walletDomains;
let addressComparatorPromise;

(async () => {
  try {
    const results = await Promise.all([
      import('../lib/address-validator.js'),
      import('../lib/ens-client.js'),
      import('../overlay/overlay.js'),
      fetch(chrome.runtime.getURL('data/wallet-exchange-domains.json')).then(
        (r) => r.json()
      ),
    ]);
    [addressValidator, ensClient, overlay, walletDomains] = results;
    console.log('[Zafu] modules loaded, listeners registered');

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
  // Track most recent address-shaped copy for clipboard hijack detection
  document.addEventListener(
    'copy',
    (e) => {
      const selected = getCopiedText(e.target);
      if (!selected) return;

      // Check if the copied text is an EVM address, Solana address, or ENS name
      if (
        addressValidator.isEvmAddress(selected) ||
        addressValidator.isSolanaAddress(selected) ||
        addressValidator.isEnsName(selected)
      ) {
        recordCopiedAddress(selected).catch((err) => {
          console.warn('[Zafu] copied address recording failed:', err);
        });
      } else {
        clearCopiedAddress().catch((err) => {
          console.warn('[Zafu] copied address clearing failed:', err);
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
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!text) return;

      // Extract address/ENS (could be embedded in text like "Send to 0x123..." or "vitalik.eth")
      const extracted =
        addressValidator.extractEvmAddress(text) ||
        addressValidator.extractSolanaAddress(text) ||
        extractEnsName(text);
      if (!extracted) return;

      // Check intervention context
      if (!shouldIntervene(e.target)) {
        // Context check failed — let paste through normally
        return;
      }

      e.preventDefault();

      // Notify service-worker to increment session badge counter
      chrome.runtime.sendMessage({ type: 'PASTE_INTERCEPTED' }).catch(() => {});

      // Get last copied address for hijack detection (cross-tab via service worker)
      let lastCopied = null;
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'GET_LAST_COPIED' });
        lastCopied = resp && resp.lastCopied ? resp.lastCopied.address : null;
      } catch (err) {
        console.warn('[Zafu] GET_LAST_COPIED failed:', err);
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
      const result = await addressComparator.compareAddress(
        addressToUse,
        lastCopied
      );
      console.log('[Zafu] detection result:', result);

      let transferCheckEnabled = false;
      try {
        const { settings } = await chrome.storage.local.get(['settings']);
        transferCheckEnabled = settings?.guardianMode !== false;
      } catch (err) {
        console.warn('[Zafu] transfer check settings lookup failed:', err);
      }

      // Show overlay and wait for user action
      const shouldShowTransferCheck = transferCheckEnabled &&
        (result.state === 'KNOWN' || result.state === 'KNOWN_PUBLIC' || result.state === 'UNKNOWN');
      const { confirmed, address } = shouldShowTransferCheck
        ? await overlay.showTransferCheck(result, e.target, transferContext, lastCopied)
        : await overlay.showOverlay(result, e.target);

      if (confirmed) {
        // If user overrode a POISONED warning, persist as exception so future
        // pastes of this address are treated as KNOWN (Manually verified).
        if (result.state === 'POISONED') {
          chrome.runtime
            .sendMessage({ type: 'MARK_SAFE', address })
            .catch((err) => console.warn('[Zafu] MARK_SAFE send failed:', err));
        }
        replayPaste(e.target, address);
        setTimeout(() => {
          if (!verifyPasteResult(e.target, address)) {
            overlay.showPostPasteMismatch(address).catch((err) => {
              console.warn('[Zafu] post-paste warning failed:', err);
            });
          }
        }, 0);
      } else {
        console.log('[Zafu] paste cancelled by user');
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
  // window.ethereum present = MetaMask or compatible wallet injected = crypto dApp
  if (typeof window.ethereum !== 'undefined') return true;

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

function collectTransferContext(target, address) {
  const field = getFieldElement(target);
  const contextText = field ? getFieldContextText(field) : '';
  return {
    recipientFieldDetected: SEND_LABEL_PATTERN.test(contextText),
    cryptoPageDetected: isCryptoPage(),
    chainHint: detectChainHint(contextText),
    addressType: addressValidator.detectChainType(address),
  };
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

function detectChainHint(text) {
  const value = String(text || '').toLowerCase();
  if (/\bsolana\b|\bsol\b/.test(value)) return 'solana';
  if (/\bethereum\b|\beth\b|\bmainnet\b/.test(value)) return 'ethereum';
  if (/\bpolygon\b|\bmatic\b/.test(value)) return 'polygon';
  if (/\barbitrum\b|\barb\b/.test(value)) return 'arbitrum';
  if (/\bbase\b/.test(value)) return 'base';
  if (/\boptimism\b|\bop\b/.test(value)) return 'optimism';
  if (/\bbnb\b|\bbsc\b|\bbinance smart chain\b/.test(value)) return 'bnb';
  return null;
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

  const normalized = addressValidator.normalizeAddress(address);
  await chrome.runtime.sendMessage({ type: 'COPY_ADDRESS', address: normalized });
  console.log('[Zafu] copied address recorded:', normalized);
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
  if (typeof window.ethereum !== 'undefined') return true;
  const hostname = window.location.hostname;
  const domains = walletDomains ? (walletDomains.domains || []) : [];
  return domains.some((d) => hostname === d || hostname.endsWith('.' + d));
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

console.log('[Zafu] content script loaded on', window.location.hostname);
