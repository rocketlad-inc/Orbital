import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch, Faction, MyFaction } from './api';

export function FactionPanel({ gameId }: { gameId: string }) {
  const [me, setMe] = useState<MyFaction | null>(null);
  const [roster, setRoster] = useState<Faction[]>([]);

  const refresh = useCallback(async () => {
    const [meRes, listRes] = await Promise.all([
      apiFetch<{ faction: MyFaction }>(`/api/games/${gameId}/me`),
      apiFetch<{ factions: Faction[] }>(`/api/games/${gameId}/factions`),
    ]);
    if (meRes.ok) setMe(meRes.data.faction);
    if (listRes.ok) setRoster(listRes.data.factions);
  }, [gameId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!me) return <div className="mp-empty">Loading faction…</div>;

  return (
    <div>
      <div className="mp-section-title">Your empire</div>
      <div className="mp-row" style={{ gap: 8 }}>
        <span className="mp-swatch" style={{ background: me.color }} />
        <strong style={{ fontSize: 13 }}>{me.name}</strong>
      </div>
      <div className="mp-resource-grid">
        <div className="mp-resource-tile"><div className="label">Metal</div><div className="value">{me.metal}</div></div>
        <div className="mp-resource-tile"><div className="label">Fuel</div><div className="value">{me.fuel}</div></div>
        <div className="mp-resource-tile"><div className="label">Gold</div><div className="value">{me.gold}</div></div>
        <div className="mp-resource-tile"><div className="label">Science</div><div className="value">{me.science}</div></div>
      </div>

      <div className="mp-section-title" style={{ marginTop: 12 }}>Other factions</div>
      {roster.filter((f) => f.id !== me.id).map((f) => (
        <div key={f.id} className="mp-presence-row">
          <span className="mp-swatch" style={{ background: f.color }} />
          <span style={{ textDecoration: f.status === 'eliminated' ? 'line-through' : 'none' }}>
            {f.name}
          </span>
          <span className="meta" style={{ marginLeft: 'auto', color: 'var(--mp-fg-dim)', fontSize: 9 }}>
            ★ {f.senate_weight}
          </span>
        </div>
      ))}
    </div>
  );
}
