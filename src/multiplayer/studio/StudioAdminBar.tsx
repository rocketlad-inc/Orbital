// The Studio bar: a person's hands on the director, floating over the
// map. Paste or pick a shot, Preview it live, Record it to a video, run
// ticks, and hide the interface. Admins only (StudioBridge mounts it).
// Everything it does, window.__studio does for an agent.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Director, Shot } from './director';
import { Director as DirectorClass } from './director';
import { SHOT_EXAMPLES } from './shotExamples';
import './StudioAdminBar.css';

const KEY = 'orbital.studio.shot';

export function StudioAdminBar({ director, onClose }: { director: Director; onClose: () => void }) {
  const [text, setText] = useState<string>(() => {
    try { return sessionStorage.getItem(KEY) || JSON.stringify(SHOT_EXAMPLES.earth_then_titan, null, 2); } catch { return '{}'; }
  });
  const [busy, setBusy] = useState<'preview' | 'record' | 'tick' | null>(null);
  const [progress, setProgress] = useState(0);
  const [msg, setMsg] = useState<string>('');
  const [open, setOpen] = useState(true);

  const shot = useMemo<{ shot: Shot | null; problems: string[] }>(() => {
    try {
      const parsed = JSON.parse(text);
      const problems = DirectorClass.lint(parsed);
      return { shot: problems.length ? null : parsed as Shot, problems };
    } catch (e) { return { shot: null, problems: [`not JSON: ${(e as Error).message}`] }; }
  }, [text]);

  useEffect(() => { try { sessionStorage.setItem(KEY, text); } catch { /* fine */ } }, [text]);
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setProgress(director.progress), 200);
    return () => window.clearInterval(id);
  }, [busy, director]);

  const run = useCallback(async (mode: 'preview' | 'record') => {
    if (!shot.shot) return;
    setBusy(mode); setMsg(mode === 'record' ? 'Recording. The page runs on a frame clock until it is done.' : 'Playing on the map.');
    try {
      if (mode === 'preview') await director.preview(shot.shot);
      else {
        const blob = await director.record(shot.shot, { download: true, name: `orbital-${Date.now()}` });
        setMsg(blob ? `Saved: ${(blob.size / 1e6).toFixed(1)} MB ${director.lastExt}. It is in your downloads.` : 'Cancelled.');
      }
    } catch (e) { setMsg(`Failed: ${(e as Error).message}`); }
    finally { setBusy(null); setProgress(0); }
  }, [director, shot]);

  const tick = useCallback(async (n: number) => {
    setBusy('tick'); setMsg(`Running ${n} tick${n > 1 ? 's' : ''}…`);
    try { const t = await director.ticks(n); setMsg(`Tick ${t}.`); } catch (e) { setMsg(`Failed: ${(e as Error).message}`); }
    finally { setBusy(null); }
  }, [director]);

  return (
    <div className={`sb${open ? '' : ' sb--closed'}`} data-studio-bar>
      <div className="sb-head">
        <strong>STUDIO</strong>
        <span className="sb-sub">{busy ? `${busy} ${Math.round(progress * 100)}%` : 'ready'}</span>
        <button className="sb-x" onClick={() => setOpen(o => !o)} title="Collapse">{open ? '–' : '+'}</button>
        <button className="sb-x" onClick={onClose} title="Leave the studio">×</button>
      </div>
      {open && (
        <>
          <div className="sb-row">
            <select className="sb-sel" onChange={e => { const k = e.target.value; if (k && SHOT_EXAMPLES[k]) setText(JSON.stringify(SHOT_EXAMPLES[k], null, 2)); e.target.value = ''; }} defaultValue="">
              <option value="">Load an example shot…</option>
              {Object.keys(SHOT_EXAMPLES).map(k => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
            </select>
            <button className="sb-btn" disabled={!!busy} onClick={() => tick(1)}>Tick +1</button>
            <button className="sb-btn" disabled={!!busy} onClick={() => tick(5)}>+5</button>
            <button className="sb-btn" disabled={!!busy} onClick={() => director.ui(!document.body.classList.contains('studio-cinema'))}>UI</button>
          </div>
          <textarea className="sb-text" value={text} onChange={e => setText(e.target.value)} spellCheck={false} rows={12} />
          {shot.problems.length > 0 && <div className="sb-problems">{shot.problems.join(' · ')}</div>}
          <div className="sb-row">
            <button className="sb-btn" disabled={!shot.shot || !!busy} onClick={() => run('preview')}>▶ Preview</button>
            <button className="sb-btn sb-btn--go" disabled={!shot.shot || !!busy} onClick={() => run('record')}>● Record</button>
            {busy && <button className="sb-btn" onClick={() => director.cancel()}>Stop</button>}
            {!busy && director.lastBlob && <button className="sb-btn" onClick={() => director.download()}>Save again</button>}
          </div>
          {msg && <div className="sb-msg">{msg}</div>}
          <div className="sb-help">
            Targets: a world id (<code>earth</code>, <code>titan</code>), <code>ship:&lt;id&gt;</code> or <code>fleet:&lt;id&gt;</code>.
            Verbs: focus, pan, zoom, follow, tick, speed, caption, hook, ui. Manual: docs/STUDIO.md.
          </div>
        </>
      )}
    </div>
  );
}
