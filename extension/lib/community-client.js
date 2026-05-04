// community-client.js — Supabase community API calls (submit-report, get-community-list, submit-dispute).
// Placeholders replaced during Supabase project setup.

const SUBMIT_REPORT_URL = 'https://bluwylbyqpurcohvznxo.supabase.co/functions/v1/submit-report';
const GET_COMMUNITY_LIST_URL = 'https://bluwylbyqpurcohvznxo.supabase.co/functions/v1/get-community-list';
const SUBMIT_DISPUTE_URL = 'https://bluwylbyqpurcohvznxo.supabase.co/functions/v1/submit-dispute';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsdXd5bGJ5cXB1cmNvaHZ6bnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNDI5OTUsImV4cCI6MjA5MjYxODk5NX0.w1WOfhil68E53yzyuOK30vVzSpOcIT9HiBWNHEu81YY';

const HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_ANON_KEY,
};

// Submit a community report. Returns true on success, false on network failure.
// source: 'user_flag' | 'suspicion_signal' | 'goplus_autoconfirm'
export async function submitReport(address, chain, source = 'user_flag', installId, googleId = null) {
  if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY === 'YOUR_SUPABASE_ANON_KEY') return false;
  try {
    const res = await fetch(SUBMIT_REPORT_URL, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        address,
        chain,
        install_id: installId,
        google_id: googleId || undefined,
        source,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Queue a failed report for retry. Caps at 200 entries to stay under chrome.storage.local 5MB ceiling.
export async function queuePendingReport(report) {
  const { pendingReports = [] } = await chrome.storage.local.get('pendingReports');
  const next = [...pendingReports, { ...report, queuedAt: Date.now() }].slice(-200);
  await chrome.storage.local.set({ pendingReports: next });
}

// Drain up to `max` pending reports, re-submitting each. Successful entries are removed.
// Callers should invoke after online events, alarm ticks, or after a successful live submit.
export async function flushPendingReports(max = 20) {
  const { pendingReports = [] } = await chrome.storage.local.get('pendingReports');
  if (pendingReports.length === 0) return { sent: 0, remaining: 0 };

  const batch = pendingReports.slice(0, max);
  const remaining = pendingReports.slice(max);
  let sent = 0;

  for (const r of batch) {
    const ok = await submitReport(r.address, r.chain, r.source, r.install_id, r.google_id);
    if (!ok) {
      remaining.push(r);
    } else {
      sent++;
    }
  }

  await chrome.storage.local.set({ pendingReports: remaining });
  return { sent, remaining: remaining.length };
}

export async function getPendingReportCount() {
  const { pendingReports = [] } = await chrome.storage.local.get('pendingReports');
  return pendingReports.length;
}

// Fetch the community blocklist. Returns { addresses, count, generatedAt } or null on error.
// Pass since (ISO string) for incremental fetches — only returns addresses added after that time.
export async function fetchCommunityList(since = null) {
  if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY === 'YOUR_SUPABASE_ANON_KEY') return null;
  const url = new URL(GET_COMMUNITY_LIST_URL);
  if (since) url.searchParams.set('since', since);
  try {
    const res = await fetch(url.toString(), { headers: HEADERS });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Submit a dispute for an incorrectly community-flagged address.
// Returns { ok, disputeCount } or null on error.
export async function submitDispute(address, chain, installId, reason, googleId = null, evidenceUrl = null) {
  if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY === 'YOUR_SUPABASE_ANON_KEY') return null;
  try {
    const res = await fetch(SUBMIT_DISPUTE_URL, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        address,
        chain,
        install_id: installId,
        google_id: googleId || undefined,
        reason,
        evidence_url: evidenceUrl || undefined,
      }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
