// ============================================================================
// Editor — the admin balance console.
//
// THERE ARE NO HAND-WRITTEN CONTROLS IN THIS FILE. Every knob is rendered
// from the schema the server sends (worker/configSchema.js). Adding a
// tunable is one entry in that file; it shows up here automatically, with
// its bounds enforced, its help text attached, and its default shown.
//
// That is the point of the whole feature: balance changes should not
// require an engineer, and neither should exposing a NEW balance change.
//
// Workflow the UI enforces:
//   draft  -> edit freely, launch test games, run the sim against it
//   publish-> becomes the config new games are created with
//   games pin their config at creation, so publishing never rewrites a
//   match in progress. Published configs are immutable — clone to change.
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from './api';

type Knob = {
  id: string; group: string; label: string; help?: string;
  type: 'number' | 'int' | 'bool' | 'enum';
  def: number | boolean; min?: number; max?: number; step?: number;
  danger?: boolean;
};
type Group = { id: string; label: string; blurb: string };
type ConfigRow = {
  id: string; name: string; status: string; notes: string | null;
  created_ms: number; updated_ms: number; published_ms: number | null; games: number;
};

const card: React.CSSProperties = {
  border: '1px solid rgba(96,130,160,.3)', borderRadius: 8, padding: '12px 14px',
};
const dim: React.CSSProperties = { fontSize: 11.5, color: '#8a9fb3', lineHeight: 1.5 };

