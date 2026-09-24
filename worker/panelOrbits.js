// ============================================================
// The Systems page and the Porthole, for the desktop panel.
//
// A JS TWIN OF THE WATCH'S CANVAS, and deliberately a twin rather than a
// port of the game's renderer: the map in src/render is a camera, a
// world of bodies, hitboxes and a socket, and none of that belongs in a
// 400px window meant to sit in a corner. What the watch proved is that
// worlds.json alone carries enough to draw the whole thing -- systems,
// orbits, who is shooting whom, what died -- so this draws from the same
// document, with the same arithmetic, in a canvas.
//
// EVERY PIECE OF ART IS ALREADY SERVED. Planets are the game's own
// procedural sprites (/wear/planet), hulls are the game's ShipIcon
// (/wear/icon), emblems are the Herald's masks (/wear/flag). Nothing
// here draws a lookalike of anything; it places what the server sends.
//
// The effects mirror android/wear BattleFx.kt line for line -- kinetic
// slug versus energy lance picked per volley at the loadout's real
// ratio, shields splashing a slug and armour spalling a lance, burns on
// a hull hit last turn, wrecks that explode where the ship was and leave
// debris for three ticks, arrivals decelerating in and departures
// accelerating out. Where the two disagree, the watch is the reference.
//
// Exported as a source string: the panel is one self-contained
// document, and this is the half of it worth reading on its own.
// ============================================================

