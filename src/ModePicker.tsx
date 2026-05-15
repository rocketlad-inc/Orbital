import React from 'react';
import { useAuth } from './multiplayer/AuthContext';
import { RoomSummary } from './multiplayer/api';

export type GameMode = 'singleplayer' | 'multiplayer';

interface ModePickerProps {
  activeRooms: RoomSummary[];
  onPick: (mode: GameMode) => void;
}

export function ModePicker({ activeRooms, onPick }: ModePickerProps) {
  const { user, signOut } = useAuth();
  const inProgress = activeRooms.filter(r => r.game_status === 'active');
  const waiting = activeRooms.filter(r => r.game_status !== 'active');

  return (
    <div className="mp-overlay">
      <div className="mp-card mode-picker-card">
        <header className="mode-picker__header">
          <div>
            <div className="mode-picker__title">ORBITAL</div>
            <div className="mode-picker__welcome">
              Welcome back, <strong>{user?.display_name || user?.email}</strong>
            </div>
          </div>
          <button className="mode-picker__signout" onClick={signOut} title="Sign out">
            Sign out
          </button>
        </header>

        {(inProgress.length > 0 || waiting.length > 0) && (
          <section className="mode-picker__section">
            <h3 className="mode-picker__heading">RESUME</h3>
            {inProgress.map(r => (
              <button
                key={r.id}
                className="mode-picker__resume mode-picker__resume--active"
                onClick={() => onPick('multiplayer')}
              >
                <div className="mode-picker__resume-name">{r.name}</div>
                <div className="mode-picker__resume-meta">
                  In progress · {r.member_count}/{r.max_players} players
                </div>
              </button>
            ))}
            {waiting.map(r => (
              <button
                key={r.id}
                className="mode-picker__resume"
                onClick={() => onPick('multiplayer')}
              >
                <div className="mode-picker__resume-name">{r.name}</div>
                <div className="mode-picker__resume-meta">
                  Lobby · {r.member_count}/{r.max_players} players
                </div>
              </button>
            ))}
          </section>
        )}

        <section className="mode-picker__section">
          <h3 className="mode-picker__heading">NEW GAME</h3>
          <div className="mode-picker__choices">
            <button
              className="mode-picker__choice"
              onClick={() => onPick('singleplayer')}
            >
              <div className="mode-picker__choice-title">Single Player</div>
              <div className="mode-picker__choice-desc">
                Local sandbox. Pick a scenario and play. Nothing is saved or shared.
              </div>
            </button>
            <button
              className="mode-picker__choice mode-picker__choice--primary"
              onClick={() => onPick('multiplayer')}
            >
              <div className="mode-picker__choice-title">Multiplayer Lobby</div>
              <div className="mode-picker__choice-desc">
                Join an open room or host your own. 2–8 players.
              </div>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