export function Editor() {
  const [schema, setSchema] = useState<Knob[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [defaults, setDefaults] = useState<Record<string, number | boolean>>({});
  const [configs, setConfigs] = useState<ConfigRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, number | boolean>>({});
  const [tab, setTab] = useState<string>('yields');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const loadCatalogue = useCallback(async () => {
    const r = await apiFetch<{ groups: Group[]; schema: Knob[]; defaults: Record<string, number | boolean> }>(
      '/api/admin/config/schema');
    if (r.ok) {
      setSchema(r.data.schema); setGroups(r.data.groups); setDefaults(r.data.defaults);
      if (r.data.groups[0]) setTab(r.data.groups[0].id);
    }
  }, []);

  const loadList = useCallback(async () => {
    const r = await apiFetch<{ configs: ConfigRow[] }>('/api/admin/config');
    if (r.ok) setConfigs(r.data.configs);
  }, []);

  useEffect(() => { loadCatalogue(); loadList(); }, [loadCatalogue, loadList]);

  const open = async (id: string) => {
    const r = await apiFetch<{ config: { overrides: Record<string, number | boolean> } }>(
      `/api/admin/config/${id}`);
    if (!r.ok) { setMsg('Could not open that config.'); return; }
    // Start from defaults, lay the sparse overrides on top. The editor
    // always shows a COMPLETE picture even though storage is sparse.
    setValues({ ...defaults, ...r.data.config.overrides });
    setOpenId(id); setDirty(false); setMsg(null);
  };

  const current = configs.find(c => c.id === openId) ?? null;
  const readOnly = !!current && current.status !== 'draft';

  const changed = useMemo(
    () => schema.filter(k => values[k.id] !== undefined && values[k.id] !== defaults[k.id]),
    [schema, values, defaults]);

  const setKnob = (id: string, v: number | boolean) => {
    setValues(prev => ({ ...prev, [id]: v })); setDirty(true);
  };

  const save = async () => {
    if (!openId) return;
    setBusy(true);
    const r = await apiFetch<{ changed: number }>(`/api/admin/config/${openId}`, {
      method: 'PATCH', body: JSON.stringify({ values }),
    });
    setBusy(false);
    if (r.ok) { setDirty(false); setMsg(`Saved — ${r.data.changed} value(s) differ from default.`); loadList(); }
    else setMsg('Save rejected. A value was out of range.');
  };

  const create = async (cloneFrom?: string) => {
    setBusy(true);
    const r = await apiFetch<{ id: string }>('/api/admin/config', {
      method: 'POST',
      body: JSON.stringify({
        name: cloneFrom ? `Copy of ${configs.find(c => c.id === cloneFrom)?.name ?? 'config'}` : 'New draft',
        clone_from: cloneFrom,
      }),
    });
    setBusy(false);
    if (r.ok) { await loadList(); open(r.data.id); }
  };

  const publish = async () => {
    if (!openId) return;
    if (!window.confirm(
      'Publish this config?\n\nEvery NEW game will be created with these values. '
      + 'Games already running keep the config they started with, so nothing in '
      + 'progress changes.\n\nPublished configs become read-only — clone to edit further.',
    )) return;
    setBusy(true);
    const r = await apiFetch(`/api/admin/config/${openId}/publish`, { method: 'POST' });
    setBusy(false);
    if (r.ok) { setMsg('Published. New games will use it.'); loadList(); }
  };

  if (!schema.length) return <div style={dim}>Loading knob catalogue…</div>;

  const inGroup = schema.filter(k => k.group === tab);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div className="mp-section-title">Game Editor</div>
        <div style={dim}>
          Every balance value in Orbital, editable without a deploy. Drafts are private;
          publishing sets the values <b>new</b> games are created with. Running matches keep
          the config they started with.
        </div>
      </div>

      {/* ---- config list ---- */}
      <div style={{ ...card }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <b style={{ fontSize: 12.5, color: '#cdd9e4' }}>Configs</b>
          <button className="mp-btn mp-btn--ghost" onClick={() => create()} disabled={busy}>
            + New draft
          </button>
        </div>
        {!configs.length && <div style={dim}>None yet. A game with no config runs on shipped defaults.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {configs.map(c => (
            <div key={c.id} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '5px 7px', borderRadius: 5,
              background: c.id === openId ? 'rgba(78,205,196,.10)' : 'transparent',
            }}>
              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 3,
                border: `1px solid ${c.status === 'published' ? '#4ecdc4' : c.status === 'draft' ? '#8a9fb3' : '#5f7186'}`,
                color: c.status === 'published' ? '#4ecdc4' : '#8a9fb3',
              }}>{c.status}</span>
              <span style={{ fontSize: 12.5, color: '#cdd9e4', flex: 1 }}>{c.name}</span>
              {c.games > 0 && <span style={{ ...dim, fontSize: 10.5 }}>{c.games} game(s)</span>}
              <button className="mp-btn mp-btn--ghost" style={{ fontSize: 11 }} onClick={() => open(c.id)}>
                {c.status === 'draft' ? 'Edit' : 'View'}
              </button>
              <button className="mp-btn mp-btn--ghost" style={{ fontSize: 11 }}
                onClick={() => create(c.id)} disabled={busy}>Clone</button>
            </div>
          ))}
        </div>
      </div>

      {/* ---- knobs ---- */}
      {openId && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div>
              <b style={{ fontSize: 13, color: '#cdd9e4' }}>{current?.name}</b>
              <div style={dim}>
                {changed.length} of {schema.length} values changed from default
                {readOnly && ' · read-only (clone to edit)'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="mp-btn" onClick={save} disabled={busy || readOnly || !dirty}>
                {dirty ? 'Save' : 'Saved'}
              </button>
              <button className="mp-btn mp-btn--primary" onClick={publish}
                disabled={busy || current?.status === 'published'}>Publish</button>
            </div>
          </div>

          {msg && <div style={{ ...dim, color: '#4ecdc4', marginTop: 6 }}>{msg}</div>}

          {/* group tabs */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', margin: '12px 0 4px' }}>
            {groups.map(g => (
              <button key={g.id} onClick={() => setTab(g.id)} className="mp-btn mp-btn--ghost"
                style={{
                  fontSize: 11,
                  borderColor: tab === g.id ? '#4ecdc4' : 'rgba(120,140,160,.35)',
                  color: tab === g.id ? '#4ecdc4' : '#8a9fb3',
                }}>{g.label}</button>
            ))}
          </div>
          <div style={{ ...dim, marginBottom: 10 }}>
            {groups.find(g => g.id === tab)?.blurb}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {inGroup.map(k => {
              const val = values[k.id] ?? k.def;
              const isChanged = val !== defaults[k.id];
              return (
                <div key={k.id} style={{
                  borderLeft: `2px solid ${isChanged ? '#ffb84d' : 'transparent'}`,
                  paddingLeft: 9,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12.5, color: '#cdd9e4' }}>{k.label}</span>
                    {k.danger && (
                      <span style={{ fontSize: 10, color: '#ff9d5c', border: '1px solid #ff9d5c',
                        borderRadius: 3, padding: '0 5px' }}>high impact</span>
                    )}
                    <span style={{ flex: 1 }} />
                    {k.type === 'bool' ? (
                      <button className="mp-btn mp-btn--ghost" disabled={readOnly}
                        onClick={() => setKnob(k.id, !val)}>{val ? 'ON' : 'OFF'}</button>
                    ) : (
                      <input
                        type="number" value={String(val)} disabled={readOnly}
                        min={k.min} max={k.max} step={k.step ?? (k.type === 'int' ? 1 : 0.01)}
                        onChange={e => setKnob(k.id, Number(e.target.value))}
                        style={{
                          width: 110, padding: '4px 7px', borderRadius: 5,
                          background: 'rgba(10,16,24,.7)', color: '#e7eef6',
                          border: `1px solid ${isChanged ? '#ffb84d' : 'rgba(120,140,160,.35)'}`,
                          fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12.5,
                        }}
                      />
                    )}
                    {isChanged && !readOnly && (
                      <button onClick={() => setKnob(k.id, defaults[k.id])}
                        title={`Reset to ${defaults[k.id]}`}
                        style={{ background: 'none', border: 'none', color: '#8a9fb3',
                          cursor: 'pointer', fontSize: 11, textDecoration: 'underline', padding: 0 }}>
                        reset
                      </button>
                    )}
                  </div>
                  <div style={{ ...dim, marginTop: 2 }}>
                    {k.help}
                    <span style={{ color: '#5f7186' }}>
                      {' '}(default {String(defaults[k.id])}
                      {k.min != null && `, range ${k.min}–${k.max}`})
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Test before publishing. The sim can't run in a Worker, so
              this hands over the exact command rather than pretending. */}
          <div style={{ ...card, marginTop: 14, borderStyle: 'dashed' }}>
            <b style={{ fontSize: 12, color: '#cdd9e4' }}>Test before publishing</b>
            <div style={{ ...dim, marginTop: 4 }}>
              Run 20 headless games against this draft and compare the balance to the
              live config. The simulator runs on Node, not in the Worker:
            </div>
            <code style={{
              display: 'block', marginTop: 6, padding: '7px 9px', borderRadius: 5,
              background: 'rgba(10,16,24,.7)', color: '#4ecdc4', fontSize: 11.5,
              fontFamily: 'ui-monospace, Menlo, Consolas, monospace', overflowX: 'auto',
            }}>npm run sim:sweep -- 20 500 bots {openId}</code>
          </div>
        </div>
      )}
    </div>
  );
}
