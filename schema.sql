-- Orbital Game Database Schema
-- SQLite 3.35+
-- Complete schema for multiplayer asynchronous strategy game

-- ============================================================================
-- CORE GAME STATE
-- ============================================================================

CREATE TABLE games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  max_ticks INTEGER NOT NULL DEFAULT 45,
  current_tick INTEGER NOT NULL DEFAULT 0,
  start_time TEXT NOT NULL, -- ISO 8601 timestamp
  tick_interval_hours REAL NOT NULL DEFAULT 24.0,
  next_tick_time TEXT, -- ISO 8601 timestamp when next tick will execute
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(name)
);

CREATE INDEX idx_games_status ON games(status);
CREATE INDEX idx_games_current_tick ON games(current_tick);
CREATE INDEX idx_games_next_tick ON games(next_tick_time);


CREATE TABLE factions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  user_id TEXT NOT NULL, -- External user ID from auth system
  name TEXT NOT NULL,
  color TEXT NOT NULL, -- Hex color code #RRGGBB
  capital_body_id INTEGER,
  faction_type TEXT NOT NULL DEFAULT 'player' CHECK (faction_type IN ('player', 'npc', 'neutral')),
  reputation INTEGER NOT NULL DEFAULT 0,
  treasury_metal INTEGER NOT NULL DEFAULT 0,
  treasury_fuel INTEGER NOT NULL DEFAULT 0,
  treasury_gold INTEGER NOT NULL DEFAULT 0,
  treasury_science INTEGER NOT NULL DEFAULT 0,
  is_eliminated INTEGER NOT NULL DEFAULT 0,
  eliminated_at_tick INTEGER,
  eliminated_by_faction_id INTEGER, -- Which faction caused elimination
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (capital_body_id) REFERENCES bodies(id),
  FOREIGN KEY (eliminated_by_faction_id) REFERENCES factions(id),
  UNIQUE(game_id, user_id),
  UNIQUE(game_id, name)
);

CREATE INDEX idx_factions_game_id ON factions(game_id);
CREATE INDEX idx_factions_game_user ON factions(game_id, user_id);
CREATE INDEX idx_factions_eliminated ON factions(is_eliminated);


CREATE TABLE bodies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  body_type TEXT NOT NULL CHECK (body_type IN (
    'star', 'terrestrial_planet', 'gas_giant', 'moon', 'asteroid',
    'lagrange_station', 'space_station'
  )),
  -- Orbital mechanics (if orbiting)
  parent_body_id INTEGER,
  semi_major_axis REAL, -- km
  eccentricity REAL, -- 0.0-1.0
  inclination REAL, -- degrees
  longitude_ascending_node REAL, -- degrees
  argument_periapsis REAL, -- degrees
  mean_anomaly_epoch REAL, -- degrees at epoch
  orbital_epoch TEXT, -- ISO 8601 when mean_anomaly_epoch is valid
  orbital_period_hours REAL, -- Simplified: orbital period in hours (derived or specified)
  -- Physical properties
  radius_km REAL,
  mass_kg REAL,
  sphere_of_influence_km REAL, -- SOI for orbital calculations
  gravity_ms2 REAL, -- Surface gravity
  -- Economic/Development
  owned_by_faction_id INTEGER,
  development_level INTEGER NOT NULL DEFAULT 0, -- 0-5 scale
  development_points INTEGER NOT NULL DEFAULT 0, -- Progress to next level
  infrastructure_json TEXT, -- {"docks": 2, "labs": 1, "mines": 3, ...}
  -- Resource generation (per tick at max development)
  produces_metal_per_tick INTEGER NOT NULL DEFAULT 0,
  produces_fuel_per_tick INTEGER NOT NULL DEFAULT 0,
  produces_gold_per_tick INTEGER NOT NULL DEFAULT 0,
  produces_science_per_tick INTEGER NOT NULL DEFAULT 0,
  storage_capacity_metal INTEGER NOT NULL DEFAULT 10000,
  storage_capacity_fuel INTEGER NOT NULL DEFAULT 10000,
  storage_capacity_gold INTEGER NOT NULL DEFAULT 5000,
  storage_capacity_science INTEGER NOT NULL DEFAULT 5000,
  -- Current resources stored here
  stored_metal INTEGER NOT NULL DEFAULT 0,
  stored_fuel INTEGER NOT NULL DEFAULT 0,
  stored_gold INTEGER NOT NULL DEFAULT 0,
  stored_science INTEGER NOT NULL DEFAULT 0,
  -- Metadata
  discovered_by_faction_id INTEGER, -- Who first discovered it (affects fog of war)
  last_production_tick INTEGER NOT NULL DEFAULT -1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (parent_body_id) REFERENCES bodies(id),
  FOREIGN KEY (owned_by_faction_id) REFERENCES factions(id),
  FOREIGN KEY (discovered_by_faction_id) REFERENCES factions(id),
  UNIQUE(game_id, name)
);

