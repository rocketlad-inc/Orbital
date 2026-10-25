import { tradeToastFor } from '../tradeToast';

// The Play for Free trial, tick 1: the Ally (f1) offers pacts to the
// player (f0) and the Warlord (f2); the Warlord declines its own.
describe('tradeToastFor: only trade news addressed to this player', () => {
  const me = 'g:f0';
  it('an offer to me toasts', () => {
    expect(tradeToastFor({ event: 'proposed', proposer_faction_id: 'g:f1', responder_faction_id: me }, me)).toBe('offer');
  });
  it('an offer between two others is silent', () => {
    expect(tradeToastFor({ event: 'proposed', proposer_faction_id: 'g:f1', responder_faction_id: 'g:f2' }, me)).toBeNull();
  });
  it('another empire declining someone else\'s offer is silent (the phantom "Trade declined")', () => {
    expect(tradeToastFor({ event: 'declined', proposer_faction_id: 'g:f1', responder_faction_id: 'g:f2' }, me)).toBeNull();
  });
  it('my own answers are silent; answers to my offers toast', () => {
    expect(tradeToastFor({ event: 'declined', proposer_faction_id: 'g:f1', responder_faction_id: me }, me)).toBeNull();
    expect(tradeToastFor({ event: 'declined', proposer_faction_id: me, responder_faction_id: 'g:f1' }, me)).toBe('declined');
    expect(tradeToastFor({ event: 'accepted', proposer_faction_id: me, responder_faction_id: 'g:f1' }, me)).toBe('accepted');
    expect(tradeToastFor({ event: 'accepted', proposer_faction_id: 'g:f1', responder_faction_id: 'g:f2' }, me)).toBeNull();
  });
  it('a counter toasts only the empire it is addressed to', () => {
    expect(tradeToastFor({ event: 'countered', proposer_faction_id: 'g:f1', responder_faction_id: me }, me)).toBe('countered');
    expect(tradeToastFor({ event: 'countered', proposer_faction_id: 'g:f1', responder_faction_id: 'g:f2' }, me)).toBeNull();
  });
  it('nothing before we know who we are', () => {
    expect(tradeToastFor({ event: 'proposed', proposer_faction_id: 'g:f1', responder_faction_id: me }, null)).toBeNull();
  });
});
