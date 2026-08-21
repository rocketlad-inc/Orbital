// TEMPORARY cinematic harness — not shipped.
import { createStage } from '../render3d/BattleStage';
import mars from './juno.json';

const W = 1280, H = 720;
const canvas = document.createElement('canvas');
canvas.width = W; canvas.height = H;
canvas.style.width = W + 'px';
document.body.appendChild(canvas);

const stage = createStage(mars as any, canvas);
stage.resize(W, H);
stage.setPos(0);
stage.render();

(window as any).__beats = stage.beats;
(window as any).__stats = () => JSON.stringify(stage.stats());
(window as any).__shot = (name: string, pos: number) => {
  stage.setPos(pos);
  stage.render();
  return fetch('http://127.0.0.1:5079/', {
    method: 'POST', body: name + '|' + canvas.toDataURL('image/png'),
  });
};
/**
 * A run of frames as JPEG. PNG encoding dominates a still capture at
 * roughly 600ms a frame; JPEG is several times faster, which is the
 * difference between filming the whole battle in two minutes and in
 * twenty.
 */
(window as any).__film = (i0: number, n: number, pos0: number, step: number) => {
  const out: Promise<unknown>[] = [];
  for (let k = 0; k < n; k++) {
    stage.setPos(pos0 + k * step);
    stage.render();
    const name = 'f' + String(i0 + k).padStart(4, '0') + '.jpg';
    out.push(fetch('http://127.0.0.1:5079/', {
      method: 'POST', body: name + '|' + canvas.toDataURL('image/jpeg', 0.92),
    }));
  }
  return Promise.all(out).then(() => 'ok');
};
(window as any).__ready = true;
