# Translating Orbital's in-game UI

English is the source. Brazilian Portuguese (`pt-BR`) is the first translation.
The lobby, sign-in and account screens are already done (see `src/i18n/en.ts` and
`src/i18n/pt-BR.ts`, the "base" catalog) and are the style reference: read a few
of their pt-BR entries before you start.

## How it works

```ts
import { t, tn, tk, fmtNumber } from '../i18n/core';
import { useI18n } from '../i18n/react';

function Panel() {
  useI18n();                       // re-renders this component when the language flips
  return <h2>{t('ship.panel.title')}</h2>;       // plain
  //     t('ship.hull', { name })                // "Hull: {name}"
  //     tn('fleet.ships', count)                // plural: fleet.ships_one / fleet.ships_other, {n} is filled in
  //     tk(`data.tech.${id}.name`, tech.name)   // key built at run time; 2nd arg is the English fallback
}
```

* Every string is added to **your area's** English file `src/i18n/parts/en/<area>.ts`
  and translated in `src/i18n/parts/pt-BR/<area>.ts`, under the SAME key.
  Never edit another area's files, `en.ts` or `pt-BR.ts`. (That is what lets several
  people translate in parallel with no merge conflicts.)
* Keys must start with one of your area's prefixes (`PART_PREFIXES` in
  `src/i18n/parts/en/index.ts`); a test enforces it. Name keys by screen and meaning
  (`ship.panel.refit.confirm`), not by the English words.
* Plural keys come in pairs (`x_one`, `x_other`) and use `{n}`. Portuguese counts 0 as singular.
* English values: keep the existing text **exactly** (tests and players depend on it).
  Placeholders `{name}` must be identical in both languages.
* A component that shows text calls `useI18n()` once at the top, so it re-renders when the
  player switches language. A child component gets its own call.

## Gotchas (each one has bitten before)

1. **Module-level constants freeze the language.** `const LABELS = { a: t('x') }` at the top
   of a file runs once at import. Make it a function (`labels()`), or store keys in the table
   and call `t(key)` where it is rendered.
2. **Never translate a value the code compares or sends.** `if (kind === 'Metal')`, API
   fields, ids, CSS classes, `data-*`, localStorage keys, analytics event names: leave alone.
   Only translate what a player reads.
3. **Do not translate** player-entered text (call signs, empire / fleet / game names), names
   that come from the server or the data tables (ship classes, techs, worlds, captains):
   those are a later pass. Leave such values as they are and list the sites in your report.
4. **Text built on the server** (event log lines, chronicle, Herald, error messages from
   `worker/`) stays English for now. For API errors use `apiErrorText(error, 'fallback.key')`
   from `src/i18n/apiErrors` and give it a translated fallback key.
5. **Tooltips, `title=`, `aria-label`, `placeholder`, alt text and canvas text are UI text.**
   Translate them. Console logs, dev-only panels and the Admin / Devlog / Editor / PerfHud /
   MapEditor tools stay English.
6. **Portuguese runs 20-30% longer.** Keep button and chip labels short and imperative
   ("Construir", "Cancelar"). When a label is in a tight space, prefer the shorter natural
   phrase over a literal one.
7. Numbers: leave `toFixed` / `toLocaleString` formatting as it is. Only use `fmtNumber`
   where a decimal appears inside a sentence you are already rewriting.
8. Existing tests run in English (jsdom defaults to en); do not change what they assert. If
   a test breaks because a string moved, fix the cause, not the assertion.
9. Do not rename or restructure components beyond what the translation needs.

## Tone

Brazilian Portuguese, "você", direct and friendly, the same register as the English. Natural,
not literal: write what a Brazilian strategy-game player would expect to see. Sentence case
for sentences; keep ALL-CAPS labels in caps. No European Portuguese ("ecrã", "rato", "utilizador").

## Glossary (use these; extend it in your own area only for terms not listed)

| English | pt-BR | | English | pt-BR |
|---|---|---|---|---|
| game / match | jogo | | Senate | Senado |
| lobby | sala | | bill (Senate) | projeto de lei |
| seat | vaga | | Chancellor | Chanceler |
| host | anfitrião | | treaty | tratado |
| turn / tick | turno | | trade / trade route | comércio / rota comercial |
| empire | império | | market | mercado |
| faction | facção | | embargo | embargo |
| world | mundo | | war / peace | guerra / paz |
| planet / moon | planeta / lua | | declare war | declarar guerra |
| asteroid | asteroide | | alliance | aliança |
| station | estação | | combat / battle | combate / batalha |
| colony | colônia | | Herald | Arauto |
| settlement | assentamento | | chronicle | crônica |
| homeworld | mundo natal | | recap | resumo |
| fleet | frota | | terraform | terraformar |
| ship | nave | | Dyson Sphere | Esfera de Dyson |
| hull | casco | | megastructure | megaestrutura |
| captain | capitão | | sun gate | portal solar |
| rank | patente | | Kuiper Belt | Cinturão de Kuiper |
| build | construir | | metal / energy | metal / energia |
| refit | readaptar | | credits (CR) | créditos (CR) |
| repair | reparar | | science (SCI) | ciência (CIÊ) |
| upkeep | manutenção | | kinetic | cinético |
| arrears | atraso | | intel | inteligência |
| research | pesquisa | | sensor range | alcance dos sensores |
| tech / tech tree | tecnologia / árvore de tecnologias | | fog of war | névoa de guerra |
| Weapons | Armas | | orbit | órbita |
| Defense | Defesa | | in transit | em trânsito |
| Propulsion | Propulsão | | engine | propulsor |
| Construction | Construção | | dock / park | atracar / estacionar |
| Society | Sociedade | | Commander's Commission | Comissão do Comandante |
| Sensors | Sensores | | Quick Join | Entrada rápida |

## Finishing

* `node ../../../node_modules/typescript/bin/tsc --noEmit -p .` (ignore errors in other
  people's `__tests__`), eslint on every file you touched (`import/first` and unused imports
  fail the production build), and the tests:
  `CI=true node ../../../node_modules/react-scripts/bin/react-scripts.js test --watchAll=false --testMatch "**/src/**/__tests__/**/*.test.{ts,tsx}"`
  from the worktree (a plain `npx jest` finds nothing and is not the runner here).
* Every English key in your part has a Portuguese entry (the catalog tests report any gap), and
  nothing in your files is left hard-coded English that a player reads.
* Commit in small steps; your final report lists: files converted, number of keys, strings
  deliberately left in English (and why), data-table / server-built strings you found.
