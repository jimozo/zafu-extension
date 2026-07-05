// goplus-client.js — public address-risk checks used by local Intel assessment.

const SCAM_FLAGS = [
  'blacklist_doubt',
  'stealing_attack',
  'phishing_activities',
  'cybercrime',
  'sanctioned',
];

const FLAG_LABELS = {
  blacklist_doubt: 'Blacklist signal',
  stealing_attack: 'Stealing attack',
  phishing_activities: 'Phishing activity',
  cybercrime: 'Cybercrime signal',
  sanctioned: 'Sanctions signal',
};

export async function fetchGoPlusAddressRisk(address) {
  const res = await fetch(`https://api.gopluslabs.io/api/v1/address_security/${address}?chain_id=1`);
  if (!res.ok) throw new Error(`GoPlus HTTP ${res.status}`);
  const json = await res.json();
  const flags = json.result?.[address.toLowerCase()] || json.result?.[address] || {};
  const matched = SCAM_FLAGS.filter((flag) => flags[flag] === '1');
  const sanctionsFlags = matched.filter((flag) => flag === 'sanctioned');
  const scamFlags = matched.filter((flag) => flag !== 'sanctioned');
  return {
    source: 'goplus',
    status: matched.length ? 'risky' : 'clear',
    verdict: matched.length ? 'Risk flagged' : 'Clear',
    flags: matched,
    sanctionsFlags,
    scamFlags,
    summary: matched.map((flag) => FLAG_LABELS[flag] || flag).join(', '),
    updatedAt: Date.now(),
  };
}
