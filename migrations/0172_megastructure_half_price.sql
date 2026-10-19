-- ============================================================
-- 0172 — megastructures at half price, for sites already being built.
--
-- Lorne, 2026-10-18, after a playtest where 10 sites were founded and two
-- finished: "All megastructures were priced completely out of the game.
-- Lets lower them by 50% each." The catalogue (worker/megastructures.js,
-- src/game/megastructures.ts) is halved in the same change; a site stores
-- its own price when it is placed, so the ones already standing are
-- halved here, rounding up.
--
-- A site whose deliveries already meet its new price completes now, at
-- its game's current tick: chronicleCompletions announces it on the next
-- tick (it looks two ticks back) and a mobile hull launches as built.
-- Anything delivered above the new price stays delivered; there is no
-- refund path for a site, and none is owed.
--
-- Running games only, and never the frozen showcase game (Kai68RfB5BhV,
-- docs: marketing showcase), which stays exactly as captured.
-- ============================================================

UPDATE game_megastructures
   SET cost_metal = (cost_metal + 1) / 2,
       cost_credits = (cost_credits + 1) / 2
 WHERE status = 'building'
   AND COALESCE(ancient, 0) = 0
   AND (cost_metal > 0 OR cost_credits > 0)
   AND game_id IN (SELECT id FROM games WHERE status = 'active' AND id <> 'Kai68RfB5BhV');

UPDATE game_megastructures
   SET status = 'complete',
       completed_at_tick = (SELECT g.current_tick FROM games g WHERE g.id = game_megastructures.game_id)
 WHERE status = 'building'
   AND COALESCE(ancient, 0) = 0
   AND (cost_metal > 0 OR cost_credits > 0)
   AND acc_metal >= cost_metal
   AND acc_credits >= cost_credits
   AND game_id IN (SELECT id FROM games WHERE status = 'active' AND id <> 'Kai68RfB5BhV');
