// ============================================================
// RecapOverlay — "while you were away", played back like a killcam.
//
// Sean (playtest): "I'm apparently losing planets so quickly I don't
// even notice it happen??? I would still love if the game itself could
// do some kind of playback recap of everything I missed like in
// Warzone."
//
// On load, if MORE THAN 5 major chronicle events landed since the last
// visit, offer a recap. Playback letterboxes the map, flies the camera
// to each scene (focusBody — the pending-FX queue then detonates the
// waiting effects on its own the moment the scene is framed), and
// captions it with the entry's flavor line. Auto-advances; click steps;
// ESC / ✕ / SKIP dismiss instantly — dismissal is always one action.
//
// "Since last visit" mirrors EventLog's watermark idiom: a per-game
// localStorage count high-water over the combatLog array. The watermark
// advances the moment we EVALUATE (not when the recap ends), so a
// dismissed prompt never re-offers the same history, and sub-threshold
// trickles don't accumulate into a stale mega-recap next week.
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { enqueueDetonation, spawnDiscoveryBloom } from '../render/combatFx';

// GameState carries no machine-kind array (only focus/flavor are
// parallel-indexed), so majors are classified from the headline text —
// the exact idiom EventLog's icon classifier already uses.
const MAJOR_RE = /destroyed|fell|impact|DISCOVERY|victor|wins the|detonat|assumed command|leaderless/i;
const THRESHOLD = 5;       // strictly more than this many majors → offer
const SCENE_CAP = 8;       // a long absence is a highlight reel, not a slog
const SCENE_MS = 3200;

const KEY = () => `recap:lastSeenCount:${typeof window !== 'undefined' ? window.location.pathname : 'default'}`;

interface Scene { bodyId?: string; shipId?: string; fx?: 'boom' | 'bloom'; lines: string[] }

/** Camera target for a chronicle entry. Ship-loss rows carry a SHIP
 *  focus whose hull is usually already gone — resolve to its parent
 *  body when it survives, else fall back to scanning the headline for a
 *  body NAME ("Debris spreading over Mars" -> Mars). Without this the
 *  recap captioned Mars while the camera sat wherever it already was
 *  (playtest screenshot). Longest name wins so 'New Lorneland' beats
 *  'Lorneland'. */
function resolveSceneBody(
  line: string,
  f: { kind: 'body'; bodyId: string } | { kind: 'ship'; shipId: string } | null | undefined,
  ships: { id: string; orbit?: { parentBodyId?: string } }[],
  bodies: { id: string; name: string }[],
): string | undefined {
  if (f?.kind === 'body') return f.bodyId;
  if (f?.kind === 'ship') {
    const sh = ships.find(x => x.id === f.shipId);
    if (sh?.orbit?.parentBodyId) return sh.orbit.parentBodyId;
  }
  let best: { id: string; len: number } | null = null;
  for (const b of bodies) {
    if (b.name && line.includes(b.name) && (!best || b.name.length > best.len)) {
      best = { id: b.id, len: b.name.length };
    }
  }
  return best?.id;
}

/** Which effect sells this line: destruction reads as a blast,
 *  discoveries as the purple bloom. */
function fxFor(line: string): 'boom' | 'bloom' | undefined {
  if (/DISCOVERY|databank|stargate|warp gate/i.test(line)) return 'bloom';
  if (/destroyed|fell|impact|detonat|stops transmitting|debris/i.test(line)) return 'boom';
  return undefined;
}

