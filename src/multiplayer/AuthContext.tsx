import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch, User } from './api';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<string | null>;
  signUp: (email: string, password: string, displayName?: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await apiFetch<{ user: User }>('/api/auth/me');
      if (cancelled) return;
      if (res.ok) setUser(res.data.user);
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

  const signOut = useCallback(async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
