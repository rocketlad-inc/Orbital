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

/** Consecutive messages from one sender on one day collapse under a
 *  single header, and each day gets a divider. Without this a thread
 *  where somebody sent ":P" three times renders three name+timestamp
 *  headers for three characters of content. */
interface MsgGroup<T> { dayKey: string; dayLabel: string; senderId: string; items: T[] }

function groupMessages<T extends { claimed_sender_faction_id: string; sent_at_ms: number }>(
  msgs: T[],
): MsgGroup<T>[] {
  const out: MsgGroup<T>[] = [];
  for (const m of msgs) {
    const d = new Date(m.sent_at_ms);
    const dayKey = d.toDateString();
    const last = out[out.length - 1];
    if (last && last.dayKey === dayKey && last.senderId === m.claimed_sender_faction_id) {
      last.items.push(m);
      continue;
    }
    out.push({
      dayKey,
      dayLabel: d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
      senderId: m.claimed_sender_faction_id,
      items: [m],
    });
  }
  return out;
}

function channelKey(ch: ChannelId): string {
  return typeof ch === 'string' ? ch : `dm:${ch.factionId}`;
}

/** Chat-style relative timestamp. Today: HH:MM. Yesterday: "Yest HH:MM".
 *  This week: short weekday + HH:MM. Older: M/D HH:MM. Locale-aware
 *  via toLocaleTimeString — uses the user's 12/24h preference. Full
 *  timestamp is on the title attr for the rare time someone hovers. */
function formatChatTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `Yest ${time}`;
  const ageDays = (now.getTime() - d.getTime()) / 86_400_000;
  if (ageDays < 7) {
    const wd = d.toLocaleDateString([], { weekday: 'short' });
    return `${wd} ${time}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

interface Props {
  gameId: string;
  /** Lets the shell badge react instantly when we mark messages
   *  read, instead of waiting for the next /unread-count poll. */
  onUnreadDelta?: (delta: number) => void;
  /** Another tab asked us to open a specific DM — the Senate's blocking-
   *  coalition builder does this, so "who to call" and "calling them"
   *  are one click apart. The nonce makes a repeat request for the same
   *  faction re-focus instead of being swallowed as an unchanged prop. */
  focusFaction?: { id: string; nonce: number } | null;
}

export function CommsPanel({ gameId, onUnreadDelta, focusFaction }: Props) {
  const [factions, setFactions] = useState<Faction[]>([]);
  const [me, setMe] = useState<MyFaction | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [channel, setChannel] = useState<ChannelId>('public');
  // Honour a focus request from another tab. Depends on the nonce, not
  // the object, so a second request for the same faction still fires.
  useEffect(() => {
    if (focusFaction) setChannel({ kind: 'dm', factionId: focusFaction.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFaction?.nonce, focusFaction?.id]);
  /** Chat reads downward, so the useful end is the BOTTOM. Jump there
   *  whenever the channel changes or new messages land. */
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const [body, setBody] = useState('');
  /** One draft per channel. Half-write a DM, click over to PUBLIC to
   *  check something, and a shared compose box silently re-aims your
   *  half-written private message at everyone. */
  const draftsRef = useRef<Map<string, string>>(new Map());
  const prevChannelRef = useRef<string>(channelKey('public'));
  useEffect(() => {
    const nowKey = channelKey(channel);
    const prevKey = prevChannelRef.current;
    if (nowKey !== prevKey) {
      // setBody below is intentionally NOT in this effect's deps: we
      // want the body as of the moment of switching, held in the ref
      // pattern via the functional update.
      setBody((current) => {
        draftsRef.current.set(prevKey, current);
        return draftsRef.current.get(nowKey) ?? '';
      });
      prevChannelRef.current = nowKey;
    }
  }, [channel]);
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
    // OLDEST FIRST. The server returns newest-first (it pages from the
    // top), which is backwards for a chat log — every messaging app on
    // earth reads down to the newest and pins the scroll to the bottom.
    // Sorting here rather than trusting the endpoint keeps the panel
    // correct whichever order the API returns.
    const list = messagesByChannel.get(channelKey(channel)) ?? [];
    return [...list].sort((a, b) => a.sent_at_ms - b.sent_at_ms);
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
    draftsRef.current.delete(channelKey(channel));
    setBody('');
    refresh();
  }

  React.useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [channel, visibleMessages.length]);

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
      {/* Channel rail: one scrolling line with a fade at the right edge,
          per the mockup — seven wrapped pills ate a third of the panel
          before the first message. */}
      <div className="mp-chanwrap">
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
      </div>

      <div className="mp-log" ref={logRef}>
        {visibleMessages.length === 0 && (
          <div className="mp-empty">
            {typeof channel === 'string'
              ? 'No public messages yet.'
              : `No messages with ${channelLabel(channel)} yet.`}
          </div>
        )}
        {groupMessages(visibleMessages).map((g, gi, all) => {
          const sender = factionsById.get(g.senderId);
          const isMine = g.senderId === me?.id;
          const first = g.items[0];
          const showDay = gi === 0 || all[gi - 1].dayKey !== g.dayKey;
          return (
            <React.Fragment key={`${g.dayKey}:${g.senderId}:${first.id}`}>
              {showDay && <div className="mp-daysep">{g.dayLabel}</div>}
              <div className={`mp-msggrp${isMine ? ' is-mine' : ''}`}>
                <div className="mp-msggrp__h">
                  <span className="mp-msggrp__who" style={{ color: sender?.color ?? 'var(--mp-accent)' }}>
                    {isMine ? 'You' : sender?.name ?? 'unknown'}
                  </span>
                  <span
                    className="mp-msggrp__t"
                    title={new Date(first.sent_at_ms).toLocaleString()}
                  >
                    {formatChatTime(first.sent_at_ms)}
                  </span>
                </div>
                {g.items.map((m) => {
                  // Group messages can reach beyond this thread; name the
                  // extra recipients so "[group]" isn't a dead end.
                  let groupNote: string | null = null;
                  if (m.scope === 'group' && m.recipient_faction_ids) {
                    const others = m.recipient_faction_ids
                      .filter((fid) => fid !== me?.id)
                      .filter((fid) => typeof channel === 'string' || fid !== channel.factionId)
                      .map((fid) => factionsById.get(fid)?.name ?? '???');
                    if (others.length > 0) groupNote = `also to: ${others.join(', ')}`;
                  }
                  return (
                    <div key={m.id} className="mp-bubble">
                      {m.body}
                      {groupNote && (
                        <span
                          className="mp-bubble__grp"
                          title="Group message — went to more than just this thread."
                        >
                          {groupNote}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      <form onSubmit={send} className="mp-compose">
        {/* The label names the room; the button just sends. "Send to
            PUBLIC" repeated the label in shouting case on every channel. */}
        <label className="mp-compose__lbl" htmlFor="mp-compose-input">
          {typeof channel === 'string'
            ? 'Public channel'
            : <>Private · <span style={{ color: channelColor(channel) }}>{channelLabel(channel)}</span></>}
        </label>
        <textarea
          id="mp-compose-input"
          className="mp-textarea"
          maxLength={4000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          // Enter sends, Shift+Enter breaks the line — the convention
          // every chat client shares. Without it the only way to send is
          // to leave the keyboard for the button, which is why threads
          // here read like telegrams.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(e);
            }
          }}
          placeholder={
            typeof channel === 'string'
              ? 'Message to all players…'
              : `Private message to ${channelLabel(channel)}…`
          }
        />
        <div className="mp-crow">
          <button
            className="mp-submit"
            type="submit"
            style={{ borderColor: channelColor(channel), flex: '0 0 auto', width: 'auto', padding: '6px 22px' }}
          >
            Send
          </button>
          <span className="mp-crow__hint">⏎ send · ⇧⏎ newline</span>
        </div>
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
    // Active is ALWAYS amber (mockup): state lives on the pill, identity
    // stays on the swatch dot. Tinting the pill per faction made the
    // active state invisible for factions whose colour sits near the
    // border grey.
    aria-pressed={active}
  >
    <span className="mp-channel-tab__swatch" style={{ background: color }} />
    <span className="mp-channel-tab__label">{label}</span>
    {/* A dot, not a number. The rail answers "is there anything new
        HERE" — the count lives on the shell's COMMS tab badge. */}
    {unread > 0 && (
      <span
        className="mp-channel-tab__dot"
        role="img"
        aria-label={`${unread} unread`}
        title={`${unread} unread`}
      />
    )}
  </button>
);
