// content/contact-picker.js — on-page contact picker
// Opened via Ctrl+Shift+Z (chrome.commands → service-worker → content-script message)
// Injects a shadow DOM overlay; selected address is returned as a Promise<string|null>

const STYLE_URL = chrome.runtime.getURL('content/contact-picker.css');

export async function showContactPicker(previousFocus) {
  const { trusted = {} } = await chrome.storage.local.get(['trusted']);
  const allContacts = Object.values(trusted).sort((a, b) => {
    const nameA = (a.label || a.etherscanLabel || a.ensName || '').toLowerCase();
    const nameB = (b.label || b.etherscanLabel || b.ensName || '').toLowerCase();
    return nameA.localeCompare(nameB);
  });

  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.id = 'zafu-contact-picker';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `@import url('${STYLE_URL}');`;
    shadow.appendChild(style);

    const backdrop = document.createElement('div');
    backdrop.className = 'picker-backdrop';

    const panel = document.createElement('div');
    panel.className = 'picker-panel';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'picker-search';
    searchInput.placeholder = 'Search contacts…';
    panel.appendChild(searchInput);

    const list = document.createElement('ul');
    list.className = 'picker-list';
    panel.appendChild(list);

    const empty = document.createElement('div');
    empty.className = 'picker-empty';
    empty.textContent = allContacts.length === 0
      ? 'No contacts yet. Fetch a wallet first.'
      : 'No contacts match.';
    panel.appendChild(empty);

    const hint = document.createElement('div');
    hint.className = 'picker-hint';
    hint.textContent = '↑↓ navigate · Enter select · Esc close';
    panel.appendChild(hint);

    backdrop.appendChild(panel);
    shadow.appendChild(backdrop);

    let activeIndex = -1;

    function renderList(query = '') {
      list.innerHTML = '';
      activeIndex = -1;

      const q = query.toLowerCase();
      const filtered = allContacts.filter((c) => {
        if (!q) return true;
        return (
          (c.label || '').toLowerCase().includes(q) ||
          (c.etherscanLabel || '').toLowerCase().includes(q) ||
          (c.ensName || '').toLowerCase().includes(q) ||
          c.address.includes(q)
        );
      });

      empty.style.display = filtered.length === 0 ? 'block' : 'none';

      for (const contact of filtered) {
        const li = document.createElement('li');
        li.className = 'picker-item';
        li.dataset.address = contact.address;

        const name = contact.label || contact.etherscanLabel || contact.ensName || '';
        if (name) {
          const nameEl = document.createElement('div');
          nameEl.className = 'picker-item-name';
          nameEl.textContent = name;
          li.appendChild(nameEl);
        }

        const addrEl = document.createElement('div');
        addrEl.className = 'picker-item-addr';
        addrEl.textContent = contact.address;
        li.appendChild(addrEl);

        li.addEventListener('click', () => select(contact.address));
        list.appendChild(li);
      }
    }

    function setActive(index) {
      const items = list.querySelectorAll('.picker-item');
      items.forEach((item, i) => item.classList.toggle('active', i === index));
      activeIndex = index;
      if (items[index]) items[index].scrollIntoView({ block: 'nearest' });
    }

    function select(address) {
      close(address);
    }

    function close(address = null) {
      document.removeEventListener('keydown', keyHandler, true);
      host.remove();
      resolve(address);
    }

    function keyHandler(e) {
      const items = list.querySelectorAll('.picker-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(Math.min(activeIndex + 1, items.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(Math.max(activeIndex - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIndex >= 0 && items[activeIndex]) {
          select(items[activeIndex].dataset.address);
        }
      } else if (e.key === 'Escape') {
        close(null);
      }
    }

    searchInput.addEventListener('input', () => renderList(searchInput.value));
    document.addEventListener('keydown', keyHandler, true);

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });

    renderList();
    // Small delay so shadow DOM styles load before focus
    setTimeout(() => searchInput.focus(), 30);
  });
}
