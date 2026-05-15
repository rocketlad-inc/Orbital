import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, Faction, Message, MyFaction } from './api';

type Scope = 'dm' | 'group' | 'broadcast';

export function CommsPanel({ gameId }: { gameId: string }) {
  const [factions, setFactions] = useState<Faction[]>([]);
  const [me, setMe] = useState<MyFaction | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [scope, setScope] = useState<Scope>('dm');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [meRes, fRes, mRes] = await Promise.all([
      apiFetch<{ faction: MyFaction }>(`/api/games/${gameId}/me`),
      apiFetch<{ factions: Faction[] }>(`/api/games/${gameId}/factions`),
      apiFetch<{ messages: Message[] }>(`/api/games/${gameId}/messages?limit=80`),
    ]);
    if (meRes.ok) setMe(meRes.data.faction);
    if (fRes.ok) setFactions(fRes.data.factions);
    if (mRes.ok) setMessages(mRes.data.messages);
  }, [gameId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const factionsById = useMemo(() => {
    const m = new Map<string, Faction>();
    for (const f of factions) m.set(f.id, f);
    return m;
  }, [factions]);

  const otherFactions = useMemo(
    () => factions.filter((f) => f.id !== me?.id),
    [factions, me],
  );

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const text = body.trim();
    if (!text) return;
    const payload: any = { scope, body: text };
    if (scope !== 'broadcast') payload.recipient_faction_ids = recipients;
    const res = await apiFetch(`/api/games/${gameId}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!res.ok) { setError(res.error?.message ?? 'Send failed'); return; }
    setBody('');
    refresh();
  }

  function toggleRecipient(fid: string) {
    if (scope === 'dm') {
      setRecipients([fid]);
    } else {
      setRecipients((prev) => prev.includes(fid) ? prev.filter((x) => x !== fid) : [...prev, fid]);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="mp-log">
        {messages.length === 0 && <div className="mp-empty">No messages yet.</div>}
        {messages.map((m) => {
          const sender = factionsById.get(m.claimed_sender_faction_id);
          return (
            <div key={m.id} className="mp-chat-line">
              <span className="who" style={{ color: sender?.color ?? 'var(--mp-accent)' }}>
                {sender?.name ?? 'unknown'}
                {m.scope === 'broadcast' && ' [public]'}
              </span>
              <span>{m.body}</span>
            </div>
          );
        })}
      </div>

      <div className="mp-section-title">Compose</div>
      <form onSubmit={send}>
        <select
          className="mp-select"
          value={scope}
          onChange={(e) => { setScope(e.target.value as Scope); setRecipients([]); }}
          style={{ marginBottom: 6 }}
        >
          <option value="dm">DM (1 recipient)</option>
          <option value="group">Group</option>
          <option value="broadcast">Public broadcast</option>
        </select>

        {scope !== 'broadcast' && (
          <div style={{ marginBottom: 6 }}>
            {otherFactions.map((f) => (
              <label key={f.id} className="mp-presence-row" style={{ cursor: 'pointer' }}>
                <input
                  type={scope === 'dm' ? 'radio' : 'checkbox'}
                  name="recipient"
                  checked={recipients.includes(f.id)}
                  onChange={() => toggleRecipient(f.id)}
                  style={{ marginRight: 4 }}
                />
                <span className="mp-swatch" style={{ background: f.color }} />
                <span>{f.name}</span>
              </label>
            ))}
          </div>
        )}

        <textarea
          className="mp-textarea"
          maxLength={4000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Message…"
        />
        <button className="mp-submit" type="submit" style={{ marginTop: 6 }}>Send</button>
        <div className="mp-error">{error || ''}</div>
      </form>
    </div>
  );
}
