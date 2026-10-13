import { storage } from '@/utils/storage';

export interface SupabaseUser {
  id: string;
  email: string;
  user_metadata?: {
    business_name?: string;
    vpa?: string;
    spoken_language?: string;
  };
}

export interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: SupabaseUser;
}

export interface MerchantRecord {
  id: string;
  user_id: string;
  email: string;
  business_name: string;
  vpa: string;
  phone?: string;
  spoken_language: string;
  announcements_enabled: boolean;
  speech_rate: number;
  created_at: string;
}

export interface CloudPaymentEvent {
  id: string;
  merchant_id: string;
  amount: number;
  source: string;
  payer_name?: string;
  utr?: string;
  note?: string;
  state: 'Played' | 'Pending' | 'Failed';
  raw_notification?: string;
  created_at: string;
}

export interface CloudExpense {
  id: string;
  merchant_id: string;
  title: string;
  amount: number;
  category: string;
  status: 'done' | 'pending';
  payment_method: string;
  date: string;
  note?: string;
  created_at: string;
}

// Storage keys
const SESSION_STORAGE_KEY = 'dhwanipay_supabase_session';
const CONFIG_STORAGE_KEY = 'dhwanipay_supabase_config';

let supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
let supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

// Initialize configuration from persistent storage if saved
export async function initSupabaseConfig(): Promise<{ url: string; anonKey: string }> {
  try {
    const saved = await storage.getItem(CONFIG_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.url) supabaseUrl = parsed.url;
      if (parsed.anonKey) supabaseAnonKey = parsed.anonKey;
    }
  } catch (e) {
    console.warn('Failed to load Supabase config', e);
  }
  return { url: supabaseUrl, anonKey: supabaseAnonKey };
}

export async function saveSupabaseConfig(url: string, anonKey: string): Promise<void> {
  supabaseUrl = url.trim();
  supabaseAnonKey = anonKey.trim();
  await storage.setItem(CONFIG_STORAGE_KEY, JSON.stringify({ url: supabaseUrl, anonKey: supabaseAnonKey }));
}

export function getSupabaseConfig(): { url: string; anonKey: string } {
  return { url: supabaseUrl, anonKey: supabaseAnonKey };
}

// Check if connecting to a real user-supplied Supabase project
export function isRealSupabaseConfigured(): boolean {
  return (
    supabaseUrl.length > 0 &&
    supabaseUrl.includes('.supabase.co') &&
    supabaseAnonKey.length > 30
  );
}

/**
 * Attempt to refresh an expired session using the stored refresh token.
 * Returns the new session or null on failure.
 */
