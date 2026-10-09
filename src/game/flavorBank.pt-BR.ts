// src/game/flavorBank.pt-BR.ts
//
// Brazilian Portuguese counterpart of flavorBank.ts. Rules this file keeps:
//
//   - SAME SHAPE as the English bank: same kinds, same number of
//     entries, entry N of a kind uses exactly the same {tokens} as
//     entry N in English (flavorBank.test.ts enforces it). That is what
//     lets one per-event hash pick the matching variant in both
//     languages and skip the same variants when data is missing.
//   - Faction / world / ship / settlement tokens are NAMES of unknown
//     gender. They only ever appear after a preposition ("de {actor}",
//     "em {body}", "sobre {body}") or as a bare subject; never behind
//     an article, an adjective or a participle that would have to agree
//     with them. Where a noun helps ("a nave {shipName}", "a facção"),
//     the carrier noun carries the gender.
//   - NOUN tokens the engine knows ({shipClass}, {settlementType},
//     {bodyType}, {secretName}) may follow a MASCULINE article
//     ("o", "um", "do", "no", "num", "ao"); the engine rewrites it to
//     the feminine for a feminine noun (flavorLocale.ts agreeArticles).
//     {building} always sits behind the carrier "edifício".
//   - {voteOutcome} is "passou" / "não passou" (no participle), {techLevel}
//     is "nível N" (so "ao {techLevel}"), {distance} is an adverbial phrase.
//   - "ciclo" is the prose word for a stretch of time, "turnos" for ticks
//     (glossary: turn / tick = turno).