CREATE INDEX idx_bodies_game_id ON bodies(game_id);
CREATE INDEX idx_bodies_parent ON bodies(parent_body_id);
CREATE INDEX idx_bodies_owner ON bodies(game_id, owned_by_faction_id);
CREATE INDEX idx_bodies_type ON bodies(body_type);


-- ============================================================================
-- SHIPS & FLEET UNITS
-- ============================================================================

CREATE TABLE ships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  faction_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('frigate', 'cruiser', 'capital', 'stealth', 'transport')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'destroyed', 'decommissioned')),
  -- Fuel system
  fuel_current INTEGER NOT NULL,
  fuel_max INTEGER NOT NULL,
  fuel_burn_rate_per_acceleration_mps REAL NOT NULL DEFAULT 0.5, -- Fuel per m/s delta-v
  -- Orbital state (JSON serialized)
  current_orbit_json TEXT NOT NULL, -- OrbitElements structure
  orbit_set_at_tick INTEGER NOT NULL,
  -- Combat/Status
  hull_integrity REAL NOT NULL DEFAULT 1.0, -- 0.0-1.0
  armor_level INTEGER NOT NULL DEFAULT 0,
  max_delta_v_mps REAL NOT NULL, -- Maximum velocity change capability
  cargo_capacity_tons INTEGER NOT NULL,
  cargo_json TEXT, -- {"metal": 100, "fuel": 50, ...}
  -- Metadata
  build_completed_at_tick INTEGER,
  last_maneuver_tick INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (faction_id) REFERENCES factions(id),
  UNIQUE(game_id, name)
);

CREATE INDEX idx_ships_game_id ON ships(game_id);
CREATE INDEX idx_ships_faction ON ships(game_id, faction_id);
CREATE INDEX idx_ships_status ON ships(status);
CREATE INDEX idx_ships_class ON ships(class);


-- ============================================================================
-- ORDERS & MANEUVERS
-- ============================================================================

CREATE TABLE maneuver_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  ship_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN (
    'planned', 'committed', 'executing', 'executed', 'failed', 'cancelled'
  )),
  order_type TEXT NOT NULL CHECK (order_type IN (
    'orbital_transfer', 'hohmann_transfer', 'manual_burn', 'dock', 'undock', 'attack'
  )),
  -- Timing
  planned_burn_tick INTEGER, -- Absolute tick number
  planned_burn_time TEXT, -- ISO 8601 timestamp
  duration_ticks INTEGER, -- How many ticks to execute
  -- Orbital transfer details (for hohmann/orbital_transfer)
  target_body_id INTEGER,
  post_maneuver_orbit_json TEXT, -- OrbitElements after successful maneuver
  delta_v_mps REAL, -- Total delta-v required
  fuel_required INTEGER,
  -- Attack details
  target_ship_id INTEGER,
  -- Metadata
  created_at_tick INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  executed_at_tick INTEGER,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (ship_id) REFERENCES ships(id),
  FOREIGN KEY (target_body_id) REFERENCES bodies(id),
  FOREIGN KEY (target_ship_id) REFERENCES ships(id)
);

CREATE INDEX idx_maneuver_orders_game_id ON maneuver_orders(game_id);
CREATE INDEX idx_maneuver_orders_ship ON maneuver_orders(ship_id);
CREATE INDEX idx_maneuver_orders_status ON maneuver_orders(status);
CREATE INDEX idx_maneuver_orders_planned_tick ON maneuver_orders(planned_burn_tick);


