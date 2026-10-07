// Português do Brasil. Same keys as en.js; a key left out falls back to
// English. Glossary (keep in step with src/i18n/pt-BR.ts): jogo, vaga
// (seat), sala (lobby), anfitrião (host), turno, império, mundo, frota,
// Arauto (Herald), Senado, Entrada rápida (Quick Join). Tone: "você".

export const PT_BR = {
  // --- email chrome -------------------------------------------------------
  'email.unsubscribe': 'Cancelar inscrição',
  'email.settings': 'Configurações de e-mail',
  'email.defaultFooter': 'Orbital · orbital-empire.com',
  'email.defaultName': 'Comandante',

  // --- welcome ------------------------------------------------------------
  'email.welcome.subject': 'Bem-vindo ao Orbital',
  'email.welcome.preheader': 'Sua conta está pronta. A Entrada rápida coloca você em um jogo com um clique.',
  'email.welcome.heading': 'Bem-vindo ao Orbital, {name}',
  'email.welcome.l1': 'Sua conta está pronta. Orbital é um jogo de estratégia que se passa em todo o Sistema Solar, com um relógio que continua correndo enquanto você está fora.',
  'email.welcome.l2': 'O jeito mais rápido de entrar: aperte ENTRADA RÁPIDA na sala e colocamos você no jogo mais perto de começar.',
  'email.welcome.l3': 'Cada turno equivale a uma hora de tempo real, então entre quando for melhor para você. Uma frota enviada hoje à noite terá chegado de manhã.',
  'email.welcome.cta': 'Encontre um jogo',
  'email.welcome.footer': 'Você está recebendo este e-mail porque uma conta do Orbital foi criada com este endereço. Se não foi você, responda a este e-mail e vamos removê-la.',

  // --- password reset -----------------------------------------------------
  'email.reset.subject': 'Redefina sua senha do Orbital',
  'email.reset.preheader': 'Este link funciona uma vez e expira em uma hora.',
  'email.reset.heading': 'Redefina sua senha',
  'email.reset.l1': 'Alguém (esperamos que você) pediu para redefinir a senha da conta do Orbital {email}.',
  'email.reset.l2': 'O link abaixo funciona uma única vez e expira em uma hora. Ao usá-lo, você é desconectado em todos os outros dispositivos.',
  'email.reset.l3': 'Se não foi você quem pediu, ignore este e-mail. Sua senha continua a mesma.',
  'email.reset.cta': 'Escolher uma nova senha',
  'email.reset.footer': 'E-mail de segurança da conta. Você recebe este aviso sempre que alguém pede a redefinição de senha do seu endereço.',
  'email.reset.footerText': 'E-mail de segurança da conta do Orbital.',

  // --- a game starts ------------------------------------------------------
  'email.started.subject': '{name} começou',
  'email.started.preheader': '{n} impérios, um só Sistema Solar. Seu primeiro turno já está rolando.',
  'email.started.heading': '{name} começou',
  'email.started.l1_one': 'Seu jogo {name} acabou de começar com {n} jogador.',
  'email.started.l1_other': 'Seu jogo {name} acabou de começar com {n} jogadores.',
  'email.started.l2': 'Cada turno equivale a {tick} de tempo real, e o relógio corre estando você conectado ou não. Escolha seu mundo natal e mande suas primeiras naves antes que os vizinhos o façam.',
  'email.started.cta': 'Abrir o jogo',
  'email.started.footer': 'Você está recebendo este e-mail porque entrou neste jogo no Orbital.',

  // turn length, spoken
  'email.tick.hour': 'uma hora',
  'email.tick.hours': '{n} horas',
  'email.tick.minutes': '{n} minutos',

  // --- lobby full (to the host) -------------------------------------------
  'email.full.subject': '{name} está cheio: comece o jogo',
  'email.full.preheader': 'Todas as {n} vagas foram preenchidas. Seus jogadores estão esperando por você.',
  'email.full.heading': 'Sua sala está cheia',
  'email.full.l1': 'Todas as {n} vagas de {name} foram preenchidas, e seus jogadores estão esperando você começar.',
  'email.full.l2': 'Só o anfitrião pode iniciar o jogo. Abra a sala e aperte INICIAR. Quando começar, o relógio corre estando alguém conectado ou não.',
  'email.full.cta': 'Iniciar o jogo',
  'email.full.footer': 'Você está recebendo este e-mail porque é o anfitrião desta sala no Orbital.',

  // --- a game ends --------------------------------------------------------
  'email.over.subjectWon': 'Você venceu {name}',
  'email.over.subjectLost': '{name}: {winner} venceu',
  'email.over.headingWon': 'Vitória em {name}',
  'email.over.headingLost': '{name} terminou',
  'email.over.defaultWinner': 'Um império',
  'email.over.yourEmpire': 'Seu império',
  'email.over.won': 'Você venceu. {empire} {how} no turno {turn}.',
  'email.over.lost': '{winner} {how} no turno {turn}, e o jogo acabou.',
  'email.over.playedAs': 'Você jogou como {empire}. O histórico completo do jogo fica em Jogos passados, com os resumos e o Arauto final.',
  'email.over.history': 'O histórico completo do jogo fica em Jogos passados, com os resumos e o Arauto final.',
  'email.over.another': 'Quer outra partida? A Entrada rápida coloca você no próximo jogo com um clique.',
  'email.over.cta': 'Veja como terminou',
  'email.over.footer': 'Você está recebendo este e-mail porque jogou esta partida no Orbital.',
  'email.over.how.engineering': 'concluiu a Esfera de Dyson ao redor do Sol',
  'email.over.how.domination': 'assumiu o controle da maioria dos mundos',
  'email.over.how.chancellor': 'foi eleito Chanceler Supremo pelo Senado',
  'email.over.how.annihilation': 'foi o último império de pé',
  'email.over.how.default': 'venceu o jogo',

  // --- the daily Herald (the chrome; the news itself is still English) ----
  'email.herald.subject': 'O Arauto de Orbital: {lead}',
  'email.herald.heading': 'O Arauto de Orbital',
  'email.herald.preheaderMany': 'As notícias de hoje dos seus {n} jogos.',
  'email.herald.preheaderOne': 'As notícias de hoje em {name}.',
  'email.herald.turn': 'Turno {n}',
  'email.herald.open': 'Abrir {name} →',
  'email.herald.openText': 'Abrir o jogo: {url}',
  'email.herald.footer': 'O Arauto diário dos jogos que você joga no Orbital. Um e-mail por dia, só quando algo aconteceu.',
};