export const FLAVOR_BANK_PT: Record<string, string[]> = {
  pact_signed: [
    "Diplomatas ilustres de {actor} e de {partner} se reuniram em {actorCapital} para discutir as muitas maneiras como são diferentes e iguais. No fim, apertaram as mãos e concordaram que deveria haver paz.",
    "O {actorLeaderTitle} de {actor} viajou {distance} para se encontrar pessoalmente com o {partnerLeaderTitle} de {partner}. Ao amanhecer, o {pactType} trazia as duas assinaturas.",
    "Coroas de flores foram depositadas no grande salão de {actorCapital} enquanto {actor} e {partner} ratificavam o {pactType}. A assinatura pôs fim a meses de diplomacia de vaivém conduzida pelas duas delegações.",
    "{actor} e {partner} anunciaram um {pactType} neste ciclo, encerrando um longo silêncio entre {actorCapital} e {partnerCapital}.",
    "Depois de trocar correspondência {distance}, os enviados de {actor} e de {partner} assinaram o {pactType}. Observadores o consideraram o acordo de maior peso da temporada.",
    "O {pactType} entre {actor} e {partner} foi selado em sessão fechada em {partnerCapital}. Nenhuma das delegações respondeu a perguntas depois.",
    "As bandeiras de {actor} e de {partner} tremularam lado a lado sobre {actorCapital} quando o {pactType} entrou em vigor. Os analistas haviam previsto que as conversas naufragariam; em vez disso, resistiram.",
    "{partner} aceitou os termos apresentados por {actor}, e o {pactType} entrou para o registro. As duas capitais, havia muito desconfiadas uma da outra, agora dividem uma assinatura.",
    "Uma delegação de {partner} viajou {distance} até {actorCapital}, onde o {pactType} foi assinado diante da imprensa reunida. O {actorLeaderTitle} disse que era o começo de uma confiança prática.",
    "O {pactType} que une {actor} e {partner} foi ratificado depois de semanas de embates de procedimento. Os dois governos o apresentaram como pragmatismo, não como amizade.",
  ],
  pact_broken: [
    "{actor} se retirou formalmente do acordo com {partner} neste ciclo. A notificação chegou a {partnerCapital} sem nenhuma explicação.",
    "O {actorLeaderTitle} de {actor} rasgou o pacto com {partner} em um pronunciamento televisionado de {actorCapital}. Os mercados entre as duas capitais despencaram em menos de uma hora.",
    "Anos de tratado entre {actor} e {partner} terminaram em silêncio, riscados do registro em {actorCapital}. Nenhum substituto foi oferecido.",
    "{actor} renunciou ao {pactType} que um dia assinara com {partner}. Diplomatas dos dois lados se recusaram a dizer o que vem agora.",
    "Chegou a {partnerCapital} a notícia de que {actor} rompeu qualquer vínculo com {partner}. O {partnerLeaderTitle} convocou uma sessão de emergência.",
    "O acordo entre {actor} e {partner} está morto. Os enviados de {actor} deixaram {partnerCapital} antes que a tinta da dissolução secasse.",
    "{actor} rompeu o {pactType} com {partner}, alegando interesses inconciliáveis. A ruptura era rumor havia ciclos; mesmo assim, o momento surpreendeu.",
    "Um comunicado seco de {actor} desfez os laços com {partner}. De repente, viajar {distance} entre as duas capitais pareceu muito mais longe.",
    "{partner} soube da ruptura por despacho: {actor} anulou o pacto entre os dois. As recriminações vieram ainda no mesmo dia.",
    "O salão de tratados de {actorCapital} ficou vazio quando {actor} deixou o pacto com {partner} caducar. Nenhum dos lados se moveu para renová-lo.",
  ],
  ship_destroyed: [
    "O {shipClass} {shipName}, de {partner}, silencia sobre {body}. {actor} reivindica o abate.",
    "Abate confirmado em {tick}: {shipName}, {shipClass} de {partner}, se desfaz sobre {body}.",
    "Os canhões de {actor} abrem fogo sobre {body}. {shipName} cede. {partner} perde um {shipClass}.",
    "O {shipClass} {shipName} para de transmitir em {tick}. Destroços se espalham sobre {body}. {actor} no gatilho.",
    "A bandeira de {partner} se apaga a bordo de {shipName}. Os destroços agora pertencem a {actor}, baixos sobre {body}.",
    "Último contato com {shipName} em {tick}, em órbita de {body}. O {shipClass} de {partner} virou sucata; {actor} não relata perdas.",
    "Rombo no casco, depois nada. A nave {shipName}, de {partner}, morre acima de {body}. {actor} classificou o abate como limpo.",
    "A nave {shipName} ardeu forte e breve sobre {body}. {actor} abriu ao meio o {shipClass} de {partner}.",
    "Menos um {shipClass}. A nave {shipName}, de {partner}, se foi — órbita de {body}, {tick}.",
    "A nave {shipName} silenciou acima de {body} em {tick}. O {shipClass} de {partner} não vai voltar.",
    // Captain-aware — only picked when the ship had one aboard
    // (fillTemplate skips these otherwise; the plain variants above
    // are the fallback for captain-less hulls and pre-captains rows).
    // "Comando de {captainName}" keeps the captain's gender out of it.
    "A nave {shipName} se apaga sobre {body}. O leme estava sob o comando de {captainName}. {actor} confirma o abate.",
    "Abate confirmado em {tick}: o {shipClass} {shipName}, de {partner}, sob o comando de {captainName}, se desfaz sobre {body}.",
    "Os canhões de {actor} abrem fogo sobre {body}. {shipName} cede, com {captainName} a bordo. {partner} perde um {shipClass}.",
    "Última transmissão de {shipName}, sob o comando de {captainName}: estática, depois nada. Órbita de {body}, {tick}.",
    "O {shipClass} {shipName} deixa de responder aos chamados em {tick}. O comando era de {captainName}. {actor} no gatilho.",
    "Rombo no casco, depois silêncio. A nave {shipName}, de {partner} — a nave sob o comando de {captainName} —, morre acima de {body}.",
  ],
  settlement_destroyed: [
    "A artilharia de {actor} varre {settlementName} de {body}. O {settlementType} para de responder em {tick}.",
    "{settlementName}, de {partner}, arde. {actor} confirma que o {settlementType} em {body} deixou de existir.",
    "Ataque a {settlementName} em {tick}. {actor} atingiu o {settlementType} com força; {partner} contabiliza o prejuízo.",
    "As luzes de {settlementName} se apagam sobre {body}. Foi obra de {actor}.",
    "{settlementName} virou escombros. {actor} quebrou o {settlementType}; {partner} perdeu o chão que pisava.",
    "O domínio de {partner} sobre {body} termina com {settlementName}. {actor} relata a destruição do {settlementType} em {tick}.",
    "Fogo, depois silêncio. {settlementName} cai diante de {actor}. {partner} não tem mais um {settlementType} sequer em {body}.",
    "{actor} arrasou {settlementName} em {tick}. O {settlementType} agora é uma cratera em {body}.",
    "{settlementName} levou o golpe e não se levantou — o {settlementType} em {body} se apagou em {tick}.",
    "Tudo o que {partner} construiu em {settlementName} virou cinza. O {settlementType} em {body} deixou de existir.",
    // Population-aware — {popLost} is scaled from the settlement's raw
    // population stat (1-10) to a people count (1 pop = 200,000, see
    // flavorLocale.ts) and formatted as "600 mil" / "1,2 milhão" /
    // "2 milhões" before it ever reaches a template, so every line says
    // "população de {popLost}" (the "de" is what "milhão" needs).
    "A artilharia de {actor} varre {settlementName}, em {body} — população de {popLost}, às escuras. O {settlementType} para de responder em {tick}.",
    "{settlementName}, de {partner}, arde. População de {popLost}, destino ignorado. {actor} confirma que o {settlementType} em {body} deixou de existir.",
    "As luzes de {settlementName} se apagam sobre {body} — e com elas uma população de {popLost}. Foi obra de {actor}.",
    "{settlementName} é escombros, e uma população de {popLost} está desaparecida. {actor} quebrou o {settlementType}; {partner} perdeu o chão que pisava.",
    "{actor} arrasou {settlementName} em {tick}. População de {popLost}. O {settlementType} agora é uma cratera em {body}.",
    "Tudo o que {partner} construiu em {settlementName} — população de {popLost} — agora é cinza.",
  ],
  ship_damaged: [
    "A nave {shipName}, de {partner}, se arrasta para longe de {body}, deixando atmosfera pelo caminho. O {shipClass} resistiu; {actor} pressionou e depois rompeu o contato.",
    "Fogo pesado sobre {body}. {actor} castigou a nave {shipName} antes de o {shipClass} de {partner} se retirar.",
    "A nave {shipName} levou o golpe e sobreviveu. O {shipClass} de {partner} vaza ar sobre {body}, ainda sob propulsão.",
    "Casco empenado, propulsores intactos. A nave {shipName}, de {partner}, sobrevive a uma surra acima de {body}; {actor} deixou que fugisse.",
    "{actor} pegou a nave {shipName} em cheio. O {shipClass} de {partner} rompeu o combate sobre {body}, fumegando, mas sem se partir.",
    "A nave {shipName} voltou em frangalhos dos canhões de {actor} sobre {body}, mas o {shipClass} de {partner} conseguiu chegar em casa.",
    "Contato sobre {body}: {actor} feriu a nave {shipName} antes de o {shipClass} de {partner} escapar do combate.",
    "A nave {shipName}, de {partner}, está avariada depois de um encontro com {actor} acima de {body}. Reparos pendentes.",
    "O {shipClass} {shipName} levou fogo de {actor} sobre {body} e continuou voando. A tripulação garante que o casco aguenta.",
    "{actor} abriu fogo sobre {body}. A nave {shipName} absorveu o golpe e se desengajou. O {shipClass} de {partner} lutará mais um ciclo.",
  ],
  ship_built: [
    "Os estaleiros de {body} lançaram a nave {shipName}, um {shipClass}, para {actor}.",
    "{actor} comissionou o {shipClass} {shipName} neste ciclo. Os testes sobre {body} transcorreram sem anomalias.",
    "Casco novo saído da linha de montagem em {body}: a nave {shipName}, {shipClass}, com as cores de {actor}.",
    "Os construtores navais de {actor} concluíram a nave {shipName}. O {shipClass} entrou em serviço em órbita de {body}.",
    "A nave {shipName} passou pela montagem final sobre {body}. {actor} soma um {shipClass} à sua ordem de batalha.",
    "{actor} lançou o {shipClass} {shipName} a partir de {body}. Os voos de aceitação começam no próximo ciclo.",
    "As carreiras de lançamento de {body} entregaram a nave {shipName} no prazo. Classe {shipClass}, registro de {actor}.",
    "Mais um {shipClass} para {actor}: a nave {shipName}, montada e selada sobre {body}.",
    "{actor} recebeu a nave {shipName} neste ciclo. O {shipClass} faz seus testes em órbita de {body}.",
    "A nave {shipName} acendeu os propulsores pela primeira vez acima de {body}. Com isso, {actor} ganha mais um {shipClass} operacional.",
  ],
  building_completed: [
    "{actor} concluiu o edifício {building} em {settlementName}, em {body}.",
    "O novo edifício {building} de {settlementName} entrou em operação neste ciclo. {actor} informa que a produção em {body} está subindo.",
    "As equipes em {body} terminaram o edifício {building} em {settlementName}. {actor} cortou a fita antes do prazo.",
    "{settlementName} ganha o edifício {building}. Os engenheiros de {actor} deram o aval depois da inspeção final em {body}.",
    "Agora há um edifício {building} em {settlementName}. {actor} espera que ele sustente as operações em {body} pelos próximos ciclos.",
    "{actor} pôs em serviço o edifício {building} em {settlementName}. A logística de {body} foi redirecionada de acordo.",
    "O edifício {building} em {settlementName} está pronto. O investimento de {actor} em {body} começa a aparecer.",
    "A obra do edifício {building} em {settlementName}, em {body}, chegou ao fim. {actor} passa a alocar pessoal.",
    "O edifício {building} de {actor} se acendeu em {settlementName} neste ciclo. O primeiro fluxo foi registrado ainda no mesmo dia.",
    "Mais uma estrutura se ergue em {settlementName}: o edifício {building}, obra de {actor}, a serviço de {body}.",
  ],
  settlement_founded: [
    "Onde só havia regolito, agora existe {settlementName}. Os primeiros colonos de {actor} ergueram a cúpula antes que a longa noite de {body} os reclamasse.",
    "Sobre um {bodyType} que jamais conhecera um nome, {actor} fincou {settlementName}. A primeira baliza respondeu à escuridão.",
    "Vieram {distance} e pararam em {body}, e ali construíram {settlementName}. {actor} vai lembrar este ciclo por gerações.",
    "Os fundadores de {settlementName} cravaram a primeira estaca em {body} neste ciclo. Para {actor}, é um {settlementType}; para os colonos, é um lar.",
    "Antes de a poeira baixar, {actor} já tinha paredes. {settlementName} se firma em {body}, e o que antes era só um {bodyType} ganhou endereço.",
    "{settlementName} começou como uma única eclusa em {body}. No fim do ciclo, {actor} tinha um {settlementType} que já respirava.",
    "Na face fria de {body}, {actor} acendeu as lâmpadas de {settlementName}. Ninguém jamais pisara ali.",
    "Um {settlementType} onde não havia nada: {actor} fundou {settlementName} em {body}, e o que era só um {bodyType} deixou de ser tão vazio.",
    "A carta de fundação de {settlementName} foi lida em voz alta em {body}, enquanto os colonos erguiam o olhar. {actor} havia chegado um pouco mais longe no sistema.",
    "A bandeira de {actor} subiu sobre {settlementName} neste ciclo. Em um {bodyType} como {body}, até um {settlementType} é um ato de fé.",
  ],
  secret_discovered: [
    "Equipes de prospecção em {body} desenterraram um {secretName} que jazia até a metade sob a poeira rica em ferro. Nada nos arquivos de {actor} corresponde às marcações.",
    "Algo zumbe sob {body}. As equipes de {actor} encontraram um {secretName} e não conseguem parar de olhar.",
    "Em {body}, um {bodyType}, {actor} encontrou um {secretName} onde a prospecção dizia não haver nada. A luz refletiu num metal que não deveria estar ali.",
    "O {secretName} em {body} é anterior a todos os registros de {actor}. As equipes agora trabalham em turnos, sem querer deixar o achado sozinho no escuro.",
    "{actor} relata um {secretName} em {body}. O achado está intacto. O achado é antigo. O achado é, por todas as leituras, impossível.",
    "No frio de {body}, um {bodyType}, os prospectores de {actor} limparam a poeira de um {secretName}. Depois, ficaram em silêncio no rádio.",
    "Um {secretName} emergiu de {body}. {actor} isolou o local e faz perguntas para as quais ainda não tem palavras.",
    "Os instrumentos em {body} cantaram antes que alguém visse: um {secretName}, à espera. {actor} reivindica o primeiro contato com seja lá o que isto for.",
    "{actor} encontrou um {secretName} em {body}. Carbono, silêncio e um sinal fraco e paciente que ninguém sabe situar.",
    "O que {actor} tirou da superfície de {body}, um {bodyType}, é um {secretName} — e isso muda o mapa do possível.",
  ],
  vote_opened: [
    "{actor} levou ao Senado, neste ciclo, a moção para {voteTitle}. O debate está aberto.",
    "O plenário deu a palavra a {actor}, que apresentou uma medida para {voteTitle}. Os articuladores dos dois lados começaram a contar votos.",
    "Uma moção para {voteTitle}, de autoria de {actor}, entrou na pauta. A câmara se acomodou para uma longa sessão.",
    "{actor} pôs a questão em votação: a Casa deve aprovar uma moção para {voteTitle}? O malhete deu a largada ao relógio.",
    "A moção de {actor} — para {voteTitle} — está agora diante do Senado. Esperam-se emendas.",
    "A delegação de {actor} apresentou um projeto de lei para {voteTitle}. Quem preside a sessão o julgou em ordem.",
    "Abre-se o debate sobre a moção de {actor} para {voteTitle}. As galerias estão lotadas.",
    "{actor} forçou o assunto a entrar na pauta: uma votação para {voteTitle}. A câmara decidirá antes do recesso.",
    "Lida em plenário por {actor}: uma resolução para {voteTitle}. O envio à comissão foi dispensado.",
    "O Senado pôs em pauta, neste ciclo, a proposta de {actor} para {voteTitle}. O lobby continua nos corredores.",
  ],
  vote_resolved: [
    "A moção “{voteTitle}” {voteOutcome} no Senado. A câmara seguiu adiante.",
    "Depois de longo debate, “{voteTitle}” {voteOutcome}.",
    "A proposta de {actor}, “{voteTitle}”, {voteOutcome} no plenário do Senado.",
    "A votação terminou e “{voteTitle}” {voteOutcome}; o resultado fica registrado em ata.",
    "Ao fim da sessão, “{voteTitle}” {voteOutcome}.",
    "A Casa falou: “{voteTitle}” {voteOutcome}.",
    "Os votos foram contados. “{voteTitle}”, por iniciativa de {actor}, {voteOutcome}.",
    "Sobre “{voteTitle}”, o veredicto do Senado: {voteOutcome}.",
    "“{voteTitle}” {voteOutcome} depois de uma última rodada de discursos no plenário.",
    "Restabelecida a ordem, a câmara registrou que “{voteTitle}” {voteOutcome}.",
  ],
  // A law reaching the end of its term. NOBODY repeals it — the clock
  // simply runs out — so every variant has to read as lapsing rather
  // than as a defeat or a rival striking it down, or players will go
  // hunting for the enemy who "cancelled" their tariff. {ticksInForce}
  // is optional, so no line may depend on it to parse.
  law_expired: [
    "“{voteTitle}” caducou. A cláusula era temporária; a câmara deixou o prazo correr.",
    "A cláusula de vigência de “{voteTitle}” chegou ao fim. Deixou de ser lei.",
    "Como estava escrito, “{voteTitle}” expirou hoje — sem votação, sem revogação, só o calendário.",
    "“{voteTitle}” sai de vigor. Os escrivães riscam a norma das regras permanentes.",
    "O prazo de “{voteTitle}” se cumpriu. Suas disposições terminam com esta sessão.",
    "Em silêncio e exatamente no prazo, “{voteTitle}” deixou de valer.",
    "A lei de {actor}, “{voteTitle}”, chegou ao vencimento. As regras antigas voltam.",
    "“{voteTitle}” esgotou o seu prazo. O que era obrigatório voltou a ser apenas opcional.",
    "Os livros se fecham sobre “{voteTitle}”; vigorou por {ticksInForce} turnos.",
    "Nenhuma mão se ergueu contra “{voteTitle}” — o tempo simplesmente acabou.",
  ],
  // The safety net catching a bill that never opened for voting. Rare
  // and slightly embarrassing, so the prose stays plain and factual —
  // a joke here would land on a player whose proposal just vanished.
  bill_reaped: [
    "“{voteTitle}” nunca chegou ao plenário. A sessão se encerrou sem votação.",
    "A moção “{voteTitle}” expirou na comissão, sem ser votada.",
    "O projeto de {actor}, “{voteTitle}”, perdeu o prazo antes de o debate abrir.",
    "“{voteTitle}” saiu da pauta — o prazo passou sem que a votação abrisse.",
    "Nunca se convocou votação sobre “{voteTitle}”. Cai sem resolução.",
    "A câmara nunca chegou a examinar “{voteTitle}”; o relógio esgotou o prazo.",
  ],
  // The gavel changing hands ("malhete"). Two things have to survive the
  // prose: WHO holds it, and that it is TEMPORARY — the whole tension of
  // a term is that agenda control expires. Variants that read as a
  // coronation rather than a rotation were cut.
  chairman_seated: [
    "O malhete passa para {actor}. Até T+{termEnd}, cabe a essa facção definir a pauta.",
    "{actor} assume a presidência no mandato {termNumber}. O plenário é seu por {termSpan} turnos — nem um a mais.",
    "Sorteio feito. {actor} preside, e os assuntos da câmara são o que {actor} disser que são até T+{termEnd}.",
    "{actor} assume a presidência. As delegações que queriam algo na pauta neste mandato já estão no corredor.",
    "O rodízio recai sobre {actor}, que agora ocupa a única cadeira capaz de convocar uma votação. O mandato {termNumber} começa.",
    "Pelo sorteio, {actor} preside o mandato {termNumber}. São {termSpan} turnos para gastar, e nenhum jeito de guardá-los.",
    "A presidência cabe a {actor}. O que não for levado ao plenário neste mandato morre sem ser proposto.",
    "{actor} tomou assento na presidência. Os peticionários têm {termSpan} turnos para ser convincentes.",
    "O mandato {termNumber} começa com {actor} segurando o malhete — um cargo que expira em T+{termEnd}, como todos.",
    "{actor} preside. O poder de legislar da câmara está, por ora, na agenda de uma única facção.",
  ],
  tech_advanced: [
    "Os laboratórios de {actor} levaram a pesquisa de {techName} ao {techLevel} neste ciclo. O avanço resiste à revisão.",
    "Os testes de campo confirmam: {actor} agora opera com {techName} no {techLevel}.",
    "{actor} rompeu o próximo limiar em {techName} e chegou ao {techLevel}. Os rivais vão ler o resumo com atenção.",
    "Depois de ciclos de becos sem saída, o programa de {techName} de {actor} alcançou o {techLevel}. A equipe está, segundo todos, insuportável com isso.",
    "Sob {actor}, o ramo de {techName} avança ao {techLevel}. As implicações já se espalham pela doutrina.",
    "{actor} publicou resultados do {techLevel} em {techName}. As demais facções correm para reproduzi-los.",
    "Uma rodada limpa no laboratório de {techName} de {actor}: {techLevel} alcançado, antes do previsto.",
    "{actor} agora detém o {techLevel} em {techName}. A vantagem é pequena; as consequências, não.",
    "Engenheiros de {actor} registraram {techName}, {techLevel}, neste ciclo. Os cadernos dizem: funciona.",
    "{actor} fechou a distância em {techName} e marcou o {techLevel}. Primeiro em silêncio, depois de uma vez.",
  ],
  trade_accepted: [
    "{actor} trocou {resourceTraded} com {partner} neste ciclo. Os mercados deram de ombros.",
    "Negócio fechado: {actor} e {partner} acertaram {resourceTraded}. Os dois lados o acharam justo.",
    "{partner} aceitou a oferta de {actor}: {resourceTraded}. A troca foi liquidada antes do fim do expediente.",
    "{actor} e {partner} fecharam os termos — {resourceTraded} — e os livros-caixa bateram.",
    "Comércio confirmado entre {actor} e {partner}: {resourceTraded}. Volume em alta, margens apertadas.",
    "{actor} despachou {resourceTraded} para {partner} neste ciclo. Analistas notaram a relação esquentando.",
    "Aperto de mãos em {resourceTraded}. {actor} e {partner} mantiveram o canal aberto por mais um ciclo.",
    "A troca de {resourceTraded} entre {actor} e {partner} saiu sem tropeços. Rotina, lucro, feito.",
    "{partner} fechou com {actor} a troca de {resourceTraded}. Ninguém pagou demais; os dois saíram satisfeitos.",
    "{actor} e {partner} registraram {resourceTraded}. Um negócio pequeno, mas o corredor entre os dois continua movimentado.",
  ],
  trade_declined: [
    "{partner} recusou a oferta de {resourceTraded} feita por {actor}. As conversas terminaram cordiais e inacabadas.",
    "{actor} pôs {resourceTraded} na mesa; {partner} recusou. O mercado viu nisso pura encenação.",
    "Sem acordo. {partner} rejeitou a proposta de {resourceTraded} de {actor}, e os livros ficaram onde estavam.",
    "{actor} e {partner} não chegaram a um acordo sobre {resourceTraded}. Os dois lados citaram o preço; nenhum disse mais.",
    "{partner} se levantou da mesa diante da proposta de {resourceTraded} de {actor}. Os analistas viram pressão, não raiva.",
    "A oferta de {resourceTraded} de {actor} morreu na mesa de {partner}. O canal segue aberto; o negócio, não.",
    "{partner} devolveu sem assinatura os termos de {resourceTraded} propostos por {actor}. Fala-se em uma contraproposta, sem confirmação.",
    "{actor} não conseguiu convencer {partner} sobre {resourceTraded}. Os dois lados não registraram nada e não culparam ninguém.",
    "As negociações sobre {resourceTraded} empacaram. {partner} disse não a {actor}, e o salão silenciou.",
    "{partner} disse não a {resourceTraded}. Os negociadores de {actor} deram de ombros e começaram a preparar a proposta do próximo ciclo.",
  ],
  asteroid_impact: [
    "{settlementName} silenciou quando a rocha desabou sobre {body} em {tick}. {actor} a lançou; {partner} enterrou o que restou.",
    "Um asteroide atingiu {body} em {tick}. O assentamento de {partner} em {settlementName} se apagou. {actor} não nega a ordem.",
    "Impacto em {body}, {tick}. {settlementName} deixou de existir. A pedra que causou isso foi guiada até lá por {actor}, contra {partner}.",
    "{actor} derrubou uma montanha sobre {body}. {settlementName}, de {partner}, estava embaixo dela. A cratera ainda brilha.",
    "Em {tick}, {body} recebeu um golpe que nada ali fora feito para aguentar. {settlementName} deixou de existir. A trajetória é obra de {actor}.",
    "A rocha encontrou {body} em {tick}. {settlementName}, de {partner}, não respondeu a mais nenhum chamado. As digitais de {actor} estão no lançamento.",
    "{partner} perdeu {settlementName} quando um impacto atingiu {body} em {tick}. {actor} chamou aquilo de ataque; os sobreviventes chamaram de fim do mundo.",
    "Impacto de asteroide, {body}, {tick}. Nada restou de {settlementName}. {actor} conduziu a pedra através do sistema para fazê-la cair sobre {partner}.",
    "{body} estremeceu e se partiu em {tick}. {settlementName} já não existia. {actor} fez a mira; {partner} vai contar os mortos por ciclos.",
    "Viram a rocha chegar e não puderam desviá-la. O asteroide de {actor} levou {body} e {settlementName} consigo em {tick}, e {partner} ficou só com o silêncio.",
  ],
  victory: [
    "Acabou. {actor} venceu — {detail}. O registro se encerra aqui, em {tick}.",
    "{tick}: {actor} toma o sistema ({detail}). Todas as outras bandeiras descem.",
    "A longa campanha termina em {tick}. {actor} reina sem rivais: {detail}.",
    "Última entrada, {tick}: {actor} vence — {detail}. Nada mais a relatar além do que vem depois.",
    "{actor} toma posse do sistema em {tick}, e a guerra acabou — {detail}.",
  ],
};
