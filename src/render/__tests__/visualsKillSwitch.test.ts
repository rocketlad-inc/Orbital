// THE SERVER'S VISUALS KILL SWITCH MUST NOT TOUCH A PLAYER'S OWN CHOICE.
//
// The "minimal" switch (admin Bot tab, sent on every /state as
// game.visuals.minimal) puts every player in lightweight mode at once.
// It has to come off as cleanly as it went on: never saved to the device
// (or it would outlive the switch), and never clearing lightweight for a
// player who chose it themselves.

import { isLightweight, setLightweight, setServerLightweight } from '../lightweightMode';

const KEY = 'orbital:lightweight';

afterEach(() => {
  setServerLightweight(false);
  setLightweight(false);
});

describe('server visuals kill switch', () => {
  it('forces lightweight on and off without saving it to the device', () => {
    expect(isLightweight()).toBe(false);
    setServerLightweight(true);
    expect(isLightweight()).toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(document.body.classList.contains('lightweight')).toBe(true);
    setServerLightweight(false);
    expect(isLightweight()).toBe(false);
    expect(document.body.classList.contains('lightweight')).toBe(false);
  });

  it('leaves a player who chose lightweight in it when the switch goes off', () => {
    setLightweight(true);
    setServerLightweight(true);
    setServerLightweight(false);
    expect(isLightweight()).toBe(true);
    expect(localStorage.getItem(KEY)).toBe('1');
  });
});
