package com.orbitalempire.wear

import org.json.JSONArray
import org.json.JSONObject

/**
 * The shape of /wear/<token>/state.json, and the only place that knows
 * it.
 *
 * PARSED BY HAND WITH org.json, WHICH IS ON THE DEVICE. A JSON library
 * would be a dependency, a code-generation step and a proguard rule, to
 * read one document with fourteen fields in it. The phone app's widget
 * reads its pairing response the same way for the same reason.
 *
 * EVERY FIELD HAS A DEFAULT AND NOTHING THROWS. A watch is the worst
 * place in the product to surface a parse error: the screen is too
 * small to say anything useful and the player cannot do anything about
 * it. The server is ours and a new field is additive, so the failure
 * this guards against is not a malicious document but an old watch
 * meeting a newer server -- in which case the right behaviour is to
 * draw what it understands.
 */
data class WearState(
  /** 'live' | 'eliminated' | 'ended' | 'none'. */
  val phase: String = "none",
  val game: String = "",
  val faction: String = "",
  val color: String = "#4ecdc4",
  val tick: Int = 0,
  val nextTickAt: Long = 0L,
  /** The SERVER's clock at the moment this was rendered. The countdown
   *  is computed against the offset between this and the watch's own
   *  clock, because a watch that is four minutes fast would otherwise
   *  show a tick that already happened as still to come. */
  val serverNow: Long = 0L,
  val metal: Long = 0,
  val credits: Long = 0,
  val science: Long = 0,
  val perTick: PerTick = PerTick(),
  val attention: Attention = Attention(),
  val battles: List<Battle> = emptyList(),
  val threats: List<Threat> = emptyList(),
  val senate: List<Bill> = emptyList(),
  /** Your active hulls, for the ship complication. Null from an older server. */
  val ships: Int? = null,
  /** Hulls on the ways right now (uncancelled build orders). */
  val building: Int? = null,
  /** Your hulls IN the fighting -- ships, not battles. */
  val inCombat: Int? = null,
  /** The project the science is going into, and how far in. */
  val research: Research? = null,
  /** Worlds owned / total, and `need`: the smallest count that wins. */
  val domination: Domination? = null,
  /** The situation log's own dock badge, as the open game last reported it. */
  val situation: SituationBadge? = null,
) {
  val isLive: Boolean get() = phase == "live"
}

data class Domination(val owned: Int, val total: Int, val need: Int)

/** The current research: [level] is the level being bought, and
 *  [progress] of [cost] is the science into it so far. */
data class Research(val tech: String, val name: String, val level: Int, val progress: Int, val cost: Int) {
  val fraction: Float get() = if (cost > 0) (progress.toFloat() / cost).coerceIn(0f, 1f) else 0f
}

/** [at] is when the game reported it: the count is exact, and can be old. */
data class SituationBadge(val count: Int, val now: Boolean, val at: Long)

/**
 * Income per tick, averaged server-side.
 *
 * NULLABLE, AND THE SCREEN DRAWS THE NULL. A faction too young to have
 * two ledger rows has no rate yet, and "+0" and "we don't know" look
 * identical at this size while meaning opposite things.
 */
data class PerTick(
  val metal: Double? = null,
  val credits: Double? = null,
  val science: Double? = null,
  val netMetal: Double? = null,
  val netCredits: Double? = null,
  val samples: Int = 0,
)

data class Attention(
  val fighting: Int = 0,
  val inbound: Int = 0,
  val bills: Int = 0,
  val unread: Int = 0,
  val offers: Int = 0,
)

/** One live fight, in the situation log's own grammar: the sides, each
 *  with its livery, its hull count and what it is dealing. */
data class Battle(
  val body: String,
  /** The world's id, so a battle alert can open its Porthole. */
  val bodyId: String? = null,
  val sides: List<Side>,
  val kills: Int,
  val lost: Int,
  /** False when sensors do not cover this body. The bar still draws --
   *  a ship shooting at you is not a secret -- but the hull health is
   *  withheld, exactly as the situation log and the battle card do. */
  val known: Boolean,
)

data class Side(
  val name: String,
  val color: String,
  val mine: Boolean,
  val alive: Int,
  val damage: Int,
  /** Per-hull health 0..100, or null where it is not ours to know. */
  val hulls: List<Double?>,
)

data class Threat(val body: String, val ships: Int, val eta: Int?)

data class Bill(
  val id: String,
  val kind: String,
  val title: String,
  val summary: String,
  val closesIn: Int,
  /** 'yea' | 'nay' | 'abstain', or null if this faction has not voted. */
  val myVote: String?,
  val yea: Int,
  val nay: Int,
  /** Ticks until voting opens; 0 once it is open. Above zero the bill
   *  is in debate: shown, but with no vote buttons, because the vote
   *  route refuses it until then. */
  val opensIn: Int = 0,
) {
  val debating: Boolean get() = opensIn > 0
}

