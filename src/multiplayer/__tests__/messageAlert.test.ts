// [pure] "New message in Comms" is for messages TO you.
//
// Lorne, 2026-09-26: sending a message pinged the sender with a "new
// message" alert for it. Every room member heard every send, private
// messages between two other players included.

import fs from 'fs';
import path from 'path';
import { messageAlertsMe } from '../messageAlert';

const ME = 'g:f0';

describe('[pure] messageAlertsMe', () => {
  it('your own broadcast does not ping you (the reported case)', () => {
    expect(messageAlertsMe({ sender_faction_id: ME, scope: 'broadcast', recipient_faction_ids: null }, ME)).toBe(false);
  });
  it('your own private message does not ping you', () => {
    expect(messageAlertsMe({ sender_faction_id: ME, scope: 'direct', recipient_faction_ids: ['g:f1'] }, ME)).toBe(false);
  });
  it('someone else\'s broadcast does', () => {
    expect(messageAlertsMe({ sender_faction_id: 'g:f1', scope: 'broadcast', recipient_faction_ids: null }, ME)).toBe(true);
  });
  it('a private message to you does', () => {
    expect(messageAlertsMe({ sender_faction_id: 'g:f1', scope: 'direct', recipient_faction_ids: [ME, 'g:f2'] }, ME)).toBe(true);
  });
  it('a private message between two other players does not', () => {
    expect(messageAlertsMe({ sender_faction_id: 'g:f1', scope: 'direct', recipient_faction_ids: ['g:f2'] }, ME)).toBe(false);
  });
  it('before we know who you are, it still pings (never miss one)', () => {
    expect(messageAlertsMe({ sender_faction_id: 'g:f1', scope: 'direct', recipient_faction_ids: ['g:f2'] }, null)).toBe(true);
  });
});

describe('the shell uses it', () => {
  it('the Comms toast and the unread badge are both behind messageAlertsMe', () => {
    const shell = fs.readFileSync(path.resolve(__dirname, '../MultiplayerShell.tsx'), 'utf8');
    const i = shell.indexOf("m?.kind === 'message'");
    const branch = shell.slice(i, shell.indexOf('} else if', i + 1));
    expect(branch).toMatch(/if \(messageAlertsMe\(m, myFactionIdRef\.current\)\) \{\s*pushToast\('message'[^]*setUnreadMessages/);
  });
});
