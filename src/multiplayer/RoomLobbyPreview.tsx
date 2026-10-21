// ============================================================================
// RoomLobbyPreview — look at the room lobby without a server.
//
//   /?room-lobby[&as=host|player|incomplete|late][&lang=pt-BR][&tab=room|chat|map][&chat=min][&incoming=1]
//
// DEV ONLY (App.tsx imports it lazily behind a NODE_ENV guard, the same as
// ?ending=). It renders RoomLobbyScreen over a fixture of a real room
// (__fixtures__/roomLobby.ts: real empire names, flags and worlds; neutral
// player names) with in-memory handlers, so every control works: ready,
// kick, flag and world picks, saves, chat. Nothing is sent anywhere; the few
// requests the Discord and captain cards make on their own are answered by a
// small fetch shim installed for the life of the preview.
//
//   as=host          the host, everyone in, one player still setting up (default)
//   as=player        a player who is finished
//   as=incomplete    a player with no empire name and no world yet (gold "Set up")
//   as=late          the late-join world picker
//   tab=chat|map     the phone tabs (below 900px wide)
//   chat=min         the desktop chat dock starts minimised
//   incoming=1       a chat line arrives every few seconds (unread badge)
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import {
  FIXTURE_OPTIONS, FIXTURE_SEATS, FIXTURE_VIEWER_ID, fixtureSnapshot,
} from './__fixtures__/roomLobby';
import type { FixtureSeat, FixtureViewer } from './__fixtures__/roomLobby';
import type { FeedView } from './GameFeedSettings';
import { AuthProvider } from './AuthContext';
import { RoomLateJoin } from './RoomLateJoin';
import { RoomLobbyScreen } from './RoomLobbyScreen';
import type { ChatLine, RoomTab } from './roomLobbyModel';
import type { NamePools } from '../game/namePools';
import { EMPTY_POOLS } from '../game/namePools';
import { isLang, setLang } from '../i18n/core';
import { useI18n } from '../i18n/react';

/** Answer the requests the Discord feed and captain cards make by themselves. */
function installFetchShim(viewer: FixtureViewer): () => void {
  const isHost = viewer === 'host';
  const seat = FIXTURE_SEATS.find((x) => x.userId === FIXTURE_VIEWER_ID[viewer])!;
  const real = window.fetch.bind(window);
  let feed: FeedView = {
    level: 'all', feed_locale: null, thread_url: null, following: true, discord_linked: true,
    forum_configured: true, is_host: isHost, discord_invite: 'https://discord.gg/orbital-preview',
    server: null, host_name: 'Player 1', i_hold_commission: isHost, host_holds_commission: true,
    server_connect_ready: true,
  };
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (/\/api\/games\/[^/]+\/feed(\/follow)?$/.test(url)) {
      if (method !== 'GET') {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if ('level' in body) feed = { ...feed, level: body.level };
        if ('feed_locale' in body) feed = { ...feed, feed_locale: body.feed_locale };
        if ('follow' in body) feed = { ...feed, following: !!body.follow };
      }
      return json(feed);
    }
    if (/\/api\/auth\/me$/.test(url)) {
      return json({ user: { id: seat.userId, email: 'preview@example.invalid', display_name: seat.displayName, is_premium: seat.commissioned } });
    }
    if (/\/api\/auth\/config$/.test(url)) return json({ google_client_id: null });
    if (/\/api\/telemetry/.test(url)) return json({ ok: true });
    if (/\/api\/auth\/me$/.test(url)) {
      return json({ user: { id: seat.userId, email: 'preview@example.invalid', display_name: seat.displayName, is_premium: seat.commissioned } });
    }
    if (/\/api\/auth\/config$/.test(url)) return json({ google_client_id: null });
    if (/\/api\/telemetry/.test(url)) return json({ ok: true });
    if (/\/api\/lobby\/name-pools\/history/.test(url)) return json({ banks: [] });
    if (/\/api\/lobby\/rooms\/[^/]+\/captains/.test(url)) {
      return json({ roster: [], saved: false, count: 0, avatars: [], traits: [], freeTraitChoice: false, dealtTraits: [] });
    }
    return real(input as RequestInfo, init);
  }) as typeof window.fetch;
  return () => { window.fetch = real; };
}

const INCOMING = [
  'Anyone else eyeing Titan?',
  'I will take the inner worlds, try to stop me.',
  'Ready when you are.',
  'Is the clock really one hour a tick?',
];

