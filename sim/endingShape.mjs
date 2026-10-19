// ============================================================================
// Runtime shape check for the ending payload, driven by the CONTRACT TEXT.
//
// src/multiplayer/endingTypes.ts is the contract. TypeScript types vanish at
// runtime, so nothing stops worker/ending.js from drifting away from them (a
// renamed key, a field left out, a stray extra one) until the page misrenders.
// This module closes that gap: it PARSES endingTypes.ts (interfaces, the
// EndingAwardId union, optional markers, Record/Array/inline-object types) and
// validates a payload against what it finds there. Add a field to the .ts and
// the check demands it; there is no second hand-kept list to forget.
//
// Used by sim/ending.mjs (the server sim) and by the fixture jest test
// (src/multiplayer/__tests__/endingFixtures.test.ts), so the real-data fixtures and the
// producer are held to the same contract.
//
// checkEndingShape(payload, contractSource) -> string[]   (empty = conforms)
// checkEndingInvariants(payload)            -> string[]   (rules the type can't say)
// ============================================================================

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:('(?:[^'\\]|\\.)*')|([A-Za-z_][A-Za-z0-9_]*)|([{}[\]<>,;:|?()]))/gy;
  let m;
  let last = 0;
  while ((m = re.exec(src)) !== null) {
    last = re.lastIndex;
    if (m[1]) tokens.push({ t: 'lit', v: m[1].slice(1, -1) });
    else if (m[2]) tokens.push({ t: 'id', v: m[2] });
    else tokens.push({ t: 'p', v: m[3] });
  }
  if (src.slice(last).trim()) throw new Error(`contract tokenizer stuck near: ${src.slice(last, last + 40)}`);
  return tokens;
}

class Parser {
  constructor(tokens) { this.tokens = tokens; this.i = 0; }
  peek() { return this.tokens[this.i]; }
  next() { return this.tokens[this.i++]; }
  isP(v) { const t = this.peek(); return t && t.t === 'p' && t.v === v; }
  expectP(v) {
    const t = this.next();
    if (!t || t.t !== 'p' || t.v !== v) throw new Error(`contract parse: expected '${v}', got ${JSON.stringify(t)}`);
  }
  union() {
    if (this.isP('|')) this.next();                 // leading bar
    const parts = [this.postfix()];
    while (this.isP('|')) { this.next(); parts.push(this.postfix()); }
    return parts.length === 1 ? parts[0] : { k: 'union', of: parts };
  }
  postfix() {
    let node = this.primary();
    while (this.isP('[')) { this.next(); this.expectP(']'); node = { k: 'array', of: node }; }
    return node;
  }
  primary() {
    const t = this.next();
    if (!t) throw new Error('contract parse: unexpected end');
    if (t.t === 'lit') return { k: 'lit', v: t.v };
    if (t.t === 'p' && t.v === '{') return this.members();
    if (t.t === 'p' && t.v === '(') { const n = this.union(); this.expectP(')'); return n; }
    if (t.t !== 'id') throw new Error(`contract parse: unexpected ${JSON.stringify(t)}`);
    if (t.v === 'Record') {
      this.expectP('<'); this.union(); this.expectP(','); const of = this.union(); this.expectP('>');
      return { k: 'record', of };
    }
    if (t.v === 'Array') { this.expectP('<'); const of = this.union(); this.expectP('>'); return { k: 'array', of }; }
    if (['number', 'string', 'boolean', 'null'].includes(t.v)) return { k: t.v };
    return { k: 'ref', name: t.v };
  }
  /** After '{': members until '}'. */
  members() {
    const fields = [];
    while (!this.isP('}')) {
      const name = this.next();
      if (!name || name.t !== 'id') throw new Error(`contract parse: field name expected, got ${JSON.stringify(name)}`);
      let optional = false;
      if (this.isP('?')) { this.next(); optional = true; }
      this.expectP(':');
      const type = this.union();
      fields.push({ name: name.v, optional, type });
      if (this.isP(';') || this.isP(',')) this.next();
    }
    this.expectP('}');
    return { k: 'object', fields };
  }
}

/** { name -> typeNode } for every `export interface` / `export type` in the source. */
export function parseContract(source) {
  const src = stripComments(source);
  const defs = {};
  const re = /export\s+(interface|type)\s+(\w+)\s*(=)?\s*/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const rest = src.slice(re.lastIndex);
    let end;
    if (m[1] === 'interface') {
      // find the matching close brace of the interface body
      let depth = 0; let i = rest.indexOf('{');
      const start = i;
      for (; i < rest.length; i++) {
        if (rest[i] === '{') depth++;
        else if (rest[i] === '}') { depth--; if (depth === 0) { i++; break; } }
      }
      end = i;
      const p = new Parser(tokenize(rest.slice(start, end)));
      p.expectP('{');
      defs[m[2]] = p.members();
    } else {
      end = rest.indexOf(';');
      const p = new Parser(tokenize(rest.slice(0, end)));
      defs[m[2]] = p.union();
    }
    re.lastIndex += end;
  }
  return defs;
}