async function refreshSessionIfExpired(session: SupabaseSession): Promise<SupabaseSession | null> {
  // Check if token is expired (with 60s buffer)
  if (session.expires_at && Date.now() < (session.expires_at * 1000) - 60_000) {
    return session; // Still valid
  }

  if (!session.refresh_token || !isRealSupabaseConfigured()) {
    return session; // Can't refresh, return as-is
  }

  try {
    const cleanUrl = supabaseUrl.replace(/\/+$/, '');
    const res = await fetch(`${cleanUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseAnonKey,
      },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });

    if (!res.ok) return session;

    const data = await res.json();
    const refreshed: SupabaseSession = {
      access_token: data.access_token || session.access_token,
      refresh_token: data.refresh_token || session.refresh_token,
      expires_at: data.expires_at || session.expires_at,
      user: data.user ? {
        id: data.user.id,
        email: data.user.email,
        user_metadata: data.user.user_metadata,
      } : session.user,
    };

    await setStoredSession(refreshed);
    return refreshed;
  } catch (e) {
    console.warn('Token refresh failed:', e);
    return session;
  }
}

// Low-level fetch wrapper with Auth, token refresh, and API key headers
async function supabaseFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
  let session = await getStoredSession();

  // Auto-refresh expired tokens before making the request
  if (session) {
    session = await refreshSessionIfExpired(session);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: supabaseAnonKey,
    ...((options.headers as Record<string, string>) || {}),
  };

  if (session?.access_token) {
    headers['Authorization'] = `Bearer ${session.access_token}`;
  }

  const cleanUrl = supabaseUrl.replace(/\/+$/, '');
  const targetUrl = `${cleanUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  return fetch(targetUrl, {
    ...options,
    headers,
  });
}

// ==============================================================================
// AUTHENTICATION APIs
// ==============================================================================

async function getStoredSession(): Promise<SupabaseSession | null> {
  try {
    const raw = await storage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setStoredSession(session: SupabaseSession | null): Promise<void> {
  if (session) {
    await storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } else {
    await storage.removeItem(SESSION_STORAGE_KEY);
  }
}

/**
 * Real Email & Password Sign Up via Supabase GoTrue Auth
 */
export async function signUpWithEmail(
  email: string,
  password: string,
  metadata: { businessName: string; vpa: string; spokenLanguage?: string }
): Promise<{ user: SupabaseUser | null; session: SupabaseSession | null; error?: string }> {
  const cleanEmail = email.trim().toLowerCase();

  // If connected to real Supabase project
  if (isRealSupabaseConfigured()) {
    try {
      const res = await supabaseFetch('/auth/v1/signup', {
        method: 'POST',
        body: JSON.stringify({
          email: cleanEmail,
          password,
          data: {
            business_name: metadata.businessName,
            vpa: metadata.vpa,
            spoken_language: metadata.spokenLanguage || 'English',
          },
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        return {
          user: null,
          session: null,
          error:
            data.error_description ||
            data.msg ||
            data.message ||
            'Registration failed. Please check your credentials.',
        };
      }

      // Supabase GoTrue returns user either in data.user OR directly on data
      const rawUser = data.user || (data.id ? data : null);
      if (!rawUser) {
        return {
          user: null,
          session: null,
          error: 'No user record returned from Supabase.',
        };
      }

      const user: SupabaseUser = {
        id: rawUser.id,
        email: rawUser.email || cleanEmail,
        user_metadata: rawUser.user_metadata || {
          business_name: metadata.businessName,
          vpa: metadata.vpa,
          spoken_language: metadata.spokenLanguage || 'English',
        },
      };

      const accessToken =
        data.access_token || data.session?.access_token || `session_${Date.now()}`;
      const refreshToken =
        data.refresh_token || data.session?.refresh_token || `refresh_${Date.now()}`;
      const expiresAt =
        data.expires_at || data.session?.expires_at || Date.now() + 3600000 * 24 * 7;

      const session: SupabaseSession = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        user,
      };

      await setStoredSession(session);
      return { user, session, error: undefined };
    } catch (err: any) {
      return {
        user: null,
        session: null,
        error: err.message || 'Network error connecting to Supabase',
      };
    }
  }

  // Graceful local emulation when testing before entering live Supabase credentials
  const mockUser: SupabaseUser = {
    id: `usr_${Date.now()}`,
    email: cleanEmail,
    user_metadata: {
      business_name: metadata.businessName,
      vpa: metadata.vpa,
      spoken_language: metadata.spokenLanguage || 'English',
    },
  };

  const mockSession: SupabaseSession = {
    access_token: `mock_jwt_${Date.now()}`,
    refresh_token: `mock_refresh_${Date.now()}`,
    expires_at: Date.now() + 3600000 * 24 * 7,
    user: mockUser,
  };

  await setStoredSession(mockSession);
  return { user: mockUser, session: mockSession, error: undefined };
}

/**
 * Real Email & Password Sign In via Supabase GoTrue Auth
 */
export async function signInWithEmail(
  email: string,
  password: string
): Promise<{ user: SupabaseUser | null; session: SupabaseSession | null; error?: string }> {
  const cleanEmail = email.trim().toLowerCase();

  if (isRealSupabaseConfigured()) {
    try {
      const res = await supabaseFetch('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: JSON.stringify({
          email: cleanEmail,
          password,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        return {
          user: null,
          session: null,
          error:
            data.error_description ||
            data.msg ||
            data.message ||
            'Invalid email or password',
        };
      }

      const rawUser = data.user || (data.id ? data : null);
      if (!rawUser) {
        return {
          user: null,
          session: null,
          error: 'No user data received from Supabase.',
        };
      }

      const user: SupabaseUser = {
        id: rawUser.id,
        email: rawUser.email || cleanEmail,
        user_metadata: rawUser.user_metadata || {},
      };

      const accessToken =
        data.access_token || data.session?.access_token || `session_${Date.now()}`;
      const refreshToken =
        data.refresh_token || data.session?.refresh_token || `refresh_${Date.now()}`;
      const expiresAt =
        data.expires_at || data.session?.expires_at || Date.now() + 3600000 * 24 * 7;

      const session: SupabaseSession = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        user,
      };

      await setStoredSession(session);
      return { user, session, error: undefined };
    } catch (err: any) {
      return {
        user: null,
        session: null,
        error: err.message || 'Network error connecting to Supabase',
      };
    }
  }

  // Graceful local emulation
  const mockUser: SupabaseUser = {
    id: `usr_${cleanEmail.replace(/[^a-z0-9]/g, '_')}`,
    email: cleanEmail,
    user_metadata: {
      business_name: '',
      vpa: `${cleanEmail.split('@')[0]}@okhdfcbank`,
      spoken_language: 'English',
    },
  };

  const mockSession: SupabaseSession = {
    access_token: `mock_jwt_${Date.now()}`,
    refresh_token: `mock_refresh_${Date.now()}`,
    expires_at: Date.now() + 3600000 * 24 * 7,
    user: mockUser,
  };

  await setStoredSession(mockSession);
  return { user: mockUser, session: mockSession, error: undefined };
}

/**
 * Sign Out
 */
export async function signOutUser(): Promise<void> {
  // 1. Immediately wipe local session from storage
  await setStoredSession(null);

  // 2. Best-effort server revocation with short timeout
  if (isRealSupabaseConfigured()) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);
      await supabaseFetch('/auth/v1/logout', {
        method: 'POST',
        signal: controller.signal,
      }).catch(() => {});
      clearTimeout(timeoutId);
    } catch {
      // Ignored
    }
  }
}

/**
 * Get active session
 */
export async function getCurrentSession(): Promise<SupabaseSession | null> {
  return getStoredSession();
}

// ==============================================================================
// DATABASE (POSTGREST) APIS
// ==============================================================================

/**
 * Fetch merchant profile from `public.merchants`
 */
export async function fetchMerchantProfile(userId: string): Promise<MerchantRecord | null> {
  if (!isRealSupabaseConfigured()) return null;

  try {
    const res = await supabaseFetch(`/rest/v1/merchants?user_id=eq.${userId}&select=*`, {
      method: 'GET',
    });
    if (res.ok) {
      const rows = await res.json();
      return rows[0] || null;
    }
  } catch (e) {
    console.warn('Failed to fetch merchant profile', e);
  }
  return null;
}

const isUUID = (str?: string): boolean =>
  typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

/**
 * Ensure merchant record exists in public.merchants and return it
 */
export async function ensureMerchantRecord(user: SupabaseUser): Promise<MerchantRecord | null> {
  if (!isRealSupabaseConfigured() || !user?.id) return null;

  try {
    const existing = await fetchMerchantProfile(user.id);
    if (existing) return existing;

    const res = await supabaseFetch('/rest/v1/merchants', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: user.id,
        email: user.email,
        business_name: user.user_metadata?.business_name || '',
        vpa: user.user_metadata?.vpa || '',
        spoken_language: user.user_metadata?.spoken_language || 'English',
      }),
    });
    if (res.ok) {
      const rows = await res.json();
      return rows[0] || null;
    }
  } catch (e) {
    console.warn('Failed to ensure merchant record', e);
  }
  return null;
}

