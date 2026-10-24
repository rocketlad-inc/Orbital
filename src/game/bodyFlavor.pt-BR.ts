// ============================================================
// bodyFlavor.pt-BR — the world lore (bodyFlavor.ts BODY_FLAVOR) in
// Brazilian Portuguese, keyed by the same body ids.
//
// A translation, not a rewrite: same facts, same mood, same length. A body
// missing here falls back to the English prose, so a new world never shows
// a blank. When you edit an English entry, edit its Portuguese twin too
// (src/game/__tests__/bodyFlavorPt.test.ts checks that every authored
// English entry has one).
// ============================================================

export const BODY_FLAVOR_PT: Record<string, string> = {
  // === Sistema Solar ==========================================
  sol: '',

  // Planetas interiores
  mercury: "O mais perto do fogo: gira três vezes a cada duas voltas em torno do Sol, então um único dia dura mais que o ano que o contém. As faces voltadas para o Sol viram escória vitrificada, enquanto o fundo das crateras nos polos guarda gelo de água em sombra permanente há bilhões de anos. Há riqueza no seu enorme coração de ferro, mas você vai arrancar esse metal sob um sol que não perdoa.",

  venus: "Um mundo do tamanho do nosso, afogado num oceano de pressão e nuvens, onde o ar é quente o bastante para derreter chumbo e a chuva é ácido que nunca chega ao chão. Sob esse véu, a superfície é mais jovem do que deveria, recoberta por alguma violência que ainda não entendemos. Seja qual for o seu segredo, ele foi bem guardado, atrás de um véu que nada conseguiu atravessar com clareza.",

  earth: "O berço azul-claro: combustível e metal equilibrados, e uma profundidade de ciência que vem de ser o único mundo que sabemos que aprendeu a viver. Uma única lua ergueu suas marés e firmou sua inclinação por tempo suficiente para isso acontecer, e talvez seja a sorte mais rara de todo o catálogo. Tudo começa aqui; a pergunta que o Orbital faz é até onde você vai chegar a partir daqui.",

  mars: "Um deserto enferrujado que um dia teve rios, com canais secos e deltas antigos ainda gravados na rocha vermelho-ferro, como se a água tivesse partido ontem. O metal é farto e os segredos são sombrios por aqui: um portal estelar adormecido sob a poeira, ou uma nave de guerra morta à deriva acima dele. A primeira fronteira de verdade, perto o bastante para alcançar e estranha o bastante para valer a viagem.",

  luna: "A companheira silenciosa da Terra, nascida de uma colisão tão grande que quase desfez os dois mundos, e que desde então mantém a mesma face cinzenta voltada para casa. Do seu regolito pouco brota além de metal e silêncio, mas antigas expedições deixaram coisas na poeira: maquinário abandonado, um banco de dados ainda paciente no escuro. O primeiro degrau para fora do berço, e o lugar mais fácil para aprender quanto custa o vazio.",
  phobos: "Uma batata enegrecida de lua, com uns dezoito quilômetros de ponta a ponta, caindo em direção a Marte alguns centímetros por século até que as marés enfim a desfaçam num anel. Sua grande cratera Stickney quase a partiu uma vez; os sulcos que se espalham dela são as rachaduras que não terminaram o serviço. Pequena demais para guardar muito e condenada demais para guardar por muito tempo, mas paira tão baixo sobre as planícies marcianas que tudo o que estaciona aqui olha direto para dentro de um poço gravitacional.",
  deimos: "A menor e mais distante das duas rochas capturadas por Marte, tão fraca vista da superfície que parece uma estrela brilhante e lenta, e não uma lua, levando um dia e meio para cruzar o céu. A poeira suavizou suas crateras até virarem covinhas: o único lugar do sistema interior onde o chão é realmente gentil. Não há quase nada aqui, e é exatamente por isso que ninguém olha duas vezes para o que você deixa nela.",

  // Cinturão de asteroides
  ceres: "O maior corpo do cinturão, redondo o bastante para ser um mundo de verdade, com depósitos de sal reluzindo onde água salgada um dia brotou de baixo. Talvez ainda haja um oceano enterrado ali dentro, selado sob gelo e rocha. Rico em metal e em boatos: se uma cidade perdida dorme em algum lugar do cinturão, é aqui que você procuraria primeiro.",

  vesta: "Um protoplaneta castigado que nunca terminou de se formar, marcado por um impacto tão enorme que lançou fragmentos até a Terra como meteoritos. Seu núcleo é de ferro, sua crosta é de pedra, e seu rendimento de metal está entre os maiores do cinturão. Um mundo partido que quase virou algo maior, e que talvez ainda guarde os ossos de alguém que chegou lá primeiro.",

  pallas: "Muito inclinada no próprio eixo e traçando um caminho íngreme e solitário que a mantém longe do resto dos destroços, Palas é andarilha até entre andarilhos. Sua superfície é um estudo de violência, cada face crivada de crateras e instável. O metal é bom e o silêncio é profundo; o que estiver enterrado aqui teve muito tempo para ser esquecido.",

  hygiea: "A quarta gigante do cinturão, escura e quieta, redonda apesar da massa modesta, lisa onde as irmãs são cheias de cicatrizes, como se um estilhaçamento antigo tivesse se recomposto em algo quase pacífico. Rende combustível e metal na mesma medida, sem alarde. Um mundo esquecido, exatamente do tipo que guarda seus segredos por mais tempo.",

  juno: "Um dos primeiros asteroides já descobertos, um bloco irregular de rocha metálica que brilha de repente ao girar sob a luz do sol. Créditos razoáveis, metal razoável e a mesma chance, funda como o cinturão, de um tesouro sob os pés. Pequeno, de arestas afiadas e fácil de ignorar, e por isso mesmo algo ainda pode estar esperando nele.",

  // Sistema joviano
  jupiter: "O rei dos mundos: um gigante listrado de tempestades, tão massivo que quase virou um segundo sol, com uma única tormenta maior que a Terra rugindo há séculos. Seus ventos são combustível puro, tirados de nuvens sem fundo. Um portal estelar poderia se ancorar nesse imenso poço gravitacional, ou uma nave de guerra morta poderia estar à deriva na sua sombra; de qualquer forma, Júpiter recompensa os ousados e engole os descuidados.",

  io: "O mundo mais vulcânico que se conhece, amassado sem trégua pela força de Júpiter até a superfície escorrer enxofre e rocha derretida, se refazendo mais rápido do que as crateras conseguem se formar. Há combustível na sua fúria e metal na sua crosta inquieta. Um lugar infernal e glorioso, e veteranos deixaram maquinário e um banco de dados em algum ponto do fogo.",

  europa: "Sob uma casca de gelo rachada há um oceano com mais água do que todos os mares da Terra, mantido líquido pelas marés que Júpiter nunca para de trabalhar nela. A ciência aqui é funda e estranha; o que foi guardado naquele banco de dados foi guardado com cuidado. Se algum dia se encontrasse vida esperando no escuro, seria num lugar exatamente como este.",

  ganymede: "A maior lua do sistema, maior que Mercúrio, e a única que gera um campo magnético próprio a partir de um núcleo de ferro em movimento. Um oceano escondido se estende entre camadas de gelo lá embaixo. Rica em metal e equilibrada em todos os rendimentos, é uma lua que se acha planeta, e tem profundidade para esconder segredos à altura de um planeta.",

  callisto: "A superfície mais crivada de crateras do sistema, uma face escura e antiga que quase não mudou em quatro bilhões de anos: um museu de cada impacto que o sistema exterior já lançou contra ela. Longe o bastante de Júpiter para escapar do pior da radiação, é a calma da família. Bons créditos, bom metal e a paciência de ter guardado o que encontrou há muito, muito tempo.",

  // Sistema de Saturno
  saturn: "A joia do sistema, cercada por incontáveis estilhaços de gelo que cobrem o espaço entre mundos e ainda assim são mais finos que uma montanha é alta. Tão leve que boiaria na água, ele rende combustível e créditos de nuvens rendadas de cristal. Um portal poderia atracar no seu esplendor, ou uma nave abandonada poderia pairar em silêncio diante daqueles anéis: beleza e perigo orbitando o mesmo centro.",

  enceladus: "Uma lua de um branco ofuscante que dispara gêiseres de água do mar direto para o espaço por fendas no polo sul, alimentando um dos anéis de Saturno com seu oceano escondido. A ciência aqui é extraordinária: água líquida, calor e a química da vida jorrando no escuro para quem quiser ler. Pequena, brilhante e impossivelmente viva; as expedições deixaram aqui suas melhores descobertas por um motivo.",

  rhea: "A segunda maior lua de Saturno, um mundo gelado de gelo e rocha quase puros que talvez já tenha usado um anel tênue e frágil só seu. Quieta e equilibrada no que oferece: um pouco de combustível, um pouco de metal, um pouco de tudo. O tipo de ponto de passagem frio e limpo onde algo poderia ficar intocado por eras.",

  titan: "A única lua com uma atmosfera de verdade: uma névoa alaranjada e espessa sobre lagos e rios de metano líquido, onde chove hidrocarboneto e a química é funda o bastante para deixar qualquer um pensativo. Combustível e ciência jorram daqui em abundância. Um mundo mais estranho que a ficção e mais rico que a maioria dos planetas; se for visitar uma só lua no sistema inteiro, que seja esta.",

  // Sistema de Urano
  uranus: "O gigante tombado, derrubado de lado por algum golpe antigo, de modo que rola em volta do sol com o polo à frente e estações que duram décadas de luz ou escuridão contínuas. Sob a névoa ciano-clara, seu manto é uma lama de gelos exóticos. Combustível e ciência em boa medida, e um portal ou um destroço esperando num lugar que já faz tudo de lado.",

  miranda: "Uma lua pequena e estilhaçada que parece costurada com peças que não combinam: penhascos de quilômetros de altura, terreno que parece ter sido rasgado e remontado por alguma coisa. Metal modesto, segredos modestos, estranheza de sobra. Um mundo quebra-cabeça que levanta mais perguntas do que responde, e é exatamente por isso que vale o pouso.",

  ariel: "A mais brilhante das luas de Urano, com a superfície riscada de vales por onde talvez já tenha escorrido lama gelada, mais jovem e mais lisa que suas irmãs castigadas. Créditos e metal equilibrados, nada extremo. Uma face limpa e reluzente que claramente já se refez antes, e que pode estar escondendo o que enterrou no processo.",

  umbriel: "A mais escura da família, uma esfera antiga e apagada que bebe a luz e devolve pouco, a não ser por um misterioso anel brilhante na superfície que ninguém jamais explicou por completo. Rica em metal e de boca fechada. A irmã sombria, guardando um segredo há mais tempo que todas as outras.",

  titania: "A maior das luas de Urano, cortada por cânions enormes onde a crosta se partiu quando um oceano enterrado congelou e se expandiu, há muito tempo. Metal sólido, rendimentos equilibrados, uma boa colheita. Um mundo cheio de cicatrizes e espaçoso, com lugar de sobra para esconder o que veio parar tão longe.",

  oberon: "A lua principal mais externa, um mundo antigo de tom avermelhado, marcado por crateras cujo fundo foi manchado de escuro por algum material que brotou de baixo. Bons créditos e metal para quem chega até aqui. O último ponto de parada antes de o alcance do gigante acabar, e o lugar mais solitário onde um segredo poderia se guardar.",

  // Sistema de Netuno
  neptune: "O gigante mais distante, de um azul profundo e vivo, movido pelos ventos mais rápidos do sistema: vendavais supersônicos uivando sobre um mundo que quase não recebe calor do sol distante. Rico em combustível e ciência, alimentado por tempestades que surgem e somem como olhos escuros se abrindo nas nuvens. Um portal ou um destroço pode se esconder aqui, na beira do domínio do sol, onde poucos se dão ao trabalho de olhar.",

  proteus: "Uma lua escura e irregular, bem no limite em que um corpo desse tamanho consegue se manter como esfera: um pouco menor e seria só uma rocha. Metal e rendimentos equilibrados, nada chamativo. Uma guardiã esquecida no portão de Netuno, o tipo de lugar onde um explorador cuidadoso deixa coisas para trás.",

  triton: "Ela circula Netuno ao contrário, na contramão de tudo: quase certamente um mundo capturado do Cinturão de Kuiper, arrastado para a órbita e condenado aos poucos por ela. Gêiseres de nitrogênio ainda irrompem na sua superfície rosada e congelada, e o rendimento de ciência é alto. Um mundo roubado que se lembra de outro céu; o que quer que tenha trazido das profundezas ainda está a bordo.",

  nereid: "Numa das órbitas mais esticadas e excêntricas de qualquer lua, Nereida passa raspando perto de Netuno e depois se afasta para o frio antes de voltar. Rendimentos modestos e equilibrados e um circuito longo e solitário. Uma andarilha que mal é segurada pelo seu mundo, e o mais longe que se pode ir e ainda se chamar de lua.",

  // Cinturão de Kuiper
  pluto: "Rebaixado de planeta a planeta anão e, mesmo assim, o mais querido de todos, Plutão exibe um coração congelado de gelo de nitrogênio sobre uma face de névoa marrom-avermelhada e montanhas pálidas de água sólida. Ele divide uma dança quase travada com sua grande lua, Caronte, os dois sempre voltados um para o outro. Rico em créditos, fundo no frio, mas nunca uma passagem; o que quer que durma aqui está preso a este sistema.",

  charon: "Com metade do tamanho do mundo que orbita, travada face a face com Plutão numa valsa que deixa cada um imóvel no céu do outro, e marcada no polo por uma calota vermelho-escura de origem desconhecida. Rica em metal e quieta. Mais um mundo companheiro do que uma lua, e antigas expedições a trataram assim, deixando equipamento e um banco de dados na sua rocha.",

  haumea: "Girando tão rápido que se esticou em forma de ovo, Haumea rodopia pelo fundo do cinturão arrastando um anel e um par de pequenas luas, com a superfície vitrificada de gelo cristalino. Rica em metal e longe de tudo. Um dos cinco mundos que podem esconder um portal de dobra: uma porta para outro lugar aqui fora, escondida num mundo que já gira rumo ao limite da razão.",

  makemake: "Um mundo avermelhado e congelado lá no escuro frio, brilhante de metano congelado e tão distante que sua única lua apagada passou anos sem ser vista. Créditos e metal razoáveis para quem se dispõe a vir até aqui. Um dos cinco que podem esconder um portal, e um limiar à altura, bem remoto, para um salto entre estrelas.",

  quaoar: "Um pequeno mundo congelado que desafia as regras usando um anel que ninguém esperava que ele conseguisse segurar, orbitando tão longe que, pelas contas, nenhum anel deveria sobreviver. Rico em metal e estranho. Um dos cinco portadores de portal: um mundo que já guarda uma coisa impossível, e que pode guardar outra.",

  eris: "O mundo que derrubou Plutão: quase seu gêmeo em tamanho, encontrado muito além dele, obrigando todos a decidir o que um planeta afinal é. Ele percorre uma órbita tão distante e inclinada que sua atmosfera fina congela e cai como neve durante séculos. Rico em créditos e ciência, e um dos cinco que podem esconder um portal; um mundo que um dia redesenhou o mapa pode ainda abrir uma porta para fora dele.",

  sedna: "Numa órbita tão vasta que um único ano dela dura mais que onze mil dos nossos, Sedna passa quase todo o tempo num frio além do frio, viajando para o escuro onde o sol é só mais uma estrela. É rica em metal e pode esconder um portal para outro lugar completamente diferente, como convém a um mundo que já vive a meio caminho do próximo sistema. Poucas coisas vagam até tão longe; menos ainda estarão esperando quando você chegar.",

  // === A casca de Kuiper ======================================
  orcus: "Descoberto em fevereiro de 2004 por Mike Brown, Chad Trujillo e David Rabinowitz, a mesma equipe que derrubaria Plutão com Éris um ano depois. Ele segue o mesmo passo de dois para três com Netuno que Plutão, mas sempre meia volta fora de fase, chegando ao ponto mais distante quando Plutão chega ao mais próximo; os astrônomos o chamam de anti-Plutão. Gelo cristalino e um traço de amônia cobrem uma superfície que deveria ter perdido os dois há muito tempo, o que significa que algo lá embaixo ainda está se renovando.",

  vanth: "O Hubble o flagrou em novembro de 2005, e em 2017 a sombra que ele projetou ao passar diante de uma estrela fixou seu tamanho em 442 quilômetros, quase metade da largura do mundo que ele circula. Leva o nome do espírito etrusco alado que acompanha os mortos, companhia apropriada para um mundo batizado em homenagem ao deus do submundo. É escuro onde Orco é claro, como se os dois tivessem sido montados com dois conjuntos de peças diferentes.",

  ixion: "Capturado em maio de 2001 pelo Deep Ecliptic Survey, em Cerro Tololo, um projeto criado para mapear exatamente esta faixa, que o encontrou já na primeira temporada. Quando ele passou diante de estrelas entre 2020 e 2023, os tempos medidos deram uma largura firme: 697 quilômetros, e 727 no eixo maior. Nenhuma lua foi encontrada em volta dele, então sua massa continua sendo um palpite, e uma camada de compostos orgânicos escuros esconde o gelo que houver por baixo.",

  mani: "Trujillo e Brown o encontraram em Palomar em junho de 2002, e ele esperou vinte e três anos por um nome, tirado em 2025 do deus nórdico que conduz a lua. Em agosto de 2020 sua sombra cruzou uma estrela e revelou uma bacia de 322 quilômetros de largura e 45 de profundidade, com um pico de 25 quilômetros de altura saindo do fundo: um dos relevos mais violentos já vistos em qualquer lugar. Desde 2023, um excesso de calor sem explicação sugere um companheiro que ninguém ainda conseguiu ver.",

  salacia: "Henry Roe, Michael Brown e Kristina Barkume o identificaram em chapas de Palomar em setembro de 2004, e foram precisos vinte e um anos para medi-lo direito. Em 2025, o conjunto de radiotelescópios ALMA o fixou em 838 quilômetros e, o que é mais útil, lhe deu uma densidade: densa o bastante para ser um mundo de verdade, e não um monte de escombros. Ele devolve quatro por cento da luz que recebe, o que o torna uma das coisas grandes mais escuras do sistema.",

  actaea: "O Hubble encontrou a lua de Salácia em julho de 2006: 393 quilômetros de gelo com o nome de uma nereida, uma filha do mar. É a órbita dela que permite pesar o par, então quase tudo o que se sabe sobre o interior de Salácia se sabe porque esta rocha gira em volta dela. A quinta maior lua daqui de fora, e sobre ela quase nada mais se sabe.",

  varuna: "Robert McMillan o registrou numa chapa do Spacewatch em Kitt Peak em novembro de 2000, numa época em que um corpo desse tamanho além de Netuno ainda era espantoso. Ele gira uma vez a cada seis horas e dezoito minutos, rápido o bastante para que a própria rotação o esticasse num ovo uma vez e meia mais comprido do que largo. Sua densidade mal chega à da água, o que faz dele menos um mundo e mais um monte frouxo que ainda não desmoronou.",

  aya: "Detectado em Palomar em janeiro de 2002 por Brown, Trujillo e Eleanor Helin, e batizado em junho de 2025 em homenagem à deusa acádia da aurora, esposa do sol. Quase 770 quilômetros de rocha vermelho-escura, com um tamanho conhecido só pelo infravermelho que ele deixa escapar, e não por alguma sombra que tenha projetado ao passar diante de uma estrela. Um dos maiores corpos daqui de fora sem lua para pesá-lo e sem nenhuma passagem diante de estrela que o tenha medido.",

  varda: "Jeffrey Larsen o encontrou em imagens do Spacewatch em junho de 2003, e em setembro de 2018 ele passou diante de uma estrela e entregou um número firme: 740 quilômetros. O telescópio James Webb olhou em 2025 e achou algo estranho para essa distância: uma superfície dominada por dióxido de carbono congelado a quarenta e quatro graus acima do zero absoluto, quase sem gelo de água. Leva o nome da Valië que acendeu as estrelas.",

  ilmare: "O levantamento de Keith Noll com o Hubble revelou a lua de Varda em abril de 2009, com quatrocentos quilômetros, tão grande em proporção que as duas estão travadas face a face pelas marés, como Plutão e Caronte. Um par binário fingindo ser um mundo e seu satélite. É um dos pouquíssimos sistemas daqui de fora com massa suficiente para ser pesado a partir do chão.",

  hiiaka: "Uma equipe do Caltech no Keck a encontrou em janeiro de 2005, a maior de duas filhas que circulam o mundo grande que gira mais rápido no sistema. Leva o nome da deusa havaiana nascida da boca de Haumea. É a órbita dela que dá a Haumea uma massa, e é a gravidade dela que mantém visivelmente instável o caminho da irmã menor.",

  namaka: "Encontrada cinco meses depois da irmã, em junho de 2005, e batizada em homenagem ao espírito da água nascido do corpo de Haumea. É a pequena, com mal 150 quilômetros, e sua órbita é puxada para fora do eixo por Hi'iaka, que a atrai de mais longe: um problema de três corpos acontecendo em tempo real, no limite do que se consegue observar.",

  weywot: "Brown e Terry-Ann Suer encontraram a lua de Quaoar em imagens do Hubble no Dia dos Namorados americano de 2006, e por dezessete anos todos erraram o tamanho dela pela metade. Em 2023, astrônomos acharam um anel em volta de Quaoar onde nenhum anel deveria sobreviver, quase exatamente onde a gravidade de Weywot bate num ritmo de seis para um. A lua pode ser o motivo de o anel nunca ter se juntado numa segunda lua.",

  dysnomia: "A equipe de Mike Brown a flagrou em setembro de 2005 usando a estrela-guia a laser do Keck, uma estrela artificial pintada no céu para deixar a imagem mais nítida, e em menos de um ano ela encerrou a discussão sobre Plutão ao mostrar que Éris era o mundo mais pesado. Seiscentos quilômetros de rocha muito escura numa órbita de quinze dias. As duas estão travadas face a face, o que, para uma lua tão modesta, significa que Éris é muito mais macia por dentro do que se esperava.",

  mk2: "A câmera Wide Field Camera 3 do Hubble encontrou a lua de Makemake em abril de 2015, e a equipe da descoberta ainda a chama de MK 2, porque ela nunca recebeu um nome de verdade. É escura como carvão diante de um mundo brilhante de geada de metano, e orbita quase exatamente de perfil vista daqui, então vive sumindo no brilho do planeta. Ninguém ainda a viu dar a volta completa.",

  // === Sistema binário de Centauri ============================
  binary_barycenter: "Não é um corpo, e sim o ponto imóvel em torno do qual o sistema inteiro gira: um centro de massa invisível onde duas estrelas trocam sua atração sem fim. Nada orbita mais perto do verdadeiro coração deste lugar. Não há nada aqui para minerar e tudo aqui para entender: o eixo escondido do qual dependem dois sóis e todos os seus mundos.",

  centauri_a: "A primária amarela, metade mais massiva que a parceira, ancorando o sistema com sua luz dourada e constante. Ela e a companheira se perseguem em volta do baricentro num ciclo incansável, sem que uma alcance a outra. Não dá para pousar num sol, mas tudo neste sistema vive ou morre pelo calor que este oferece. Verdant orbita só ela. Uma estação entre os mundos que circulam os dois sóis rende o dobro; uma num mundo que orbita um só sol acompanha a dança, rendendo metade a mais quando os sóis estão afastados e o triplo quando se aproximam.",

  centauri_b: "A secundária laranja, menor e mais fria, sempre do lado oposto da dança em relação à irmã mais brilhante. Juntas, elas formam um céu que nenhum olho nascido em Sol já viu: dois sóis, duas sombras, duas auroras. Inalcançável e essencial, a segunda fogueira de um sistema feito para dois. Cinder orbita só ela, e entre os dois sóis há uma faixa onde nada consegue manter uma órbita por muito tempo.",

  verdant: "Um mundo verde aninhado perto de Centauri A, com o céu oscilando na dança de dois sóis, e a mente mais rica de qualquer sistema: doze medidas de ciência numa só colheita, um jardim de biologia que, por nenhuma lei que conhecemos, deveria existir. Tudo cresce aqui, inclusive perguntas. O que quer que tenha aprendido a prosperar sob um céu duplo teve muito tempo para pensar, e mais tempo ainda para esperar que alguém viesse perguntar.",

  crimson: "Um gigante vermelho-escuro além da zona do caos, com nuvens listradas iluminadas cor de sangue pelos dois sóis ao mesmo tempo. Treze medidas de créditos numa só extração, uma fortuna para qualquer império ousado o bastante para explorá-lo, com ciência de sobra e quase nenhum metal. Três luas lhe fazem companhia, bem no limite de onde qualquer coisa consegue ficar.",

  prismara: "Uma lua violeta-clara pendurada diante do seu gigante carmesim, com uma coloração estranha que capta a luz dupla das estrelas de jeitos que nada em Sol jamais conseguiu. Rica em créditos e funda em ciência. Um mundo de tons de joia que parece irreal e rende como um sonho, o tipo de lugar que exploradores atravessam anos-luz para pisar.",

  cinder: "Uma rocha enferrujada que parece morta e não está: sob a superfície queimada há uma fortuna em créditos, metal e parte da maior ciência do sistema. Centauri B, que ela orbita sozinha, a assou até a cor de ferro velho, e A termina o serviço toda vez que a dança a traz para perto. Sem graça para os olhos e valiosíssima para o levantamento; nunca julgue um mundo de Centauri pela cara.",

  scoria: "Uma brasa de lua, torcida pelas marés de Crimson até a crosta rachar e nunca mais fechar. Rios de rocha incandescente correm entre placas de vidro negro, e a luz de dois sóis volta dela na cor de uma forja. Pesada em metal, quente sob os pés e mais perto do seu gigante do que qualquer coisa deveria querer estar.",
  umber: "A lua externa de Crimson, escura como couro velho e crivada de crateras até o horizonte, carregando a poeira de tudo o que já caiu em direção ao gigante. Rica em metal, pobre em todo o resto, e quieta de um jeito que as luas internas nunca são.",
  elegy: "Uma lua de retalhos estilhaçados cujas peças congelaram de volta nos lugares errados, com cristas e terraços empilhados como um monumento que ninguém terminou. Ela gira mais perto de Vellichor e bebe a maior parte da sua luz. Forte em ciência; as fraturas são fundas, e o gelo também.",
  vesper: "Pálida e violeta-prateada, Vesper surge sobre o horizonte de Vellichor como uma estrela da tarde. Seus longos cânions captam o brilho azul de HDE 226868 e o seguram um pouco depois que a luz se vai. Equilibrada em tudo, o mundo mais estável de Cygnus.",
  threnody: "A mais externa das luas de Vellichor, uma pedra índigo escura salpicada de raios brilhantes de impacto, como se o buraco negro estivesse jogando coisas nela. Fria, lenta e paciente, com metal sob o gelo para quem vier até aqui.",
  thistle: "A lua próxima de Verdant, cinza-violeta e eriçada de cristas emplumadas de geada que captam a luz dupla como cabeças de sementes. Nada cresce aqui, mas parece que algo tentou. A ciência vem mais fácil do que qualquer outra coisa.",
  sorrel: "Uma pequena lua vermelho-ferrugem numa órbita larga, da cor das terras altas e secas sobre as quais ela paira. Manchada de ferro e sem rodeios: um pouco de metal, alguns créditos e uma bela vista do único jardim num raio de anos-luz.",
  clinker: "O que a fornalha deixou. A única lua de Cinder é um bloco de escória negra vitrificada por dois sóis, ainda um pouco morna na face voltada para eles. Principalmente metal, e não há muito mais a dizer a favor dela.",
  lacrimosa: "A lua pálida de Requiem, de gelo azul como lágrimas antigas, riscado onde o brilho de raios X o gravou. A metade quieta do luto do sistema, e a sua melhor ciência.",
  sanctus: "Uma lua de marfim brilhante bem alta sobre Requiem, lisa e calma demais para um lugar tão perto de um buraco negro. Créditos e metal em boa medida, e uma espécie de paz.",
  gilt: "A lua de Echelon, um fragmento folheado a ouro da mesma supernova que dourou o seu mundo, atravessado por veios que faíscam quando ela gira. Pesada em créditos, como se espera pelo nome.",
  flint: "A âncora cinzenta do Kindling, uma longa lasca de pedra dura que solta faíscas de luz enquanto gira sob dois sóis. Metal, principalmente, e um ótimo lugar para atracar uma estação que bebe dos dois.",
  tinder: "Um monte de escombros solto e castanho, mantido inteiro por pouco mais que o hábito. Leve, porosa e rica o bastante em metal e créditos para valer o risco de construir em algo que pode se desfazer.",
  ember: "A quente: uma rocha escura raiada de vermelho-ferrugem onde a luz do binário assou o seu ferro. Ela nunca chega a esfriar no lado voltado para os sóis.",
  pyrite: "Ouro de tolo, dizem os garimpeiros, e eles estão errados: o brilho de latão é real, e os créditos também. A rocha mais brilhante do Kindling.",
  farspire: "O posto solitário na borda do sistema, uma pequena agulha congelada de rocha e gelo, rica em ciência apesar do tamanho modesto. Logo além dela, quando o Sol abre suas portas, o portal de volta para casa vem descansar: a outra ponta da travessia a partir do Alcance Distante de Sol. O fim de uma jornada e o começo do caminho de volta; toda rota por Centauri passa, cedo ou tarde, por Farspire.",

  // === O análogo de Cygnus X-1 ================================
  bh_barycenter: '',
  cygnus_x: "Um buraco negro com quinze vezes a massa do Sol, se alimentando da sua companheira azul por uma fita de gás roubado. Nada pousa aqui e nada sai. Sua atração dobra o próprio tempo: quanto mais fundo uma nave entra no poço, mais devagar corre a sua viagem, então um salto entre os mundos internos de Cygnus leva quase o dobro do tempo da mesma distância em qualquer outro lugar. Requiem circula só ele, e o buraco e a companheira giram um em torno do outro, perto e longe, num ciclo que dá para acompanhar.",
  hde_226868: "Uma supergigante azul sendo devorada viva. HDE 226868 despeja um fluxo da própria atmosfera no buraco negro ao lado, e seu brilho deixa cada mundo de Cygnus violeta, bronze ou vidro. Inalcançável, instável e a única luz que este sistema tem. Echelon circula só ela, e toda vez que a dança traz a gigante para perto do buraco, Echelon é arrastado para as águas rasas do poço.",
  requiem: "O único mundo que orbita o próprio buraco negro, uma rocha escura cor de vinho-violeta cujas cicatrizes de impacto o brilho de raios X fundiu em vidro. Rico em metal e ciência, e fundo no poço: tudo o que vai ou vem de Requiem se arrasta, com os relógios andando mais devagar que o resto do sistema.",
  vellichor: "Um gigante gasoso desbotado para um azul-violeta pálido pela radiação do binário, com o metano arrancado e as faixas suavizadas. Vellichor tem três luas melancólicas e uma fortuna em créditos, longe o bastante do buraco negro para que as naves desacelerem só um pouco no caminho.",
  echelon: "Um mundo forjado em cinzas de supernova, com a crosta feita de uma liga de elementos pesados, bronze e ouro, que ressoa quando o vento a atravessa. Os créditos mais ricos de Cygnus. Ele orbita sozinho a gigante azul, então a força do poço sobre ele vai e vem com a dança: leve quando o par se afasta, mais pesada quando se aproxima.",
  cenotaph: "Uma rocha que é um monumento vazio, de encostas lisas e pesada de metal, num anel que é tudo o que resta do que o buraco negro desmontou primeiro.",
  epitaph: "Uma rocha marcada por longos sulcos retos, como se algo tivesse tentado escrever nela. Ciência e metal, e um silêncio desconfortável.",
  votive: "Uma pequena rocha brilhante com um reflexo metálico quente, que capta o brilho azul de HDE 226868 e o devolve dourado. A mais rica em créditos entre os mortos do Ossuário.",
  marrow: "A pálida: um bloco de níquel e ferro branco como osso, a coisa mais densa do anel e o melhor metal de Cygnus para quem estiver disposto a trabalhar tão fundo no poço.",
  reliquary: "O último mundo de Cygnus, uma pequena relíquia fria girando longe do buraco negro e da gigante azul que ele devora aos poucos. Ciência e metal em boa medida, e silêncio de sobra. Logo além dele é onde o portal vindo de Sol vem descansar: a primeira coisa que qualquer viajante vê ao atravessá-lo, e a última pela qual passa no caminho de volta para casa.",
};
