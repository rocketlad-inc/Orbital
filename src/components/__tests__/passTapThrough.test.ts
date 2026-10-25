/**
 * With the menu drawer open, a tap on a rail button only closed the
 * drawer; the panel took a second tap (round 2, Leo, Rafaela, Maya).
 */
import { passTapThrough } from '../passTapThrough';

describe('passTapThrough', () => {
  const realEfp = (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
  afterEach(() => {
    (document as unknown as { elementFromPoint?: unknown }).elementFromPoint = realEfp;
    document.body.innerHTML = '';
    jest.useRealTimers();
  });

  function setup(under: (bd: HTMLElement) => Element | null) {
    document.body.innerHTML = `
      <div class="top-bar"><button class="top-bar__title">ORBITAL</button><button class="solo">Start</button></div>
      <div class="dock-rail"><button aria-label="Research"><svg><path/></svg></button></div>
      <div class="side-menu__backdrop"></div>`;
    const bd = document.querySelector('.side-menu__backdrop') as HTMLElement;
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint =
      () => (bd.style.pointerEvents === 'none' ? under(bd) : bd);
    return bd;
  }

  it('presses the rail button under the dismissing tap', () => {
    jest.useFakeTimers();
    const bd = setup(() => document.querySelector('.dock-rail path'));
    const btn = document.querySelector('.dock-rail button') as HTMLButtonElement;
    const onClick = jest.fn();
    btn.addEventListener('click', onClick);
    expect(passTapThrough(bd, 10, 10)).toBe(btn);
    expect(bd.style.pointerEvents).toBe('');
    jest.runAllTimers();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('never presses the menu button, and a tap on the map presses nothing', () => {
    let bd = setup(() => document.querySelector('.top-bar__title'));
    expect(passTapThrough(bd, 10, 10)).toBeNull();
    bd = setup(() => document.body);
    expect(passTapThrough(bd, 10, 10)).toBeNull();
  });
});
