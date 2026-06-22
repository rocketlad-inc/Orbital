// ============================================================
// GoogleSignInButton — wraps Google Identity Services (GIS).
//
// GIS is Google's "new" Sign In SDK — a small script we load lazily
// from accounts.google.com/gsi/client. It exposes window.google.accounts.id
// which we use to:
//   1) initialize() with our client_id + a callback
//   2) renderButton(<div>, {...style}) to draw the official button
//
// The callback receives a JWT (Google's ID token) which we hand to the
// AuthContext's signInWithGoogle(). The token is verified server-side.
//
// We keep this isolated from AuthContext so it stays opt-in: if the
// server doesn't advertise a Google client_id, we never load the script
// and never touch window.google.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';

const GSI_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

// Promise reused across mounts so we don't load the script twice.
let scriptPromise: Promise<void> | null = null;

function loadGsi(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    // Already on the page (e.g. from a prior session in dev fast-refresh)?
    if (document.querySelector(`script[src="${GSI_SCRIPT_URL}"]`)) {
      // Wait until window.google is populated.
      const start = Date.now();
      (function poll() {
        if ((window as any).google?.accounts?.id) return resolve();
        if (Date.now() - start > 5000) return reject(new Error('GSI script present but window.google never appeared'));
        setTimeout(poll, 50);
      })();
      return;
    }
    const s = document.createElement('script');
    s.src = GSI_SCRIPT_URL;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

interface Props {
  clientId: string;
  onCredential: (idToken: string) => void;
  /** Surface load / render errors to the parent. Optional. */
  onError?: (msg: string) => void;
  /** Width passed to GIS — defaults to "100%" via a container measurement.
   *  GIS only accepts pixel widths so we measure the host element on mount. */
  disabled?: boolean;
}

export const GoogleSignInButton: React.FC<Props> = ({
  clientId, onCredential, onError, disabled,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadGsi();
      } catch (e) {
        if (!cancelled) onError?.(e instanceof Error ? e.message : 'GSI load failed');
        return;
      }
      if (cancelled || !hostRef.current) return;
      const goog = (window as any).google?.accounts?.id;
      if (!goog) {
        onError?.('Google library missing after load');
        return;
      }
      try {
        goog.initialize({
          client_id: clientId,
          // We use our own backend exchange, so just accept the JWT here.
          callback: (resp: { credential?: string }) => {
            if (resp.credential) onCredential(resp.credential);
          },
          // Don't auto-prompt on load — render the explicit button so the
          // user always sees the consent step before any account is shared.
          auto_select: false,
        });
        // Width is required by GIS, in pixels. Measure the host element so
        // the button fills its column.
        const width = Math.max(220, Math.min(400, hostRef.current.clientWidth || 280));
        goog.renderButton(hostRef.current, {
          type: 'standard',
          theme: 'filled_black',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'left',
          width,
        });
        setReady(true);
      } catch (e) {
        onError?.(e instanceof Error ? e.message : 'Google button render failed');
      }
    })();
    return () => { cancelled = true; };
  }, [clientId, onCredential, onError]);

  return (
    <div
      ref={hostRef}
      className="mp-google-host"
      style={{
        // Until the GSI iframe is up, hold space so the layout doesn't pop.
        minHeight: 40,
        // Disable interaction while a sign-in is in flight.
        opacity: disabled ? 0.5 : 1,
        pointerEvents: disabled ? 'none' : 'auto',
      }}
      aria-busy={!ready}
    />
  );
};
