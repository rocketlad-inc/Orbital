// ============================================================
// PHYSICS SANDBOX — React entry point
// ============================================================
// Single-page playground for KSP-style maneuver planning. Mounted on
// `?physics` (see App.tsx). Owns its own tick loop, camera, and ship
// state — completely isolated from the live game's Bezier transfer
// system.
//
// Controls:
//   Wheel       — zoom (cursor-anchored)
//   Right-drag  — pan
//   Left-click  — select ship / body / node, drag node handles
//   F           — focus camera on selected ship's parent body
//   Esc         — focus the whole system
//
// Plan flow:
//   1. Select the ship (auto-selected on load)
//   2. Add a step (Periapsis / Apoapsis / +30 ticks)
//   3. Drag prograde / radial handles on the diamond
//   4. Commit individual steps (or Commit All)
//   5. Hit ▶ to play and watch the burns fire

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { BODIES, BY_ID, muOf } from './bodies';
import {
  Orbit, applyNodeToOrbit, bodyPosition, eccentricity,
  orbitWorldPos, velocityVectorsAt,
} from './orbitalMath';
import {
  ManeuverNode, AnchorKind, NodeLink, computeTrajectory, computeNodeChain,
  nextApsisTime, recomputeNodeTimes,
} from './trajectory';

const TWO_PI = Math.PI * 2;

// ----- ship type local to the sandbox -----

interface SandboxShip {
  id: string;
  name: string;
  orbit: Orbit;
  nodes: ManeuverNode[];
  fuel: number;
  /** Cached trajectory; invalidated whenever nodes or orbit change. */
  _traj?: ReturnType<typeof computeTrajectory> | null;
}

function makeInitialShip(): SandboxShip {
  // Park at ~Pe 25, Ap 28 around Earth (just outside the surface, inside SOI).
  const earth = BY_ID['earth'];
  const orbit: Orbit = {
    rp: 8,
    ra: 12,
    omega: 0.4,
    M0: 0,
    epoch: 0,
    direction: 1,
    period: TWO_PI * Math.sqrt((10 * 10 * 10) / muOf(earth.id)),
    parentBodyId: 'earth',
  };
  return {
    id: 'ts-01',
    name: 'TS-01 Pathfinder',
    orbit,
    nodes: [],
    fuel: 1000,
  };
}

// ============================================================
// MAIN COMPONENT
// ============================================================