export const ORBITS_JS = String.raw`
(function (root) {
  var TAU = Math.PI * 2;
  var INNER_LAP_MS = 36000;
  var FLIGHT_MS = 2600;
  var WRECK_MS = 2200;

  function hash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function roll(id, volley) {
    var h = hash(id + ':' + volley);
    return (h % 10000) / 10000;
  }
  function lerp(a, b, u) { return a + (b - a) * u; }

  // ---- art, fetched once and kept -------------------------------------
  var imgs = {};
  function img(url) {
    if (imgs[url] !== undefined) return imgs[url];
    var im = new Image();
    im.src = url;
    im.onerror = function () { imgs[url] = null; };
    imgs[url] = im;
    return im;
  }
  function hullKey(k) { return k.split(':').slice(0, 2).join(':') + ':green'; }

  // ---- the drawing itself ---------------------------------------------
  function iconPx(cls) {
    if (cls === 'colony' || cls === 'freighter') return 22;
    if (cls === 'destroyer' || cls === 'capital' || cls === 'mega_destroyer') return 26;
    if (cls === 'frigate') return 20;
    return 17;
  }

  /** Every hull's seat: its faction's ring, evenly spaced, flagship first. */
  function seats(ships) {
    var byF = {};
    ships.forEach(function (s) { (byF[s.f] = byF[s.f] || []).push(s); });
    var out = [], ring = 0;
    Object.keys(byF).forEach(function (f) {
      var list = byF[f];
      var per = Math.max(4, Math.ceil(list.length / 2));
      for (var i = 0; i < list.length; i++) {
        if (i > 0 && i % per === 0) ring++;
        out.push({
          ship: list[i],
          ring: ring,
          a0: (TAU * (i % per)) / per + hash(f) % 100 / 100,
          px: iconPx(list[i].cls),
        });
      }
      ring++;
    });
    return out;
  }

  function plume(g, x, y, heading, size, color, t, seed) {
    var flick = 0.85 + 0.15 * Math.sin(t / 90 + (seed % 628) / 100);
    var len = size * 0.8 * flick, wide = size * 0.17;
    var dx = Math.cos(heading), dy = Math.sin(heading);
    var bx = x - dx * size * 0.42, by = y - dy * size * 0.42;
    var tx = bx - dx * len, ty = by - dy * len;
    var px = -dy, py = dx;
    var grad = g.createLinearGradient(bx, by, tx, ty);
    grad.addColorStop(0, 'rgba(255,240,190,0.9)');
    grad.addColorStop(0.25, 'rgba(255,150,50,0.5)');
    grad.addColorStop(0.6, color.replace('rgb', 'rgba').replace(')', ',0.3)'));
    grad.addColorStop(1, 'rgba(255,90,50,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(bx + px * wide, by + py * wide);
    g.lineTo(tx, ty);
    g.lineTo(bx - px * wide, by - py * wide);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(255,240,190,' + (0.9 * flick).toFixed(2) + ')';
    g.beginPath();
    g.arc(bx, by, size * 0.07, 0, TAU);
    g.fill();
  }

  /** A hull hit last turn, or crippled: smoke under, fires over. */
  function burn(g, s, x, y, tick, t, size) {
    if (s.hp == null) return;
    var frac = s.hp / 100;
    var recent = s.dt != null && tick - s.dt < 2;
    if (!recent && frac >= 0.34) return;
    var sev = Math.max(recent ? 0.5 : 0.25, 1 - frac);
    var base = Math.max(4, size * 0.4);
    var ph = (hash(s.id) % 1000) / 1000 * TAU;
    for (var i = 0; i <= 2 + Math.round(sev); i++) {
      var drift = ((t / 1400) + i / 4 + ph) % 1;
      g.fillStyle = 'rgba(48,54,62,' + ((1 - drift) * 0.3 * sev).toFixed(3) + ')';
      g.beginPath();
      g.arc(x + Math.cos(ph + i * 2.4) * base * 0.3 + drift * base * 0.5,
            y - drift * base * 1.1, base * (0.22 + drift * 0.3), 0, TAU);
      g.fill();
    }
    for (var k = 0; k < 1 + Math.round(sev * 2); k++) {
      var a = ph + k * 2.3;
      var f = 0.55 + 0.45 * Math.sin(t / 130 + k * 2 + ph);
      var r = base * (0.28 + 0.18 * sev) * (0.7 + 0.5 * f);
      var fx = x + Math.cos(a) * base * 0.4, fy = y + Math.sin(a) * base * 0.4 - r * 0.25;
      g.fillStyle = 'rgba(255,150,50,' + (0.45 * f * sev).toFixed(3) + ')';
      g.beginPath(); g.arc(fx, fy, r, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,240,190,' + (0.8 * f * sev).toFixed(3) + ')';
      g.beginPath(); g.arc(fx, fy, r * 0.4, 0, TAU); g.fill();
    }
  }

  function volley(g, from, to, k, color, target) {
    var MUZZLE = 130, CHARGE = 180, BEAM = 200, TRAVEL0 = 60, TRAVEL = 300, IMPACT = 200;
    var energy = arguments[5];
    if (energy) {
      if (k < CHARGE) {
        var c = k / CHARGE;
        g.fillStyle = 'rgba(57,215,255,' + (0.25 + 0.55 * c).toFixed(2) + ')';
        g.beginPath(); g.arc(from.x, from.y, 0.8 + 2.2 * c, 0, TAU); g.fill();
      }
      var b = k - CHARGE;
      if (b >= 0 && b <= BEAM) {
        var a = b < BEAM * 0.2 ? b / (BEAM * 0.2) : 1 - (b - BEAM * 0.2) / (BEAM * 0.8);
        g.strokeStyle = 'rgba(57,215,255,' + (0.35 * a).toFixed(2) + ')';
        g.lineWidth = 3.2;
        g.beginPath(); g.moveTo(from.x, from.y); g.lineTo(to.x, to.y); g.stroke();
        g.strokeStyle = 'rgba(230,251,255,' + (0.9 * a).toFixed(2) + ')';
        g.lineWidth = 1.1;
        g.beginPath(); g.moveTo(from.x, from.y); g.lineTo(to.x, to.y); g.stroke();
      }
      var land = k - (CHARGE + BEAM);
      if (land >= 0 && land <= IMPACT) {
        var f = land / IMPACT;
        if (target && target.ar > 0) {
          for (var i = 0; i < 5; i++) {
            var ang = i * 1.27 + f, rr = 1.5 + 6 * f;
            g.fillStyle = 'rgba(255,154,60,' + (0.8 * (1 - f)).toFixed(2) + ')';
            g.beginPath(); g.arc(to.x + Math.cos(ang) * rr, to.y + Math.sin(ang) * rr, 0.9, 0, TAU); g.fill();
          }
        } else {
          g.fillStyle = 'rgba(57,215,255,' + (0.55 * (1 - f)).toFixed(2) + ')';
          g.beginPath(); g.arc(to.x, to.y, 1.5 + 6 * f, 0, TAU); g.fill();
        }
      }
      return;
    }
    if (k < MUZZLE) {
      var m = 1 - k / MUZZLE;
      g.fillStyle = 'rgba(255,196,107,' + (0.75 * m).toFixed(2) + ')';
      g.beginPath(); g.arc(from.x, from.y, 1.5 + 2.5 * m, 0, TAU); g.fill();
    }
    var travel = Math.max(0, Math.min(1, (k - TRAVEL0) / TRAVEL));
    if (travel > 0 && travel < 1) {
      var tail = Math.max(0, travel - 0.16);
      g.strokeStyle = color;
      g.lineWidth = 1.3;
      g.beginPath();
      g.moveTo(lerp(from.x, to.x, tail), lerp(from.y, to.y, tail));
      g.lineTo(lerp(from.x, to.x, travel), lerp(from.y, to.y, travel));
      g.stroke();
      g.fillStyle = 'rgb(255,242,196)';
      g.beginPath(); g.arc(lerp(from.x, to.x, travel), lerp(from.y, to.y, travel), 1.3, 0, TAU); g.fill();
    }
    var hit = k - (TRAVEL0 + TRAVEL);
    if (hit >= 0 && hit <= IMPACT) {
      var hf = hit / IMPACT;
      if (target && target.sh > 0) {
        var face = Math.atan2(from.y - to.y, from.x - to.x);
        g.strokeStyle = 'rgba(111,199,255,' + (0.75 * (1 - hf)).toFixed(2) + ')';
        g.lineWidth = 1.6 - 0.8 * hf;
        g.beginPath();
        g.arc(to.x, to.y, 5.5, face - 0.95, face + 0.95);
        g.stroke();
      } else {
        g.strokeStyle = 'rgba(255,242,196,' + (0.8 * (1 - hf)).toFixed(2) + ')';
        g.lineWidth = 1;
        g.beginPath(); g.arc(to.x, to.y, 1.5 + 5 * hf, 0, TAU); g.stroke();
        for (var s2 = 0; s2 < 4; s2++) {
          var sa = s2 * 1.9 + hf * 1.2, r0 = 2 + 3 * hf;
          g.strokeStyle = 'rgba(255,196,107,' + (0.7 * (1 - hf)).toFixed(2) + ')';
          g.beginPath();
          g.moveTo(to.x + Math.cos(sa) * r0, to.y + Math.sin(sa) * r0);
          g.lineTo(to.x + Math.cos(sa) * (r0 + 2.5), to.y + Math.sin(sa) * (r0 + 2.5));
          g.stroke();
        }
      }
    }
  }

  function wreck(g, x, y, color, age, fade) {
    var f = Math.max(0, Math.min(1, age / WRECK_MS));
    if (f < 1) {
      if (f < 0.18) {
        var k = 1 - f / 0.18;
        g.fillStyle = 'rgba(255,255,255,' + (0.9 * k).toFixed(2) + ')';
        g.beginPath(); g.arc(x, y, 2 + 9 * (1 - k), 0, TAU); g.fill();
      }
      g.strokeStyle = 'rgba(255,196,107,' + (0.55 * (1 - f)).toFixed(2) + ')';
      g.lineWidth = 1.8 - 1.2 * f;
      g.beginPath(); g.arc(x, y, 3 + 22 * f, 0, TAU); g.stroke();
    }
    for (var i = 0; i < 7; i++) {
      var a = i * 0.92 + (x + y) * 0.01;
      var d = (10 + (i % 3) * 5) * Math.min(1, f * 2.2) + 6 * f + 7 * fade;
      var px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
      g.strokeStyle = color.replace('rgb', 'rgba').replace(')', ',' + (0.2 + 0.65 * (1 - fade)).toFixed(2) + ')');
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + Math.cos(a) * 2.2, py + Math.sin(a) * 2.2);
      g.stroke();
    }
  }

  function hex(c) {
    // '#rrggbb' -> 'rgb(r,g,b)', so alpha can be spliced in above.
    var n = parseInt(String(c || '#7d92a6').slice(1), 16);
    return 'rgb(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ')';
  }

  // ---- the two views ---------------------------------------------------
  function Orbits(canvas, opts) {
    var g = canvas.getContext('2d');
    var self = this;
    this.worlds = null;
    this.system = 0;
    this.body = null;          // null = the system; else a world id
    this.seen = {};            // wreck / movement first-sight clocks
    this.onPick = opts && opts.onPick;
    this.hit = [];

    canvas.addEventListener('click', function (e) {
      var r = canvas.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;
      if (self.body) { self.body = null; self.seen = {}; if (self.onPick) self.onPick(null); return; }
      for (var i = 0; i < self.hit.length; i++) {
        var h = self.hit[i];
        if ((h.x - x) * (h.x - x) + (h.y - y) * (h.y - y) < (h.r + 10) * (h.r + 10)) {
          self.body = h.id;
          self.seen = {};
          if (self.onPick) self.onPick(h.id);
          return;
        }
      }
    });

    this.set = function (w) {
      self.worlds = w;
      if (self.system >= (w.systems || []).length) self.system = 0;
    };
    this.step = function (dir) {
      if (!self.worlds || !self.worlds.systems.length) return;
      self.system = (self.system + dir + self.worlds.systems.length) % self.worlds.systems.length;
      self.body = null;
    };
    this.label = function () {
      if (!self.worlds) return '';
      if (self.body) {
        var w = (self.worlds.worlds || []).filter(function (x) { return x.id === self.body; })[0];
        var b = null;
        (self.worlds.systems || []).forEach(function (s) {
          s.bodies.forEach(function (x) { if (x.id === self.body) b = x; });
        });
        return ((w && w.name) || (b && b.name) || '?').toUpperCase();
      }
      var sys = (self.worlds.systems || [])[self.system];
      return sys ? sys.label.toUpperCase() : '';
    };

    function draw(t) {
      var w = canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
      var h = canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, w, h);
      g.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
      var W = canvas.clientWidth, H = canvas.clientHeight;
      self.hit = [];
      if (!self.worlds) return;
      if (self.body) drawPorthole(W, H, t);
      else drawSystem(W, H, t);
    }

    function drawSystem(W, H, t) {
      var sys = (self.worlds.systems || [])[self.system];
      if (!sys) return;
      var cx = W / 2, cy = H / 2;
      var outer = Math.min(W, H) / 2 * 0.82;
      // The controller's colour under the whole system, as the map bands it.
      if (sys.controller && !sys.contested) {
        var grad = g.createRadialGradient(cx, cy, 0, cx, cy, outer);
        grad.addColorStop(0, hex(self.worlds.factions[sys.controller].color).replace('rgb', 'rgba').replace(')', ',0.30)'));
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.beginPath(); g.arc(cx, cy, outer, 0, TAU); g.fill();
      }
      var bodies = sys.bodies.slice();
      var center = sys.id === 'core' ? null : bodies.reduce(function (a, b) {
        return (!a || b.radius > a.radius) && !b.parent ? b : a;
      }, null);
      var ringed = bodies.filter(function (b) { return b !== center; })
        .sort(function (a, b) { return a.orbit - b.orbit; });
      var centerR = center ? 13 : 10;
      if (center) place(center, cx, cy, centerR);
      else {
        var sun = g.createRadialGradient(cx, cy, 0, cx, cy, 18);
        sun.addColorStop(0, 'rgba(255,241,176,1)'); sun.addColorStop(1, 'rgba(255,138,0,0)');
        g.fillStyle = sun; g.beginPath(); g.arc(cx, cy, 18, 0, TAU); g.fill();
      }
      var inner = centerR + 22;
      ringed.forEach(function (b, i) {
        var r = ringed.length === 1 ? (inner + outer) / 2
          : inner + (outer - inner) * i / (ringed.length - 1);
        g.strokeStyle = 'rgba(27,36,48,1)';
        g.lineWidth = 1;
        g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.stroke();
        place(b, cx + Math.cos(b.angle) * r, cy + Math.sin(b.angle) * r, bodyR(b.type));
      });

      function bodyR(type) {
        if (type === 'gas-giant' || type === 'gas_giant') return 13;
        if (type === 'ice-giant' || type === 'ice_giant') return 12;
        if (type === 'terrestrial') return 10;
        if (type === 'dwarf') return 8;
        if (type === 'moon') return 7;
        return 6;
      }

      function place(b, x, y, r) {
        self.hit.push({ id: b.id, x: x, y: y, r: r });
        var sprite = b.sp ? img('/wear/planet/' + b.sp + '/' + (b.sp.indexOf('saturn') === 0 || b.sp.indexOf('uranus') === 0 ? 192 : 96) + '.png') : null;
        var scale = (b.sp && (b.sp.indexOf('saturn') === 0 || b.sp.indexOf('uranus') === 0)) ? 2 : 1;
        if (sprite && sprite.complete && sprite.naturalWidth) {
          g.globalAlpha = b.seen ? 1 : 0.45;
          g.drawImage(sprite, x - r * scale, y - r * scale, r * 2 * scale, r * 2 * scale);
          g.globalAlpha = 1;
        } else {
          g.fillStyle = hex(b.color);
          g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
        }
        if (b.battle) {
          var period = b.battle === 'firing' ? 700 : 1600;
          var k = (t % period) / period;
          g.strokeStyle = 'rgba(255,94,94,' + (0.85 * (1 - k)).toFixed(2) + ')';
          g.lineWidth = 1.6;
          g.beginPath(); g.arc(x, y, r + 3 + 7 * k, 0, TAU); g.stroke();
        }
        if (b.owner && self.worlds.factions[b.owner]) {
          g.strokeStyle = hex(self.worlds.factions[b.owner].color);
          g.lineWidth = 1.4;
          g.beginPath(); g.arc(x, y, r + 2, 0, TAU); g.stroke();
        }
        // Counts, each empire with its flag.
        var entries = Object.keys(b.counts || {}).filter(function (f) { return b.counts[f] > 0; });
        entries.sort(function (a, c) { return b.counts[c] - b.counts[a]; });
        entries.slice(0, 3).forEach(function (f, i) {
          var info = self.worlds.factions[f] || {};
          var fy = y - r - 2 + i * 11;
          var fx = x + r + 3;
          var em = info.em ? img('/wear/flag/' + info.em + '/32.png') : null;
          g.fillStyle = hex(info.color);
          if (em && em.complete && em.naturalWidth) {
            g.save();
            g.globalCompositeOperation = 'source-over';
            drawTinted(em, fx, fy - 7, 8, hex(info.color));
            g.restore();
            g.font = '10px system-ui, sans-serif';
            g.fillText(String(b.counts[f]), fx + 10, fy);
          } else {
            g.font = '10px system-ui, sans-serif';
            g.fillText('★' + b.counts[f], fx, fy);
          }
        });
        g.fillStyle = 'rgba(125,146,166,1)';
        g.font = '9px system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText(b.name.toUpperCase(), x, y + r + 11);
        g.textAlign = 'left';
      }
    }

    // A white mask drawn in a colour: the emblems are served white.
    var tintCanvas = document.createElement('canvas');
    function drawTinted(im, x, y, size, color) {
      tintCanvas.width = size; tintCanvas.height = size;
      var tg = tintCanvas.getContext('2d');
      tg.clearRect(0, 0, size, size);
      tg.drawImage(im, 0, 0, size, size);
      tg.globalCompositeOperation = 'source-in';
      tg.fillStyle = color;
      tg.fillRect(0, 0, size, size);
      g.drawImage(tintCanvas, x, y, size, size);
    }

    function drawPorthole(W, H, t) {
      var world = (self.worlds.worlds || []).filter(function (x) { return x.id === self.body; })[0];
      var body = null;
      (self.worlds.systems || []).forEach(function (s) {
        s.bodies.forEach(function (x) { if (x.id === self.body) body = x; });
      });
      var cx = W / 2, cy = H / 2;
      var type = (world && world.type) || (body && body.type) || 'terrestrial';
      var pr = Math.min(W, H) * ((type.indexOf('giant') >= 0) ? 0.17 : 0.13);
      var sp = (world && world.sp) || (body && body.sp);
      var scale = sp && (sp.indexOf('saturn') === 0 || sp.indexOf('uranus') === 0) ? 2 : 1;
      var planet = sp ? img('/wear/planet/' + sp + '/' + (192 * scale) + '.png') : null;
      if (planet && planet.complete && planet.naturalWidth) {
        g.drawImage(planet, cx - pr * scale, cy - pr * scale, pr * 2 * scale, pr * 2 * scale);
      } else {
        g.fillStyle = hex((world && world.color) || (body && body.color));
        g.beginPath(); g.arc(cx, cy, pr, 0, TAU); g.fill();
      }
      if (!world) {
        g.fillStyle = 'rgba(125,146,166,1)';
        g.font = '11px system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText('OUT OF SENSOR RANGE', cx, cy + pr + 26);
        g.textAlign = 'left';
        return;
      }
      var slots = seats(world.ships || []);
      var maxRing = slots.reduce(function (m, s) { return Math.max(m, s.ring); }, 0);
      var first = pr + 22;
      var fit = Math.min(W, H) / 2 * 0.92;
      var gap = maxRing === 0 ? 0 : Math.min(16, (fit - first) / maxRing);
      for (var ring = 0; ring <= maxRing; ring++) {
        g.strokeStyle = 'rgba(27,36,48,0.8)';
        g.lineWidth = 0.8;
        g.beginPath(); g.arc(cx, cy, first + ring * gap, 0, TAU); g.stroke();
      }
      // Movements: what came and went this tick.
      var flights = {};
      (world.moves || []).forEach(function (m) {
        if (self.seen[m.id] === undefined) self.seen[m.id] = t;
        var k = (t - self.seen[m.id]) / FLIGHT_MS;
        if (k >= 0 && k <= 1) flights[m.id] = k;
      });
      var pos = {}, live = {};
      slots.forEach(function (s) {
        var r = first + s.ring * gap;
        var w = TAU / INNER_LAP_MS * Math.pow(first / r, 1.5);
        var a = s.a0 + w * t;
        var seat = { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
        var k = flights[s.ship.id];
        var p = seat;
        if (k !== undefined) {
          var far = { x: cx + Math.cos(a) * Math.min(W, H), y: cy + Math.sin(a) * Math.min(W, H) };
          var u = 1 - (1 - k) * (1 - k);
          p = { x: lerp(far.x, seat.x, u), y: lerp(far.y, seat.y, u) };
        }
        pos[s.ship.id] = p;
        live[s.ship.id] = s.ship;
        s.seatAngle = a;
        s.p = p;
        self.seen['seat:' + s.ship.id] = { r: r, a0: s.a0, w: w };
      });
      // Hulls, plumes and burns.
      slots.forEach(function (s) {
        var color = hex((self.worlds.factions[s.ship.f] || {}).color);
        var heading = flights[s.ship.id] !== undefined ? s.seatAngle + Math.PI : s.seatAngle + Math.PI / 2;
        plume(g, s.p.x, s.p.y, heading, s.px, color, t, hash(s.ship.id));
        var icon = img('/wear/icon/' + hullKey(s.ship.k) + '/64.png');
        g.save();
        g.translate(s.p.x, s.p.y);
        g.rotate(heading);
        if (icon && icon.complete && icon.naturalWidth) {
          var hh = s.px * icon.naturalHeight / icon.naturalWidth;
          drawTinted(icon, -s.px / 2, -hh / 2, s.px, color);
        } else {
          g.fillStyle = color;
          g.beginPath(); g.moveTo(s.px / 2, 0); g.lineTo(-s.px / 2, -s.px / 4); g.lineTo(-s.px / 2, s.px / 4); g.closePath(); g.fill();
        }
        g.restore();
        burn(g, s.ship, s.p.x, s.p.y, self.worlds.tick, t, s.px);
      });
      // Shots.
      if (world.firing) {
        var pairs = {};
        (world.ships || []).forEach(function (s) { if (s.t && pos[s.t]) pairs[s.id] = s.t; });
        if (!Object.keys(pairs).length) {
          var mine = (world.ships || []).filter(function (s) { return s.c && s.f === self.worlds.me; });
          var theirs = (world.ships || []).filter(function (s) { return s.c && s.f !== self.worlds.me; });
          mine.forEach(function (s, i) { if (theirs.length) pairs[s.id] = theirs[i % theirs.length].id; });
          theirs.forEach(function (s, i) { if (mine.length) pairs[s.id] = mine[i % mine.length].id; });
        }
        Object.keys(pairs).forEach(function (id) {
          var from = pos[id], to = pos[pairs[id]];
          if (!from || !to) return;
          var sh = live[id];
          var beat = 1100 + (hash(id) % 900);
          var phase = (hash(id + 'p')) % beat;
          var since = (t + phase) % beat;
          if (since > 560) return;
          var vol = Math.floor((t + phase) / beat);
          var isEnergy = sh.e > 0 && (sh.e >= 1 || roll(id, vol) < sh.e);
          volley(g, from, to, since, hex((self.worlds.factions[sh.f] || {}).color), live[pairs[id]], isEnergy);
        });
      }
      // The dead: an explosion where they were, then debris.
      (world.dead || []).forEach(function (d) {
        if (self.seen['w:' + d.id] === undefined) self.seen['w:' + d.id] = t;
        var seat = self.seen['seat:' + d.id];
        var x, y;
        if (seat) {
          var a = seat.a0 + seat.w * t;
          x = cx + Math.cos(a) * seat.r; y = cy + Math.sin(a) * seat.r;
        } else {
          var a2 = (hash(d.id) % 628) / 100 + TAU / INNER_LAP_MS * t;
          x = cx + Math.cos(a2) * (first + gap * 0.5); y = cy + Math.sin(a2) * (first + gap * 0.5);
        }
        var old = Math.max(0, self.worlds.tick - d.at);
        wreck(g, x, y, hex((self.worlds.factions[d.f] || {}).color), t - self.seen['w:' + d.id], Math.min(1, old / 3));
      });
      // And the ones that left.
      (world.moves || []).forEach(function (m) {
        if (m.dir !== 'out') return;
        var k = flights[m.id];
        if (k === undefined) return;
        var seat = self.seen['seat:' + m.id];
        var a = seat ? seat.a0 + seat.w * t : (hash(m.id) % 628) / 100;
        var r0 = seat ? seat.r : first;
        var fromP = { x: cx + Math.cos(a) * r0, y: cy + Math.sin(a) * r0 };
        var out = Math.atan2(fromP.y - cy, fromP.x - cx);
        var far = { x: cx + Math.cos(out) * Math.min(W, H), y: cy + Math.sin(out) * Math.min(W, H) };
        var u = k * k;
        var p = { x: lerp(fromP.x, far.x, u), y: lerp(fromP.y, far.y, u) };
        var color = hex((self.worlds.factions[m.f] || {}).color);
        var px = iconPx(m.cls) * (1 - 0.25 * k);
        plume(g, p.x, p.y, out, px * (0.9 + 0.9 * k), color, t, hash(m.id));
        var icon = img('/wear/icon/' + hullKey(m.k) + '/64.png');
        g.save();
        g.globalAlpha = 1 - k * k;
        g.translate(p.x, p.y);
        g.rotate(out);
        if (icon && icon.complete && icon.naturalWidth) {
          var hh2 = px * icon.naturalHeight / icon.naturalWidth;
          drawTinted(icon, -px / 2, -hh2 / 2, px, color);
        }
        g.restore();
        g.globalAlpha = 1;
      });
    }

    var start = null;
    function frame(ms) {
      if (start === null) start = ms;
      draw(ms - start);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  root.OrbitalOrbits = Orbits;
})(window);
`;
