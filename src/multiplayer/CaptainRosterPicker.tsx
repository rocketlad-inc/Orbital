// ============================================================
// Pre-game captain roster — the lobby step.
//
// A faction fields ten officers before money enters the game, and until now
// all ten were rolled sight-unseen on the first tick. This is where a player
// meets them first: rename, repick the portrait, and decide WHICH officer
// carries which of the dealt traits.
//
// Everything arrives pre-generated. The step is optional and there is no
// "finish" gate — a player who never opens it gets exactly the old
// behaviour, because the server rolls every slot from a NULL roster.
//
// TRAITS ARE PERMUTED, NOT PICKED. The server deals a multiset and accepts
// only a rearrangement of it (see sanitizeCaptainRoster). Free choice would
// make this a balance change rather than a customization feature — every
// roster would be ten Gunners. So the UI offers a SWAP: choose another
// officer and the two trade traits. That keeps the pool honest by
// construction rather than by validation, and means the player can never
// build a submission the server will reject.
//
// If the server reports freeTraitChoice, the swap becomes a plain dropdown.
// ============================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from './api';
import { CaptainAvatar } from '../components/CaptainAvatar';

interface RosterEntry {
  name: string;
  avatar_id: string;
  trait: string;
  bio?: string;
}
interface TraitDef { id: string; name: string; blurb?: string }
interface RosterPayload {
  roster: RosterEntry[];
  saved: boolean;
  count: number;
  avatars: string[];
  traits: TraitDef[];
  freeTraitChoice: boolean;
  dealtTraits: string[];
}

/**
 * As large as the card allows without making the card taller.
 *
 * This is the height of the column beside it, which is what bounds it:
 *
 *   name input   14px text + 16 padding + 2 border + 4 margin  = 39
 *   trait row    11px chip + 4 padding + 2 border + slack       = 20
 *   bio textarea 5 margin + 2 rows (26) + 16 padding + 2 border = 49
 *                                                        total  = 108
 *
 * Sized just under that, so a portrait never grows the row: if the
 * trait blurb wraps on a narrow window the column gets taller and the
 * portrait simply sits at the top, which is the harmless direction.
 *
 * It was 72 to match the ship panel's chip — but this is the one screen
 * where a player is CHOOSING a face, and a face you are choosing should
 * be the biggest thing on its card. The in-game chip is unchanged; the
 * two sizes answer different questions.
 */
const PORTRAIT_PX = 104;

/**
 * The faces you choose FROM. Bigger than it was for the same reason the
 * card portrait is: at 34px these were thumbnails of thumbnails, and
 * picking a face you cannot make out is guessing. The tray scrolls
 * (maxHeight 200) so a larger tile costs scrolling, not layout.
 */
const PICKER_PX = 52;

