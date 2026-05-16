// ============================================================
// ErrorBoundary — catches render/lifecycle errors anywhere in
// its subtree, logs them, and shows a recoverable fallback so
// the whole app doesn't disappear into a white screen.
//
// Mount this near the top of the React tree (above AppShell)
// so it captures crashes in any panel, the canvas, multiplayer
// chrome, etc. Without it, a bug in render code triggers an
// uncaught error that React already handled internally and the
// user sees a blank page with no log entry to explain why.
// ============================================================

import React from 'react';
import { logger } from '../game/logger';

interface Props {
  children: React.ReactNode;
  /** Optional label so the log knows which subtree crashed. */
  scope?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    logger.error('SYSTEM', `React render error${this.props.scope ? ` in ${this.props.scope}` : ''}: ${error.message}`, {
      stack: error.stack?.slice(0, 600),
      componentStack: info.componentStack?.slice(0, 600) ?? undefined,
    });
  }

  reset = () => {
    logger.info('SYSTEM', 'User reset error boundary');
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(5, 8, 12, 0.96)',
        color: '#d8e4ee',
        fontFamily: "'JetBrains Mono', monospace",
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}>
        <div style={{
          maxWidth: 520,
          width: '100%',
          background: '#0e1620',
          border: '1px solid #ff5e5e',
          borderRadius: 6,
          padding: 24,
        }}>
          <div style={{
            fontSize: 14,
            fontWeight: 700,
            color: '#ff5e5e',
            letterSpacing: '0.12em',
            marginBottom: 12,
            fontFamily: "'Orbitron', 'JetBrains Mono', monospace",
          }}>
            ⚠ SOMETHING BROKE
          </div>
          <div style={{ fontSize: 11, color: '#8aa0b4', marginBottom: 12, lineHeight: 1.5 }}>
            The UI hit an error and rendered this fallback so the whole
            app doesn't disappear. The crash has been written to the
            diagnostic log — open the side menu and click <strong>Download Log</strong>
            to grab the full trace.
          </div>
          <div style={{
            background: 'rgba(255, 94, 94, 0.08)',
            border: '1px solid rgba(255, 94, 94, 0.3)',
            borderRadius: 4,
            padding: '8px 10px',
            fontSize: 11,
            color: '#ff8a8a',
            wordBreak: 'break-word',
            maxHeight: 140,
            overflow: 'auto',
          }}>
            {this.state.error.message}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
            <button
              onClick={this.reset}
              style={{
                flex: 1,
                padding: '12px 16px',
                background: 'rgba(78, 205, 196, 0.15)',
                border: '1px solid #4ecdc4',
                color: '#4ecdc4',
                borderRadius: 4,
                fontFamily: 'inherit',
                fontSize: 11,
                letterSpacing: '0.12em',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              TRY AGAIN
            </button>
            <button
              onClick={() => {
                logger.info('SYSTEM', 'User reloaded page from error boundary');
                window.location.reload();
              }}
              style={{
                flex: 1,
                padding: '12px 16px',
                background: 'transparent',
                border: '1px solid #2a3d50',
                color: '#d8e4ee',
                borderRadius: 4,
                fontFamily: 'inherit',
                fontSize: 11,
                letterSpacing: '0.12em',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              RELOAD PAGE
            </button>
          </div>
        </div>
      </div>
    );
  }
}