function Preview() {
  useI18n();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const asParam = params.get('as');
  const late = asParam === 'late';
  const viewer: FixtureViewer = asParam === 'player' || asParam === 'incomplete' ? asParam : 'host';
  const viewerId = FIXTURE_VIEWER_ID[viewer];
  const tabParam = params.get('tab');
  const tab: RoomTab = tabParam === 'chat' || tabParam === 'map' ? tabParam : 'room';

  useEffect(() => {
    const lang = params.get('lang');
    if (isLang(lang)) setLang(lang, false);
  }, [params]);

  // Installed during the first render, not in an effect: a child's effect (the
  // Discord card fetching its state) runs before this component's would.
  const [uninstall] = useState(() => installFetchShim(viewer));
  useEffect(() => uninstall, [uninstall]);

  const [seats, setSeats] = useState<FixtureSeat[]>(FIXTURE_SEATS);
  const [error, setError] = useState<string | null>(null);
  const [empireName, setEmpireName] = useState(() => FIXTURE_SEATS.find((s) => s.userId === viewerId)?.empire ?? '');
  const [bio, setBio] = useState(() => FIXTURE_SEATS.find((s) => s.userId === viewerId)?.bio ?? '');
  const [flash, setFlash] = useState<'empire' | 'settings' | null>(null);
  const [pools, setPools] = useState<NamePools>({ ...EMPTY_POOLS });
  const [rules, setRules] = useState({ name: 'The Zone of the Future', max: 8, interval: 3_600_000 });
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState('');
  const [lateName, setLateName] = useState('');
  const [lateChoice, setLateChoice] = useState<string | null>(null);

  const patchMe = (patch: Partial<FixtureSeat>) =>
    setSeats((all) => all.map((s) => (s.userId === viewerId ? { ...s, ...patch } : s)));
  const me = seats.find((s) => s.userId === viewerId);

  // incoming=1: somebody else keeps talking.
  const incoming = params.has('incoming');
  useEffect(() => {
    if (!incoming) return;
    let i = 0;
    const id = window.setInterval(() => {
      setChat((c) => [...c, {
        key: c.length + 1000, from: { userId: 'fx3', displayName: 'Player 3' }, text: INCOMING[i++ % INCOMING.length], at: Date.now(),
      }]);
    }, 4000);
    return () => window.clearInterval(id);
  }, [incoming]);

  const snap = useMemo(() => {
    const s = fixtureSnapshot(seats.map((x) => ({ ...x })), {
      name: rules.name, max_players: rules.max, tick_interval_ms: rules.interval,
      host_id: 'fx1',
    });
    return s;
  }, [seats, rules]);

  if (late) {
    const taken = new Set(seats.map((s) => s.world));
    return (
      <RoomLateJoin
        roomName={snap.settings.name}
        bodies={FIXTURE_OPTIONS.filter((o) => !taken.has(o.id)).map((o) => ({ id: o.id, name: o.name, type: o.type, yield: o.yield }))}
        empireName={lateName} onEmpireName={setLateName}
        choice={lateChoice} onChoice={setLateChoice}
        submitting={false} onSubmit={() => setError('Preview: nothing is sent.')}
        onBack={() => setError('Preview: Back would leave the room.')}
        error={error} onDismissError={() => setError(null)}
      />
    );
  }

  const say = (msg: string) => setError(`Preview: ${msg}`);
  return (
    <RoomLobbyScreen
      roomId="fxRoom000001"
      snap={snap}
      viewerId={viewerId}
      isHost={viewer === 'host'}
      started={false}
      myReady={!!me?.ready}
      error={error}
      onDismissError={() => setError(null)}
      onBack={() => say('Back would return to My games.')}
      onLeaveLobby={() => { if (window.confirm('Leave this lobby?')) say('you would leave the lobby.'); }}
      onDeleteRoom={() => { if (window.confirm('Delete this room for everyone?')) say('the room would be deleted.'); }}
      onStart={() => say('the match would start now.')}
      onToggleReady={() => patchMe({ ready: !me?.ready })}
      onKick={(uid, name) => {
        if (window.confirm(`Kick ${name}?`)) setSeats((all) => all.filter((s) => s.userId !== uid));
      }}
      onSeatsOpened={() => undefined}
      empire={{
        myChoice: me?.world ?? null,
        empireName, onEmpireName: setEmpireName,
        bio, onBio: setBio,
        onSaveEmpire: () => { patchMe({ empire: empireName.trim() || null, bio: bio.trim() || null }); setFlash('empire'); window.setTimeout(() => setFlash(null), 1800); },
        saved: flash === 'empire',
        onPickFlag: (field, value) => {
          if (field === 'color' || field === 'color2' || field === 'emblem') {
            if (field === 'color' && value && seats.some((s) => s.userId !== viewerId && s.color === value)) { setError('Another player already flies that color'); return; }
            if (field === 'emblem' && value && seats.some((s) => s.userId !== viewerId && s.emblem === value)) { setError('Another player already flies that emblem'); return; }
            patchMe({ [field]: value } as Partial<FixtureSeat>);
          }
        },
        onPickBody: (id) => {
          if (id && seats.some((s) => s.userId !== viewerId && s.world === id)) return;
          patchMe({ world: id });
        },
        namePools: pools, onSaveNamePools: async (next) => setPools(next),
        pastBanks: [],
      }}
      rules={{
        draft: rules,
        onDraft: setRules,
        onSave: () => { setFlash('settings'); window.setTimeout(() => setFlash(null), 1800); },
        saved: flash === 'settings',
      }}
      chat={{
        log: chat, draft, onDraft: setDraft,
        onSend: (e) => {
          e.preventDefault();
          const text = draft.trim();
          if (!text) return;
          setChat((c) => [...c, { key: c.length + 1, from: { userId: viewerId, displayName: me?.displayName ?? 'You' }, text, at: Date.now() }]);
          setDraft('');
        },
      }}
      initial={{ tab, chatMin: params.get('chat') === 'min' ? true : undefined }}
    />
  );
}

/** The app mounts previews above its AuthProvider; the lobby's cards read the user. */
export function RoomLobbyPreview() {
  return <AuthProvider><Preview /></AuthProvider>;
}

export default RoomLobbyPreview;