fun parseWearState(raw: String): WearState {
  val o = JSONObject(raw)
  val res = o.optJSONObject("resources")
  val pt = o.optJSONObject("perTick")
  val at = o.optJSONObject("attention")
  return WearState(
    phase = o.optString("state", "none"),
    game = o.optString("game", ""),
    faction = o.optString("faction", ""),
    color = o.optString("color", "#4ecdc4"),
    tick = o.optInt("tick", 0),
    nextTickAt = o.optLong("nextTickAt", 0L),
    serverNow = o.optLong("now", 0L),
    metal = res?.optLong("metal", 0L) ?: 0L,
    credits = res?.optLong("credits", 0L) ?: 0L,
    science = res?.optLong("science", 0L) ?: 0L,
    perTick = PerTick(
      metal = pt?.optDoubleOrNull("metal"),
      credits = pt?.optDoubleOrNull("gold"),
      science = pt?.optDoubleOrNull("science"),
      netMetal = pt?.optDoubleOrNull("netMetal"),
      netCredits = pt?.optDoubleOrNull("netGold"),
      samples = pt?.optInt("samples", 0) ?: 0,
    ),
    attention = Attention(
      fighting = at?.optInt("fighting", 0) ?: 0,
      inbound = at?.optInt("inbound", 0) ?: 0,
      bills = at?.optInt("bills", 0) ?: 0,
      unread = at?.optInt("unread", 0) ?: 0,
      offers = at?.optInt("offers", 0) ?: 0,
    ),
    battles = o.optJSONArray("battles").map { b ->
      Battle(
        body = b.optString("body", "?"),
        bodyId = if (b.isNull("bodyId")) null else b.optString("bodyId", "").ifEmpty { null },
        kills = b.optInt("kills", 0),
        lost = b.optInt("lost", 0),
        known = b.optBoolean("known", false),
        sides = b.optJSONArray("sides").map { s ->
          Side(
            name = s.optString("name", "?"),
            color = s.optString("color", "#7d92a6"),
            mine = s.optBoolean("mine", false),
            alive = s.optInt("alive", 0),
            damage = s.optInt("damage", 0),
            hulls = s.optJSONArray("hulls").map { h -> h.optDoubleOrNull("hp") },
          )
        },
      )
    },
    threats = o.optJSONArray("threats").map { t ->
      Threat(
        body = t.optString("body", "?"),
        ships = t.optInt("ships", 0),
        eta = if (t.isNull("eta")) null else t.optInt("eta", 0),
      )
    },
    senate = o.optJSONArray("senate").map { parseBill(it) },
    ships = if (o.has("ships") && !o.isNull("ships")) o.optInt("ships", 0) else null,
    building = if (o.has("building") && !o.isNull("building")) o.optInt("building", 0) else null,
    inCombat = if (o.has("inCombat") && !o.isNull("inCombat")) o.optInt("inCombat", 0) else null,
    research = o.optJSONObject("research")?.let { r ->
      Research(
        tech = r.optString("tech"),
        name = r.optString("name", r.optString("tech")),
        level = r.optInt("level", 1),
        progress = r.optInt("progress", 0),
        cost = r.optInt("cost", 0),
      )
    },
    domination = o.optJSONObject("domination")?.let { d ->
      Domination(d.optInt("owned", 0), d.optInt("total", 0), d.optInt("need", 1))
    },
    situation = o.optJSONObject("situation")?.let { b ->
      SituationBadge(b.optInt("count", 0), b.optBoolean("now", false), b.optLong("at", 0L))
    },
  )
}

fun parseBill(b: JSONObject): Bill = Bill(
  id = b.optString("id", ""),
  kind = b.optString("kind", ""),
  title = b.optString("title", ""),
  summary = b.optString("summary", ""),
  closesIn = b.optInt("closesIn", 0),
  myVote = if (b.isNull("myVote")) null else b.optString("myVote", "").ifEmpty { null },
  yea = b.optInt("yea", 0),
  nay = b.optInt("nay", 0),
  opensIn = b.optInt("opensIn", 0),
)

/** optDouble returns NaN for a missing key and 0.0 for an explicit
 *  null, and the difference between those two and a real zero is the
 *  whole point of the nullable rates. */
private fun JSONObject.optDoubleOrNull(key: String): Double? {
  if (!has(key) || isNull(key)) return null
  val d = optDouble(key, Double.NaN)
  return if (d.isNaN()) null else d
}

private inline fun <T> JSONArray?.map(f: (JSONObject) -> T): List<T> {
  if (this == null) return emptyList()
  val out = ArrayList<T>(length())
  for (i in 0 until length()) {
    val o = optJSONObject(i) ?: continue
    out.add(f(o))
  }
  return out
}
