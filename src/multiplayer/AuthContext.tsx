import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch, User } from './api';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  /** Public Google OAuth client_id, or null if the server hasn't been
   *  configured with GOOGLE_CLIENT_ID. The AuthOverlay reads this to
   *  decide whether to render the Google button. */
  googleClientId: string | null;
  signIn: (email: string, password: string) => Promise<string | null>;
  signUp: (email: string, password: string, displayName?: string) => Promise<string | null>;
  /** Exchange a Google ID token (JWT from GIS) for an Orbital session. */
  signInWithGoogle: (idToken: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Two parallel probes: current session + public auth config.
      // The config call is cheap (no DB) and lets us show or hide the
      // Google button without a follow-up round-trip.
      const [meRes, cfgRes] = await Promise.all([
        apiFetch<{ user: User }>('/api/auth/me'),
        apiFetch<{ google_client_id: string | null }>('/api/auth/config'),
      ]);
      if (cancelled) return;
      if (meRes.ok) setUser(meRes.data.user);
      if (cfgRes.ok) setGoogleClientId(cfgRes.data.google_client_id);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await apiFetch<{ user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) { setUser(res.data.user); return null; }
    return res.error?.message ?? 'Sign in failed';
  }, []);

  const signUp = useCallback(async (email: string, password: string, displayName?: string) => {
    const body: Record<string, unknown> = { email, password };
    if (displayName?.trim()) body.display_name = displayName.trim();
    const res = await apiFetch<{ user: User }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (res.ok) { setUser(res.data.user); return null; }
    return res.error?.message ?? 'Sign up failed';
  }, []);

  const signInWithGoogle = useCallback(async (idToken: string) => {
    const res = await apiFetch<{ user: User }>('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ id_token: idToken }),
    });
    if (res.ok) { setUser(res.data.user); return null; }
    return res.error?.message ?? 'Google sign-in failed';
  }, []);

  const signOut = useCallback(async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, googleClientId, signIn, signUp, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
