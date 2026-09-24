// ============================================================
// GET /panel -- the pop-out, for a desktop left running all day.
//
// WHY A PAGE AND NOT THE GAME IN A SMALL WINDOW. A second copy of the
// game in a 380px window is the whole React bundle, the map canvas and a
// websocket, running for hours beside the one you are already playing.
// This is a single self-contained document that fetches four small JSON
// documents a minute and paints text: it is meant to sit in the corner
// of a monitor, not to be played.
//
// IT IS THE SAME DATA THE WATCH READS, and deliberately so. The wear
// feeds (state.json, standings.json, command.json) are already the
// compact, summarised view of an empire that a glance needs, and the
// widget images are already rendered server-side for the phone's home
// screen. The panel is those things reformatted for a browser -- one
// more surface on the same feeds, not a fifth set of rules.
//
// AUTHENTICATION IS A WIDGET TOKEN, NOT THE COOKIE. The images and the
// feeds are token routes (a phone widget has no session), so the page
// asks /api/me/panel-token once, behind the cookie, and keeps using
// that. One token per player, reused, revocable with every other device
// from account settings.
// ============================================================

import { mintWidgetToken } from './widget.js';

export const PANEL_RE = /^\/panel\/?$/;

/** The label its token wears, so a second open reuses the first. */
const PANEL_LABEL = 'desktop panel';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * POST /api/me/panel-token -- the token this browser's panel reads with.
 *
 * Reused, not minted per open: a player who opens the panel every
 * morning should not collect three hundred tokens, and a panel that
 * survives a reload without a round trip is the point.
 */
async function handlePanelToken(_req, env, { session }) {
  if (!session) return json({ error: { code: 'unauthenticated', message: 'sign in required' } }, 401);
  const row = await env.DB
    .prepare(
      `SELECT token FROM widget_tokens
        WHERE user_id = ? AND label = ? AND revoked_ms IS NULL AND scope = 'wear_orders'
        ORDER BY created_ms DESC LIMIT 1`,
    )
    .bind(session.user_id, PANEL_LABEL).first().catch(() => null);
  if (row?.token) return json({ ok: true, token: String(row.token) });
  // Orders included, on the same reasoning the watch settled on: this is
  // the signed-in player's own browser, and a panel that can see a bill
  // closing but not vote on it is a worse panel.
  const token = await mintWidgetToken(env, session.user_id, PANEL_LABEL, 'wear_orders');
  return json({ ok: true, token });
}

export const routes = [
  { method: 'POST', pattern: /^\/api\/me\/panel-token$/, auth: 'required', handle: handlePanelToken },
];

