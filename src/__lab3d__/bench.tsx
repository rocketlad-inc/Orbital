// TEMPORARY component bench — not shipped.
//
// Each element on its own, at a size it can actually be judged at:
// hulls, effects, and the world under the light rig. Fixing pieces
// inside a whole battle scene means never knowing which change did what.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { hullGeometry } from '../render3d/hullGeometry';
import {
  Billboards, Tracers, drawBlast, drawPlume, hullMaterial, spaceEnv,
} from '../render3d/fx3d';
import { makeWorld } from '../render3d/planetSphere';
import mars from './mars.json';

const W = 1280, H = 720;
const canvas = document.createElement('canvas');
canvas.width = W; canvas.height = H;
canvas.style.width = W + 'px';
document.body.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.setClearColor(0x03050a, 1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 8000);

const composer = new EffectComposer(renderer);
composer.setPixelRatio(1);
composer.setSize(W, H);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.9, 0.6, 0.75);
composer.addPass(bloom);

// ---- the light rig, shared by every bench ----------------------------
// Key from one side, a cool fill from the other so the shadow side keeps
// its form, and a rim from behind to separate hulls from black.
const key = new THREE.DirectionalLight(0xfff1dc, 3.0);
key.position.set(-6, 5, 7);
scene.add(key);
const fill = new THREE.DirectionalLight(0x4d7ab5, 0.85);
fill.position.set(7, -2, 3);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xbfd8ff, 2.2);
rim.position.set(3, 4, -8);
scene.add(rim);
scene.add(new THREE.AmbientLight(0x2b3d55, 0.5));

scene.environment = spaceEnv(renderer);
const bb = new Billboards(scene);
const tr = new Tracers(scene);
const holder = new THREE.Group();
scene.add(holder);

function clearHolder() {
  for (const c of [...holder.children]) {
    holder.remove(c);
    const m = c as THREE.Mesh;
    if (m.material) (m.material as THREE.Material).dispose?.();
  }
}

const GOLD = '#ffca28', PINK = '#ec407a';

// ---- benches ----------------------------------------------------------
function benchShips() {
  clearHolder();
  camera.position.set(0, 3.6, 12.5);
  camera.lookAt(0, 0, 0);
  camera.fov = 40; camera.updateProjectionMatrix();
  const picks: Array<[any, any]> = [
    ['corvette', 'A'], ['corvette', 'F'], ['frigate', 'C'],
    ['destroyer', 'B'], ['destroyer', 'K'], ['freighter', 'A'],
  ];
  picks.forEach(([cls, v], i) => {
    const m = new THREE.Mesh(hullGeometry(cls, v), hullMaterial(i % 2 ? PINK : GOLD));
    m.scale.setScalar(3.6);
    m.position.set(((i % 3) - 1) * 4.6, i < 3 ? 1.9 : -1.9, 0);
    m.rotation.set(0.18, -0.55, 0.06);
    holder.add(m);
  });
  bb.begin(); tr.begin();
  // Engines lit, because a hull with dark engine bells reads as a hulk.
  picks.forEach(([, ], i) => {
    const p = new THREE.Vector3(((i % 3) - 1) * 4.6, i < 3 ? 1.9 : -1.9, 0);
    const back = new THREE.Vector3(-Math.cos(-0.55), 0, Math.sin(-0.55)).multiplyScalar(-1);
    drawPlume(tr, bb, p.clone().add(back.clone().multiplyScalar(1.75)), back, 0.55,
      i % 2 ? PINK : GOLD, 1, camera);
  });
  bb.end(); tr.end();
}

function benchFx(step: number) {
  clearHolder();
  camera.position.set(0, 0, 44);
  camera.lookAt(0, 0, 0);
  camera.fov = 40; camera.updateProjectionMatrix();
  bb.begin();
  tr.begin();
  // Top row: one blast across its whole life.
  for (let i = 0; i < 5; i++) {
    const k = 0.06 + i * 0.22;
    drawBlast(bb, new THREE.Vector3((i - 2) * 12, 8.5, 0), k, 2.6, 11 + i);
  }
  // Middle: tracers at three lengths, both factions.
  for (let i = 0; i < 3; i++) {
    const y = -1.5;
    const x0 = (i - 1) * 13 - 4.5, x1 = x0 + 4 + i * 2.6;
    tr.put(new THREE.Vector3(x0, y, 0), new THREE.Vector3(x1, y, 0),
      0.85, i % 2 ? PINK : GOLD, 1, camera);
  }
  // Bottom: plumes at three throttles.
  for (let i = 0; i < 3; i++) {
    const p = new THREE.Vector3((i - 1) * 13, -10, 0);
    drawPlume(tr, bb, p, new THREE.Vector3(-1, 0, 0), 2.2, GOLD, 0.35 + i * 0.32, camera);
  }
  void step;
  bb.end(); tr.end();
}

function benchWorld() {
  clearHolder();
  const body = (mars as any).bodies.find((b: any) => /mars$/.test(b.id)) ?? (mars as any).bodies[0];
  // The same module the stage uses, so the bench judges the real thing.
  const sphere = makeWorld(String(body.id).split(':').pop()!, body.color || '#b06a3f', 10, false);
  holder.add(sphere);
  // A hull for scale, so the world can be judged against something.
  const ship = new THREE.Mesh(hullGeometry('destroyer', 'B'), hullMaterial(GOLD));
  ship.scale.setScalar(2.4);
  ship.position.set(9, -3.5, 13);
  ship.rotation.set(0.1, -0.7, 0);
  holder.add(ship);
  camera.position.set(0, 4, 30);
  camera.lookAt(0, 0, 0);
  camera.fov = 42; camera.updateProjectionMatrix();
  bb.begin();
  tr.begin();
  drawPlume(tr, bb, new THREE.Vector3(10.6, -3.5, 12.4),
    new THREE.Vector3(1, 0, -0.3), 0.9, GOLD, 1, camera);
  bb.end(); tr.end();
}

const MODES: Record<string, () => void> = {
  ships: benchShips,
  fx: () => benchFx(0),
  world: benchWorld,
};

(window as any).__bench = (mode: string) => {
  (MODES[mode] ?? benchShips)();
  composer.render();
  return fetch('http://127.0.0.1:5079/', {
    method: 'POST', body: `bench_${mode}.png|` + canvas.toDataURL('image/png'),
  });
};
(window as any).__ready = true;
benchShips();
composer.render();
