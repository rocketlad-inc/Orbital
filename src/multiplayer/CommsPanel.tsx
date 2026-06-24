import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, Faction, Message, MyFaction } from './api';

// ============================================================
// CommsPanel — per-recipient channels + mark-on-view.
//
// Two playtester complaints drove the v2 layout:
//
//   1. "Notification ping for comms doesn't go away when I open the
//      tab." Root cause: the old panel never POSTed to the per-
//      message /read endpoint. MultiplayerShell did an optimistic
//      setUnreadMessages(0) on tab change, but the next /unread-count
//      poll (every 10s) restored the stale server value. Fix: when
//      a channel is in view, call .../messages/:id/read for every
//      unread message in that channel and notify the parent shell.
//
//   2. "DMs and public messages are both in the same thread rather
//      than having separate channels." Fix: add a channel rail
//      (PUBLIC + one DM per other faction). Selecting a channel
//      filters the log AND auto-targets the compose form, so a
//      reply lands in the right place without re-selecting
//      recipients.
//
// Group messages (scope=group) are still supported on the server.
// They show up in every recipient's DM thread with a "[group]" tag.
// ============================================================

type ChannelId = 'public' | { kind: 'dm'; factionId: string };

function channelKey(ch: ChannelId): string {
  return typeof ch === 'string' ? ch : `dm:${ch.factionId}`;
}

interface Props {
  gameId: string;
  /** Lets the shell badge react instantly when we mark messages
   *  read, instead of waiting for the next /unread-count poll. */
  onUnreadDelta?: (delta: number) => void;
}

