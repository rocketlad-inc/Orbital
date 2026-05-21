// ============================================================
// TradeComposer — modal for drafting a new offer or counter-offer.
//
// Two columns (You give / They give) with numeric inputs for each
// resource and toggles for each pact kind. "Propose" sends to API.
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import {
  Faction,
  MyFaction,
  PactKind,
  PACT_LABELS,
  ResourceBundle,
  TradeOffer,
  emptyBundle,
  tradesApi,
} from './api';

type Mode =
  | { kind: 'new' }
  | { kind: 'counter'; original: TradeOffer };

type Side = 'offer' | 'request';

const PACT_KINDS_ORDER: PactKind[] = ['nap', 'defense_pact', 'intel_share'];
// Fuel was removed from the economy. The schema column stays so we don't
// need a migration, but the trade composer no longer offers it as a knob.
const RESOURCE_KEYS: Array<keyof ResourceBundle> = ['metal', 'gold', 'science'];
const RESOURCE_LABELS: Record<keyof ResourceBundle, string> = {
  metal: 'Metal', fuel: 'Fuel', gold: 'Gold', science: 'Science',
};
const RESOURCE_COLORS: Record<keyof ResourceBundle, string> = {
  metal: '#a0a0a0', fuel: '#ffb84d', gold: '#ffd700', science: '#6ee7b7',
};

interface TradeComposerProps {
  gameId: string;
  me: MyFaction;
  factions: Faction[];
  mode: Mode;
  onClose: () => void;
  onSuccess: () => void;
}

