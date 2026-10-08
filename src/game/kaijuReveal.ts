// ============================================================
// Has the Leviathan shown itself yet? (worker/kaiju.js reveal)
//
// Lorne, 2026-10-08: "Keep the players wondering until it attacks." Until
// its first wind-up it is an unknown object: the map draws the shape it
// can see but no name it cannot know and no HP bar, and the class is
// "Unknown contact" wherever the UI names hull classes. The provider sets
// this from /state (game.kaiju.revealed_at_tick) every poll.
// ============================================================

let revealed = true;

export function setKaijuRevealed(v: boolean): void { revealed = v; }
export function kaijuRevealed(): boolean { return revealed; }