/**
 * Fetch payments from public.payment_events for a merchant
 */
export async function fetchCloudPayments(merchantId: string): Promise<CloudPaymentEvent[]> {
  if (!isRealSupabaseConfigured() || !isUUID(merchantId)) return [];

  try {
    const res = await supabaseFetch(
      `/rest/v1/payment_events?merchant_id=eq.${merchantId}&order=created_at.desc&limit=50`,
      { method: 'GET' }
    );
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.warn('Failed to fetch payments from Supabase', e);
  }
  return [];
}

/**
 * Fetch expenses from public.expenses for a merchant
 */
export async function fetchCloudExpenses(merchantId: string): Promise<CloudExpense[]> {
  if (!isRealSupabaseConfigured() || !isUUID(merchantId)) return [];

  try {
    const res = await supabaseFetch(
      `/rest/v1/expenses?merchant_id=eq.${merchantId}&order=created_at.desc&limit=50`,
      { method: 'GET' }
    );
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.warn('Failed to fetch expenses from Supabase', e);
  }
  return [];
}

/**
 * Sync / insert incoming payment from Android Notification Listener into `public.payment_events`
 */
export async function insertPaymentToCloud(payment: {
  merchantId: string;
  amount: number;
  source: string;
  payerName?: string;
  utr?: string;
  state?: 'Played' | 'Pending' | 'Failed';
  rawNotification?: string;
}): Promise<boolean> {
  if (!isRealSupabaseConfigured() || !isUUID(payment.merchantId)) return false;

  try {
    const res = await supabaseFetch('/rest/v1/payment_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        merchant_id: payment.merchantId,
        amount: payment.amount,
        source: payment.source,
        payer_name: payment.payerName,
        utr: payment.utr,
        state: payment.state || 'Played',
        raw_notification: payment.rawNotification,
      }),
    });
    return res.ok;
  } catch (e) {
    console.warn('Failed to sync payment event to Supabase', e);
    return false;
  }
}

/**
 * Sync / insert expense into `public.expenses`
 */
export async function insertExpenseToCloud(expense: {
  merchantId: string;
  title: string;
  amount: number;
  category: string;
  status: 'done' | 'pending';
  paymentMethod: string;
  date: string;
  note?: string;
}): Promise<boolean> {
  if (!isRealSupabaseConfigured() || !isUUID(expense.merchantId)) return false;

  try {
    const res = await supabaseFetch('/rest/v1/expenses', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        merchant_id: expense.merchantId,
        title: expense.title,
        amount: expense.amount,
        category: expense.category,
        status: expense.status,
        payment_method: expense.paymentMethod,
        date: expense.date,
        note: expense.note,
      }),
    });
    return res.ok;
  } catch (e) {
    console.warn('Failed to sync expense to Supabase', e);
    return false;
  }
}

