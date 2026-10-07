// ============================================================
// AIActivityFeed — small bottom-left widget showing what the AI
// has been deciding. Reads from gameState.aiActivityLog (written
// by gameContext when an AI faction's decision cycle fires).
//
// Collapsible. Auto-shows recent entries; click to expand history.
// ============================================================

import React, { useState } from 'react';
import { useGameContext } from '../state/gameContext';
import { t, tn } from '../i18n/core';
import { useI18n } from '../i18n/react';
import './AIActivityFeed.css';

const KIND_GLYPH: Record<string, string> = {
  build: '▸',
  deploy: '◆',
  transfer: '→',
  research: '⚛',
  collector: '⧉',
  upgrade: '↑',
  dyson: '☀',
  idle: '·',
};

const KIND_COLOR: Record<string, string> = {
  build: '#ffb84d',
  deploy: '#6ee7b7',
  transfer: '#4ecdc4',
  research: '#67e8f9',
  collector: '#a3e635',
  upgrade: '#f59e0b',
  dyson: '#fbbf24',
  idle: '#9aaec0',
};

export const AIActivityFeed: React.FC = () => {
  useI18n();
  const { gameState } = useGameContext();
  const [collapsed, setCollapsed] = useState(false);

  const log = gameState.aiActivityLog ?? [];
  const aiFactions = gameState.factions.filter(f => f.isAI);

  // Don't render at all if there are no AI factions in this scenario.
  if (aiFactions.length === 0) return null;

  const recent = log.slice(-8).reverse();
  const factionLookup = new Map(gameState.factions.map(f => [f.id, f]));

  if (collapsed) {
    return (
      <button
        className="ai-feed ai-feed--collapsed"
        onClick={() => setCollapsed(false)}
        title={t('site.ai.show')}
      >
        <span className="ai-feed-glyph">⌬</span>
        <span className="ai-feed-collapsed-text">{t('site.ai.short')}</span>
      </button>
    );
  }

  return (
    <div className="ai-feed">
      <header className="ai-feed-head">
        <span className="ai-feed-title">
          <span className="ai-feed-glyph">⌬</span>
          {t('site.ai.title')}
        </span>
        <button
          className="ai-feed-collapse"
          onClick={() => setCollapsed(true)}
          title={t('site.ai.collapse')}
        >−</button>
      </header>

      {recent.length === 0 ? (
        <div className="ai-feed-empty">{t('site.ai.empty')}</div>
      ) : (
        <ul className="ai-feed-list">
          {recent.map(entry => {
            const faction = factionLookup.get(entry.factionId);
            const glyph = KIND_GLYPH[entry.kind] ?? '·';
            const color = KIND_COLOR[entry.kind] ?? '#9aaec0';
            return (
              <li key={entry.id} className="ai-feed-entry">
                <span className="ai-feed-tick">T+{entry.tick}</span>
                <span className="ai-feed-kind" style={{ color }}>{glyph}</span>
                <span
                  className="ai-feed-message"
                  style={{ borderLeftColor: faction?.color ?? '#888' }}
                >
                  {entry.message}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <footer className="ai-feed-foot">
        {tn('site.ai.footer', aiFactions.length, { shown: recent.length })}
      </footer>
    </div>
  );
};