/** GET /panel -- the document itself. */
export function handlePanel() {
  return new Response(PAGE, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orbital</title>
<style>
  :root {
    --bg: #070b10; --panel: #0e141c; --line: #1b2430;
    --ink: #d8e4ee; --dim: #7d92a6; --good: #6ee7b7; --warn: #ffb84d;
    --alarm: #ff5e5e; --metal: #b8c6d4; --credit: #ffd479; --sci: #8fd8ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { padding: 10px 12px 14px; display: flex; flex-direction: column; gap: 10px; }
  .row { display: flex; align-items: center; gap: 8px; }
  .between { justify-content: space-between; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; }
  .lbl { color: var(--dim); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
  .big { font-size: 20px; font-weight: 600; }
  .mono { font-variant-numeric: tabular-nums; }
  .res { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; text-align: center; }
  .bar { height: 12px; border-radius: 6px; overflow: hidden; display: flex; background: #131c26; position: relative; }
  .bar i { display: block; height: 100%; }
  .tick { position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--warn); }
  .flag { width: 13px; height: 13px; display: inline-block; vertical-align: -2px;
          -webkit-mask-size: contain; mask-size: contain; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  button {
    font: inherit; color: var(--ink); background: #16202c; border: 1px solid var(--line);
    border-radius: 999px; padding: 4px 10px; cursor: pointer;
  }
  button:hover { border-color: #33465c; }
  button:disabled { opacity: .5; cursor: default; }
  img.card-img { width: 100%; border-radius: 10px; border: 1px solid var(--line); display: block; }
  .muted { color: var(--dim); }
  .alarm { color: var(--alarm); }
  .warn { color: var(--warn); }
  .good { color: var(--good); }
  a { color: var(--sci); }
</style>
</head>
<body>
<div class="wrap" id="wrap"><div class="muted">Connecting…</div></div>
<script>
(function () {
  var token = null;
  var tickAt = 0, skew = 0, tickNo = 0, phase = 'none';
  var el = document.getElementById('wrap');

  function h(html) { el.innerHTML = html; }
  function esc(s) {
    return String(s == null ? '' : s)
      .split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
  }
  function compact(n) {
    n = Number(n) || 0;
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }
  function rate(v) {
    if (v == null) return '—';
    var r = Math.round(v);
    return (r >= 0 ? '+' : '−') + compact(Math.abs(r));
  }
  function flag(em, color) {
    if (!em) return '<span class="dot" style="background:' + esc(color) + '"></span>';
    var u = '/wear/flag/' + encodeURIComponent(em) + '/32.png';
    return '<span class="flag" style="background:' + esc(color)
      + ';-webkit-mask-image:url(' + u + ');mask-image:url(' + u + ')"></span>';
  }

  function countdown() {
    if (!tickAt) return '';
    var left = tickAt - (Date.now() + skew);
    if (left <= 0) return 'ANY MOMENT';
    var m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    if (left < 60000) return s + 's';
    if (m < 60) return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  function paintClock() {
    var n = document.getElementById('cd');
    if (n) n.textContent = countdown();
  }

  function render(s, board, cmd) {
    var a = s.attention || {};
    var pt = s.perTick || {};
    var res = s.resources || {};
    var out = [];

    out.push('<div class="row between">'
      + '<div><div class="big" style="color:' + esc(s.color || '#4ecdc4') + '">' + esc(s.faction || 'Orbital') + '</div>'
      + '<div class="lbl">' + esc(s.game || '') + '</div></div>'
      + '<div style="text-align:right"><div class="lbl">Turn ' + (s.tick || 0) + '</div>'
      + '<div class="mono" id="cd">' + countdown() + '</div></div></div>');

    out.push('<div class="card res">'
      + '<div><div class="lbl">Metal</div><div class="mono" style="color:var(--metal)">' + compact(res.metal) + '</div>'
      + '<div class="lbl mono">' + rate(pt.netMetal != null ? pt.netMetal : pt.metal) + '/t</div></div>'
      + '<div><div class="lbl">Credits</div><div class="mono" style="color:var(--credit)">' + compact(res.credits) + '</div>'
      + '<div class="lbl mono">' + rate(pt.netCredits != null ? pt.netCredits : pt.credits) + '/t</div></div>'
      + '<div><div class="lbl">Science</div><div class="mono" style="color:var(--sci)">' + compact(res.science) + '</div>'
      + '<div class="lbl mono">' + rate(pt.science) + '/t</div></div></div>');

    if (s.research) {
      var pct = s.research.cost > 0 ? Math.round((s.research.progress / s.research.cost) * 100) : 0;
      out.push('<div class="card"><div class="row between"><span class="lbl">Researching</span>'
        + '<span class="mono">' + esc(s.research.name) + ' ' + s.research.level + ' · ' + pct + '%</span></div>'
        + '<div class="bar" style="margin-top:6px"><i style="width:' + pct + '%;background:var(--sci)"></i></div></div>');
    } else if (phase === 'live') {
      out.push('<div class="card warn">No research project</div>');
    }

    var fleet = [];
    if (s.ships != null) fleet.push(s.ships + ' ships');
    if (s.building) fleet.push('<span class="good">' + s.building + ' building</span>');
    if (s.inCombat) fleet.push('<span class="alarm">' + s.inCombat + ' in combat</span>');
    var alerts = [];
    if (a.inbound) alerts.push('<span class="alarm">' + a.inbound + ' inbound</span>');
    if (a.bills) alerts.push('<span class="warn">' + a.bills + ' to vote</span>');
    if (a.unread) alerts.push(a.unread + ' unread');
    if (a.offers) alerts.push(a.offers + ' offers');
    if (fleet.length || alerts.length) {
      out.push('<div class="card"><div>' + (fleet.join(' · ') || '<span class="muted">No fleet</span>') + '</div>'
        + (alerts.length ? '<div style="margin-top:4px">' + alerts.join(' · ') + '</div>' : '') + '</div>');
    }

    if (board && board.worlds && board.worlds.total > 0) {
      var w = board.worlds, segs = '', held = 0;
      (board.factions || []).forEach(function (f) {
        if (!f.worlds) return;
        held += f.worlds;
        segs += '<i style="width:' + ((100 * f.worlds) / w.total) + '%;background:' + esc(f.color) + '"></i>';
      });
      var mark = w.need > 0 ? '<span class="tick" style="left:' + ((100 * w.need) / w.total) + '%"></span>' : '';
      var rows = (board.factions || []).filter(function (f) { return f.worlds > 0 || f.mine; }).slice(0, 5)
        .map(function (f) {
          return '<div class="row between" style="margin-top:4px">'
            + '<span>' + flag(f.emblem, f.color) + ' ' + esc(f.name) + (f.mine ? ' <span class="lbl">you</span>' : '') + '</span>'
            + '<span class="mono muted">' + f.worlds + 'w · ' + f.systems + 's · ★' + f.weight
            + (f.ships == null ? ' · 🔒' : ' · ' + f.ships) + '</span></div>';
        }).join('');
      out.push('<div class="card"><div class="row between"><span class="lbl">Territory</span>'
        + '<span class="lbl mono">' + held + '/' + w.total + ' held · ' + w.need + ' wins</span></div>'
        + '<div class="bar" style="margin-top:6px">' + segs + mark + '</div>' + rows + '</div>');
    }

    if (cmd && cmd.wars && cmd.wars.length) {
      out.push('<div class="card alarm">At war: ' + cmd.wars.map(function (x) {
        return esc((cmd.factions && cmd.factions[x.with] && cmd.factions[x.with].name) || '?');
      }).join(', ') + '</div>');
    }

    if (s.senate && s.senate.length) {
      var b = s.senate[0];
      out.push('<div class="card"><div class="lbl">Senate · closes in ' + b.closesIn + 't</div>'
        + '<div style="margin:3px 0 7px">' + esc(b.title) + '</div>'
        + '<div class="row" data-bill="' + esc(b.id) + '">'
        + '<button data-vote="yea">Yea</button><button data-vote="nay">Nay</button>'
        + '<button data-vote="abstain">Abstain</button>'
        + '<span class="muted mono" style="margin-left:auto">' + b.yea + '–' + b.nay + '</span></div></div>');
    }

    if (token) {
      var bust = '?t=' + Math.floor(Date.now() / 30000);
      if (a.fighting) {
        out.push('<img class="card-img" alt="Battles" src="/widget/' + token + '/battle.png' + bust + '">');
      }
      out.push('<img class="card-img" alt="The map" src="/widget/' + token + '/map.png' + bust + '">');
    }

    out.push('<div class="row between"><span class="lbl">Updates every minute</span>'
      + '<button id="refresh">Refresh</button></div>');
    h(out.join(''));

    var refresh = document.getElementById('refresh');
    if (refresh) refresh.onclick = function () { load(); };
    var votes = document.querySelectorAll('[data-vote]');
    for (var i = 0; i < votes.length; i++) {
      votes[i].onclick = function (e) {
        var btn = e.currentTarget;
        var bill = btn.parentNode.getAttribute('data-bill');
        btn.disabled = true;
        fetch('/wear/' + token + '/vote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ proposalId: bill, vote: btn.getAttribute('data-vote') }),
        }).then(function () { load(); }).catch(function () { btn.disabled = false; });
      };
    }
  }

  function get(path) {
    return fetch(path, { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).catch(function () { return null; });
  }

  function load() {
    if (!token) return;
    Promise.all([
      get('/wear/' + token + '/state.json'),
      get('/wear/' + token + '/standings.json'),
      get('/wear/' + token + '/command.json'),
    ]).then(function (all) {
      var s = all[0];
      if (!s) { h('<div class="muted">Orbital is not reachable right now.</div>'); return; }
      phase = s.state || 'none';
      if (phase === 'none') { h('<div class="muted">No game yet. Join one in Orbital.</div>'); return; }
      tickAt = s.nextTickAt || 0;
      skew = s.now ? (s.now - Date.now()) : 0;
      tickNo = s.tick || 0;
      render(s, all[1], all[2]);
      schedule();
    });
  }

  var timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    // A minute, or just after the turn lands -- whichever comes first.
    var wait = 60000;
    if (tickAt) {
      var toTick = tickAt - (Date.now() + skew) + 1500;
      if (toTick > 0 && toTick < wait) wait = toTick;
    }
    timer = setTimeout(load, wait);
  }

  setInterval(paintClock, 1000);
  fetch('/api/me/panel-token', { method: 'POST', credentials: 'include' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j || !j.token) {
        h('<div class="muted">Sign in to Orbital in this browser, then reopen the panel.</div>');
        return;
      }
      token = j.token;
      load();
    })
    .catch(function () { h('<div class="muted">Orbital is not reachable right now.</div>'); });
})();
</script>
</body>
</html>`;
