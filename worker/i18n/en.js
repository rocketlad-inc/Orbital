// English: the source catalog for everything the worker says to a person.
// Plain keys -> strings with {placeholders}; count-sensitive lines come as
// a `_one` / `_other` pair and are read through trn().

export const EN = {
  // --- email chrome -------------------------------------------------------
  'email.unsubscribe': 'Unsubscribe',
  'email.settings': 'Email settings',
  'email.defaultFooter': 'Orbital · orbital-empire.com',
  'email.defaultName': 'Commander',

  // --- welcome ------------------------------------------------------------
  'email.welcome.subject': 'Welcome to Orbital',
  'email.welcome.preheader': 'Your account is ready. Quick Join seats you in a game in one click.',
  'email.welcome.heading': 'Welcome to Orbital, {name}',
  'email.welcome.l1': 'Your account is ready. Orbital is a strategy game across the whole Sol system, on a clock that keeps running while you are away.',
  'email.welcome.l2': 'The fastest way in: press QUICK JOIN in the lobby and we will seat you in the game closest to starting.',
  'email.welcome.l3': 'Each turn is an hour of real time, so check in when it suits you. A fleet you send tonight will have arrived by morning.',
  'email.welcome.cta': 'Find a game',
  'email.welcome.footer': 'You are getting this because an Orbital account was created with this address. If that wasn\'t you, reply to this email and we will remove it.',

  // --- password reset -----------------------------------------------------
  'email.reset.subject': 'Reset your Orbital password',
  'email.reset.preheader': 'This link works once and expires in one hour.',
  'email.reset.heading': 'Reset your password',
  'email.reset.l1': 'Someone (hopefully you) asked to reset the password for the Orbital account {email}.',
  'email.reset.l2': 'The link below works once and expires in one hour. Using it signs you out on every other device.',
  'email.reset.l3': 'If you didn\'t ask for this, ignore this email. Your password stays as it is.',
  'email.reset.cta': 'Choose a new password',
  'email.reset.footer': 'Account security email. You get these whenever a password reset is requested for your address.',
  'email.reset.footerText': 'Account security email from Orbital.',

  // --- a game starts ------------------------------------------------------
  'email.started.subject': '{name} has begun',
  'email.started.preheader': '{n} empires, one Sol system. Your first turn is live.',
  'email.started.heading': '{name} has begun',
  'email.started.l1_one': 'Your game {name} just started with {n} player.',
  'email.started.l1_other': 'Your game {name} just started with {n} players.',
  'email.started.l2': 'Each turn is {tick} of real time, and the clock runs whether or not you are logged in. Pick your home world and send your first ships out before the neighbours do.',
  'email.started.cta': 'Open the game',
  'email.started.footer': 'You are getting this because you joined this game on Orbital.',

  // turn length, spoken
  'email.tick.hour': 'an hour',
  'email.tick.hours': '{n} hours',
  'email.tick.minutes': '{n} minutes',

  // --- lobby full (to the host) -------------------------------------------
  'email.full.subject': '{name} is full: start the game',
  'email.full.preheader': 'All {n} seats are taken. Your players are waiting on you.',
  'email.full.heading': 'Your lobby is full',
  'email.full.l1': 'All {n} seats in {name} are taken, and your players are waiting for you to start.',
  'email.full.l2': 'Only the host can start the game. Open the lobby and press START. Once it begins, the clock runs whether or not anyone is logged in.',
  'email.full.cta': 'Start the game',
  'email.full.footer': 'You are getting this because you host this lobby on Orbital.',

  // --- a game ends --------------------------------------------------------
  'email.over.subjectWon': 'You won {name}',
  'email.over.subjectLost': '{name}: {winner} wins',
  'email.over.headingWon': 'Victory in {name}',
  'email.over.headingLost': '{name} is over',
  'email.over.defaultWinner': 'An empire',
  'email.over.yourEmpire': 'Your empire',
  'email.over.won': 'You won. {empire} {how} on turn {turn}.',
  'email.over.lost': '{winner} {how} on turn {turn}, and the game is over.',
  'email.over.playedAs': 'You played as {empire}. The full history of the game stays in Past Games, with its recaps and the final Herald.',
  'email.over.history': 'The full history of the game stays in Past Games, with its recaps and the final Herald.',
  'email.over.another': 'Ready for another? Quick Join seats you in the next game in one click.',
  'email.over.cta': 'See how it ended',
  'email.over.footer': 'You are getting this because you played in this game on Orbital.',
  'email.over.how.engineering': 'finished the Dyson Sphere around the Sun',
  'email.over.how.domination': 'took control of most of the worlds',
  'email.over.how.chancellor': 'was elected Supreme Chancellor by the Senate',
  'email.over.how.annihilation': 'was the last empire left standing',
  'email.over.how.default': 'won the game',

  // --- the daily Herald (the chrome; the news itself is still English) ----
  'email.herald.subject': 'The Orbital Herald: {lead}',
  'email.herald.heading': 'The Orbital Herald',
  'email.herald.preheaderMany': 'Today\'s news from your {n} games.',
  'email.herald.preheaderOne': 'Today\'s news from {name}.',
  'email.herald.turn': 'Turn {n}',
  'email.herald.open': 'Open {name} →',
  'email.herald.openText': 'Open the game: {url}',
  'email.herald.footer': 'The daily Herald for the games you are playing on Orbital. One email a day, only when something happened.',
};
