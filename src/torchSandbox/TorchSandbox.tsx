// ============================================================
// TORCH SANDBOX — Expanse-style brachistochrone playground
// ============================================================
// Reachable at ?torch. Pick a target body, hit GO, watch the ship
// accelerate / flip / decelerate to arrive at rest relative to the
// target. Stats panel shows trip time, Δv, peak velocity, current
// phase.

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  BODIES, BY_ID, bodyPosition, bodyVelocity,
  planTorchTransfer, stepTorchShip, sampleTrajectory,
  TorchTransfer, TorchShipState, asG, fromG,
} from './torchPhysics';

const TWO_PI = Math.PI * 2;

// ============================================================
// MAIN COMPONENT
// ============================================================

export function TorchSandbox({ onExit }: { onExit?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({
    w: typeof window !== 'undefined' ? window.innerWidth : 1280,
    h: typeof window !== 'undefined' ? window.innerHeight : 800,
  });

  // ---- sim state ----
  const tickRef = useRef(0);
  const simSpeedRef = useRef(0);            // ticks per real second
  const cameraRef = useRef({ x: 0, y: 0, scale: 1 });

  // Ship starts co-orbiting Earth — inherits Earth's orbital velocity.
  // Without this, the brachistochrone would be a perfect straight line
  // (no curve from sideways momentum); inheriting Earth's velocity is
  // both realistic and produces the characteristic banana-shaped path
  // an Expanse torchship traces between planets.
  const [ship, setShip] = useState<TorchShipState>(() => ({
    pos: { ...bodyPosition(BY_ID['earth'], 0) },
    vel: { ...bodyVelocity(BY_ID['earth'], 0) },
  }));
  const shipRef = useRef(ship);
  shipRef.current = ship;

  const [transfer, setTransfer] = useState<TorchTransfer | null>(null);
  const transferRef = useRef<TorchTransfer | null>(null);
  transferRef.current = transfer;

  // Planning controls
  const [targetId, setTargetId] = useState('jupiter');
  const [boostG, setBoostG] = useState(0.1);  // boost-phase g
  const [brakeG, setBrakeG] = useState(0.1);  // brake-phase g
  const [linkG, setLinkG] = useState(true);   // when true, brake follows boost
  const [simSpeed, setSimSpeed] = useState(0);
  const [, setFrameTick] = useState(0);

  // ---- resize ----
  useEffect(() => {
    const measure = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // ---- initial camera: fit Saturn-ish range ----
  useEffect(() => {
    if (size.w === 0 || size.h === 0) return;
    cameraRef.current.x = 0;
    cameraRef.current.y = 0;
    cameraRef.current.scale = Math.min(size.w, size.h) / (550 * 2);
  }, [size]);

  // ---- planning ----
  // The CURRENT plan we'd execute if the user clicked GO right now.
  // Recomputed whenever target / acceleration / ship state / tick changes.
  const plannedTransfer = useMemo(() => {
    const boostAccel = fromG(boostG);
    const brakeAccel = fromG(linkG ? boostG : brakeG);
    return planTorchTransfer(ship, targetId, boostAccel, brakeAccel, tickRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, boostG, brakeG, linkG, ship, simSpeed]);

  // Max perpendicular deviation of the integrated curve from the
  // straight-line reference (Earth → intercept). At 1g it's ~1% of
  // trip distance — visible but subtle. At 0.1g it's much more
  // dramatic.
  const curveStats = useMemo(() => {
    if (!plannedTransfer) return null;
    const startShip = {
      pos: { ...plannedTransfer.startPos },
      vel: { ...plannedTransfer.startVel },
    };
    const samples = sampleTrajectory(plannedTransfer, startShip, 200);
    const dx = plannedTransfer.interceptPos.x - plannedTransfer.startPos.x;
    const dy = plannedTransfer.interceptPos.y - plannedTransfer.startPos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-6) return null;
    // Perpendicular unit (normal to the straight-line direction)
    const nx = -dy / d, ny = dx / d;
    let maxDev = 0;
    for (const s of samples) {
      const rx = s.x - plannedTransfer.startPos.x;
      const ry = s.y - plannedTransfer.startPos.y;
      const dev = Math.abs(rx * nx + ry * ny);
      if (dev > maxDev) maxDev = dev;
    }
    return { maxDev, fraction: maxDev / d, directDist: d };
  }, [plannedTransfer]);

  const launchPlan = useCallback(() => {
    if (!plannedTransfer) return;
    setTransfer(plannedTransfer);
    // Auto-start at 1× if currently paused
    if (simSpeedRef.current === 0) {
      simSpeedRef.current = 1;
      setSimSpeed(1);
    }
  }, [plannedTransfer]);

  const cancelTransfer = useCallback(() => {
    setTransfer(null);
    // Park ship at current position with zero velocity
    setShip(s => ({ pos: { ...s.pos }, vel: { x: 0, y: 0 } }));
  }, []);

  const resetShip = useCallback(() => {
    tickRef.current = 0;
    setShip({
      pos: { ...bodyPosition(BY_ID['earth'], 0) },
      vel: { ...bodyVelocity(BY_ID['earth'], 0) },
    });
    setTransfer(null);
    setFrameTick(t => t + 1);
  }, []);

  // ---- RAF loop ----
  const drawRef = useRef<() => void>(() => {});
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dtMs = now - last;
      last = now;
      const ticksPerSec = simSpeedRef.current;
      if (ticksPerSec > 0) {
        const before = tickRef.current;
        const dt = (ticksPerSec * dtMs) / 1000;
        tickRef.current = before + dt;
        // Step ship under current transfer
        const cur = transferRef.current ?? undefined;
        const next = { ...shipRef.current, pos: { ...shipRef.current.pos }, vel: { ...shipRef.current.vel } };
        stepTorchShip(next, cur, before, dt);
        shipRef.current = next;
        setShip(next);
        // Auto-pause at arrival
        if (cur && tickRef.current >= cur.arriveTick) {
          simSpeedRef.current = 0;
          setSimSpeed(0);
          setTransfer(null);
          transferRef.current = null;
        }
      }
      drawRef.current();
      setFrameTick(f => (f + 1) & 0xffff);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- coord transforms ----
  const worldToScreen = useCallback((x: number, y: number) => {
    const cam = cameraRef.current;
    return {
      x: size.w / 2 + (x - cam.x) * cam.scale,
      y: size.h / 2 + (y - cam.y) * cam.scale,
    };
  }, [size]);

  // ---- drawing ----
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cam = cameraRef.current;
    const t = tickRef.current;
    const s = shipRef.current;
    const xfer = transferRef.current;

    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, 0, size.w, size.h);

    // Planet orbits (faint background rings)
    for (const body of BODIES) {
      if (body.orbitRadius === 0) continue;
      const center = worldToScreen(0, 0);
      ctx.strokeStyle = '#1c2c3c';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(center.x, center.y, body.orbitRadius * cam.scale, 0, TWO_PI);
      ctx.stroke();
    }

    // Bodies (current positions)
    for (const body of BODIES) {
      const pos = bodyPosition(body, t);
      const sp = worldToScreen(pos.x, pos.y);
      const r = Math.max(2, body.radius * cam.scale);
      if (body.id === 'sol') {
        const grd = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, r * 5);
        grd.addColorStop(0, 'rgba(255, 209, 128, 0.45)');
        grd.addColorStop(1, 'rgba(255, 154, 60, 0)');
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(sp.x, sp.y, r * 5, 0, TWO_PI); ctx.fill();
      }
      ctx.fillStyle = body.color;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, TWO_PI);
      ctx.fill();
      // Label
      ctx.fillStyle = body.id === targetId ? '#ffb84d' : '#8aa0b4';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(body.name.toUpperCase(), sp.x, sp.y + r + 14);
      // Highlight target
      if (body.id === targetId) {
        ctx.save();
        ctx.strokeStyle = '#ffb84d';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r + 8, 0, TWO_PI);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Planned-but-not-launched trajectory: dashed amber. The planner
    // stamped the ship's launch state into the plan, so sampleTrajectory
    // can integrate forward from that — and we get a CURVED path (the
    // ship inherits parent orbital velocity, thrust continuously re-
    // aims) rather than a straight line.
    if (!xfer && plannedTransfer) {
      const startShip: TorchShipState = {
        pos: { ...plannedTransfer.startPos },
        vel: { ...plannedTransfer.startVel },
      };
      const samples = sampleTrajectory(plannedTransfer, startShip, 240);
      // Reference straight line from launch to intercept (zero-velocity
      // ideal). The actual integrated path bends away from this by the
      // inherited-orbital-velocity contribution — at 1g cruise the
      // deviation is ~1% of trip distance and might not jump out
      // visually, but the reference line makes it obvious.
      ctx.save();
      ctx.strokeStyle = 'rgba(106, 132, 154, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      const startSp = worldToScreen(plannedTransfer.startPos.x, plannedTransfer.startPos.y);
      const endSp = worldToScreen(plannedTransfer.interceptPos.x, plannedTransfer.interceptPos.y);
      ctx.beginPath();
      ctx.moveTo(startSp.x, startSp.y);
      ctx.lineTo(endSp.x, endSp.y);
      ctx.stroke();
      ctx.restore();
      // Actual integrated path: dashed amber
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 184, 77, 0.75)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      for (let i = 0; i < samples.length; i++) {
        const sp = worldToScreen(samples[i].x, samples[i].y);
        if (i === 0) ctx.moveTo(sp.x, sp.y);
        else ctx.lineTo(sp.x, sp.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      // Intercept marker (ghost of where target will be)
      const ip = worldToScreen(plannedTransfer.interceptPos.x, plannedTransfer.interceptPos.y);
      const target = BY_ID[plannedTransfer.targetId];
      const targetR = Math.max(2, target.radius * cam.scale);
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = target.color;
      ctx.beginPath(); ctx.arc(ip.x, ip.y, targetR, 0, TWO_PI); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = 'rgba(255, 184, 77, 0.7)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.arc(ip.x, ip.y, targetR + 3, 0, TWO_PI);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255, 184, 77, 0.85)';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('INTERCEPT', ip.x, ip.y - targetR - 6);
    }

    // Active transfer path: solid + flip marker. Use the launch state
    // recorded in the plan so the integrated curve matches what the
    // sim is actually flying.
    if (xfer) {
      const startShip: TorchShipState = {
        pos: { ...xfer.startPos },
        vel: { ...xfer.startVel },
      };
      const samples = sampleTrajectory(xfer, startShip, 120);
      // Already-traveled portion: solid teal
      // Not-yet-traveled portion: solid amber
      const tNow = tickRef.current;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let prevWas: 'past' | 'future' | null = null;
      for (let i = 0; i < samples.length; i++) {
        const sp = worldToScreen(samples[i].x, samples[i].y);
        const phase = samples[i].t < tNow ? 'past' : 'future';
        if (phase !== prevWas) {
          if (prevWas !== null) ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(sp.x, sp.y);
          ctx.strokeStyle = phase === 'past' ? '#4ecdc4' : '#ffb84d';
          prevWas = phase;
        } else {
          ctx.lineTo(sp.x, sp.y);
        }
      }
      ctx.stroke();
      // Flip marker
      // Pull the flip position straight out of the integrated samples
      // — the closed-form would assume zero initial velocity, which
      // the inheritance from Earth's orbital motion no longer
      // satisfies.
      const flipFrac = (xfer.flipTick - xfer.startTick) /
                       (xfer.arriveTick - xfer.startTick);
      const flipIdx = Math.round(flipFrac * (samples.length - 1));
      const flipPos = samples[flipIdx];
      const fp = worldToScreen(flipPos.x, flipPos.y);
      ctx.save();
      ctx.translate(fp.x, fp.y);
      ctx.rotate(Math.PI / 4);
      ctx.strokeStyle = '#ffb84d';
      ctx.lineWidth = 2;
      ctx.strokeRect(-6, -6, 12, 12);
      ctx.restore();
      ctx.fillStyle = '#ffb84d';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('FLIP', fp.x, fp.y - 14);
    }

    // Ship marker
    const ssp = worldToScreen(s.pos.x, s.pos.y);
    ctx.fillStyle = '#4ecdc4';
    ctx.beginPath();
    ctx.arc(ssp.x, ssp.y, 5, 0, TWO_PI);
    ctx.fill();
    // Velocity vector
    const vMag = Math.sqrt(s.vel.x * s.vel.x + s.vel.y * s.vel.y);
    if (vMag > 0.01) {
      const len = Math.min(40, 6 + vMag * 0.3);
      ctx.strokeStyle = '#4ecdc4';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ssp.x, ssp.y);
      ctx.lineTo(ssp.x + (s.vel.x / vMag) * len, ssp.y + (s.vel.y / vMag) * len);
      ctx.stroke();
    }
    // Thrust direction during burn
    if (xfer && t < xfer.arriveTick) {
      const inAccel = t < xfer.flipTick;
      const sign = inAccel ? 1 : -1;
      const tx = sign * xfer.thrustDir.x;
      const ty = sign * xfer.thrustDir.y;
      ctx.strokeStyle = inAccel ? '#6ee7b7' : '#fda4af';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ssp.x, ssp.y);
      ctx.lineTo(ssp.x + tx * 22, ssp.y + ty * 22);
      ctx.stroke();
    }
    ctx.fillStyle = '#4ecdc4';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('TS-01', ssp.x + 8, ssp.y - 6);
  }, [size, plannedTransfer, targetId, worldToScreen]);

  drawRef.current = draw;

  // ---- panel rendering ----
  const setSpeed = (v: number) => {
    simSpeedRef.current = v;
    setSimSpeed(v);
  };

  const distance = (() => {
    const target = BY_ID[targetId];
    const tp = bodyPosition(target, tickRef.current);
    const dx = tp.x - shipRef.current.pos.x;
    const dy = tp.y - shipRef.current.pos.y;
    return Math.sqrt(dx * dx + dy * dy);
  })();

  const shipSpeed = Math.sqrt(ship.vel.x ** 2 + ship.vel.y ** 2);
  const eta = transfer ? Math.max(0, transfer.arriveTick - tickRef.current) : null;
  const phase = transfer
    ? (tickRef.current < transfer.startTick ? 'pre-burn'
       : tickRef.current < transfer.flipTick ? 'ACCELERATING'
       : tickRef.current < transfer.arriveTick ? 'DECELERATING'
       : 'ARRIVED')
    : 'idle';

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: '#0a0e14', color: '#d8e4ee',
      fontFamily: '"JetBrains Mono", monospace',
      overflow: 'hidden', userSelect: 'none',
    }}>
      <canvas
        ref={canvasRef}
        width={size.w}
        height={size.h}
        style={{ position: 'absolute', inset: 0 }}
      />

      {/* HUD top-left */}
      <div style={hudBlock({ top: 16, left: 16 })}>
        <div style={{ color: '#ffb84d', fontWeight: 600, fontSize: 14, letterSpacing: '0.25em' }}>
          TORCH SANDBOX
        </div>
        <div style={{ color: '#6b8195', fontSize: 9, letterSpacing: '0.15em', marginTop: 2 }}>
          CONSTANT-THRUST BRACHISTOCHRONE
        </div>
        {onExit && (
          <button onClick={onExit} style={{
            marginTop: 8, background: 'transparent',
            border: '1px solid #2a3d50', color: '#6b8195',
            padding: '4px 10px', fontFamily: 'inherit',
            fontSize: 10, letterSpacing: '0.1em', cursor: 'pointer',
          }}>✕ EXIT</button>
        )}
      </div>

      {/* HUD top-right: tick */}
      <div style={hudBlock({ top: 16, right: 16, textAlign: 'right' })}>
        <div style={{ color: '#6b8195', fontSize: 9, letterSpacing: '0.15em' }}>TICK</div>
        <div style={{ fontSize: 14, marginTop: 2 }}>{tickRef.current.toFixed(2)}</div>
        <div style={{ color: '#6b8195', fontSize: 9, letterSpacing: '0.15em', marginTop: 4 }}>PHASE</div>
        <div style={{ fontSize: 11, marginTop: 2,
          color: phase === 'ACCELERATING' ? '#6ee7b7'
               : phase === 'DECELERATING' ? '#fda4af'
               : phase === 'ARRIVED' ? '#4ecdc4'
               : '#8aa0b4'
        }}>{phase}</div>
      </div>

      {/* Time controls */}
      <div style={{
        position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
        background: 'rgba(10, 14, 20, 0.94)', border: '1px solid #2a3d50',
        padding: 4, display: 'flex', gap: 4,
      }}>
        {[
          { v: 0, label: '⏸ PAUSE' },
          { v: 1, label: '▶ 1×' },
          { v: 4, label: '▶▶ 4×' },
          { v: 16, label: '▶▶▶ 16×' },
          { v: 64, label: '▶▶▶▶ 64×' },
        ].map(opt => (
          <button key={opt.v} onClick={() => setSpeed(opt.v)} style={{
            background: 'transparent', border: 'none',
            color: simSpeed === opt.v ? '#ffb84d' : '#6b8195',
            padding: '6px 12px', fontFamily: 'inherit',
            fontSize: 11, letterSpacing: '0.1em', cursor: 'pointer',
          }}>{opt.label}</button>
        ))}
      </div>

      {/* Plan panel (right) */}
      <div style={{
        position: 'fixed', top: 90, right: 16, width: 340,
        background: 'rgba(10, 14, 20, 0.94)', border: '1px solid #2a3d50',
      }}>
        <div style={panelHeader()}>FLIGHT PLAN</div>
        <div style={{ padding: '12px 14px' }}>
          <SectionLabel>TARGET</SectionLabel>
          <select
            value={targetId}
            onChange={e => setTargetId(e.target.value)}
            style={inputStyle}
          >
            {BODIES.filter(b => b.id !== 'sol').map(b => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, marginBottom: 4 }}>
            <span style={{ color: '#6b8195', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.18em' }}>
              THRUST PROFILE
            </span>
            <label style={{ color: '#6b8195', fontSize: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={linkG} onChange={e => setLinkG(e.target.checked)} />
              SYMMETRIC
            </label>
          </div>
          <div style={{ fontSize: 10, marginBottom: 4, color: '#6ee7b7' }}>BOOST</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range" min={0.01} max={10} step={0.01}
              value={boostG}
              onChange={e => {
                const v = Number(e.target.value);
                setBoostG(v);
                if (linkG) setBrakeG(v);
              }}
              style={{ flex: 1 }}
            />
            <span style={{ minWidth: 50, textAlign: 'right', color: '#6ee7b7' }}>
              {boostG < 0.1 ? boostG.toFixed(2) : boostG.toFixed(1)}g
            </span>
          </div>
          <div style={{ fontSize: 10, marginBottom: 4, marginTop: 8, color: '#fda4af' }}>BRAKE</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: linkG ? 0.45 : 1 }}>
            <input
              type="range" min={0.01} max={10} step={0.01}
              value={linkG ? boostG : brakeG}
              disabled={linkG}
              onChange={e => setBrakeG(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ minWidth: 50, textAlign: 'right', color: '#fda4af' }}>
              {(() => {
                const g = linkG ? boostG : brakeG;
                return g < 0.1 ? g.toFixed(2) : g.toFixed(1);
              })()}g
            </span>
          </div>
          <div style={{ fontSize: 9, color: '#6b8195', marginTop: 6 }}>
            Symmetric = classic brachistochrone. Asymmetric models
            kick-coast-brake or slow-cruise-emergency-brake profiles.
            Trip time grows with the gentler of the two phases.
          </div>

          {plannedTransfer && (
            <>
              <Divider />
              <SectionLabel>PROJECTED</SectionLabel>
              <Row k="DISTANCE NOW" v={`${distance.toFixed(1)} u`} />
              <Row k="TRIP TIME" v={`${(plannedTransfer.arriveTick - plannedTransfer.startTick).toFixed(2)} ticks`} />
              <Row k="PEAK VELOCITY" v={`${plannedTransfer.peakVelocity.toFixed(2)} u/tick`} />
              <Row k="TOTAL Δv" v={`${plannedTransfer.totalDv.toFixed(2)} u/tick`} />
              <Row k="FLIP @" v={`T+${(plannedTransfer.flipTick - tickRef.current).toFixed(2)}`} />
              <Row k="ARRIVE @" v={`T+${(plannedTransfer.arriveTick - tickRef.current).toFixed(2)}`} />
              <Row k="BOOST" v={`${asG(plannedTransfer.acceleration).toFixed(2)}g · ${(plannedTransfer.flipTick - plannedTransfer.startTick).toFixed(2)} ticks`} />
              <Row k="BRAKE" v={`${asG(plannedTransfer.brakeAcceleration).toFixed(2)}g · ${(plannedTransfer.arriveTick - plannedTransfer.flipTick).toFixed(2)} ticks`} />
              {curveStats && (
                <Row
                  k="CURVE"
                  v={`${curveStats.maxDev.toFixed(1)} u (${(curveStats.fraction * 100).toFixed(2)}%)`}
                />
              )}
            </>
          )}

          <Divider />
          {!transfer && (
            <button onClick={launchPlan} disabled={!plannedTransfer} style={{
              ...btnPrimary,
              opacity: plannedTransfer ? 1 : 0.3,
              cursor: plannedTransfer ? 'pointer' : 'not-allowed',
            }}>
              ▶ LAUNCH BURN
            </button>
          )}
          {transfer && (
            <button onClick={cancelTransfer} style={{
              ...btnPrimary,
              background: 'rgba(255, 94, 94, 0.06)',
              borderColor: '#ff5e5e', color: '#ff5e5e',
            }}>
              ✕ ABORT BURN
            </button>
          )}
          <button onClick={resetShip} style={{
            ...btnPrimary, marginTop: 4,
            background: 'rgba(78, 205, 196, 0.05)',
            borderColor: '#4ecdc4', color: '#4ecdc4',
          }}>
            ↻ RESET SHIP TO EARTH
          </button>
        </div>
      </div>

      {/* Live readouts (bottom-left, only during burn) */}
      {transfer && (
        <div style={{
          position: 'fixed', bottom: 16, left: 16, width: 280,
          background: 'rgba(10, 14, 20, 0.94)', border: '1px solid #2a3d50',
        }}>
          <div style={panelHeader()}>LIVE</div>
          <div style={{ padding: '12px 14px' }}>
            <Row k="SPEED" v={`${shipSpeed.toFixed(2)} u/tick`} />
            <Row k="ETA" v={eta != null ? `T+${eta.toFixed(2)}` : '—'} />
            <Row k="THRUST" v={(() => {
              const a = tickRef.current < transfer.flipTick
                ? transfer.acceleration : transfer.brakeAcceleration;
              return asG(a).toFixed(2) + 'g';
            })()} />
            <Row k="DIRECTION" v={
              tickRef.current < transfer.flipTick ? 'prograde' : 'retrograde'
            } />
          </div>
        </div>
      )}

      {/* Legend (bottom-right) */}
      <div style={hudBlock({ bottom: 16, right: 16, fontSize: 9, width: 200 })}>
        <div style={{ color: '#6b8195', textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: 4 }}>
          KEY
        </div>
        <Legend color="#4ecdc4" label="Traveled path" />
        <Legend color="#ffb84d" label="Planned / remaining" />
        <Legend color="#6a849a" label="Straight reference" />
        <Legend color="#6ee7b7" label="Thrust prograde" />
        <Legend color="#fda4af" label="Thrust retrograde" />
        <div style={{ marginTop: 6, color: '#8aa0b4' }}>
          Path bends from straight by inherited orbital velocity. At
          1g it's ~1% of trip; drop to 0.1g for a clear banana.
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Small UI helpers
// ============================================================

function hudBlock(extra: React.CSSProperties): React.CSSProperties {
  return {
    position: 'fixed',
    background: 'rgba(10, 14, 20, 0.94)',
    border: '1px solid #2a3d50',
    padding: '10px 14px',
    fontSize: 11,
    lineHeight: 1.5,
    letterSpacing: '0.05em',
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

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#0d1218',
  border: '1px solid #2a3d50',
  color: '#d8e4ee',
  padding: '6px 8px',
  fontFamily: 'inherit',
  fontSize: 11,
};

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 11 }}>
      <span style={{ color: '#6b8195' }}>{k}</span>
      <span style={{ color: '#d8e4ee', fontWeight: 500 }}>{v}</span>
    </div>
  );
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

function Divider() {
  return <div style={{ height: 1, background: '#2a3d50', margin: '10px 0' }} />;
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 10, height: 2, background: color }} />
      <span>{label}</span>
    </div>
  );
}

// Keep import-only references silenced
void bodyVelocity;
