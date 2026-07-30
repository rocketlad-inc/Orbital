-- ============================================================================
-- One-time backfill of analytics_events from the entity tables (2026-07-30).
--
-- Telemetry started logging at 16:10Z today, so "feature usage" was blind
-- to everything before it - the dashboard claimed ship building was
-- "never used" in a game with 280 built hulls. The entity tables ARE the
-- event log for the pre-telemetry era: every ship, settlement, tech,
-- trade, fleet, design, and senate vote row carries its creation tick or
-- ms. This reconstructs one event per row, with:
--
--   kind       = the SAME normalized label live logging produces, so
--                backfilled and live counts merge in one bar
--   timestamp  = room.created_at + tick * tick_interval_ms (approximate:
--                interval changes shift it, good enough for usage bars),
--                or the row's real created_at_ms where one exists
--   user_id    = the owning faction's human (NULL for AI factions)
--
-- Guards: only rows whose computed timestamp lands BEFORE the telemetry
-- cutoff (no double counting live events), and only games with at least
-- one real-human faction (QA fixture games stay out of the data).
-- Run ONCE via wrangler d1 execute. Cutoff = 2026-07-30T16:10:00Z.
-- ============================================================================

-- Ships built by players (built_at_tick = 0 rows are world-seeded, skip).
INSERT INTO analytics_events (game_id, user_id, kind, created_at_ms)
SELECT s.game_id, f.user_id, 'POST bodies/build',
       r.created_at + s.built_at_tick * g.tick_interval_ms
  FROM game_ships s
  JOIN games g ON g.id = s.game_id
  JOIN rooms r ON r.id = g.id
  JOIN game_factions f ON f.id = s.owner_faction_id
 WHERE s.built_at_tick > 0
   AND r.created_at + s.built_at_tick * g.tick_interval_ms < 1785427800000
   AND EXISTS (SELECT 1 FROM game_factions f2 JOIN users u ON u.id = f2.user_id
                WHERE f2.game_id = s.game_id
                  AND u.email NOT LIKE '%@example.com'
                  AND u.email NOT LIKE '%@example.test'
                  AND u.email NOT LIKE '%@orbital-test.local');

-- Settlements founded after game start.
INSERT INTO analytics_events (game_id, user_id, kind, created_at_ms)
SELECT st.game_id, f.user_id, 'POST bodies/settlement',
       r.created_at + st.created_at_tick * g.tick_interval_ms
  FROM game_settlements st
  JOIN games g ON g.id = st.game_id
  JOIN rooms r ON r.id = g.id
  JOIN game_factions f ON f.id = st.owner_faction_id
 WHERE st.created_at_tick > 0
   AND r.created_at + st.created_at_tick * g.tick_interval_ms < 1785427800000
   AND EXISTS (SELECT 1 FROM game_factions f2 JOIN users u ON u.id = f2.user_id
                WHERE f2.game_id = st.game_id
                  AND u.email NOT LIKE '%@example.com'
                  AND u.email NOT LIKE '%@example.test'
                  AND u.email NOT LIKE '%@orbital-test.local');

-- Research projects started.
INSERT INTO analytics_events (game_id, user_id, kind, created_at_ms)
SELECT t.game_id, f.user_id, 'POST research',
       r.created_at + t.started_at_tick * g.tick_interval_ms
  FROM faction_techs t
  JOIN games g ON g.id = t.game_id
  JOIN rooms r ON r.id = g.id
  JOIN game_factions f ON f.id = t.faction_id
 WHERE r.created_at + t.started_at_tick * g.tick_interval_ms < 1785427800000
   AND EXISTS (SELECT 1 FROM game_factions f2 JOIN users u ON u.id = f2.user_id
                WHERE f2.game_id = t.game_id
                  AND u.email NOT LIKE '%@example.com'
                  AND u.email NOT LIKE '%@example.test'
                  AND u.email NOT LIKE '%@orbital-test.local');

-- Trade offers proposed (real ms timestamp on the row).
INSERT INTO analytics_events (game_id, user_id, kind, created_at_ms)
SELECT o.game_id, f.user_id, 'POST trades', o.created_at_ms
  FROM trade_offers o
  JOIN game_factions f ON f.id = o.proposer_faction_id
 WHERE o.created_at_ms < 1785427800000
   AND EXISTS (SELECT 1 FROM game_factions f2 JOIN users u ON u.id = f2.user_id
                WHERE f2.game_id = o.game_id
                  AND u.email NOT LIKE '%@example.com'
                  AND u.email NOT LIKE '%@example.test'
                  AND u.email NOT LIKE '%@orbital-test.local');

