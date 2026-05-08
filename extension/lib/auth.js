// auth.js — Google Sign-In via chrome.identity API (MV3)
// Stores auth state in chrome.storage.local under 'authState' key.
// The oauth2 client_id in manifest.json must be set before sign-in works.

const AUTH_KEY = 'authState';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// Supabase Edge Function endpoint — replace with real URL after Supabase project is created
export const UPSERT_USER_URL = 'https://bluwylbyqpurcohvznxo.supabase.co/functions/v1/upsert-user';
// Supabase anon key — safe to expose client-side (RLS enforces access control)
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsdXd5bGJ5cXB1cmNvaHZ6bnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNDI5OTUsImV4cCI6MjA5MjYxODk5NX0.w1WOfhil68E53yzyuOK30vVzSpOcIT9HiBWNHEu81YY';

export const AUTH_DEFAULT = {
  isAuthenticated: false,
  googleId: '',
  email: '',
  displayName: '',
  avatar: '',
  signedInAt: 0,
};

export async function getAuthState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(AUTH_KEY, (result) => {
      resolve(result[AUTH_KEY] || { ...AUTH_DEFAULT });
    });
  });
}

export async function signIn() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, async (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'Auth cancelled'));
        return;
      }
      try {
        const resp = await fetch(USERINFO_URL, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) throw new Error('Userinfo fetch failed');
        const user = await resp.json();
        const state = {
          isAuthenticated: true,
          googleId: user.id,
          email: user.email,
          displayName: user.name || user.email,
          avatar: user.picture || '',
          signedInAt: Date.now(),
        };
        await new Promise((res) => chrome.storage.local.set({ [AUTH_KEY]: state }, res));
        resolve(state);
      } catch (err) {
        chrome.identity.removeCachedAuthToken({ token }, () => {});
        reject(err);
      }
    });
  });
}

export async function signOut() {
  await new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError || !token) { resolve(); return; }
      chrome.identity.removeCachedAuthToken({ token }, resolve);
    });
  });
  await new Promise((res) => chrome.storage.local.set({ [AUTH_KEY]: { ...AUTH_DEFAULT } }, res));
}

// Fire-and-forget upsert to Supabase — non-critical, never blocks UI
export async function upsertUserToSupabase(state) {
  if (!state.googleId || UPSERT_USER_URL.includes('YOUR_PROJECT_REF')) return;
  try {
    await fetch(UPSERT_USER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        googleId: state.googleId,
        email: state.email,
        displayName: state.displayName,
        avatar: state.avatar,
      }),
    });
  } catch { /* ignore — offline or misconfigured */ }
}