function validate(value, node, defs, path, errs) {
  switch (node.k) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) errs.push(`${path}: expected number, got ${JSON.stringify(value)}`);
      return;
    case 'string':
      if (typeof value !== 'string') errs.push(`${path}: expected string, got ${JSON.stringify(value)}`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') errs.push(`${path}: expected boolean, got ${JSON.stringify(value)}`);
      return;
    case 'null':
      if (value !== null) errs.push(`${path}: expected null, got ${JSON.stringify(value)}`);
      return;
    case 'lit':
      if (value !== node.v) errs.push(`${path}: expected '${node.v}', got ${JSON.stringify(value)}`);
      return;
    case 'ref': {
      const def = defs[node.name];
      if (!def) { errs.push(`${path}: contract references unknown type ${node.name}`); return; }
      validate(value, def, defs, path, errs);
      return;
    }
    case 'union': {
      for (const alt of node.of) {
        const sub = [];
        validate(value, alt, defs, path, sub);
        if (!sub.length) return;
      }
      errs.push(`${path}: ${JSON.stringify(value)} matches none of the union alternatives`);
      return;
    }
    case 'array':
      if (!Array.isArray(value)) { errs.push(`${path}: expected array`); return; }
      value.forEach((v, i) => validate(v, node.of, defs, `${path}[${i}]`, errs));
      return;
    case 'record':
      if (!value || typeof value !== 'object' || Array.isArray(value)) { errs.push(`${path}: expected record`); return; }
      for (const [k, v] of Object.entries(value)) validate(v, node.of, defs, `${path}.${k}`, errs);
      return;
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { errs.push(`${path}: expected object`); return; }
      const known = new Set(node.fields.map(f => f.name));
      for (const k of Object.keys(value)) if (!known.has(k)) errs.push(`${path}.${k}: not in the contract`);
      for (const f of node.fields) {
        if (!(f.name in value) || value[f.name] === undefined) {
          if (!f.optional) errs.push(`${path}.${f.name}: required by the contract, missing`);
          continue;
        }
        validate(value[f.name], f.type, defs, `${path}.${f.name}`, errs);
      }
      return;
    }
    default:
      errs.push(`${path}: unhandled contract node ${node.k}`);
  }
}

export function checkEndingShape(payload, contractSource) {
  const defs = parseContract(contractSource);
  if (!defs.EndingPayload) return ['contract has no EndingPayload interface'];
  const errs = [];
  validate(payload, { k: 'ref', name: 'EndingPayload' }, defs, '$', errs);
  return errs;
}

/** Things the type system can't say but the page depends on. */
export function checkEndingInvariants(p) {
  const errs = [];
  const ids = new Set(p.factions.map(f => f.id));
  if (ids.size !== p.factions.length) errs.push('duplicate faction ids');
  p.factions.forEach((f, i) => { if (f.place !== i + 1) errs.push(`factions[${i}] place ${f.place} != ${i + 1}`); });
  const winners = p.factions.filter(f => f.isWinner);
  if (p.game.winnerFactionId) {
    if (winners.length !== 1 || winners[0].id !== p.game.winnerFactionId) errs.push('isWinner does not match game.winnerFactionId');
    else if (p.factions[0].id !== p.game.winnerFactionId) errs.push('winner is not in first place');
  } else if (winners.length) errs.push('isWinner set with no winnerFactionId');
  if (p.factions.filter(f => f.isMe).length > 1) errs.push('more than one isMe');
  for (const f of p.factions) {
    if (f.finalStatus === 'active' && f.eliminatedAtTick != null) errs.push(`${f.id}: active but eliminatedAtTick set`);
    if (f.peak.holdings < f.final.holdings || f.peak.ships < f.final.ships || f.peak.credits < f.final.credits) {
      errs.push(`${f.id}: peak below final`);
    }
  }
  const seen = new Set();
  for (const a of p.awards) {
    if (seen.has(a.id)) errs.push(`award ${a.id} twice`);
    seen.add(a.id);
    if (!ids.has(a.factionId)) errs.push(`award ${a.id}: unknown faction ${a.factionId}`);
    if (!(a.value > 0) || !Number.isInteger(a.value)) errs.push(`award ${a.id}: value ${a.value} is not a positive whole number`);
    if (a.runnerUp) {
      if (!ids.has(a.runnerUp.factionId)) errs.push(`award ${a.id}: unknown runner-up`);
      if (!(a.runnerUp.value > 0) || a.runnerUp.value > a.value) errs.push(`award ${a.id}: runner-up value ${a.runnerUp.value} invalid`);
      if (a.runnerUp.factionId === a.factionId) errs.push(`award ${a.id}: runner-up is the winner`);
    }
    const hull = ['ace', 'heavy_hitter', 'iron_wall', 'last_stand'].includes(a.id);
    if (hull !== !!a.ship) errs.push(`award ${a.id}: ship ${hull ? 'missing' : 'present'}`);
  }
  const s = p.series;
  const n = s.ticks.length;
  if (n > 120) errs.push(`series has ${n} points (> 120)`);
  for (let i = 1; i < n; i++) if (!(s.ticks[i] > s.ticks[i - 1])) errs.push('series ticks not strictly increasing');
  for (const key of ['holdings', 'ships', 'credits', 'science']) {
    const have = Object.keys(s[key]);
    if (have.length !== ids.size || have.some(k => !ids.has(k))) errs.push(`series.${key} keys != factions`);
    for (const [k, arr] of Object.entries(s[key])) if (arr.length !== n) errs.push(`series.${key}.${k} length ${arr.length} != ${n}`);
  }
  if (n && s.ticks[n - 1] > p.game.currentTick) errs.push('series runs past currentTick');
  if (p.battles.length > 3) errs.push('more than three battles');
  p.battles.forEach((b, i) => {
    if (i && p.battles[i - 1].shipsLost < b.shipsLost) errs.push('battles not ordered by hulls lost');
    for (const l of b.lossesByFaction) {
      if (!ids.has(l.factionId) || !(l.shipsLost > 0)) errs.push(`battle ${b.id}: bad loss entry`);
    }
  });
  const text = JSON.stringify(p);
  if (/@/.test(text)) errs.push('payload contains an @ (email?)');
  return errs;
}