export const CaptainRosterPicker: React.FC<{ roomId: string }> = ({ roomId }) => {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<RosterPayload | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /** Which row has its portrait grid open. Only one at a time: 122 faces is
   *  a lot of DOM, and ten grids at once is a scroll nobody can use. */
  const [pickingFor, setPickingFor] = useState<number | null>(null);
  /** Which row is offering a trait swap. */
  const [swapFor, setSwapFor] = useState<number | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    const res = await apiFetch<RosterPayload>(`/api/lobby/rooms/${roomId}/captains`);
    setBusy(false);
    if (!res.ok) { setMsg(res.error?.message ?? 'Could not load your officers'); return; }
    setData(res.data);
    setRoster(res.data.roster);
    setMsg(null);
  }, [roomId]);

  useEffect(() => { if (open && !data) void load(); }, [open, data, load]);

  const traitName = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of data?.traits ?? []) m.set(t.id, t.name);
    return (id: string) => m.get(id) ?? id;
  }, [data]);

  /** What the bonus DOES. A pill reading "Gunner" tells a first-time player
   *  nothing about the choice they just made. */
  const traitBlurb = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of data?.traits ?? []) m.set(t.id, t.blurb ?? '');
    return (id: string) => m.get(id) ?? '';
  }, [data]);

  /** The pool, as counts, so a player can see what they have to work with
   *  rather than inferring it from ten rows. */
  const poolSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of roster) counts.set(c.trait, (counts.get(c.trait) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, n]) => `${traitName(id)}${n > 1 ? ` x${n}` : ''}`)
      .join(' · ');
  }, [roster, traitName]);

  const setEntry = (i: number, patch: Partial<RosterEntry>) => {
    setRoster(prev => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));
    setMsg(null);
  };

  /** SWAP, not assign — the two officers trade traits, so the multiset is
   *  preserved and the server's permutation check cannot fail. */
  const swapTraits = (a: number, b: number) => {
    setRoster(prev => {
      if (a === b) return prev;
      const next = prev.slice();
      const t = next[a].trait;
      next[a] = { ...next[a], trait: next[b].trait };
      next[b] = { ...next[b], trait: t };
      return next;
    });
    setSwapFor(null);
    setMsg(null);
  };

  const save = async () => {
    if (!data) return;
    setBusy(true);
    const res = await apiFetch<{ ok: boolean }>(`/api/lobby/rooms/${roomId}/captains`, {
      method: 'PUT',
      body: JSON.stringify({ roster, dealtTraits: data.dealtTraits }),
    });
    setBusy(false);
    setMsg(res.ok ? 'Officers commissioned.' : (res.error?.message ?? 'Could not save'));
    if (res.ok) setData({ ...data, saved: true });
  };

  const reroll = async () => {
    // Server-side deal, so a reroll produces a legal pool rather than one the
    // client invented. Clears the saved roster only on the next save.
    setData(null);
    setRoster([]);
    setPickingFor(null);
    setSwapFor(null);
    await load();
  };

  // Escape closes the dialog. Standard for anything modal, and the keyboard
  // counterpart to the close button now that focus can land inside a textarea.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) {
    return (
      <div className="mp-row" style={{ marginTop: 12 }}>
        <button
          className="mp-submit"
          style={{ width: 'auto', margin: 0, padding: '6px 12px' }}
          onClick={() => setOpen(true)}
        >
          ★ Your first ten captains
        </button>
        <span className="mp-saved" style={{ marginLeft: 8, opacity: 0.7 }}>
          optional — they are already named and posted
        </span>
      </div>
    );
  }

  // POPS OUT OVER THE MAP -- VIA A PORTAL, and the portal is the whole point.
  //
  // `position: fixed` is NOT reliably relative to the viewport: an ancestor
  // with a transform, filter, backdrop-filter or contain creates a containing
  // block, and a fixed child is then fixed to THAT box instead. The lobby
  // chain has one (.mp-overlay carries backdrop-filter, and the surrounding
  // panels are laid out in a column), so the first cut rendered this dialog
  // trapped inside the right-hand lobby column -- pinned to the right edge,
  // about a quarter of the width, with every row clipped mid-word.
  //
  // Portalling to document.body escapes every such ancestor at once, which is
  // why it is the fix rather than hunting the specific offender: the next
  // ancestor to gain a transform cannot break this again.
  //
  // z-index clears the dock rail (3200) and the panels (3000-3100), and sits
  // below .mp-overlay's 5000 so a sign-in prompt still wins.
  return createPortal((
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 4000,
        background: 'rgba(4, 8, 14, 0.86)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
      // Click the backdrop to close, but never a click that started inside.
      onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
    >
    <div style={{
      background: '#0a0e14', border: '1px solid #2a3d50', borderRadius: 10,
      width: 'min(980px, 100%)', maxHeight: '92vh', overflowY: 'auto',
      padding: 16, boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
    }}>
      {/* Sticky, because the close control has to stay reachable. Ten captain
          rows scroll well past a screen, and a header that scrolls away
          strands the only explicit way out at the top of the list --
          backdrop-click and Escape both exist, but neither is visible. */}
      <div style={{
        position: 'sticky', top: -16, zIndex: 2,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: '#0a0e14', borderBottom: '1px solid #16222e',
        margin: '-16px -16px 8px', padding: '16px 16px 8px',
      }}>
        <div className="mp-section-title" style={{ marginTop: 0, marginBottom: 0 }}>Your first ten captains</div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="mp-modal-close"
          aria-label="Close captain roster"
          title="Close"
        >&times;</button>
      </div>
      <div style={{ fontSize: 12, color: '#8aa0b4', margin: '0 0 8px', lineHeight: 1.5 }}>
        These ten sail with your opening fleet. Rename them, pick their faces, and
        decide who carries which trait — the traits below are what you were dealt,
        {data?.freeTraitChoice ? ' and you may set them freely.' : ' and officers TRADE traits rather than picking new ones.'}
      </div>
      {poolSummary && (
        <div style={{ fontSize: 11, color: '#b8c8d6', marginBottom: 10 }}>
          <span style={{ color: '#5f7488' }}>YOUR POOL: </span>{poolSummary}
        </div>
      )}

      {busy && !roster.length && <div style={{ fontSize: 12, color: '#8aa0b4' }}>Mustering…</div>}

      <div style={{
        display: 'grid', gap: 10,
        gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))',
      }}>
      {roster.map((c, i) => (
        <div
          key={i}
          style={{
            display: 'flex', gap: 10, alignItems: 'flex-start',
            padding: 8, border: '1px solid #1b2836', borderRadius: 6,
          }}
        >
          <button
            onClick={() => { setPickingFor(pickingFor === i ? null : i); setSwapFor(null); }}
            title="Change portrait"
            style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0 }}
          >
            <CaptainAvatar avatarId={c.avatar_id} size={PORTRAIT_PX} />
          </button>

          <div style={{ flex: 1, minWidth: 0 }}>
            <input
              className="mp-input"
              type="text"
              maxLength={28}
              value={c.name}
              onChange={(e) => setEntry(i, { name: e.target.value })}
              style={{ fontSize: 14, marginBottom: 4 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {data?.freeTraitChoice ? (
                <select
                  className="mp-input"
                  value={c.trait}
                  onChange={(e) => setEntry(i, { trait: e.target.value })}
                  style={{ width: 'auto', fontSize: 12, padding: '2px 6px' }}
                >
                  {(data?.traits ?? []).map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              ) : (
                <>
                  <span style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 10,
                    border: '1px solid #2a3d50', color: '#4ecdc4',
                  }}>{traitName(c.trait)}</span>
                  <button
                    onClick={() => { setSwapFor(swapFor === i ? null : i); setPickingFor(null); }}
                    style={{
                      background: 'transparent', border: 'none', color: '#5f7488',
                      cursor: 'pointer', fontSize: 11, textDecoration: 'underline',
                    }}
                  >swap</button>
                </>
              )}
              <span style={{ fontSize: 11, color: '#4ecdc4' }}>{traitBlurb(c.trait)}</span>
            </div>

            {/* BIO. Was a truncated read-only line; a player who is naming
                these officers wants to write them too. One line, 140 chars,
                because it has to fit a roster row and the ship panel. */}
            <textarea
              className="mp-textarea"
              maxLength={140}
              rows={2}
              value={c.bio ?? ''}
              onChange={(e) => setEntry(i, { bio: e.target.value })}
              placeholder="A line about this officer…"
              style={{ marginTop: 5, fontSize: 11, minHeight: 34 }}
            />

            {swapFor === i && (
              <div style={{ marginTop: 6, fontSize: 11, color: '#8aa0b4' }}>
                Trade {traitName(c.trait)} with:
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                  {roster.map((o, j) => (j === i ? null : (
                    <button
                      key={j}
                      onClick={() => swapTraits(i, j)}
                      style={{
                        background: '#14202c', border: '1px solid #2a3d50', borderRadius: 3,
                        color: '#d8e4ee', cursor: 'pointer', fontSize: 11, padding: '2px 6px',
                      }}
                    >{o.name} · {traitName(o.trait)}</button>
                  )))}
                </div>
              </div>
            )}

            {pickingFor === i && (
              <div style={{
                marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4,
                maxHeight: 200, overflowY: 'auto',
                border: '1px solid #1b2836', borderRadius: 4, padding: 6,
              }}>
                {(data?.avatars ?? []).map(a => (
                  <button
                    key={a}
                    onClick={() => { setEntry(i, { avatar_id: a }); setPickingFor(null); }}
                    title={a}
                    style={{
                      background: 'transparent', border: a === c.avatar_id ? '1px solid #4ecdc4' : 'none',
                      borderRadius: 4, padding: 1, cursor: 'pointer', lineHeight: 0,
                    }}
                  >
                    <CaptainAvatar avatarId={a} size={PICKER_PX} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
      </div>

      {roster.length > 0 && (
        <div className="mp-row" style={{ marginTop: 10 }}>
          <button
            className="mp-submit"
            style={{ width: 'auto', margin: 0, padding: '6px 12px' }}
            onClick={save}
            disabled={busy}
          >
            {data?.saved ? 'Update officers' : 'Commission these ten'}
          </button>
          <button
            onClick={reroll}
            disabled={busy}
            style={{
              background: 'transparent', border: '1px solid #2a3d50', borderRadius: 3,
              color: '#8aa0b4', cursor: 'pointer', fontSize: 12, padding: '6px 10px', marginLeft: 8,
            }}
          >Deal again</button>
          <span className="mp-saved" style={{ marginLeft: 8 }}>{msg || ''}</span>
        </div>
      )}
    </div>
    </div>
  ), document.body);
};