-- Trade routes created.
INSERT INTO analytics_events (game_id, user_id, kind, created_at_ms)
SELECT tr.game_id, f.user_id, 'POST trade-routes',
       r.created_at + tr.created_at_tick * g.tick_interval_ms
  FROM game_trade_routes tr
  JOIN games g ON g.id = tr.game_id
  JOIN rooms r ON r.id = g.id
  JOIN game_factions f ON f.id = tr.owner_faction_id
 WHERE r.created_at + tr.created_at_tick * g.tick_interval_ms < 1785427800000
   AND EXISTS (SELECT 1 FROM game_factions f2 JOIN users u ON u.id = f2.user_id
                WHERE f2.game_id = tr.game_id
                  AND u.email NOT LIKE '%@example.com'
                  AND u.email NOT LIKE '%@example.test'
                  AND u.email NOT LIKE '%@orbital-test.local');

-- Fleets formed.
INSERT INTO analytics_events (game_id, user_id, kind, created_at_ms)
SELECT fl.game_id, f.user_id, 'POST fleets',
       r.created_at + fl.created_at_tick * g.tick_interval_ms
  FROM game_fleets fl
  JOIN games g ON g.id = fl.game_id
  JOIN rooms r ON r.id = g.id
  JOIN game_factions f ON f.id = fl.faction_id
 WHERE r.created_at + fl.created_at_tick * g.tick_interval_ms < 1785427800000
   AND EXISTS (SELECT 1 FROM game_factions f2 JOIN users u ON u.id = f2.user_id
                WHERE f2.game_id = fl.game_id
                  AND u.email NOT LIKE '%@example.com'
                  AND u.email NOT LIKE '%@example.test'
                  AND u.email NOT LIKE '%@orbital-test.local');

-- Ship designs saved (real ms timestamp on the row).
INSERT INTO analytics_events (game_id, user_id, kind, created_at_ms)
SELECT d.game_id, f.user_id, 'POST designs', d.created_at_ms
  FROM game_ship_designs d
  JOIN game_factions f ON f.id = d.faction_id
 WHERE d.created_at_ms < 1785427800000
   AND EXISTS (SELECT 1 FROM game_factions f2 JOIN users u ON u.id = f2.user_id
                WHERE f2.game_id = d.game_id
                  AND u.email NOT LIKE '%@example.com'
                  AND u.email NOT LIKE '%@example.test'
                  AND u.email NOT LIKE '%@orbital-test.local');

-- Senate votes cast.
INSERT INTO analytics_events (game_id, user_id, kind, created_at_ms)
SELECT p.game_id, f.user_id, 'POST senate/proposals/vote',
       r.created_at + v.cast_at_tick * g.tick_interval_ms
  FROM senate_votes v
  JOIN senate_proposals p ON p.id = v.proposal_id
  JOIN games g ON g.id = p.game_id
  JOIN rooms r ON r.id = g.id
  JOIN game_factions f ON f.id = v.faction_id
 WHERE r.created_at + v.cast_at_tick * g.tick_interval_ms < 1785427800000
   AND EXISTS (SELECT 1 FROM game_factions f2 JOIN users u ON u.id = f2.user_id
                WHERE f2.game_id = p.game_id
                  AND u.email NOT LIKE '%@example.com'
                  AND u.email NOT LIKE '%@example.test'
                  AND u.email NOT LIKE '%@orbital-test.local');

-- Player-raised senate proposals (system ones have NULL proposer).
INSERT INTO analytics_events (game_id, user_id, kind, created_at_ms)
SELECT p.game_id, f.user_id, 'POST senate/proposals',
       r.created_at + p.proposed_at_tick * g.tick_interval_ms
  FROM senate_proposals p
  JOIN games g ON g.id = p.game_id
  JOIN rooms r ON r.id = g.id
  JOIN game_factions f ON f.id = p.proposer_faction_id
 WHERE p.proposer_faction_id IS NOT NULL
   AND r.created_at + p.proposed_at_tick * g.tick_interval_ms < 1785427800000
   AND EXISTS (SELECT 1 FROM game_factions f2 JOIN users u ON u.id = f2.user_id
                WHERE f2.game_id = p.game_id
                  AND u.email NOT LIKE '%@example.com'
                  AND u.email NOT LIKE '%@example.test'
                  AND u.email NOT LIKE '%@orbital-test.local');