CREATE TABLE standing_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  faction_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  order_type TEXT NOT NULL CHECK (order_type IN (
    'auto_defend', 'auto_scout', 'auto_trade', 'auto_collect'
  )),
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Condition to trigger (JSON: {"type": "fleet_near_body", "body_id": 5, "distance_km": 50000})
  condition_json TEXT NOT NULL,
  -- Action to execute (JSON: {"type": "launch_fleet", "source_body_id": 2, "count": 5})
  action_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  last_executed_tick INTEGER,
  execution_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (faction_id) REFERENCES factions(id)
);

CREATE INDEX idx_standing_orders_game_faction ON standing_orders(game_id, faction_id);
CREATE INDEX idx_standing_orders_enabled ON standing_orders(enabled);


-- ============================================================================
-- PRODUCTION QUEUES
-- ============================================================================

CREATE TABLE production_queue_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  faction_id INTEGER NOT NULL,
  location_body_id INTEGER, -- Where it's being built
  item_type TEXT NOT NULL CHECK (item_type IN (
    'ship', 'facility', 'research', 'defense', 'infrastructure'
  )),
  -- For ships
  ship_class TEXT, -- frigate, cruiser, capital, etc.
  ship_name TEXT,
  -- For facilities/infrastructure
  facility_type TEXT, -- dock, lab, mine, refinery, etc.
  -- For research
  tech_id TEXT,
  tech_name TEXT,
  -- Progress
  progress_ticks INTEGER NOT NULL DEFAULT 0,
  total_ticks INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'building', 'completed', 'cancelled'
  )),
  -- Resource requirements (snapshot at queue time)
  cost_metal INTEGER NOT NULL DEFAULT 0,
  cost_fuel INTEGER NOT NULL DEFAULT 0,
  cost_gold INTEGER NOT NULL DEFAULT 0,
  cost_science INTEGER NOT NULL DEFAULT 0,
  -- Completion
  completed_at_tick INTEGER,
  result_ship_id INTEGER, -- If this was a ship build
  -- Metadata
  priority INTEGER NOT NULL DEFAULT 0,
  created_at_tick INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (faction_id) REFERENCES factions(id),
  FOREIGN KEY (location_body_id) REFERENCES bodies(id),
  FOREIGN KEY (result_ship_id) REFERENCES ships(id)
);

CREATE INDEX idx_production_queue_game_faction ON production_queue_items(game_id, faction_id);
CREATE INDEX idx_production_queue_status ON production_queue_items(status);
CREATE INDEX idx_production_queue_location ON production_queue_items(location_body_id);


-- ============================================================================
-- DIPLOMACY & TREATIES
-- ============================================================================

CREATE TABLE treaties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  treaty_type TEXT NOT NULL CHECK (treaty_type IN (
    'non_aggression_pact', 'defense_pact', 'trade_agreement', 'intel_sharing',
    'demilitarization_zone', 'technology_sharing', 'mining_rights'
  )),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'expired', 'broken', 'cancelled', 'proposed'
  )),
  -- Signatories (JSON array of faction IDs)
  signatories_json TEXT NOT NULL,
  -- Terms and timing
  start_tick INTEGER NOT NULL,
  end_tick INTEGER, -- NULL for indefinite
  duration_ticks INTEGER,
  terms_json TEXT, -- Treaty-specific terms
  broken_at_tick INTEGER,
  broken_by_faction_id INTEGER, -- Which faction broke it
  breach_reason TEXT, -- Reason for breaking
  -- Metadata
  created_at_tick INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (broken_by_faction_id) REFERENCES factions(id)
);

CREATE INDEX idx_treaties_game_id ON treaties(game_id);
CREATE INDEX idx_treaties_status ON treaties(status);
CREATE INDEX idx_treaties_start_tick ON treaties(start_tick);


CREATE TABLE reputation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  faction_id INTEGER NOT NULL,
  other_faction_id INTEGER, -- Who the reputation is with (NULL for global)
  change_amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  tick INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (faction_id) REFERENCES factions(id),
  FOREIGN KEY (other_faction_id) REFERENCES factions(id)
);

CREATE INDEX idx_reputation_logs_game_faction ON reputation_logs(game_id, faction_id);
CREATE INDEX idx_reputation_logs_tick ON reputation_logs(tick);


