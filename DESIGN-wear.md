# Orbital on Wear OS

A companion watch app: what the empire is earning, what is on fire, and
what the senate is waiting on you for.

---

## Why the widget trick does not work here

The phone app contains no game code. It is a Trusted Web Activity — a
Chrome tab with the browser chrome removed — and the home-screen widgets
beside it contain no layout either: the Worker renders each card whole,
as a PNG, so the content, the colours and the information can all change
with a deploy and never a store release. `worker/widget.js` states the
principle outright: *the dumbness of the client is the feature*.

**Neither half of that survives contact with a watch.** There is no
Chrome on Wear OS, no Custom Tabs, and nothing for a TWA to launch. And
a watch is not a picture — it is three screens you swipe between, scroll,
and press buttons on. Compose wants values: a number to animate, a row to
scroll, a button to disable while a vote is in flight. None of that
survives being flattened to a bitmap.

So the watch is the first genuinely native client in this project, and
the trade is made deliberately:

| | Phone widget | Watch |
|---|---|---|
| Layout lives | On the server | In the APK |
| Changing it costs | A deploy | A release |
| Game rules live | On the server | On the server |

The second row is the price. The third row is the thing that was not
given up: every number the watch shows is derived by `worker/wear.js`,
including income per tick, which the watch could compute from the pools
and deliberately does not.

---

## The server half

One endpoint, one document, three screens.

```
GET  /wear/<token>/state.json   everything the three screens show
POST /wear/<token>/vote         {proposalId, vote}
```

**One request, not three.** A watch radio is the battery. Three
endpoints would mean three wakeups for one glance, and any of the three
being a tick older than the others would show.

**It reuses the snapshots rather than re-querying.** `widgetSnapshot`
and `battleSnapshot` already encode rules that took the widget several
passes to get right — which game to show a player who is in three, what
an eliminated faction's counts mean, the treaty exclusion that stops an
ally reading as inbound. A second set of queries would have drifted.

**Income per tick is the Economy tab's own arithmetic.** Income is not
stored; it falls out of `(pool_now − pool_prev) + upkeep + spending`
over the ledger from migration 0087. `handleGetEconomy` used to own that
derivation inline; it is now `economySeries()` + `economyAverages()`, and
the watch calls the same two functions. A watch face that reimplemented
the formula would agree with the Economy tab right up until somebody
added a seventh way for money to arrive.

`null` is a real answer and the watch draws it as a dash. A faction too
young to have two ledger rows has no rate yet, and `+0` and *we don't
know* look identical at 1.4 inches while meaning opposite things.

---

## The vote, and what it cost

Migration 0134 made the widget token one narrow capability and said so
in as many words: it renders a card, it cannot read messages, it cannot
issue orders, it cannot be exchanged for a session. The worst a leak
could do was show someone your metal count.

The watch needs one thing that token must never grow. So rather than
widen what a widget token means, **migration 0136 splits the table by
intent**:

- `card` — what 0134 described, unchanged. Every token minted before the
  migration is one, which is why the default is `card` and not `NULL`.
- `wear` — render, plus read the state document, plus cast a senate vote
  on a bill that is **already open**. Nothing else.

A wear token is a **separate row, never an upgraded one**. There is no
route that raises a card token's scope, because a read-only token that
can promote itself is not read-only. The authority that grants the
higher scope is the signed-in browser session that binds the pairing
code — the same authority that minted the first token.

The vote goes through `castVoteCore`, the same function the in-game
panel and the Discord buttons call, so the window, the weight snapshot
and update-don't-duplicate are not reimplemented. The server also checks
that the proposal belongs to the game the watch is showing: the watch
would never send another game's id, which is exactly why the server has
to be the one that refuses it.

**Blast radius of a leaked wear token:** your resource counts, your live
battles, and a vote you did not intend on a bill you could already see.
Revoking it is still one row.

`npm run sim:wear` exercises all of that against the real migration
bundle and the real handlers — 23 checks, including the cross-game vote
and the card-token refusal.

---

## Pairing: the watch asks the phone

A token can only be minted by a signed-in session; the session is a
cookie in a browser; a watch has neither a browser nor a keyboard anyone
would type an email address on.

```
watch mints a code  →  RemoteActivityHelper opens
                       https://orbital-empire.com/?w=<code>&ws=wear
                       on the phone
                    →  the game's own shell binds it (public/index.html)
                    →  watch polls /widget/pair/<code> and collects
                       a wear-scoped token
```

