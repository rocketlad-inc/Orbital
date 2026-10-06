// ============================================================
// How far the map camera can pull out. ONE number: the wheel, pinch,
// focus-to-fit, the inspector's zoom and the transit-hull size ramp
// (MapCanvas, matchMap) all clamp or scale against it, and it lived as
// six separate 0.0012 literals until the far systems moved.
//
//   0.005  — Sol-system-only era
//   0.002  — Centauri at 60K landed
//   0.0012 — Centauri at 265K east, Cygnus X at 340K west
//   0.0006 — both DOUBLED (2026-10-06): Centauri 530K, Cygnus 680K. On
//            a 1000px canvas centred on Sol that is ±833K, so both sit
//            inside it with room for their own outer worlds and gates.
// ============================================================

export const MIN_CAMERA_SCALE = 0.0006;
