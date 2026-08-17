// Model bench: one ship, lit and framed like a product shot.
//
// Whole-scene captures hide model defects — at battle distance a hull is
// forty pixels and any silhouette passes. This renders a single hull
// large, from a three-quarter hero angle, so a reviewer is judging the
// MODEL and its material rather than the composition around it.
//
// Untracked scaffolding. Not part of the app.

import * as THREE from 'three';
import { shipGeometry, archetypeOf } from '../render3d/shipModel';
import { platedHullMaterial, spaceEnv, hullDecalMaterial, attachLivery, stripeMaterial } from '../render3d/fx3d';
import { hullProfile } from '../render3d/shipModel';
import type { ShipIconClass, ShipIconVariant } from '../components/ShipIcons';

const SINK = 'http://127.0.0.1:5079/';

/** The sink splits on the first '|': name, then the data URL. */
function post(name: string, dataUrl: string) {
  return fetch(SINK, { method: 'POST', body: `${name}|${dataUrl}` });
}

const canvas = document.createElement('canvas');
canvas.width = 1280; canvas.height = 720;
document.body.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, preserveDrawingBuffer: true,
});
renderer.setSize(1280, 720, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.86;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070c);
scene.environment = spaceEnv(renderer);

// Three-point: a hard key for shape, a cool fill so the shadow side is
// not a hole, and a rim to lift the silhouette off the background.
// Matched to the battle stage's actual lighting. The bench was running a
// 3.2 key and a 2.2 rim at exposure 1.0 -- hotter than anything a player
// sees -- and blowing flat plate to white, which three reviewers then
// reported as a broken texture. Dumping the maps settled it: albedo,
// roughness and emissive are all clean. An instrument brighter than the
// thing it measures invents defects.
const key = new THREE.DirectionalLight(0xfff4e6, 2.6);
key.position.set(-6, 4, 7); scene.add(key);
const fill = new THREE.DirectionalLight(0x5b7fa8, 0.7);
fill.position.set(7, -2, -3); scene.add(fill);
const rim = new THREE.DirectionalLight(0xcfe4ff, 1.3);
rim.position.set(4, 3, -8); scene.add(rim);
scene.add(new THREE.HemisphereLight(0x8fa8c8, 0x1a1410, 0.3));

const camera = new THREE.PerspectiveCamera(32, 16 / 9, 0.1, 500);

let current: THREE.Mesh | null = null;

/** Faction under test: primary, secondary, and a name for the hull. */
let LIVERY: { p: string; s: string; ship: string; no: string } | null = null;

async function shoot(
  cls: ShipIconClass, variant: ShipIconVariant, name: string, yaw = 0.62,
  fit = 1.25,
) {
  if (current) { scene.remove(current); current = null; }
  const lv = LIVERY ?? { p: '#7fb2e8', s: '#e8a33f', ship: '', no: '' };
  const m = new THREE.Mesh(
    shipGeometry(cls, variant),
    [platedHullMaterial(lv.p, variant), platedHullMaterial(lv.s, variant, true)],
  );
  if (LIVERY) {
    const prof = hullProfile(cls, variant);
    attachLivery(m, prof.halfBeam, prof.halfHeight,
      hullDecalMaterial(lv.ship, lv.p, lv.s, lv.no), stripeMaterial(lv.p, lv.s));
  }
  // Scaled by the SAME class-length table the battle stage uses, and
  // framed off the largest hull in the fleet rather than off this one.
  //
  // Framing each ship to fill the shot made a corvette and a destroyer
  // render the same size, and a reviewer duly reported that class does
  // not read — from renders where class could not possibly read. The
  // bench was lying; the models were not (necessarily) at fault.
  const LENGTH: Record<string, number> = {
    corvette: 10, frigate: 20, destroyer: 46, freighter: 26, colony: 36,
  };
  const BIGGEST = 46;
  m.scale.setScalar(LENGTH[cls] ?? 10);
  scene.add(m);
  current = m;

  m.geometry.computeBoundingSphere();
  const unit = m.geometry.boundingSphere?.radius ?? 0.5;
  const r = unit * BIGGEST;
  const d = r / Math.tan((camera.fov * Math.PI) / 360) * fit;
  camera.position.set(
    Math.sin(yaw) * d * 0.86, d * 0.30, Math.cos(yaw) * d * 0.86);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  // Materials resolve their canvas textures a tick late; photographing
  // before that captures the untextured fallback, which has fooled this
  // bench before.
  await new Promise(res => setTimeout(res, 60));
  renderer.render(scene, camera);
  await post(name, canvas.toDataURL('image/png'));
}