**Why `RemoteActivityHelper` and not a Data Layer message.** The obvious
build is a `MessageClient` send to a `WearableListenerService` on the
phone, which starts the game. That service *cannot start an activity* —
it is a background process, and background activity starts have been
blocked since Android 10 — so the phone-side half has to degrade into a
notification the player then has to find and tap. `RemoteActivityHelper`
hands the intent to the system's own wearable services, which may start
it, and the phone app's `autoVerify` filter on `orbital-empire.com`
means it opens in the game rather than in a browser tab.

**One call, and not one line of new code in the phone APK.**

`?ws=` is the scope the device is asking for. A player could edit it —
and that is fine, because the only account they can escalate is the one
they are signed into. What matters is that the grant happens behind the
cookie and never on a route a bare token can reach. A pairing that comes
back as a plain card token is refused by the watch rather than stored,
because the alternative is a paired watch whose every screen 403s.

---

## Three pages, swiped

A watch interaction is about a second long. A list of destinations
spends that second choosing. So the three things worth a glance are each
one swipe from the last, in the order they matter when nothing is wrong:

1. **Empire** — metal, credits, science; each with its per-tick rate and
   the countdown to the next tick. The rate is the point: a stockpile
   answers *can I afford this*, which you ask with the game in front of
   you; a wrist asks *is it going up*.
2. **Situation** — live battles in the situation log's own grammar, then
   what is inbound.
3. **Senate** — open bills with YEA / NAY / ABS.

The countdown runs against the **server's** clock. The document carries
the server's `now`; the offset against the watch's clock is held and
applied forever after, because a watch four minutes fast would otherwise
count a tick as past while the game is still waiting for it — and the
player would believe the watch.

**Raising your wrist is the refresh.** A tick is minutes long and nobody
looks at a watch for more than a moment; a poll loop would spend battery
keeping a screen fresh that nobody is looking at.

The battles page borrows `SituationLog.tsx` wholesale — the damage-
weighted bar (fifty freighters are not a fleet), livery on the rail and
never on the hulls, the green/amber/red health ramp, and **grey where
sensors do not reach**. It does *not* draw the ships: the battle card
renders each hull as the game's own `ShipIcon`, which is right at 512px
and four grey pixels on a watch.

---

## Shipping it

Same package name, same signing key, **different version code**, and a
**different track**.

- `com.orbitalempire.game` for both — Play matches a watch artifact to
  its phone app by application id, and a different one would be a
  separate listing with its own reviews.
- The wear `versionCode` is the phone's + 1000. A watch artifact's code
  must be unique across form factors; a collision is rejected at upload
  with a message that reads like *you forgot to bump it* and in fact
  means *the other form factor has it*.
- `<uses-feature android:name="android.hardware.type.watch" />` with **no
  `required="false"`** — that attribute describes one binary for phones
  and watches, which Play does not support.
- `com.google.android.wearable.standalone = false`. Once it holds a
  token the watch needs the phone for nothing; getting the *first* token
  needs it.

**Tracks.** Since March 2023 Wear OS artifacts belong on dedicated
form-factor tracks, and since September 2023 a Wear release left on a
mobile track can still serve users but can no longer be updated. The API
names them with a prefix — `wear:qa`, `wear:beta`, `wear:production` —
and note what is *not* on that list: **there is no `wear:internal`**.
`wear:qa` is the closed-testing track that plays the role `internal`
plays for the phone.

**One console step no API call replaces:** Play Console → Test and
release → Advanced settings → Form factors → Add form factor → Wear OS.
Until that exists the upload fails with a track that cannot be found,
which is why the workflow gates it behind its own `publishWear` input
rather than running it by default.

---

## Not built yet

- **A Tile.** The single highest-value thing left: a tile is what a Wear
  player actually swipes to, without opening an app at all. Resources
  and the tick countdown would fit one.
- **A complication**, for the next-tick countdown on the watch face.
- **Rotary scrolling.** `ScalingLazyColumn` handles touch; the crown
  needs `Modifier.rotaryScrollable`, which is one line per screen.
- **Notifications on the watch.** The web push subscription is delivered
  by Chrome on the phone and bridged to the watch by the system, so a
  battle alert already reaches the wrist — but it opens the phone, not
  this app.