-- ============================================================================
-- COMMUNICATION
-- ============================================================================

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  from_faction_id INTEGER NOT NULL,
  to_faction_id INTEGER, -- NULL for broadcast/public
  message_type TEXT NOT NULL DEFAULT 'private' CHECK (message_type IN (
    'private', 'broadcast', 'formal_declaration', 'treaty_proposal', 'trade_offer'
  )),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  read_by_json TEXT, -- JSON array of faction IDs who've read it
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at_tick INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (from_faction_id) REFERENCES factions(id),
  FOREIGN KEY (to_faction_id) REFERENCES factions(id)
);

CREATE INDEX idx_messages_game_id ON messages(game_id);
CREATE INDEX idx_messages_from_to ON messages(from_faction_id, to_faction_id);
CREATE INDEX idx_messages_created_at ON messages(created_at_tick);


-- ============================================================================
-- SENATE & VOTING
-- ============================================================================

CREATE TABLE senate_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  submitted_by_faction_id INTEGER, -- NULL for system proposals
  proposal_type TEXT NOT NULL CHECK (proposal_type IN (
    'trade_embargo', 'military_alliance', 'scientific_cooperation',
    'faction_recognition', 'sanction', 'crisis_response', 'rule_change'
  )),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  -- Voting
  voting_start_tick INTEGER NOT NULL,
  voting_end_tick INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'voting', 'passed', 'failed', 'cancelled'
  )),
  -- Terms (JSON)
  terms_json TEXT,
  -- Result
  votes_for INTEGER NOT NULL DEFAULT 0,
  votes_against INTEGER NOT NULL DEFAULT 0,
  result TEXT, -- 'passed', 'failed', or NULL if still voting
  result_details_json TEXT, -- Effect details
  created_at_tick INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (submitted_by_faction_id) REFERENCES factions(id)
);

CREATE INDEX idx_senate_proposals_game_id ON senate_proposals(game_id);
CREATE INDEX idx_senate_proposals_status ON senate_proposals(status);
CREATE INDEX idx_senate_proposals_voting_tick ON senate_proposals(voting_start_tick, voting_end_tick);


CREATE TABLE senate_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  proposal_id INTEGER NOT NULL,
  faction_id INTEGER NOT NULL,
  vote TEXT NOT NULL CHECK (vote IN ('for', 'against', 'abstain')),
  voted_at_tick INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (proposal_id) REFERENCES senate_proposals(id),
  FOREIGN KEY (faction_id) REFERENCES factions(id),
  UNIQUE(proposal_id, faction_id)
);

CREATE INDEX idx_senate_votes_proposal ON senate_votes(proposal_id);
CREATE INDEX idx_senate_votes_faction ON senate_votes(game_id, faction_id);


-- ============================================================================
-- TECHNOLOGY & RESEARCH
-- ============================================================================

CREATE TABLE tech_research (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  faction_id INTEGER NOT NULL,
  tech_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'locked' CHECK (status IN (
    'locked', 'available', 'researching', 'completed'
  )),
  progress_ticks INTEGER NOT NULL DEFAULT 0,
  total_ticks INTEGER NOT NULL DEFAULT 0,
  completed_at_tick INTEGER,
  -- Research queue position
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (faction_id) REFERENCES factions(id),
  UNIQUE(game_id, faction_id, tech_id)
);

CREATE INDEX idx_tech_research_game_faction ON tech_research(game_id, faction_id);
CREATE INDEX idx_tech_research_status ON tech_research(status);


-- ============================================================================
-- GAME EVENTS & CHRONICLE
-- ============================================================================

CREATE TABLE chronicle_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN (
    'battle', 'treaty_signed', 'treaty_broken', 'declaration', 'vote_result',
    'faction_eliminated', 'production_completed', 'discovery', 'research_completed',
    'resource_transfer', 'diplomatic_incident', 'custom'
  )),
  headline TEXT NOT NULL,
  description TEXT,
  -- Involved parties
  primary_faction_id INTEGER,
  secondary_faction_id INTEGER,
  -- Event data (JSON for flexible structure)
  event_data_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (primary_faction_id) REFERENCES factions(id),
  FOREIGN KEY (secondary_faction_id) REFERENCES factions(id)
);

CREATE INDEX idx_chronicle_game_tick ON chronicle_entries(game_id, tick);
CREATE INDEX idx_chronicle_type ON chronicle_entries(entry_type);


CREATE TABLE game_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  log_type TEXT NOT NULL,
  severity TEXT CHECK (severity IN ('debug', 'info', 'warning', 'error')),
  message TEXT,
  log_data_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id)
);