export function TradeComposer({ gameId, me, factions, mode, onClose, onSuccess }: TradeComposerProps) {
  const api = useMemo(() => tradesApi(gameId), [gameId]);

  // For counters, role flips: "I" become the proposer of the counter. So
  // "what I give" = the original's "request" (what was being asked of me),
  // and "what they give" = the original's "offer".
  const isCounter = mode.kind === 'counter';
  const original = isCounter ? mode.original : null;

  const initialResponderId = isCounter
    ? original!.proposer_faction_id
    : (factions.find((f) => f.id !== me.id)?.id ?? '');

  const [responderId, setResponderId] = useState<string>(initialResponderId);
  const [offer, setOffer] = useState<ResourceBundle>(
    isCounter ? { ...original!.request } : emptyBundle(),
  );
  const [request, setRequest] = useState<ResourceBundle>(
    isCounter ? { ...original!.offer } : emptyBundle(),
  );
  const [offerPacts, setOfferPacts] = useState<PactKind[]>(
    isCounter ? [...original!.request_pacts] : [],
  );
  const [requestPacts, setRequestPacts] = useState<PactKind[]>(
    isCounter ? [...original!.offer_pacts] : [],
  );
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Reset if mode flips
    if (mode.kind === 'new') {
      setOffer(emptyBundle());
      setRequest(emptyBundle());
      setOfferPacts([]);
      setRequestPacts([]);
    }
  }, [mode.kind]);

  const responderName = useMemo(() => {
    return factions.find((f) => f.id === responderId)?.name ?? 'unknown';
  }, [factions, responderId]);

  const responderColor = useMemo(() => {
    return factions.find((f) => f.id === responderId)?.color ?? '#a8b8c8';
  }, [factions, responderId]);

  const offerTotal = RESOURCE_KEYS.reduce((s, k) => s + offer[k], 0) + offerPacts.length;
  const requestTotal = RESOURCE_KEYS.reduce((s, k) => s + request[k], 0) + requestPacts.length;
  const canSubmit = responderId && (offerTotal + requestTotal) > 0 && !submitting;

  // Check whether you actually have what you're offering
  const overspend: Partial<Record<keyof ResourceBundle, number>> = {};
  for (const k of RESOURCE_KEYS) {
    if (offer[k] > me[k]) overspend[k] = me[k];
  }
  const hasOverspend = Object.keys(overspend).length > 0;

  const updateBundle = (side: Side, key: keyof ResourceBundle, value: number) => {
    const v = Math.max(0, Math.floor(value || 0));
    if (side === 'offer') setOffer((b) => ({ ...b, [key]: v }));
    else setRequest((b) => ({ ...b, [key]: v }));
  };
  const togglePact = (side: Side, kind: PactKind) => {
    const setter = side === 'offer' ? setOfferPacts : setRequestPacts;
    setter((arr) => (arr.includes(kind) ? arr.filter((x) => x !== kind) : [...arr, kind]));
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!canSubmit) return;
    if (hasOverspend) {
      setError('You don\'t hold enough resources to make that offer.');
      return;
    }
    setSubmitting(true);
    const payload = {
      offer, request,
      offer_pacts: offerPacts,
      request_pacts: requestPacts,
      note: note.trim() || undefined,
    };
    const res = isCounter
      ? await api.counter(original!.id, payload)
      : await api.propose({ ...payload, responder_faction_id: responderId });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error?.message ?? 'Failed to send offer');
      return;
    }
    onSuccess();
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'JetBrains Mono', monospace",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'rgba(10, 14, 20, 0.98)',
          border: '1px solid #2a3d50',
          borderRadius: 4,
          width: 540, maxWidth: '95vw', maxHeight: '92vh',
          overflow: 'auto',
          boxShadow: '0 16px 64px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 16px', borderBottom: '1px solid #2a3d50',
          background: 'rgba(255, 184, 77, 0.05)',
        }}>
          <div>
            <div style={{
              fontSize: 13, fontWeight: 700, color: '#ffb84d',
              letterSpacing: '0.18em', textTransform: 'uppercase',
            }}>
              {isCounter ? 'Counter Offer' : 'New Trade Offer'}
            </div>
            <div style={{ fontSize: 10, color: '#b8c8d6', marginTop: 2 }}>
              {isCounter ? 'Modify terms and send back' : 'Propose terms to another faction'}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: '1px solid #2a3d50',
              color: '#b8c8d6', cursor: 'pointer', fontSize: 14,
              padding: 0, width: 24, height: 24, borderRadius: 3,
            }}
          >✕</button>
        </div>

        <form onSubmit={submit} style={{ padding: 16, color: '#d8e4ee', fontSize: 11 }}>
          {!isCounter && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, color: '#b8c8d6', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>
                Negotiating with
              </div>
              <select
                className="mp-select"
                value={responderId}
                onChange={(e) => setResponderId(e.target.value)}
                style={{ width: '100%' }}
              >
                {factions.filter((f) => f.id !== me.id).map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
          )}
          {isCounter && (
            <div style={{ marginBottom: 12, fontSize: 10, color: '#b8c8d6' }}>
              Replying to{' '}
              <span style={{ color: responderColor, fontWeight: 600 }}>{responderName}</span>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <ColumnEditor
              title="You give"
              titleColor="#ffb84d"
              bundle={offer}
              pacts={offerPacts}
              onResource={(k, v) => updateBundle('offer', k, v)}
              onTogglePact={(p) => togglePact('offer', p)}
              hint={me ? `Your stockpile: ${RESOURCE_KEYS.map(k => `${me[k]} ${k}`).join(' · ')}` : undefined}
              overspend={overspend}
            />
            <ColumnEditor
              title="They give"
              titleColor="#4ecdc4"
              bundle={request}
              pacts={requestPacts}
              onResource={(k, v) => updateBundle('request', k, v)}
              onTogglePact={(p) => togglePact('request', p)}
            />
          </div>

          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 9, color: '#b8c8d6', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>
              Note (optional)
            </div>
            <textarea
              className="mp-textarea"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
              style={{ width: '100%' }}
              placeholder="Add a message to the offer…"
            />
          </div>

          {error && (
            <div className="mp-error" style={{ marginTop: 8 }}>{error}</div>
          )}

          <div style={{
            display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end',
          }}>
            <button
              type="button"
              className="mp-btn"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="mp-btn-primary"
              disabled={!canSubmit || hasOverspend}
            >
              {isCounter ? 'Send Counter' : 'Send Offer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------

function ColumnEditor({
  title, titleColor, bundle, pacts, onResource, onTogglePact, hint, overspend,
}: {
  title: string;
  titleColor: string;
  bundle: ResourceBundle;
  pacts: PactKind[];
  onResource: (k: keyof ResourceBundle, v: number) => void;
  onTogglePact: (p: PactKind) => void;
  hint?: string;
  overspend?: Partial<Record<keyof ResourceBundle, number>>;
}) {
  return (
    <div style={{
      border: '1px solid #2a3d50',
      borderRadius: 3,
      padding: 10,
      background: 'rgba(78, 205, 196, 0.03)',
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700, color: titleColor,
        letterSpacing: '0.12em', textTransform: 'uppercase',
        marginBottom: 8, paddingBottom: 4,
        borderBottom: '1px solid #2a3d50',
      }}>
        {title}
      </div>

      {RESOURCE_KEYS.map((k) => {
        const isOver = overspend && overspend[k] != null;
        return (
          <div key={k} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 4,
          }}>
            <span style={{ color: RESOURCE_COLORS[k], fontSize: 10 }}>
              {RESOURCE_LABELS[k]}
            </span>
            <input
              type="number"
              min={0}
              value={bundle[k]}
              onChange={(e) => onResource(k, Number(e.target.value))}
              style={{
                width: 64, padding: '3px 6px',
                background: 'rgba(10, 14, 20, 0.6)',
                border: `1px solid ${isOver ? '#ff5e5e' : '#2a3d50'}`,
                color: isOver ? '#ff5e5e' : '#d8e4ee',
                fontFamily: 'inherit', fontSize: 10,
                borderRadius: 2, textAlign: 'right',
                outline: 'none',
              }}
            />
          </div>
        );
      })}

      <div style={{
        fontSize: 9, color: '#b8c8d6', letterSpacing: '0.1em',
        textTransform: 'uppercase', marginTop: 8, marginBottom: 4,
      }}>
        Pacts
      </div>
      {PACT_KINDS_ORDER.map((p) => {
        const selected = pacts.includes(p);
        return (
          <label
            key={p}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 10, padding: '2px 0', cursor: 'pointer',
              color: selected ? '#4ecdc4' : '#a8b8c8',
            }}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onTogglePact(p)}
            />
            {PACT_LABELS[p]}
          </label>
        );
      })}

      {hint && (
        <div style={{ fontSize: 8, color: '#b8c8d6', marginTop: 6, fontStyle: 'italic' }}>
          {hint}
        </div>
      )}
    </div>
  );
}