export function CommsPanel({ gameId, onUnreadDelta }: Props) {
  const [factions, setFactions] = useState<Faction[]>([]);
  const [me, setMe] = useState<MyFaction | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [channel, setChannel] = useState<ChannelId>('public');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Tracks messageIds we've already fired the /read POST for this
  // session so we don't spam the server every poll cycle.
  const markedReadRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const [meRes, fRes, mRes] = await Promise.all([
      apiFetch<{ faction: MyFaction }>(`/api/games/${gameId}/me`),
      apiFetch<{ factions: Faction[] }>(`/api/games/${gameId}/factions`),
      apiFetch<{ messages: Message[] }>(`/api/games/${gameId}/messages?limit=200`),
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

  /**
   * Bucket every message into one or more channels:
   *   - scope=broadcast  -> 'public'
   *   - scope=dm/group   -> a DM thread for EACH non-me participant
   *     (sender + recipients - me). A group msg to A+B+C shows up in
   *     A's, B's, AND C's DM threads with a [group] tag at render time.
   */
  const messagesByChannel = useMemo(() => {
    const map = new Map<string, Message[]>();
    const push = (key: string, m: Message) => {
      let arr = map.get(key);
      if (!arr) { arr = []; map.set(key, arr); }
      arr.push(m);
    };
    for (const m of messages) {
      if (m.scope === 'broadcast') { push('public', m); continue; }
      const participants = new Set<string>();
      participants.add(m.claimed_sender_faction_id);
      for (const r of m.recipient_faction_ids ?? []) participants.add(r);
      if (me) participants.delete(me.id);
      for (const fid of participants) push(`dm:${fid}`, m);
    }
    return map;
  }, [messages, me]);

  const unreadByChannel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [k, arr] of messagesByChannel) {
      let c = 0;
      for (const m of arr) {
        if (m.claimed_sender_faction_id === me?.id) continue; // own messages don't count
        if (m.read_by_caller === false) c++;
      }
      counts.set(k, c);
    }
    return counts;
  }, [messagesByChannel, me]);

  const visibleMessages = useMemo(() => {
    return messagesByChannel.get(channelKey(channel)) ?? [];
  }, [messagesByChannel, channel]);

  // Mark visible unread messages as read on the server. Fires once
  // per message per session (markedReadRef gate). Reports the delta
  // to the parent shell so the topbar badge reflects the change
  // instantly instead of waiting up to 10s for the next poll.
  useEffect(() => {
    if (!me) return;
    const toMark: string[] = [];
    for (const m of visibleMessages) {
      if (m.read_by_caller !== false) continue;
      if (m.claimed_sender_faction_id === me.id) continue;
      if (markedReadRef.current.has(m.id)) continue;
      markedReadRef.current.add(m.id);
      toMark.push(m.id);
    }
    if (toMark.length === 0) return;
    onUnreadDelta?.(-toMark.length);
    for (const id of toMark) {
      apiFetch(`/api/games/${gameId}/messages/${id}/read`, { method: 'POST' })
        .catch(() => { markedReadRef.current.delete(id); });
    }
  }, [visibleMessages, me, gameId, onUnreadDelta]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const text = body.trim();
    if (!text) return;
    const payload: { scope: 'dm' | 'broadcast'; body: string; recipient_faction_ids?: string[] } =
      typeof channel === 'string'
        ? { scope: 'broadcast', body: text }
        : { scope: 'dm', body: text, recipient_faction_ids: [channel.factionId] };
    const res = await apiFetch(`/api/games/${gameId}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!res.ok) { setError(res.error?.message ?? 'Send failed'); return; }
    setBody('');
    refresh();
  }

  const channelLabel = (ch: ChannelId): string => {
    if (typeof ch === 'string') return 'PUBLIC';
    const f = factionsById.get(ch.factionId);
    return f?.name ?? '???';
  };

  const channelColor = (ch: ChannelId): string => {
    if (typeof ch === 'string') return 'var(--mp-accent)';
    return factionsById.get(ch.factionId)?.color ?? 'var(--mp-accent)';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Channel rail */}
      <div className="mp-channel-rail">
        <ChannelTab
          active={channel === 'public'}
          label="PUBLIC"
          color="var(--mp-accent)"
          unread={unreadByChannel.get('public') ?? 0}
          onClick={() => setChannel('public')}
        />
        {otherFactions.map((f) => {
          const key = `dm:${f.id}`;
          const isActive = typeof channel !== 'string' && channel.factionId === f.id;
          return (
            <ChannelTab
              key={f.id}
              active={isActive}
              label={f.name}
              color={f.color}
              unread={unreadByChannel.get(key) ?? 0}
              onClick={() => setChannel({ kind: 'dm', factionId: f.id })}
            />
          );
        })}
      </div>

      <div className="mp-log">
        {visibleMessages.length === 0 && (
          <div className="mp-empty">
            {typeof channel === 'string'
              ? 'No public messages yet.'
              : `No messages with ${channelLabel(channel)} yet.`}
          </div>
        )}
        {visibleMessages.map((m) => {
          const sender = factionsById.get(m.claimed_sender_faction_id);
          const isGroup = m.scope === 'group';
          const isMine = m.claimed_sender_faction_id === me?.id;
          return (
            <div key={m.id} className="mp-chat-line">
              <span className="who" style={{ color: sender?.color ?? 'var(--mp-accent)' }}>
                {isMine ? 'You' : sender?.name ?? 'unknown'}
                {isGroup && ' [group]'}
              </span>
              <span>{m.body}</span>
            </div>
          );
        })}
      </div>

      <div className="mp-section-title" style={{ borderTop: '1px solid var(--mp-border)', paddingTop: 8, marginTop: 4 }}>
        {typeof channel === 'string' ? 'Compose public message' : `Reply to ${channelLabel(channel)}`}
      </div>
      <form onSubmit={send}>
        <textarea
          className="mp-textarea"
          maxLength={4000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={
            typeof channel === 'string'
              ? 'Message to all players…'
              : `Private message to ${channelLabel(channel)}…`
          }
        />
        <button
          className="mp-submit"
          type="submit"
          style={{ marginTop: 6, borderColor: channelColor(channel) }}
        >
          {typeof channel === 'string' ? 'Send to PUBLIC' : `Send DM to ${channelLabel(channel)}`}
        </button>
        <div className="mp-error">{error || ''}</div>
      </form>
    </div>
  );
}

interface ChannelTabProps {
  active: boolean;
  label: string;
  color: string;
  unread: number;
  onClick: () => void;
}

const ChannelTab: React.FC<ChannelTabProps> = ({ active, label, color, unread, onClick }) => (
  <button
    type="button"
    className={`mp-channel-tab ${active ? 'is-active' : ''}`}
    onClick={onClick}
    style={active ? { borderColor: color, color } : undefined}
  >
    <span className="mp-channel-tab__swatch" style={{ background: color }} />
    <span className="mp-channel-tab__label">{label}</span>
    {unread > 0 && <span className="mp-channel-tab__badge">{unread}</span>}
  </button>
);