export function PhysicsSandbox({ onExit }: { onExit?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({
    w: typeof window !== 'undefined' ? window.innerWidth : 1280,
    h: typeof window !== 'undefined' ? window.innerHeight : 800,
  });

  // Core sim state — refs so the RAF loop can read without re-renders.
  const tickRef = useRef(0);
  const simSpeedRef = useRef(0);             // 0 = paused, 1, 4, 16
  const cameraRef = useRef({ x: 0, y: 0, scale: 1 });
  const viewTargetRef = useRef<string | null>('earth');
  const manualCameraRef = useRef(false);

  const [ship, setShip] = useState<SandboxShip>(() => makeInitialShip());
  const shipRef = useRef(ship);
  shipRef.current = ship;

  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [selectedBodyId, setSelectedBodyId] = useState<string | null>(null);
  const [simSpeed, setSimSpeed] = useState(0);
  const [, setFrame] = useState(0);      // bumped by RAF for HUD updates

  // ---------- resize ----------
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ---------- initial camera focus on Earth ----------
  useEffect(() => {
    focusBody('earth');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- RAF loop ----------
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dtMs = now - last;
      last = now;
      // simSpeed ticks per *real* second
      const ticksPerSec = simSpeedRef.current;
      if (ticksPerSec > 0) {
        const before = tickRef.current;
        tickRef.current += (ticksPerSec * dtMs) / 1000;
        // Fire any committed nodes that elapsed during this dt
        executeNodes(before, tickRef.current);
      }
      // Camera auto-follow
      if (!manualCameraRef.current && viewTargetRef.current && viewTargetRef.current !== 'system') {
        const body = BY_ID[viewTargetRef.current];
        if (body) {
          const p = bodyPosition(body, tickRef.current);
          cameraRef.current.x = p.x;
          cameraRef.current.y = p.y;
        }
      }
      draw();
      setFrame(f => (f + 1) & 0xffff);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- node execution ----------
  // Fire committed nodes whose t falls within the dt we just advanced.
  const executeNodes = useCallback((tBefore: number, tAfter: number) => {
    const s = shipRef.current;
    let mutated = false;
    let orbit = s.orbit;
    let nodes = s.nodes;
    let fuel = s.fuel;
    const toFire = nodes
      .filter(n => n.committed && n.t > tBefore && n.t <= tAfter)
      .sort((a, b) => a.t - b.t);
    if (toFire.length === 0) return;
    for (const n of toFire) {
      orbit = applyNodeToOrbit(orbit, n.t, n.dv);
      const dvMag = Math.sqrt(n.dv.prograde ** 2 + n.dv.radial ** 2);
      fuel = Math.max(0, fuel - Math.round(dvMag * 10));
    }
    nodes = nodes.filter(n => !toFire.includes(n));
    mutated = true;
    if (mutated) {
      const updated: SandboxShip = { ...s, orbit, nodes, fuel, _traj: null };
      shipRef.current = updated;
      setShip(updated);
    }
  }, []);

  // ---------- trajectory + chain (memoized via shipRef) ----------
  const trajectory = useMemo(() => {
    const tStart = Math.max(tickRef.current, ship.orbit.epoch);
    return computeTrajectory(ship.orbit, ship.nodes, tStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ship.orbit, ship.nodes, simSpeed]);

  const nodeChain = useMemo(() => {
    return computeNodeChain(ship.orbit, ship.nodes, tickRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ship.orbit, ship.nodes, simSpeed]);

  // ---------- coordinate transforms ----------
  const worldToScreen = useCallback((x: number, y: number): { x: number; y: number } => {
    const cam = cameraRef.current;
    return {
      x: size.w / 2 + (x - cam.x) * cam.scale,
      y: size.h / 2 + (y - cam.y) * cam.scale,
    };
  }, [size]);

  // ---------- camera helpers ----------
  const focusBody = useCallback((bodyId: string) => {
    const body = BY_ID[bodyId];
    if (!body) return;
    viewTargetRef.current = bodyId;
    manualCameraRef.current = false;
    const pos = bodyPosition(body, tickRef.current);
    cameraRef.current.x = pos.x;
    cameraRef.current.y = pos.y;
    let viewRadius: number;
    if (body.id === 'sol') viewRadius = 3000;
    else if (body.soi && body.soi !== Infinity) viewRadius = body.soi * 1.4;
    else viewRadius = 100;
    cameraRef.current.scale = Math.min(size.w, size.h) / (viewRadius * 2);
  }, [size]);

  const focusSystem = useCallback(() => {
    viewTargetRef.current = 'system';
    manualCameraRef.current = false;
    cameraRef.current.x = 0;
    cameraRef.current.y = 0;
    cameraRef.current.scale = Math.min(size.w, size.h) / 6500;
  }, [size]);

  // ---------- drawing ----------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cam = cameraRef.current;
    const t = tickRef.current;
    const s = shipRef.current;

    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, 0, size.w, size.h);

    // Body orbits (faint background)
    for (const body of BODIES) {
      if (!body.parent) continue;
      const parent = BY_ID[body.parent];
      const pp = bodyPosition(parent, t);
      const ps = worldToScreen(pp.x, pp.y);
      ctx.strokeStyle = '#2d4255';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(ps.x, ps.y, body.orbitRadius * cam.scale, 0, TWO_PI);
      ctx.stroke();
    }

    // Bodies + SOIs + labels
    for (const body of BODIES) {
      const pos = bodyPosition(body, t);
      const sp = worldToScreen(pos.x, pos.y);
      const r = Math.max(1.5, body.radius * cam.scale);

      // SOI
      if (body.soi && body.soi !== Infinity) {
        ctx.save();
        ctx.strokeStyle = 'rgba(78, 205, 196, 0.12)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 6]);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, body.soi * cam.scale, 0, TWO_PI);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Star halo
      if (body.type === 'star') {
        const grd = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, r * 4);
        grd.addColorStop(0, 'rgba(255, 209, 128, 0.4)');
        grd.addColorStop(0.5, 'rgba(255, 154, 60, 0.1)');
        grd.addColorStop(1, 'rgba(255, 154, 60, 0)');
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(sp.x, sp.y, r * 4, 0, TWO_PI); ctx.fill();
      }

      ctx.fillStyle = body.color;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, TWO_PI);
      ctx.fill();

      // Saturn ring
      if (body.id === 'saturn') {
        ctx.strokeStyle = 'rgba(212, 165, 116, 0.55)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(sp.x, sp.y, r * 2.2, r * 0.4, 0, 0, TWO_PI);
        ctx.stroke();
      }

      // Label visibility — match HTML prototype logic
      const showLabel =
        body.type === 'star' || body.parent === 'sol' ||
        (body.type === 'moon' && cam.scale > 1.5) ||
        cam.scale > 0.4;
      if (showLabel) {
        ctx.fillStyle = body.id === selectedBodyId ? '#ffb84d' : '#8aa0b4';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(body.name.toUpperCase(), sp.x, sp.y + r + 14);
      }

      if (body.id === selectedBodyId) {
        ctx.save();
        ctx.strokeStyle = '#ffb84d';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r + 6, 0, TWO_PI);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Trajectory (current + projected)
    drawTrajectory(ctx, trajectory, t, worldToScreen, cam);

    // Node diamonds + handles (for the selected node)
    drawNodes(ctx, nodeChain, t, worldToScreen, selectedNodeId);

    // Ship marker
    const shipPos = orbitWorldPos(s.orbit, t);
    const ss = worldToScreen(shipPos.x, shipPos.y);
    ctx.fillStyle = '#4ecdc4';
    ctx.beginPath();
    ctx.arc(ss.x, ss.y, 5, 0, TWO_PI);
    ctx.fill();
    const { prograde } = velocityVectorsAt(s.orbit, t);
    ctx.strokeStyle = '#4ecdc4';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ss.x, ss.y);
    ctx.lineTo(ss.x + prograde.x * 12, ss.y + prograde.y * 12);
    ctx.stroke();
    ctx.fillStyle = '#4ecdc4';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(s.name.split(' ')[0], ss.x + 8, ss.y - 6);
  }, [size, trajectory, nodeChain, selectedBodyId, selectedNodeId, worldToScreen]);

  // ---------- mouse handling ----------
  const draggingRef = useRef<
    | null
    | { kind: 'pan'; startX: number; startY: number; camX: number; camY: number }
    | { kind: 'handle'; handle: 'prograde' | 'retrograde' | 'radial-out' | 'radial-in'; nodeId: number }
  >(null);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Right or middle → pan
    if (e.button === 2 || e.button === 1) {
      e.preventDefault();
      draggingRef.current = {
        kind: 'pan',
        startX: sx, startY: sy,
        camX: cameraRef.current.x, camY: cameraRef.current.y,
      };
      return;
    }
    if (e.button !== 0) return;

    // 1) Handle hit (only on selected node)
    if (selectedNodeId !== null) {
      const link = nodeChain.find(l => l.node.id === selectedNodeId);
      if (link) {
        const handle = hitHandle(sx, sy, link, worldToScreen);
        if (handle) {
          draggingRef.current = { kind: 'handle', handle, nodeId: selectedNodeId };
          return;
        }
      }
    }

    // 2) Node hit
    for (const link of nodeChain) {
      const ws = orbitWorldPos(link.preBurnOrbit, link.node.t);
      const sp = worldToScreen(ws.x, ws.y);
      const dx = sx - sp.x, dy = sy - sp.y;
      if (dx * dx + dy * dy < 100) {
        setSelectedNodeId(link.node.id);
        return;
      }
    }

    // 3) Body hit
    for (let i = BODIES.length - 1; i >= 0; i--) {
      const body = BODIES[i];
      const pos = bodyPosition(body, tickRef.current);
      const sp = worldToScreen(pos.x, pos.y);
      const r = Math.max(8, body.radius * cameraRef.current.scale + 4);
      const dx = sx - sp.x, dy = sy - sp.y;
      if (dx * dx + dy * dy < r * r) {
        setSelectedBodyId(body.id);
        return;
      }
    }

    // 4) Empty: deselect
    setSelectedNodeId(null);
    setSelectedBodyId(null);
  }, [nodeChain, selectedNodeId, worldToScreen]);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = draggingRef.current;
    if (!drag) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (drag.kind === 'pan') {
      const dx = sx - drag.startX;
      const dy = sy - drag.startY;
      cameraRef.current.x = drag.camX - dx / cameraRef.current.scale;
      cameraRef.current.y = drag.camY - dy / cameraRef.current.scale;
      manualCameraRef.current = true;
      return;
    }

    if (drag.kind === 'handle') {
      const link = nodeChain.find(l => l.node.id === drag.nodeId);
      if (!link) return;
      const ws = orbitWorldPos(link.preBurnOrbit, link.node.t);
      const center = worldToScreen(ws.x, ws.y);
      const { prograde, radialOut } = velocityVectorsAt(link.preBurnOrbit, link.node.t);
      let dir = { x: 0, y: 0 };
      switch (drag.handle) {
        case 'prograde':   dir = prograde; break;
        case 'retrograde': dir = { x: -prograde.x, y: -prograde.y }; break;
        case 'radial-out': dir = radialOut; break;
        case 'radial-in':  dir = { x: -radialOut.x, y: -radialOut.y }; break;
      }
      const dx = sx - center.x, dy = sy - center.y;
      const proj = dx * dir.x + dy * dir.y;
      const HANDLE_LEN = 50;
      const SCALE = 0.01;
      const dv = Math.max(0, proj - HANDLE_LEN) * SCALE;

      setShip(prev => {
        const nodes = prev.nodes.map(n => {
          if (n.id !== drag.nodeId) return n;
          const next = { ...n, dv: { ...n.dv } };
          switch (drag.handle) {
            case 'prograde':   next.dv.prograde =  dv; break;
            case 'retrograde': next.dv.prograde = -dv; break;
            case 'radial-out': next.dv.radial   =  dv; break;
            case 'radial-in':  next.dv.radial   = -dv; break;
          }
          return next;
        });
        // Apsis anchors depend on prior burns: rebuild times
        recomputeNodeTimes(prev.orbit, nodes, tickRef.current);
        return { ...prev, nodes };
      });
    }
  }, [nodeChain, worldToScreen]);

  const onMouseUp = useCallback(() => {
    draggingRef.current = null;
  }, []);

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const cam = cameraRef.current;
    const worldX = (sx - size.w / 2) / cam.scale + cam.x;
    const worldY = (sy - size.h / 2) / cam.scale + cam.y;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    cam.scale = Math.max(0.005, Math.min(50, cam.scale * factor));
    cam.x = worldX - (sx - size.w / 2) / cam.scale;
    cam.y = worldY - (sy - size.h / 2) / cam.scale;
    manualCameraRef.current = true;
  }, [size]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key === 'f' || e.key === 'F') focusBody(shipRef.current.orbit.parentBodyId);
      else if (e.key === 'Escape') focusSystem();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusBody, focusSystem]);

  // ---------- node operations ----------
  let nodeIdCounter = useRef(1);
  const addNode = (anchor: AnchorKind) => {
    setShip(prev => {
      const t = tickRef.current;
      // Determine t for the new node
      const sortedExisting = [...prev.nodes].sort((a, b) => a.t - b.t);
      let cursorOrbit = prev.orbit;
      let cursorTick = Math.max(t, prev.orbit.epoch);
      for (const n of sortedExisting) {
        cursorOrbit = applyNodeToOrbit(cursorOrbit, n.t, n.dv);
        cursorTick = n.t;
      }
      let newT: number;
      if (anchor === 'periapsis' || anchor === 'apoapsis') {
        newT = nextApsisTime(cursorOrbit, cursorTick, anchor);
      } else {
        newT = cursorTick + 30;
      }
      const newNode: ManeuverNode = {
        id: nodeIdCounter.current++,
        t: newT,
        anchor,
        dv: { prograde: 0, radial: 0 },
        committed: false,
      };
      const nodes = [...prev.nodes, newNode];
      recomputeNodeTimes(prev.orbit, nodes, tickRef.current);
      setSelectedNodeId(newNode.id);
      return { ...prev, nodes };
    });
  };

  const deleteNode = (nodeId: number) => {
    setShip(prev => {
      const nodes = prev.nodes.filter(n => n.id !== nodeId);
      recomputeNodeTimes(prev.orbit, nodes, tickRef.current);
      if (selectedNodeId === nodeId) setSelectedNodeId(null);
      return { ...prev, nodes };
    });
  };

  const commitNode = (nodeId: number) => {
    setShip(prev => {
      const nodes = prev.nodes.map(n => n.id === nodeId ? { ...n, committed: true } : n);
      return { ...prev, nodes };
    });
  };

  const commitAll = () => {
    setShip(prev => {
      const nodes = prev.nodes.map(n => ({ ...n, committed: true }));
      return { ...prev, nodes };
    });
  };

  const resetShip = () => {
    nodeIdCounter.current = 1;
    setShip(makeInitialShip());
    setSelectedNodeId(null);
    tickRef.current = 0;
  };

  // ---------- speed control ----------
  const setSpeed = (v: number) => {
    setSimSpeed(v);
    simSpeedRef.current = v;
  };

  // ---------- panel rendering ----------
  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: '#0a0e14', color: '#d8e4ee',
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      overflow: 'hidden', userSelect: 'none',
    }}>
      <canvas
        ref={canvasRef}
        width={size.w}
        height={size.h}
        style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onContextMenu={e => e.preventDefault()}
      />

      {/* HUD top-left: title + exit */}
      <div style={hudBlock({ top: 16, left: 16 })}>
        <div style={{ color: '#ffb84d', fontWeight: 600, fontSize: 14, letterSpacing: '0.25em' }}>
          ORBITAL · SANDBOX
        </div>
        <div style={{ color: '#6b8195', fontSize: 9, letterSpacing: '0.15em', marginTop: 2 }}>
          PATCHED CONICS · 2D
        </div>
        {onExit && (
          <button
            onClick={onExit}
            style={{
              marginTop: 8,
              background: 'transparent',
              border: '1px solid #2a3d50',
              color: '#6b8195',
              padding: '4px 10px',
              fontFamily: 'inherit',
              fontSize: 10,
              letterSpacing: '0.1em',
              cursor: 'pointer',
            }}
          >
            ✕ EXIT SANDBOX
          </button>
        )}
      </div>

      {/* HUD top-right: tick */}
      <div style={hudBlock({ top: 16, right: 16, textAlign: 'right' })}>
        <div style={{ color: '#6b8195', fontSize: 9, letterSpacing: '0.15em' }}>TICK</div>
        <div style={{ fontSize: 13, marginTop: 2 }}>{tickRef.current.toFixed(1)}</div>
      </div>

      {/* Time controls */}
      <div style={{
        position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
        background: 'rgba(10, 14, 20, 0.94)', border: '1px solid #2a3d50',
        padding: 4, display: 'flex', gap: 4, backdropFilter: 'blur(8px)',
      }}>
        {[
          { v: 0, label: '⏸ PAUSE' },
          { v: 1, label: '▶ 1×' },
          { v: 4, label: '▶▶ 4×' },
          { v: 16, label: '▶▶▶ 16×' },
        ].map(s => (
          <button
            key={s.v}
            onClick={() => setSpeed(s.v)}
            style={{
              background: 'transparent', border: 'none',
              color: simSpeed === s.v ? '#ffb84d' : '#6b8195',
              padding: '6px 12px',
              fontFamily: 'inherit', fontSize: 11, letterSpacing: '0.1em',
              cursor: 'pointer',
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Legend (bottom-left) */}
      <div style={hudBlock({ bottom: 16, left: 16, fontSize: 9 })}>
        <div style={{ color: '#6b8195', textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: 4 }}>
          Maneuver handles
        </div>
        <Legend color="#6ee7b7" label="Prograde · raises far side" />
        <Legend color="#fda4af" label="Retrograde · lowers far side" />
        <Legend color="#67e8f9" label="Radial-out · rotates" />
        <Legend color="#c4b5fd" label="Radial-in · rotates" />
        <div style={{ color: '#6b8195', textTransform: 'uppercase', letterSpacing: '0.15em', marginTop: 8, marginBottom: 4 }}>
          Camera
        </div>
        <div>Scroll · zoom · Right-drag · pan</div>
        <div>F · focus ship · Esc · system</div>
      </div>

      {/* Ship panel (right) */}
      <div style={{
        position: 'fixed', top: 70, right: 16, width: 320,
        background: 'rgba(10, 14, 20, 0.94)', border: '1px solid #2a3d50',
        backdropFilter: 'blur(8px)', maxHeight: 'calc(100vh - 100px)', overflowY: 'auto',
      }}>
        <div style={panelHeader()}>
          {ship.name}
        </div>
        <div style={{ padding: '12px 14px' }}>
          <Row k="PARENT" v={BY_ID[ship.orbit.parentBodyId].name.toUpperCase()} />
          <Row k="PERIAPSIS" v={ship.orbit.rp.toFixed(1)} />
          <Row k="APOAPSIS" v={ship.orbit.ra.toFixed(1)} />
          <Row k="ECCENTRICITY" v={eccentricity(ship.orbit).toFixed(3)} />
          <Row k="PERIOD" v={ship.orbit.period.toFixed(1)} />
          <Row k="FUEL" v={String(ship.fuel)} />

          <Divider />
          <SectionLabel>Plan steps</SectionLabel>
          <button style={btnPrimary} onClick={() => addNode('periapsis')}>+ STEP @ PERIAPSIS</button>
          <button style={btnPrimary} onClick={() => addNode('apoapsis')}>+ STEP @ APOAPSIS</button>
          <button style={btnPrimary} onClick={() => addNode('absolute')}>+ STEP @ T+30</button>

          {ship.nodes.length > 0 && (
            <>
              <Divider />
              {ship.nodes
                .slice()
                .sort((a, b) => a.t - b.t)
                .map(n => {
                  const isSel = n.id === selectedNodeId;
                  const dv = Math.sqrt(n.dv.prograde ** 2 + n.dv.radial ** 2);
                  return (
                    <div
                      key={n.id}
                      onClick={() => setSelectedNodeId(n.id)}
                      style={{
                        background: n.committed
                          ? 'rgba(255, 184, 77, 0.10)'
                          : 'rgba(255, 184, 77, 0.04)',
                        border: `1px ${n.committed ? 'solid' : 'dashed'} ${isSel ? '#ffb84d' : 'rgba(255, 184, 77, 0.35)'}`,
                        padding: '8px 10px', marginBottom: 6, fontSize: 10, cursor: 'pointer',
                      }}
                    >
                      <div style={{
                        display: 'flex', justifyContent: 'space-between',
                        color: '#ffb84d', letterSpacing: '0.1em',
                      }}>
                        <span>{n.committed ? '● ' : '◇ '}{anchorLabel(n.anchor)} T+{(n.t - tickRef.current).toFixed(1)}</span>
                        <span>Δv {dv.toFixed(2)}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                        <Pill color="#6ee7b7">PG {n.dv.prograde.toFixed(2)}</Pill>
                        <Pill color="#67e8f9">R {n.dv.radial.toFixed(2)}</Pill>
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        {!n.committed && (
                          <button
                            onClick={e => { e.stopPropagation(); commitNode(n.id); }}
                            style={{
                              flex: 1, background: 'rgba(78, 205, 196, 0.08)',
                              border: '1px solid #4ecdc4', color: '#4ecdc4',
                              padding: 4, fontSize: 9, letterSpacing: '0.1em',
                              cursor: 'pointer', fontFamily: 'inherit',
                            }}
                          >
                            COMMIT
                          </button>
                        )}
                        <button
                          onClick={e => { e.stopPropagation(); deleteNode(n.id); }}
                          style={{
                            flex: 1, background: 'rgba(255, 94, 94, 0.06)',
                            border: '1px solid #ff5e5e', color: '#ff5e5e',
                            padding: 4, fontSize: 9, letterSpacing: '0.1em',
                            cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          DELETE
                        </button>
                      </div>
                    </div>
                  );
                })}
              <button style={{ ...btnPrimary, marginTop: 4 }} onClick={commitAll}>COMMIT ALL</button>
            </>
          )}
          <Divider />
          <button
            onClick={resetShip}
            style={{
              ...btnPrimary,
              background: 'rgba(255, 94, 94, 0.06)',
              borderColor: '#ff5e5e', color: '#ff5e5e',
            }}
          >
            RESET SHIP
          </button>
        </div>
      </div>

      {/* Selected body inspector (bottom-right) */}
      {selectedBodyId && (
        <div style={{
          position: 'fixed', bottom: 16, right: 16, width: 240,
          background: 'rgba(10, 14, 20, 0.94)', border: '1px solid #2a3d50',
          backdropFilter: 'blur(8px)',
        }}>
          <div style={panelHeader()}>
            {BY_ID[selectedBodyId].name.toUpperCase()}
            <button
              onClick={() => setSelectedBodyId(null)}
              style={{ background: 'none', border: 'none', color: '#6b8195', cursor: 'pointer', fontSize: 12 }}
            >
              ✕
            </button>
          </div>
          <div style={{ padding: '12px 14px' }}>
            <Row k="CLASS" v={BY_ID[selectedBodyId].type.replace('-', ' ').toUpperCase()} />
            {BY_ID[selectedBodyId].soi !== Infinity && (
              <Row k="SOI" v={BY_ID[selectedBodyId].soi.toFixed(0)} />
            )}
            <Row k="μ" v={muOf(selectedBodyId).toFixed(0)} />
            <Divider />
            <button style={btnPrimary} onClick={() => focusBody(selectedBodyId)}>
              FOCUS CAMERA
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Drawing helpers (kept outside the main component for clarity)
// ============================================================

type ScreenTransform = (x: number, y: number) => { x: number; y: number };

function drawTrajectory(
  ctx: CanvasRenderingContext2D,
  arcs: ReturnType<typeof computeTrajectory>,
  currentTick: number,
  worldToScreen: ScreenTransform,
  cam: { x: number; y: number; scale: number },
) {
  // Current arc(s): solid line. Future arcs (committed): dashed amber.
  for (let i = 0; i < arcs.length; i++) {
    const arc = arcs[i];
    const isCurrent = currentTick >= arc.tStart && currentTick <= arc.tEnd;
    const color = isCurrent ? '#4a7090' : 'rgba(255, 184, 77, 0.6)';
    const dashed = !isCurrent;
    drawArc(ctx, arc, worldToScreen, color, dashed);

    // Encounter ghost
    if (arc.endReason === 'enter' && arc.enteredBodyId) {
      const body = BY_ID[arc.enteredBodyId];
      const bp = bodyPosition(body, arc.tEnd);
      const sp = worldToScreen(bp.x, bp.y);
      const r = Math.max(3, body.radius * cam.scale);
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = body.color;
      ctx.beginPath(); ctx.arc(sp.x, sp.y, r, 0, TWO_PI); ctx.fill();
      ctx.strokeStyle = 'rgba(255, 184, 77, 0.3)';
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, body.soi * cam.scale, 0, TWO_PI);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      ctx.fillStyle = 'rgba(255, 184, 77, 0.85)';
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`ENC ${body.name.toUpperCase()} T+${(arc.tEnd - currentTick).toFixed(0)}`, sp.x, sp.y - r - 6);
    }
    if (arc.endReason === 'exit') {
      const exitPos = orbitWorldPos(arc.orbit, arc.tEnd);
      const sp = worldToScreen(exitPos.x, exitPos.y);
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 184, 77, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 5, 0, TWO_PI); ctx.stroke();
      ctx.fillStyle = 'rgba(255, 184, 77, 0.85)';
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`EXIT ${BY_ID[arc.orbit.parentBodyId].name.toUpperCase()}`, sp.x, sp.y - 10);
      ctx.restore();
    }
  }
}

function drawArc(
  ctx: CanvasRenderingContext2D,
  arc: ReturnType<typeof computeTrajectory>[number],
  worldToScreen: ScreenTransform,
  color: string,
  dashed: boolean,
) {
  const duration = arc.tEnd - arc.tStart;
  if (duration <= 0) return;
  const samples = Math.max(20, Math.min(200, Math.ceil(duration * 4)));
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;
  if (dashed) ctx.setLineDash([5, 5]);
  ctx.beginPath();
  for (let i = 0; i <= samples; i++) {
    const t = arc.tStart + (i / samples) * duration;
    const wp = orbitWorldPos(arc.orbit, t);
    const sp = worldToScreen(wp.x, wp.y);
    if (i === 0) ctx.moveTo(sp.x, sp.y);
    else ctx.lineTo(sp.x, sp.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawNodes(
  ctx: CanvasRenderingContext2D,
  chain: NodeLink[],
  currentTick: number,
  worldToScreen: ScreenTransform,
  selectedNodeId: number | null,
) {
  for (const link of chain) {
    const { node, preBurnOrbit } = link;
    const wp = orbitWorldPos(preBurnOrbit, node.t);
    const sp = worldToScreen(wp.x, wp.y);
    const isSel = node.id === selectedNodeId;

    // Diamond
    ctx.save();
    ctx.translate(sp.x, sp.y);
    ctx.rotate(Math.PI / 4);
    if (node.committed) {
      ctx.fillStyle = isSel ? '#ffb84d' : 'rgba(255, 184, 77, 0.85)';
      ctx.fillRect(-5, -5, 10, 10);
      ctx.strokeStyle = '#ffb84d';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-5, -5, 10, 10);
    } else {
      ctx.fillStyle = isSel ? 'rgba(255, 184, 77, 0.25)' : 'rgba(255, 184, 77, 0.08)';
      ctx.fillRect(-5, -5, 10, 10);
      ctx.strokeStyle = isSel ? '#ffb84d' : 'rgba(255, 184, 77, 0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.strokeRect(-5, -5, 10, 10);
      ctx.setLineDash([]);
    }
    ctx.restore();

    ctx.fillStyle = node.committed ? '#ffb84d' : 'rgba(255, 184, 77, 0.7)';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    const label = `${node.committed ? '● ' : '◇ '}${anchorLabel(node.anchor)} T+${(node.t - currentTick).toFixed(1)}`;
    ctx.fillText(label, sp.x, sp.y - 12);

    if (isSel) drawHandles(ctx, link, sp);
  }
}

function drawHandles(ctx: CanvasRenderingContext2D, link: NodeLink, screenPos: { x: number; y: number }) {
  const { prograde, radialOut } = velocityVectorsAt(link.preBurnOrbit, link.node.t);
  const HANDLE_LEN = 50;
  const SCALE = 0.01;
  const dvAmt = {
    prograde:    link.node.dv.prograde > 0 ?  link.node.dv.prograde : 0,
    retrograde:  link.node.dv.prograde < 0 ? -link.node.dv.prograde : 0,
    'radial-out': link.node.dv.radial   > 0 ?  link.node.dv.radial : 0,
    'radial-in':  link.node.dv.radial   < 0 ? -link.node.dv.radial : 0,
  };
  const dirs: Record<string, { x: number; y: number; color: string; label: string }> = {
    prograde:    { x: prograde.x,   y: prograde.y,   color: '#6ee7b7', label: 'PG' },
    retrograde:  { x: -prograde.x,  y: -prograde.y,  color: '#fda4af', label: 'RG' },
    'radial-out':{ x: radialOut.x,  y: radialOut.y,  color: '#67e8f9', label: 'R+' },
    'radial-in': { x: -radialOut.x, y: -radialOut.y, color: '#c4b5fd', label: 'R-' },
  };
  for (const [key, dir] of Object.entries(dirs)) {
    const dv = (dvAmt as any)[key] as number;
    const length = HANDLE_LEN + dv / SCALE;
    const ex = screenPos.x + dir.x * length;
    const ey = screenPos.y + dir.y * length;
    ctx.strokeStyle = dir.color;
    ctx.lineWidth = 1.2;
    if (dv === 0) ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(screenPos.x, screenPos.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = dir.color;
    ctx.beginPath(); ctx.arc(ex, ey, 6, 0, TWO_PI); ctx.fill();
    ctx.fillStyle = '#0a0e14';
    ctx.font = 'bold 8px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(dir.label, ex, ey);
    ctx.textBaseline = 'alphabetic';

    if (dv > 0) {
      ctx.fillStyle = dir.color;
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillText(dv.toFixed(1), ex + dir.x * 14, ey + dir.y * 14 + 3);
    }
  }
}

function hitHandle(
  sx: number,
  sy: number,
  link: NodeLink,
  worldToScreen: ScreenTransform,
): 'prograde' | 'retrograde' | 'radial-out' | 'radial-in' | null {
  const wp = orbitWorldPos(link.preBurnOrbit, link.node.t);
  const center = worldToScreen(wp.x, wp.y);
  const { prograde, radialOut } = velocityVectorsAt(link.preBurnOrbit, link.node.t);
  const HANDLE_LEN = 50;
  const SCALE = 0.01;
  const dvAmt = {
    prograde:    link.node.dv.prograde > 0 ?  link.node.dv.prograde : 0,
    retrograde:  link.node.dv.prograde < 0 ? -link.node.dv.prograde : 0,
    'radial-out': link.node.dv.radial   > 0 ?  link.node.dv.radial : 0,
    'radial-in':  link.node.dv.radial   < 0 ? -link.node.dv.radial : 0,
  };
  const dirs: Record<string, { x: number; y: number }> = {
    prograde:    { x: prograde.x,   y: prograde.y },
    retrograde:  { x: -prograde.x,  y: -prograde.y },
    'radial-out':{ x: radialOut.x,  y: radialOut.y },
    'radial-in': { x: -radialOut.x, y: -radialOut.y },
  };
  for (const [key, dir] of Object.entries(dirs)) {
    const length = HANDLE_LEN + ((dvAmt as any)[key] / SCALE);
    const ex = center.x + dir.x * length;
    const ey = center.y + dir.y * length;
    const dx = sx - ex, dy = sy - ey;
    if (dx * dx + dy * dy < 100) return key as any;
  }
  return null;
}

// ----- tiny UI helpers -----

function anchorLabel(a: AnchorKind): string {
  if (a === 'periapsis') return 'Pe';
  if (a === 'apoapsis') return 'Ap';
  return 'TX';
}

function hudBlock(extra: React.CSSProperties): React.CSSProperties {
  return {
    position: 'fixed',
    background: 'rgba(10, 14, 20, 0.94)',
    border: '1px solid #2a3d50',
    padding: '10px 14px',
    fontSize: 11,
    lineHeight: 1.5,
    letterSpacing: '0.05em',
    backdropFilter: 'blur(8px)',
    pointerEvents: 'auto',
    ...extra,
  };
}

function panelHeader(): React.CSSProperties {
  return {
    padding: '8px 14px',
    borderBottom: '1px solid #2a3d50',
    background: 'rgba(255, 184, 77, 0.05)',
    color: '#ffb84d',
    fontSize: 10,
    letterSpacing: '0.2em',
    textTransform: 'uppercase',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  };
}

const btnPrimary: React.CSSProperties = {
  width: '100%',
  background: 'rgba(78, 205, 196, 0.08)',
  border: '1px solid #4ecdc4',
  color: '#4ecdc4',
  padding: 10,
  marginTop: 6,
  fontFamily: 'inherit',
  fontSize: 10,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  fontWeight: 600,
};

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
      <span style={{ color: '#6b8195' }}>{k}</span>
      <span style={{ color: '#d8e4ee', fontWeight: 500 }}>{v}</span>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: '#2a3d50', margin: '8px 0' }} />;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      color: '#6b8195', fontSize: 9,
      textTransform: 'uppercase', letterSpacing: '0.18em',
      marginBottom: 6, marginTop: 8,
    }}>
      {children}
    </div>
  );
}

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      padding: '2px 6px', borderRadius: 2, fontSize: 9,
      background: 'rgba(255,255,255,0.04)',
      color, border: `1px solid ${color}55`,
    }}>
      {children}
    </span>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 10, height: 10, borderRadius: '50%', background: color }} />
      <span>{label}</span>
    </div>
  );
}
