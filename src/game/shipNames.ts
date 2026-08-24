// ============================================================
// shipNames — the default ship-name pools + picker.
//
// One shared bank for the player BuildPanel and the faction AI so
// every hull in a game draws from the same universe of names. Names
// are grouped by class and chosen to match the hull's character:
//
//   corvette   fast, sharp, predatory — blades, raptors, winds,
//              venomous things, anything that strikes first
//   frigate    steadfast line-of-battle — virtues, fortifications,
//              guardians, lawgivers, scientists
//   destroyer  heavy and wrathful — monsters, storms, volcanoes,
//              siege weapons, conquerors
//   freighter  the working spine of an empire — beasts of burden,
//              rivers, clippers, explorers, good fortune
//
// The picker filters out names already in use in the game; when a
// pool runs dry it falls back to "<Name>-NN" hull numbering.
// ============================================================

import { ShipClassName } from './shipClasses';

// Capital hulls are NAMED FOR WHAT THEY ARE rather than drawn from a
// pool. There is at most a handful in a game and each one is an event;
// giving a world-killer a random hawk name would undersell it, and the
// launch chronicle reads better naming the thing than a callsign.
export const SHIP_NAME_POOLS: Record<ShipClassName, string[]> = {
  mega_destroyer: ['Mega Destroyer'],
  mobile_foundry: ['Mobile Foundry'],
  corvette: [
    // Originals
    'Tachi', 'Razorback', 'Pella', 'Chetzemoka', 'Screaming Firehawk',
    'Kittur Chennamma', 'Lance', 'Sting', 'Razor', 'Falcon', 'Spear',
    'Knife', 'Hawk', 'Dart', 'Talon',
    // Raptors and hunting birds
    'Kestrel', 'Merlin', 'Peregrine', 'Sparrowhawk', 'Goshawk',
    'Harrier', 'Osprey', 'Shrike', 'Kite', 'Gyrfalcon', 'Saker',
    'Hobby', 'Kingfisher', 'Swift', 'Swallow', 'Raptor', 'Condor',
    // Blades and points
    'Stiletto', 'Rapier', 'Saber', 'Scalpel', 'Needle', 'Barb',
    'Thorn', 'Flechette', 'Javelin', 'Arrow', 'Bolt', 'Quarrel',
    'Dagger', 'Dirk', 'Cutlass', 'Scimitar', 'Katana', 'Tanto',
    'Foil', 'Epee', 'Bayonet', 'Lancet', 'Skewer', 'Splinter',
    // Winds
    'Mistral', 'Zephyr', 'Boreas', 'Tramontane', 'Chinook', 'Squall',
    'Gale', 'Gust', 'Whirlwind', 'Levanter', 'Ghibli', 'Pampero',
    'Williwaw', 'Etesian', 'Meltemi', 'Harmattan',
    // Predators
    'Lynx', 'Ocelot', 'Caracal', 'Serval', 'Cheetah', 'Jackal',
    'Coyote', 'Viper', 'Adder', 'Krait', 'Mamba', 'Cobra', 'Asp',
    'Taipan', 'Fer-de-Lance', 'Copperhead', 'Sidewinder',
    'Diamondback', 'Rattler', 'Wasp', 'Hornet', 'Yellowjacket',
    'Mosquito', 'Gadfly', 'Firefly', 'Dragonfly', 'Damselfly',
    'Mantis', 'Scorpion', 'Piranha', 'Barracuda', 'Moray',
    // Fast and fleeting
    'Comet', 'Meteor', 'Bullet', 'Tracer', 'Ricochet', 'Flicker',
    'Flash', 'Glint', 'Spark', 'Banshee', 'Specter', 'Phantom',
    'Ghost', 'Shade', 'Whisper', 'Echo', 'Quicksilver', 'Slipstream',
    // Swift myth
    'Hermes', 'Iris', 'Sleipnir', 'Aello', 'Ocypete', 'Podarge',
  ],
  frigate: [
    // Originals
    'Scirocco', 'Hammurabi', 'Xuesen', 'Amberjack', 'Zenobia',
    'Resolute', 'Vanguard', 'Hammer', 'Stalwart', 'Sentinel',
    'Bulwark', 'Aegis', 'Defiant',
    // Guardians and watchers
    'Guardian', 'Warden', 'Keeper', 'Custodian', 'Protector',
    'Sentry', 'Vigil', 'Vigilant', 'Watchman', 'Outrider', 'Escort',
    'Shepherd', 'Vanquish', 'Champion', 'Paladin', 'Templar',
    'Praetorian', 'Centurion', 'Hoplite', 'Phalanx', 'Legionnaire',
    // Fortifications
    'Rampart', 'Bastion', 'Palisade', 'Parapet', 'Barbican',
    'Redoubt', 'Garrison', 'Citadelle', 'Portcullis', 'Battlement',
    'Stockade', 'Breakwater', 'Seawall', 'Watchtower', 'Keep',
    // Virtues
    'Steadfast', 'Constant', 'Reliant', 'Resolve', 'Tenacity',
    'Fortitude', 'Temperance', 'Prudence', 'Valor', 'Honor',
    'Fidelity', 'Integrity', 'Courage', 'Audacity', 'Intrepid',
    'Dauntless', 'Fearless', 'Indomitable', 'Implacable',
    'Inflexible', 'Illustrious', 'Formidable', 'Ardent', 'Diligent',
    'Adamant', 'Unyielding', 'Perseverance', 'Endurance', 'Clarity',
    // Solid ground
    'Anvil', 'Mainstay', 'Keystone', 'Cornerstone', 'Linchpin',
    'Bedrock', 'Granite', 'Basalt', 'Ironwood', 'Oakheart',
    'Heartwood', 'Bulkhead', 'Buttress', 'Girder',
    // Lawgivers and stateswomen
    'Solon', 'Justinian', 'Ashoka', 'Lycurgus', 'Cincinnatus',
    'Aurelius', 'Saladin', 'Nefertiti', 'Hatshepsut', 'Mansa Musa',
    'Pachacuti', 'Tecumseh', 'Toussaint', 'Bolivar', 'Wu Zetian',
    'Sejong', 'Kangxi', 'Boudicca', 'Eleanor', 'Theodora',
    // Scientists and engineers
    'Curie', 'Noether', 'Turing', 'Hopper', 'Lovelace', 'Franklin',
    'Bose', 'Raman', 'Tereshkova', 'Korolev', 'Goddard',
    'Tsiolkovsky', 'Oberth', 'Chawla', 'Ride', 'Jemison',
  ],
  destroyer: [
    // Originals
    'Donnager', 'Agatha King', 'Truman', 'Barkeith', 'Sagarmatha',
    'Jimenez', 'Tyrant', 'Ironclad', 'Vengeance', 'Wrath', 'Citadel',
    'Behemoth', 'Conqueror', 'Dreadnought',
    // Monsters of myth
    'Leviathan', 'Kraken', 'Jormungandr', 'Fenrir', 'Tiamat',
    'Typhon', 'Charybdis', 'Scylla', 'Hydra', 'Cerberus', 'Chimera',
    'Manticore', 'Basilisk', 'Gorgon', 'Medusa', 'Minotaur',
    'Cyclops', 'Titan', 'Colossus', 'Goliath', 'Juggernaut',
    'Mastodon', 'Ziz', 'Roc', 'Wyvern', 'Tarasque', 'Balrog',
    // Storms and cataclysms
    'Tempest', 'Maelstrom', 'Hurricane', 'Typhoon', 'Cyclone',
    'Monsoon', 'Thunderhead', 'Stormfront', 'Derecho', 'Supercell',
    'Avalanche', 'Landslide', 'Tsunami', 'Riptide', 'Undertow',
    'Firestorm', 'Whiteout', 'Blizzard', 'Sandstorm', 'Shockwave',
    // Volcanoes
    'Vesuvius', 'Krakatoa', 'Tambora', 'Pinatubo', 'Etna',
    'Stromboli', 'Popocatepetl', 'Mauna Loa', 'Hekla', 'Fuji',
    // Reckonings
    'Onslaught', 'Rampage', 'Havoc', 'Ruin', 'Reckoning',
    'Retribution', 'Requiem', 'Oblivion', 'Devastation', 'Fury',
    'Ferocity', 'Savage', 'Relentless', 'Remorseless', 'Merciless',
    'Inexorable', 'Annihilation', 'Cataclysm', 'Apocalypse', 'Doom',
    // Conquerors and admirals
    'Attila', 'Genghis', 'Timur', 'Hannibal', 'Scipio', 'Alaric',
    'Ragnar', 'Shaka', 'Musashi', 'Nobunaga', 'Zhukov', 'Nimitz',
    'Halsey', 'Yamamoto', 'Nelson', 'Drake', 'Cochrane', 'Yi Sun-sin',
    'Barbarossa', 'Tomoe',
    // Siege engines and heavy arms
    'Warhammer', 'Maul', 'Claymore', 'Zweihander', 'Halberd',
    'Poleaxe', 'Morningstar', 'Flail', 'Ballista', 'Trebuchet',
    'Onager', 'Howitzer', 'Broadside', 'Cannonade', 'Barrage',
    'Salvo', 'Fusillade', 'Enfilade', 'Bombard', 'Culverin',
  ],
  freighter: [
    // Originals
    'Canterbury', 'Somnambulist', 'Weeping Somnambulist',
    'Barbapiccola', 'Cerisier', 'Carryall', 'Caravan', 'Pioneer',
    'Voyager', 'Drifter', 'Trader', 'Ferry', 'Skipper',
    // Beasts of burden
    'Mule', 'Packhorse', 'Clydesdale', 'Percheron', 'Shire',
    'Burro', 'Dromedary', 'Bactrian', 'Yak', 'Ox', 'Bullock',
    'Draft Horse', 'Reindeer', 'Llama', 'Alpaca', 'Elephant',
    // Wagons and haulage
    'Conestoga', 'Prairie Schooner', 'Buckboard', 'Wain', 'Dray',
    'Stevedore', 'Teamster', 'Longshoreman', 'Deckhand', 'Bosun',
    'Purser', 'Quartermaster', 'Chandler', 'Dockyard', 'Longhaul',
    'Overland', 'Flatbed', 'Boxcar', 'Gondola', 'Tender',
    // Rivers
    'Mississippi', 'Amazon', 'Danube', 'Volga', 'Mekong', 'Yangtze',
    'Ganges', 'Nile', 'Congo', 'Zambezi', 'Rhine', 'Rhone', 'Elbe',
    'Tigris', 'Euphrates', 'Indus', 'Brahmaputra', 'Irrawaddy',
    'Orinoco', 'Parana', 'Yukon', 'Mackenzie', 'Columbia',
    // Plenty and providence
    'Windfall', 'Plenty', 'Harvest', 'Gleaner', 'Granary',
    'Cornucopia', 'Providence', 'Prosperity', 'Fortune', 'Venture',
    'Bounty', 'Abundance', 'Dividend', 'Larder', 'Breadbasket',
    // Explorers and merchant sail
    'Zheng He', 'Marco Polo', 'Ibn Battuta', 'Magellan', 'Vespucci',
    'Tasman', 'Bering', 'Shackleton', 'Amundsen', 'Nansen',
    'Terra Nova', 'Discovery', 'Resolution', 'Endeavour',
    'Cutty Sark', 'Flying Cloud', 'Sea Witch', 'Star of India',
    'Pamir', 'Passat', 'Preussen', 'Padua', 'Golden Hind',
    // Wayfarers
    'Homestead', 'Hearth', 'Lodestar', 'Waypoint', 'Milepost',
    'Caravanserai', 'Roadhouse', 'Wayfarer', 'Sojourner', 'Rambler',
    'Vagabond', 'Nomad', 'Tinker', 'Peddler', 'Carter', 'Drayman',
  ],
  colony: [
    // Generation ships and famous colony vessels
    'Nauvoo', 'Mayflower', 'Arboghast', 'Edward Israel', 'Rocinante Ark',
    // Ships of exploration and settlement
    'Beagle', 'Endurance', 'Fram', 'Terra Nova II', 'Discovery',
    'Resolution', 'Investigator', 'Challenger', 'Astrolabe', 'Vostok',
    'Santa María', 'Half Moon', 'Susan Constant', 'Godspeed',
    'Speedwell', 'Arbella', 'Fortune', 'Ann', 'Talbot', 'Ark',
    'Dove', 'Welcome', 'Kalmar Nyckel', 'Zeewijk', 'Batavia',
    // Founding and first-light
    'Genesis', 'Foundation', 'Cornerstone', 'Groundbreak', 'First Light',
    'New Dawn', 'Daybreak', 'Sunrise', 'Threshold', 'Landfall',
    'Beachhead', 'Homestead', 'Freehold', 'Settlement', 'Township',
    'Fieldstone', 'Hearthfire', 'Firstborn', 'Origin', 'Inception',
    // Seeds and growth
    'Seedling', 'Sower', 'Germinate', 'Sapling', 'Rootstock',
    'Grafting', 'Cutting', 'Orchard', 'Greenhouse', 'Terrarium',
    'Biosphere', 'Vivarium', 'Nursery', 'Cradle', 'Seedbank',
    // Promise and departure
    'Exodus', 'Diaspora', 'Emigrant', 'Pilgrim', 'Settler',
    'Colonist', 'Frontier', 'Outward Bound', 'Far Horizon', 'Promised Land',
    'Canaan', 'Elysium', 'Arcadia', 'Avalon', 'Shangri-La',
    'Eldorado', 'Zion', 'Vinland', 'Roanoke', 'Jamestown',
    // Hope
    'Hopewell', 'Providence', 'Covenant', 'Promise', 'Endeavour II',
    'Perseverance', 'Constancy', 'Steadfast Hope', 'Bright Prospect',
    'Fair Wind', 'Safe Harbor', 'New Beginning', 'Second Chance',
    'Fresh Start', 'Open Country', 'Wide Acres', 'Long Meadow',
    'Greenfield', 'Fallow', 'Tilth', 'Furrow', 'Plowshare',
  ],
};

/**
 * Pick a default name for a new hull: a pool name not already in use,
 * or "<Name>-NN" hull numbering once the pool for that class runs dry.
 */
export function randomShipName(cls: ShipClassName, existingNames: Iterable<string>): string {
  const pool = SHIP_NAME_POOLS[cls];
  const taken = existingNames instanceof Set ? existingNames : new Set(existingNames);
  const available = pool.filter(n => !taken.has(n));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  const base = pool[Math.floor(Math.random() * pool.length)];
  return `${base}-${Math.floor(Math.random() * 100)}`;
}
