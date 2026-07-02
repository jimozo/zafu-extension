// community-client.js — Supabase community API calls (submit-report, get-community-list, submit-dispute).
// Placeholders replaced during Supabase project setup.

import { getGoogleAuthToken } from './auth.js';

const SUBMIT_REPORT_URL = 'https://bluwylbyqpurcohvznxo.supabase.co/functions/v1/submit-report';
const GET_COMMUNITY_LIST_URL = 'https://bluwylbyqpurcohvznxo.supabase.co/functions/v1/get-community-list';
const SUBMIT_DISPUTE_URL = 'https://bluwylbyqpurcohvznxo.supabase.co/functions/v1/submit-dispute';
const SUBMIT_NETWORK_METRICS_URL = 'https://bluwylbyqpurcohvznxo.supabase.co/functions/v1/submit-network-metrics';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsdXd5bGJ5cXB1cmNvaHZ6bnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNDI5OTUsImV4cCI6MjA5MjYxODk5NX0.w1WOfhil68E53yzyuOK30vVzSpOcIT9HiBWNHEu81YY';

const HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_ANON_KEY,
};

async function optionalAuthHeaders() {
  const token = await getGoogleAuthToken();
  return token ? { ...HEADERS, 'Authorization': `Bearer ${token}` } : HEADERS;
}

// Submit a community report. Returns true on success, false on network failure.
// source: 'user_flag' | 'suspicion_signal' | 'goplus_autoconfirm'
export async function submitReport(address, chain, source = 'user_flag', installId) {
  if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY === 'YOUR_SUPABASE_ANON_KEY') return false;
  try {
    const res = await fetch(SUBMIT_REPORT_URL, {
      method: 'POST',
      headers: await optionalAuthHeaders(),
      body: JSON.stringify({
        address,
        chain,
        install_id: installId,
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
  const { pendingReports = [], settings = {} } = await chrome.storage.local.get(['pendingReports', 'settings']);
  if (pendingReports.length === 0) return { sent: 0, remaining: 0 };

  const automaticSignalsEnabled = settings.communityThreatSignals === true;
  const allowedReports = pendingReports.filter((r) => r.source === 'user_flag' || automaticSignalsEnabled);
  const dropped = pendingReports.length - allowedReports.length;
  const batch = allowedReports.slice(0, max);
  const remaining = allowedReports.slice(max);
  let sent = 0;

  for (const r of batch) {
    const ok = await submitReport(r.address, r.chain, r.source, r.install_id);
    if (!ok) {
      remaining.push(r);
    } else {
      sent++;
    }
  }

  await chrome.storage.local.set({ pendingReports: remaining });
  return { sent, remaining: remaining.length, dropped };
}

export async function getPendingReportCount() {
  const { pendingReports = [], settings = {} } = await chrome.storage.local.get(['pendingReports', 'settings']);
  if (settings.communityThreatSignals === true) return pendingReports.length;
  const manualReports = pendingReports.filter((r) => r.source === 'user_flag');
  if (manualReports.length !== pendingReports.length) {
    await chrome.storage.local.set({ pendingReports: manualReports });
  }
  return manualReports.length;
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
export async function submitDispute(address, chain, installId, reason, evidenceUrl = null) {
  if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY === 'YOUR_SUPABASE_ANON_KEY') return null;
  try {
    const res = await fetch(SUBMIT_DISPUTE_URL, {
      method: 'POST',
      headers: await optionalAuthHeaders(),
      body: JSON.stringify({
        address,
        chain,
        install_id: installId,
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

export async function submitNetworkMetrics(payload) {
  if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY === 'YOUR_SUPABASE_ANON_KEY') return false;
  try {
    const res = await fetch(SUBMIT_NETWORK_METRICS_URL, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}
