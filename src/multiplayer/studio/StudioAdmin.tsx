// The Studio tab in the lobby: write a scene, apply it to a test game,
// run ticks, then open the game with the Studio bar to shoot it. The
// scene language is worker/studioScene.js; the shot language is
// director.ts; docs/STUDIO.md explains both for people and agents.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../api';
import { SHOT_EXAMPLES } from './shotExamples';
import '../AdminAnalytics.css';
import './StudioAdmin.css';

interface Catalog {
  classes: string[]; loadouts: string[]; emblems: string[];
  bodies: Array<{ id: string; name: string; type: string; parent: string | null; radius: number; start: boolean }>;
  examples: Record<string, unknown>;
}
interface StudioGame { id: string; name: string; status: string; current_tick: number; tick_interval_ms: number; created_at: number }
interface ApplyResult {
  game_id: string; created: boolean; tick: number; viewer: string;
  factions: Array<{ key: string; id: string; name: string; handle: string; seat_me: boolean }>;
  ships: Record<string, string[]>; fleets: Record<string, string>; wars: number;
  orders: Array<Record<string, unknown>>;
}

const SCENE_KEY = 'orbital.studio.scene';
const SHOT_KEY = 'orbital.studio.shot';

export function StudioAdmin({ onEnterRoom }: { onEnterRoom: (roomId: string) => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [games, setGames] = useState<StudioGame[]>([]);
  const [scene, setScene] = useState<string>(() => { try { return sessionStorage.getItem(SCENE_KEY) || ''; } catch { return ''; } });
  const [shot, setShot] = useState<string>(() => { try { return sessionStorage.getItem(SHOT_KEY) || JSON.stringify(SHOT_EXAMPLES.earth_then_titan, null, 2); } catch { return ''; } });
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [last, setLast] = useState<ApplyResult | null>(null);
  const [seatMe, setSeatMe] = useState(true);

  const refresh = useCallback(async () => {
    const r = await apiFetch<{ games: StudioGame[] }>('/api/admin/studio/games');
    if (r.ok) setGames(r.data.games);
  }, []);
  useEffect(() => {
    (async () => {
      const c = await apiFetch<Catalog>('/api/admin/studio/catalog');
      if (c.ok) {
        setCatalog(c.data);
        if (!scene) {
          const first = Object.values(c.data.examples)[0];
          if (first) setScene(JSON.stringify(first, null, 2));
        }
      }
      refresh();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { try { sessionStorage.setItem(SCENE_KEY, scene); } catch { /* fine */ } }, [scene]);
  useEffect(() => { try { sessionStorage.setItem(SHOT_KEY, shot); } catch { /* fine */ } }, [shot]);

  const parsed = useMemo(() => { try { return { ok: true as const, value: JSON.parse(scene) }; } catch (e) { return { ok: false as const, error: (e as Error).message }; } }, [scene]);

  const validate = useCallback(async () => {
    if (!parsed.ok) { setNote({ kind: 'err', text: `Not JSON: ${parsed.error}` }); return; }
    setBusy('validate');
    const r = await apiFetch<{ summary: Record<string, unknown> }>('/api/admin/studio/validate', { method: 'POST', body: JSON.stringify(parsed.value) });
    setBusy(null);
    if (!r.ok) setNote({ kind: 'err', text: r.error?.message ?? `Failed (${r.status})` });
    else setNote({ kind: 'ok', text: `Scene is well formed: ${JSON.stringify(r.data.summary)}` });
  }, [parsed]);

  const apply = useCallback(async () => {
    if (!parsed.ok) { setNote({ kind: 'err', text: `Not JSON: ${parsed.error}` }); return; }
    setBusy('apply'); setNote(null);
    const body = { ...(parsed.value as Record<string, unknown>), seat_me: seatMe };
    const r = await apiFetch<ApplyResult>('/api/admin/studio/games', { method: 'POST', body: JSON.stringify(body) });
    setBusy(null);
    if (!r.ok) { setNote({ kind: 'err', text: r.error?.message ?? `Failed (${r.status})` }); return; }
    setLast(r.data);
    setNote({ kind: 'ok', text: `${r.data.created ? 'Created' : 'Updated'} ${r.data.game_id}: ${Object.values(r.data.ships).flat().length} ships, ${r.data.wars} wars, ${r.data.orders.length} orders.` });
    if (r.data.created) setScene(JSON.stringify({ ...(parsed.value as Record<string, unknown>), game_id: r.data.game_id }, null, 2));
    refresh();
  }, [parsed, seatMe, refresh]);

  const tick = useCallback(async (gameId: string, n: number) => {
    setBusy(`tick:${gameId}`);
    const r = await apiFetch<{ current_tick: number }>(`/api/admin/studio/games/${gameId}/tick`, { method: 'POST', body: JSON.stringify({ n }) });
    setBusy(null);
    setNote(r.ok ? { kind: 'ok', text: `${gameId} is at tick ${r.data.current_tick}.` } : { kind: 'err', text: r.error?.message ?? 'tick failed' });
    refresh();
  }, [refresh]);

  const close = useCallback(async (gameId: string) => {
    setBusy(`close:${gameId}`);
    const r = await apiFetch(`/api/admin/studio/games/${gameId}/close`, { method: 'POST', body: '{}' });
    setBusy(null);
    setNote(r.ok ? { kind: 'ok', text: `${gameId} closed.` } : { kind: 'err', text: r.error?.message ?? 'close failed' });
    refresh();
  }, [refresh]);

  const openGame = useCallback((gameId: string) => {
    try { sessionStorage.setItem(SHOT_KEY, shot); localStorage.setItem('orbital.studio.on', '1'); } catch { /* fine */ }
    onEnterRoom(gameId);
  }, [onEnterRoom, shot]);

  return (
    <div className="aa-root st">
      <div className="st-head">
        <h2 className="st-title">Studio</h2>
        <p className="st-sub">
          A scene puts ships, cities, wars and orders into a private test game. A shot moves the camera and
          records the map. Agents do the same from <code>scripts/studio.mjs</code>; the manual is <code>docs/STUDIO.md</code>.
        </p>
      </div>

      <section className="st-grid">
        <div className="st-col">
          <div className="st-bar">
            <span className="aa-section-title">1 · Scene</span>
            <select className="st-sel" defaultValue="" onChange={e => { const ex = catalog?.examples[e.target.value]; if (ex) setScene(JSON.stringify(ex, null, 2)); e.target.value = ''; }}>
              <option value="">Load an example…</option>
              {catalog && Object.keys(catalog.examples).map(k => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <textarea className="st-text" value={scene} onChange={e => setScene(e.target.value)} spellCheck={false} rows={26} />
          <div className="st-bar">
            <label className="st-check"><input type="checkbox" checked={seatMe} onChange={e => setSeatMe(e.target.checked)} /> seat me as the viewer faction</label>
            <button className="aa-btn" disabled={!!busy} onClick={validate}>Validate</button>
            <button className="aa-btn aa-btn--primary" disabled={!!busy} onClick={apply}>{busy === 'apply' ? 'Applying…' : 'Apply scene'}</button>
          </div>
          {note && <div className={note.kind === 'ok' ? 'st-ok' : 'st-err'}>{note.text}</div>}
          {last && (
            <div className="st-result">
              <div><b>{last.game_id}</b> · tick {last.tick} · viewer <b>{last.viewer}</b></div>
              <div>Factions: {last.factions.map(f => `${f.key}=${f.id.split(':').pop()}${f.seat_me ? ' (you)' : ''}`).join(', ')}</div>
              <div>Ships: {Object.entries(last.ships).map(([k, ids]) => `${k}: ${ids.length}`).join(', ')}</div>
              {Object.keys(last.fleets).length > 0 && <div>Fleets: {Object.entries(last.fleets).map(([k, id]) => `${k} → fleet:${id.split(':').pop()}`).join(', ')}</div>}
              {last.orders.length > 0 && <div>Orders: {last.orders.map(o => JSON.stringify(o)).join(' ')}</div>}
              <div className="st-bar">
                <button className="aa-btn" disabled={!!busy} onClick={() => tick(last.game_id, 1)}>Tick +1</button>
                <button className="aa-btn" disabled={!!busy} onClick={() => tick(last.game_id, 5)}>Tick +5</button>
                <button className="aa-btn aa-btn--primary" onClick={() => openGame(last.game_id)}>Open with the Studio bar →</button>
              </div>
            </div>
          )}
        </div>

        <div className="st-col">
          <div className="st-bar"><span className="aa-section-title">2 · Shot</span>
            <select className="st-sel" defaultValue="" onChange={e => { const ex = SHOT_EXAMPLES[e.target.value]; if (ex) setShot(JSON.stringify(ex, null, 2)); e.target.value = ''; }}>
              <option value="">Load an example…</option>
              {Object.keys(SHOT_EXAMPLES).map(k => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <textarea className="st-text" value={shot} onChange={e => setShot(e.target.value)} spellCheck={false} rows={26} />
          <div className="st-help">
            Saved with the page. Open a studio game and the Studio bar carries this shot: <b>Preview</b> plays it on the
            map, <b>Record</b> writes the video and downloads it. Targets are world ids (<code>earth</code>, <code>titan</code>),
            <code>ship:&lt;id&gt;</code> or <code>fleet:&lt;id&gt;</code> from the scene result above.
          </div>
        </div>
      </section>

      <section>
        <div className="st-bar"><span className="aa-section-title">Studio games</span><button className="aa-btn" onClick={refresh}>Refresh</button></div>
        {games.length === 0 ? <div className="aa-empty">None yet. Apply a scene to make one.</div> : (
          <table className="aa-table">
            <thead><tr><th>Game</th><th>Name</th><th>Status</th><th>Tick</th><th></th></tr></thead>
            <tbody>
              {games.map(g => (
                <tr key={g.id}>
                  <td><code>{g.id}</code></td><td>{g.name.replace(/^Studio: /, '')}</td><td>{g.status}</td><td>{g.current_tick}</td>
                  <td className="st-actions">
                    <button className="aa-btn" disabled={!!busy || g.status !== 'active'} onClick={() => tick(g.id, 1)}>Tick</button>
                    <button className="aa-btn" disabled={g.status !== 'active'} onClick={() => openGame(g.id)}>Open</button>
                    <button className="aa-btn" disabled={!!busy} onClick={() => setScene(s => { try { return JSON.stringify({ ...JSON.parse(s), game_id: g.id }, null, 2); } catch { return s; } })}>Use in scene</button>
                    <button className="aa-btn" disabled={!!busy || g.status !== 'active'} onClick={() => { if (window.confirm(`Close ${g.id}? It stops ticking and leaves everyone's lists.`)) close(g.id); }}>Close</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {catalog && (
        <section className="st-ref">
          <div className="aa-section-title">Reference</div>
          <div className="st-help">
            Classes: {catalog.classes.join(', ')}. Loadouts: {catalog.loadouts.join(', ')} or a parts array.
            Emblems: {catalog.emblems.join(', ')}.
          </div>
          <div className="st-help">Start worlds: {catalog.bodies.filter(b => b.start).map(b => b.id).join(', ')}.</div>
          <div className="st-help">All worlds: {catalog.bodies.map(b => b.id).join(', ')}.</div>
        </section>
      )}
    </div>
  );
}