CREATE INDEX idx_game_logs_game_tick ON game_logs(game_id, tick);
CREATE INDEX idx_game_logs_severity ON game_logs(severity);


-- ============================================================================
-- TICK EXECUTION STATE
-- ============================================================================

CREATE TABLE tick_execution_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL UNIQUE,
  current_tick INTEGER NOT NULL,
  execution_status TEXT NOT NULL DEFAULT 'idle' CHECK (execution_status IN (
    'idle', 'executing', 'completed', 'failed'
  )),
  last_execution_start TEXT,
  last_execution_end TEXT,
  last_error_message TEXT,
  production_updates_applied INTEGER NOT NULL DEFAULT 0,
  maneuver_updates_applied INTEGER NOT NULL DEFAULT 0,
  resource_updates_applied INTEGER NOT NULL DEFAULT 0,
  treaty_checks_applied INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id)
);

CREATE INDEX idx_tick_state_game_id ON tick_execution_state(game_id);


-- ============================================================================
-- GAME SETTINGS & METADATA
-- ============================================================================

CREATE TABLE game_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL UNIQUE,
  difficulty TEXT NOT NULL DEFAULT 'normal' CHECK (difficulty IN ('easy', 'normal', 'hard')),
  victory_condition TEXT NOT NULL DEFAULT 'domination' CHECK (victory_condition IN (
    'domination', 'diplomatic', 'scientific', 'economic', 'hybrid'
  )),
  max_player_count INTEGER NOT NULL DEFAULT 8,
  allow_treaties INTEGER NOT NULL DEFAULT 1,
  allow_piracy INTEGER NOT NULL DEFAULT 1,
  allow_trading INTEGER NOT NULL DEFAULT 1,
  fog_of_war_enabled INTEGER NOT NULL DEFAULT 1,
  -- Custom rules (JSON)
  custom_rules_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id)
);

CREATE INDEX idx_game_settings_game_id ON game_settings(game_id);


-- ============================================================================
-- INDEXING SUMMARY FOR PERFORMANCE
-- ============================================================================

-- All tables have created_at/updated_at indexed on game_id for efficient
-- time-series queries and tick-based filtering.
-- Standing orders, production queue, and maneuver orders indexed on status
-- for efficient "things to process this tick" queries.

-- ============================================================================
-- VIEWS FOR COMMON QUERIES
-- ============================================================================

CREATE VIEW faction_resources AS
  SELECT
    f.id as faction_id,
    f.game_id,
    f.treasury_metal,
    f.treasury_fuel,
    f.treasury_gold,
    f.treasury_science,
    (f.treasury_metal + f.treasury_fuel + f.treasury_gold + f.treasury_science) as total_resources
  FROM factions f;


CREATE VIEW body_production_status AS
  SELECT
    b.id,
    b.game_id,
    b.name,
    b.owned_by_faction_id,
    b.development_level,
    (b.produces_metal_per_tick + b.produces_fuel_per_tick + b.produces_gold_per_tick + b.produces_science_per_tick) as total_production_rate,
    b.stored_metal,
    b.stored_fuel,
    b.stored_gold,
    b.stored_science
  FROM bodies b;


CREATE VIEW fleet_status AS
  SELECT
    s.id,
    s.game_id,
    s.faction_id,
    s.name,
    s.class,
    COUNT(CASE WHEN mo.status IN ('planned', 'committed') THEN 1 END) as pending_maneuvers,
    s.fuel_current,
    s.fuel_max,
    s.hull_integrity
  FROM ships s
  LEFT JOIN maneuver_orders mo ON s.id = mo.ship_id AND mo.status IN ('planned', 'committed', 'executing')
  GROUP BY s.id;


CREATE VIEW active_treaties AS
  SELECT
    t.id,
    t.game_id,
    t.treaty_type,
    t.signatories_json,
    t.start_tick,
    t.end_tick,
    t.status
  FROM treaties t
  WHERE t.status IN ('active', 'proposed');


CREATE VIEW pending_senate_proposals AS
  SELECT
    sp.id,
    sp.game_id,
    sp.proposal_type,
    sp.title,
    sp.voting_start_tick,
    sp.voting_end_tick,
    sp.votes_for,
    sp.votes_against,
    sp.status
  FROM senate_proposals sp
  WHERE sp.status IN ('pending', 'voting');
