// ============================================================
// bodyFlavor — per-body flavor text shown in the BodyInspector.
//
// Authored prose (typically 2-3 sentences) keyed by body.id. Kept
// in its own file rather than added as a field on Body so the
// 41-row body catalog in mockGameState.ts stays focused on game
// data — orbital elements, resources, IDs — while the writing
// lives somewhere it can be edited without grepping past tables
// of numbers.
//
// To add or edit: drop a string under the body's id. Empty / missing
// entries render nothing in the inspector (no awkward placeholder),
// so you can fill these in incrementally.
//
// Voice notes:
//   - 2-3 sentences, atmospheric. Not a manual page.
//   - Hint at the body's mood, history, or what makes it worth
//     visiting / avoiding. Numbers (yields, distances) already
//     show elsewhere — don't repeat them.
//   - For bodies that CAN host hidden secrets, the flavor can
//     gesture at the possibility ("old combat satellites still
//     patrol — most are dead, but not all"). Don't author the
//     actual discovery toast; the secrets system owns those.
//   - Barycenter "bodies" (binary_barycenter, bh_barycenter) are
//     invisible markers — no flavor needed.
// ============================================================

export const BODY_FLAVOR: Record<string, string> = {
  // === Sol system ============================================
  sol: '',

  // Inner planets
  mercury: '',
  venus: '',
  earth: '',
  mars: '',
  luna: '',

  // Asteroid belt
  ceres: '',
  vesta: '',
  pallas: '',
  hygiea: '',
  juno: '',

  // Jovian system
  jupiter: '',
  io: '',
  europa: '',
  ganymede: '',
  callisto: '',

  // Saturnian system
  saturn: '',
  enceladus: '',
  rhea: '',
  titan: '',

  // Uranian system
  uranus: '',
  miranda: '',
  ariel: '',
  umbriel: '',
  titania: '',
  oberon: '',

  // Neptunian system
  neptune: '',
  proteus: '',
  triton: '',
  nereid: '',

  // Kuiper belt
  pluto: '',
  charon: '',
  haumea: '',
  makemake: '',
  quaoar: '',
  eris: '',
  sedna: '',

  // === Centauri binary system ================================
  // binary_barycenter intentionally omitted — invisible marker.
  centauri_a: '',
  centauri_b: '',
  verdant: '',
  crimson: '',
  prismara: '',
  cinder: '',
  farspire: '',

  // === Cygnus X-1 analogue ===================================
  // bh_barycenter intentionally omitted — invisible marker.
  cygnus_x: '',
  hde_226868: '',
  requiem: '',
  vellichor: '',
  echelon: '',
  reliquary: '',
};

/** Lookup helper. Returns the flavor string for a body id, or
 *  empty string if none is authored. Callers should treat empty
 *  as "render nothing" rather than a placeholder. */
export function getBodyFlavor(bodyId: string): string {
  return BODY_FLAVOR[bodyId] ?? '';
}