export const RecapOverlay: React.FC = () => {
  const { gameState, focusBody, selectBody } = useGameContext();
  const [scenes, setScenes] = useState<Scene[] | null>(null);  // null = no offer
  const [playing, setPlaying] = useState(false);
  const [idx, setIdx] = useState(0);
  const evaluatedRef = useRef(false);

  // Evaluate ONCE per mount, and only after the first non-empty log
  // (the provider hydrates combatLog on the first /state poll).
  useEffect(() => {
    if (evaluatedRef.current) return;
    const log = gameState.combatLog ?? [];
    if (log.length === 0) return;
    evaluatedRef.current = true;

    let stored = 0;
    try { stored = parseInt(localStorage.getItem(KEY()) ?? '0', 10) || 0; } catch { /* fine */ }
    // Advance immediately — see header. A rolling window can shrink the
    // array, so clamp instead of trusting subtraction.
    try { localStorage.setItem(KEY(), String(log.length)); } catch { /* fine */ }
    const fresh = Math.max(0, Math.min(log.length, log.length - stored));
    if (fresh === 0) return;

    const focus = gameState.chronicleFocus ?? [];
    const flavor = gameState.chronicleFlavor ?? [];
    const majors: { i: number; bodyId?: string; shipId?: string }[] = [];
    for (let i = log.length - fresh; i < log.length; i++) {
      if (MAJOR_RE.test(log[i] ?? '')) {
        majors.push({
          i,
          bodyId: resolveSceneBody(log[i] ?? '', focus[i], gameState.ships, gameState.bodies),
        });
      }
    }
    if (majors.length <= THRESHOLD) return;

    // Cluster consecutive majors at the same body into one scene — a
    // battle is thirty rows and ONE place; the captions stack.
    const built: Scene[] = [];
    for (const m of majors) {
      const line = flavor[m.i] || log[m.i];
      const last = built[built.length - 1];
      if (last && last.bodyId && last.bodyId === m.bodyId) {
        if (last.lines.length < 3) last.lines.push(line);
      } else {
        built.push({ bodyId: m.bodyId, fx: fxFor(log[m.i] ?? ''), lines: [line] });
      }
    }
    setScenes(built.slice(-SCENE_CAP));
  }, [gameState.combatLog, gameState.chronicleFocus, gameState.chronicleFlavor, gameState.ships, gameState.bodies]);

  const scene = playing && scenes ? scenes[idx] : null;

  // Fly the camera on scene change; pendingFx plays the queued effects
  // once the body is framed — the recap is a guided tour of that queue.
  useEffect(() => {
    if (!scene) return;
    if (scene.bodyId) { selectBody(scene.bodyId); focusBody(scene.bodyId); }
    // The pending-FX queue plays each real event exactly once ever, so a
    // REPLAY spawns its own effect: blast or bloom at the scene body,
    // delayed so the camera tween lands first. Unique id per showing —
    // combatFx dedups by id.
    let fxT: ReturnType<typeof setTimeout> | null = null;
    if (scene.bodyId && scene.fx) {
      const bid = scene.bodyId;
      const kind = scene.fx;
      fxT = setTimeout(() => {
        if (kind === 'bloom') spawnDiscoveryBloom(`recap_${Date.now()}_${bid}`, bid);
        else enqueueDetonation(`recap_${Date.now()}_${bid}`, bid, null);
      }, 700);
    }
    const t = setTimeout(() => {
      setIdx(i => {
        if (!scenes || i + 1 >= scenes.length) { setPlaying(false); setScenes(null); return i; }
        return i + 1;
      });
    }, SCENE_MS);
    return () => { clearTimeout(t); if (fxT) clearTimeout(fxT); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  // Manual replay — the EventLog's "▶ RECAP" button dispatches this
  // (established CustomEvent idiom, same as orbital:open-panel). Builds
  // scenes from the last N ticks by parsing the T+<tick> prefix the
  // provider stamps on every headline; majors preferred, falling back
  // to every event in the window so the button always shows something
  // when anything happened at all. Bypasses the offer card and the
  // watermark — an explicit request plays immediately and doesn't
  // consume the login-recap state.
  useEffect(() => {
    const onPlay = (e: Event) => {
      const ticks = (e as CustomEvent).detail?.ticks ?? 12;
      const log = gameState.combatLog ?? [];
      const focus = gameState.chronicleFocus ?? [];
      const flavor = gameState.chronicleFlavor ?? [];
      const cutoff = (gameState.currentTick ?? 0) - ticks;
      const inWindow: number[] = [];
      for (let i = 0; i < log.length; i++) {
        const m = /^T\+(\d+)/.exec(log[i] ?? '');
        if (m && Number(m[1]) >= cutoff) inWindow.push(i);
      }
      let picks = inWindow.filter(i => MAJOR_RE.test(log[i] ?? ''));
      if (picks.length === 0) picks = inWindow;
      if (picks.length === 0) return;
      const built: Scene[] = [];
      for (const i of picks) {
        const bodyId = resolveSceneBody(log[i] ?? '', focus[i], gameState.ships, gameState.bodies);
        const line = flavor[i] || log[i];
        const last = built[built.length - 1];
        if (last && last.bodyId && last.bodyId === bodyId) {
          if (last.lines.length < 3) last.lines.push(line);
        } else {
          built.push({ bodyId, fx: fxFor(log[i] ?? ''), lines: [line] });
        }
      }
      setScenes(built.slice(-SCENE_CAP));
      setIdx(0);
      setPlaying(true);
    };
    window.addEventListener('orbital:play-recap', onPlay as EventListener);
    return () => window.removeEventListener('orbital:play-recap', onPlay as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState.combatLog, gameState.chronicleFocus, gameState.chronicleFlavor, gameState.currentTick, gameState.ships, gameState.bodies]);

  // ESC dismisses at any stage.
  useEffect(() => {
    if (!scenes) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setPlaying(false); setScenes(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scenes]);

  if (!scenes) return null;

  const dismiss = () => { setPlaying(false); setScenes(null); };
  const mono: React.CSSProperties = { fontFamily: 'Orbitron, system-ui, sans-serif', letterSpacing: '0.14em' };

  if (!playing) {
    // The offer — one small card, two exits, zero blocking of the map.
    return (
      <div style={{ position: 'fixed', top: 64, left: '50%', transform: 'translateX(-50%)', zIndex: 60,
                    background: 'rgba(10,16,24,0.96)', border: '1px solid #4ecdc4', borderRadius: 8,
                    padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14,
                    boxShadow: '0 8px 30px rgba(0,0,0,0.5)' }}>
        <span style={{ ...mono, fontSize: 11, color: '#8a9fb3' }}>WHILE YOU WERE AWAY</span>
        <button onClick={() => { setIdx(0); setPlaying(true); }}
                style={{ ...mono, fontSize: 12, color: '#0a1018', background: '#4ecdc4', border: 'none',
                         borderRadius: 4, padding: '7px 14px', cursor: 'pointer', fontWeight: 700 }}>
          ▶ WATCH RECAP · {scenes.length}
        </button>
        <button onClick={dismiss} title="Dismiss (Esc)"
                style={{ ...mono, fontSize: 11, color: '#8a9fb3', background: 'transparent',
                         border: '1px solid #24344a', borderRadius: 4, padding: '6px 10px', cursor: 'pointer' }}>
          SKIP
        </button>
      </div>
    );
  }

  return (
    <div onClick={() => setIdx(i => (scenes && i + 1 < scenes.length ? i + 1 : (dismiss(), i)))}
         style={{ position: 'fixed', inset: 0, zIndex: 60, cursor: 'pointer' }}>
      {/* Letterbox bars — the map stays live between them. */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 64, background: 'rgba(0,0,0,0.88)' }} />
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 110, background: 'rgba(0,0,0,0.88)',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
        {scene?.lines.map((l, i) => (
          <div key={i} style={{ ...mono, fontSize: i === 0 ? 14 : 11, color: i === 0 ? '#e8eef5' : '#8a9fb3',
                                maxWidth: '72ch', textAlign: 'center', padding: '0 16px' }}>{l}</div>
        ))}
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          {scenes.map((_, i) => (
            <span key={i} style={{ width: 6, height: 6, borderRadius: 3,
                                   background: i === idx ? '#4ecdc4' : '#2a3d50' }} />
          ))}
        </div>
      </div>
      <button onClick={(e) => { e.stopPropagation(); dismiss(); }} title="Dismiss (Esc)"
              style={{ ...mono, position: 'absolute', top: 18, right: 18, fontSize: 12, color: '#8a9fb3',
                       background: 'transparent', border: '1px solid #24344a', borderRadius: 4,
                       padding: '6px 12px', cursor: 'pointer', zIndex: 61 }}>
        ✕ SKIP
      </button>
    </div>
  );
};
