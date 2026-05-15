-- ============================================================================
-- Orbital — Trade Offers (Civ/Stellaris-style diplomacy negotiation)
-- ============================================================================
--
-- Design notes:
--
-- 1. trade_offers vs treaties. The existing treaties table (0003) stores
--    finalized, signed agreements. trade_offers stores the back-and-forth
--    negotiation that precedes a treaty: A offers X for Y, B counters with
--    Y' for X, A accepts. When an offer is accepted, resource transfers
--    happen atomically AND any agreed pacts create rows in treaties.
--
-- 2. Counter-offer chains. A counter creates a NEW row that points at its
--    predecessor via parent_offer_id. The predecessor flips to 'countered'.
--    Walking back through parent_offer_id reconstructs the negotiation
--    history for the UI.
--
-- 3. Resource payload uses the four server-side faction resources
--    (metal/fuel/gold/science) directly. The client maps these to its
--    own display labels.
--
-- 4. Pacts. offer_pacts and request_pacts are JSON arrays of treaty kinds
--    ('nap', 'defense_pact', 'intel_share') that the side offering them
--    will sign if the trade is accepted. Empty array = no pacts offered.
--
-- 5. Visibility. An offer is visible to its proposer and its responder
--    only, plus optionally to spectators (not implemented in v1).
-- ============================================================================

CREATE TABLE trade_offers (
  id                    TEXT PRIMARY KEY,
  game_id               TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  proposer_faction_id   TEXT NOT NULL REFERENCES game_factions(id) ON DELETE CASCADE,
  responder_faction_id  TEXT NOT NULL REFERENCES game_factions(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'open',
    -- 'open'      : awaiting responder action
    -- 'accepted'  : responder accepted; resources & pacts applied
    -- 'declined'  : responder declined
    -- 'cancelled' : proposer withdrew before action
    -- 'countered' : responder made a counter-offer; superseded by child

  -- Resources offered BY proposer TO responder (proposer is paying).
  offer_metal           INTEGER NOT NULL DEFAULT 0,
  offer_fuel            INTEGER NOT NULL DEFAULT 0,
  offer_gold            INTEGER NOT NULL DEFAULT 0,
  offer_science         INTEGER NOT NULL DEFAULT 0,

  -- Resources requested BY proposer FROM responder (responder pays if accepted).
  request_metal         INTEGER NOT NULL DEFAULT 0,
  request_fuel          INTEGER NOT NULL DEFAULT 0,
  request_gold          INTEGER NOT NULL DEFAULT 0,
  request_science       INTEGER NOT NULL DEFAULT 0,

  -- Pacts that proposer offers to sign / requests responder to sign.
  -- JSON array of treaty kind strings, e.g. '["nap","intel_share"]'.
  offer_pacts           TEXT NOT NULL DEFAULT '[]',
  request_pacts         TEXT NOT NULL DEFAULT '[]',

  -- Counter-offer linkage. Walk parent_offer_id back to the original draft.
  parent_offer_id       TEXT REFERENCES trade_offers(id),

  -- Optional short note attached to the offer.
  note                  TEXT,

  created_at_tick       INTEGER NOT NULL,
  created_at_ms         INTEGER NOT NULL,
  resolved_at_ms        INTEGER,
  resolved_by_faction_id TEXT REFERENCES game_factions(id)
);

CREATE INDEX idx_trades_game_status ON trade_offers(game_id, status);
CREATE INDEX idx_trades_responder   ON trade_offers(responder_faction_id, status);
CREATE INDEX idx_trades_proposer    ON trade_offers(proposer_faction_id, status);
CREATE INDEX idx_trades_parent      ON trade_offers(parent_offer_id);
