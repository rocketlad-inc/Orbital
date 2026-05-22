-- Normalize starter-Hauler ship class.
--
-- factions.js seeded haulers as ship_class = 'cargo' but every other
-- server check (handleDeploySettlement no_presence, handleQueueTradeRoute,
-- harvest loop in tickHarvest, settlement-resource pickup gating) hard-
-- codes 'freighter'. Net effect: a starter Hauler reads as 'freighter'
-- on the client (translateShipClass maps cargo→freighter) but never
-- matches any of the freighter-only gates server-side. Player tries to
-- deploy a city — server returns no_presence even though the Hauler is
-- right there at the body.
--
-- Fix: collapse 'cargo' onto 'freighter' so the one source of truth
-- across the codebase wins. Also covers any legacy 'hauler' rows from
-- earlier prototyping (translateShipClass already accepts both).
UPDATE game_ships
   SET ship_class = 'freighter'
 WHERE ship_class IN ('cargo', 'hauler');
