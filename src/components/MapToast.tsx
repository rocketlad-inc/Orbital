// ============================================================
// MapToast — shows 'orbital:toast' messages.
//
// THE EVENT HAD NO LISTENER. MapCanvas has dispatched 'orbital:toast'
// for a rejected megastructure placement since placement shipped, and
// nothing anywhere listened: the server named the rule that was broken
// and the player saw nothing at all. Touch controls need the same
// channel for the few things a gesture has to explain ("tap Mars again
// to add this leg"), so it gets a listener.
//
// One message at a time, newest wins; errors linger a little longer.
// ============================================================

import React, { useEffect, useState } from 'react';
import './MapToast.css';

type Kind = 'info' | 'error';

export const MapToast: React.FC = () => {
  const [toast, setToast] = useState<{ kind: Kind; text: string; id: number } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onToast = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      const text = typeof d.text === 'string' ? d.text : '';
      if (!text) return;
      const kind: Kind = d.kind === 'error' ? 'error' : 'info';
      setToast({ kind, text, id: Date.now() });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setToast(null), kind === 'error' ? 5000 : 3000);
    };
    window.addEventListener('orbital:toast', onToast as EventListener);
    return () => {
      window.removeEventListener('orbital:toast', onToast as EventListener);
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!toast) return null;
  return (
    <div
      key={toast.id}
      className={`map-toast map-toast--${toast.kind}`}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      onClick={() => setToast(null)}
    >
      {toast.text}
    </div>
  );
};
