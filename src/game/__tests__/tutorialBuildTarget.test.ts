// A friend tried the tutorial on a phone and could not play it: on the two
// "build a corvette" steps the card sat on top of the corvette's BUILD
// button (it kept off the whole shipyard panel, found no clear side, and
// took the top edge, which is exactly where the first row is). The steps now
// point at that one button once the yard is open, so the card keeps off IT.
import fs from 'fs';
import path from 'path';
import { TUTORIAL_STEPS, TRIAL_TUTORIAL_STEPS } from '../tutorialSteps';

const overlay = fs.readFileSync(path.join(__dirname, '../../multiplayer/WorldMenuOverlay.tsx'), 'utf8');

describe('the tutorial points at the corvette BUILD button itself', () => {
  const buildSteps = [...TUTORIAL_STEPS, ...TRIAL_TUTORIAL_STEPS]
    .filter(s => s.target === 'wm-build' && s.task?.check === 'ship-queued');

  it('finds both build-a-corvette steps', () => {
    expect(buildSteps.map(s => s.id)).toEqual(expect.arrayContaining(['build-ship', 'trial-defend']));
  });

  it.each(['build-ship', 'trial-defend'])('%s hands the ring to the corvette BUILD button', (id) => {
    const step = [...TUTORIAL_STEPS, ...TRIAL_TUTORIAL_STEPS].find(s => s.id === id)!;
    expect(step.thenTarget).toBe('wm-build-corvette');
  });

  it('both the phone and the desktop BUILD buttons carry that anchor', () => {
    const marked = overlay.match(/data-testid=\{`wm-ship-\$\{cls\}`\} data-tutorial-id=\{cls === 'corvette' \? 'wm-build-corvette' : undefined\}/g) ?? [];
    expect(marked).toHaveLength(2);
  });
});