(window as any).__models = async () => {
  const set: Array<[ShipIconClass, ShipIconVariant]> = [
    ['corvette', 'A'], ['corvette', 'B'], ['corvette', 'C'],
    ['frigate', 'A'], ['frigate', 'B'], ['frigate', 'C'],
    ['destroyer', 'A'], ['destroyer', 'B'],
    ['freighter', 'A'], ['colony', 'A'],
  ];
  for (const [cls, v] of set) {
    await shoot(cls, v, `${cls}_${v}_${archetypeOf(cls, v)}.png`);
  }
  return 'done';
};

/**
 * Dump the generated maps themselves.
 *
 * Reviewers keep describing white plates the albedo cannot be producing;
 * looking at the maps settles which of the four is responsible instead
 * of another round of guessing at the shader from the outside.
 */
(window as any).__maps = async () => {
  const p: any = (platedHullMaterial('#7fb2e8', 'A') as any);
  for (const k of ['map', 'roughnessMap', 'emissiveMap', 'normalMap']) {
    const t = p[k] as THREE.Texture | null;
    if (!t?.image) continue;
    const c = document.createElement('canvas');
    c.width = t.image.width; c.height = t.image.height;
    c.getContext('2d')!.drawImage(t.image, 0, 0);
    await post(`map_${k}.png`, c.toDataURL('image/png'));
  }
  return 'done';
};

/** Stern quarter: the only angle that proves an engine deck exists. */
(window as any).__sterns = async () => {
  const set: Array<[ShipIconClass, ShipIconVariant]> = [
    ['destroyer', 'A'], ['destroyer', 'B'], ['frigate', 'B'], ['freighter', 'A'],
  ];
  for (const [cls, v] of set) await shoot(cls, v, `stern_${cls}_${v}.png`, 3.6);
  return 'done';
};

(window as any).__closeup = async () => {
  // Tight on a destroyer, to judge surface rather than silhouette.
  await shoot('destroyer', 'A', 'closeup_destroyer.png', 1.15);
  await shoot('frigate', 'A', 'closeup_frigate.png', 1.15);
  return 'done';
};

/**
 * Two rival empires, same hulls. The question this answers is not "does
 * it look nice" but "can you tell these apart, and can you read the
 * name" — so it renders the same class in both liveries, plus a close
 * pass where the type has to hold up.
 */
(window as any).__livery = async () => {
  const EMPIRES = [
    { p: '#e8483f', s: '#f2c14e', ship: 'Ardent', no: '604', tag: 'utef' },
    { p: '#4f8ff0', s: '#c9d6e8', ship: 'Sword of Nine', no: '112', tag: 'frowny' },
  ];
  const SHIPS: Array<[ShipIconClass, ShipIconVariant]> = [
    ['destroyer', 'B'], ['frigate', 'C'], ['corvette', 'A'],
  ];
  for (const e of EMPIRES) {
    for (const [cls, v] of SHIPS) {
      LIVERY = e;
      await shoot(cls, v, `livery_${e.tag}_${cls}.png`, 0.22);
    }
    // A close pass: the legibility test the wide shots cannot make.
    LIVERY = e;
    await shoot('destroyer', 'B', `livery_${e.tag}_closeup.png`, 0.12, 0.78);
  }
  LIVERY = null;
  return 'done';
};
