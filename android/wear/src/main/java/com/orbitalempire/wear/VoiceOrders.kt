package com.orbitalempire.wear

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.wear.compose.material.Text

/**
 * VOICE ORDERS. "Send Vanguard to Oberon": heard by the watch's own speech
 * input, matched HERE against your own fleets (their names, their
 * captains, their hull classes) and the worlds you know, shown back, and
 * only sent when you hold SEND. Nothing is sent on a guess; a phrase that
 * does not name one of your fleets and one world asks you to say it again.
 */
object VoiceParse {
  data class Heard(val group: FleetGroup?, val place: Place?, val retreat: Boolean)

  private val FILLER = setOf("the", "a", "an", "my", "fleet", "ship", "ships", "please", "now", "to", "towards", "toward", "at", "go", "send", "move", "take", "fly", "jump", "head", "retreat", "withdraw", "pull", "back", "out", "of", "from", "and")

  fun parse(text: String, cmd: Command?, worlds: Worlds?): Heard {
    val t = text.lowercase().replace(Regex("[^a-z0-9' ]"), " ").replace(Regex("\\s+"), " ").trim()
    val retreat = Regex("\\b(retreat|withdraw|pull back|pull out|fall back)\\b").containsMatchIn(t)
    // "send X to Y" splits on the last " to "; without one, the whole
    // phrase is searched for both.
    val cut = t.lastIndexOf(" to ")
    val who = if (cut > 0) t.substring(0, cut) else t
    val where = if (cut > 0) t.substring(cut + 4) else t
    val groups = cmd?.let { groupsOf(it) } ?: emptyList()
    val group = groups.maxByOrNull { g -> scoreGroup(g, who) }?.takeIf { scoreGroup(it, who) >= 0.6 }
    val places = allPlaces(worlds)
    val place = if (retreat) null else places.maxByOrNull { p -> score(p.name, where) }?.takeIf { score(it.name, where) >= 0.6 }
    return Heard(group, place, retreat)
  }

  private fun scoreGroup(g: FleetGroup, said: String): Double {
    val names = g.ships.map { it.name } + listOfNotNull(g.captain?.name) + g.ships.map { it.cls.replace('_', ' ') }
    return names.maxOf { score(it, said) }
  }

  /**
   * How well [name] is said in [said], 0..1: the best run of its words
   * found among the spoken words, each word matched loosely (speech
   * recognisers spell names their own way -- "Oberon" as "oberin").
   */
  fun score(name: String, said: String): Double {
    val want = name.lowercase().replace(Regex("[^a-z0-9 ]"), " ").split(' ').filter { it.isNotBlank() && it !in FILLER }
    val got = said.split(' ').filter { it.isNotBlank() && it !in FILLER }
    if (want.isEmpty() || got.isEmpty()) return 0.0
    var total = 0.0
    for (w in want) total += got.maxOf { similar(w, it) }
    return total / want.size
  }

  private fun similar(a: String, b: String): Double {
    if (a == b) return 1.0
    if (a.length >= 4 && (b.startsWith(a) || a.startsWith(b)) && minOf(a.length, b.length) >= 4) return 0.9
    val d = lev(a, b)
    return (1.0 - d.toDouble() / maxOf(a.length, b.length)).coerceAtLeast(0.0)
  }

  private fun lev(a: String, b: String): Int {
    val prev = IntArray(b.length + 1) { it }
    val cur = IntArray(b.length + 1)
    for (i in 1..a.length) {
      cur[0] = i
      for (j in 1..b.length) {
        cur[j] = minOf(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + if (a[i - 1] == b[j - 1]) 0 else 1)
      }
      System.arraycopy(cur, 0, prev, 0, cur.size)
    }
    return prev[b.length]
  }
}

/**
 * The voice sheet: asks for speech straight away, then shows what it
 * understood -- the fleet and the world, or the fleet and RETREAT -- with
 * a held button to give the order.
 */
@Composable
fun VoiceOrderSheet(ui: WearViewModel.UiState, vm: WearViewModel, onClose: () -> Unit) {
  var heard by remember { mutableStateOf<String?>(null) }
  var asks by remember { mutableIntStateOf(0) }
  val listen = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
    val text = if (r.resultCode == Activity.RESULT_OK) r.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull() else null
    if (text.isNullOrBlank()) {
      if (heard == null) onClose()
    } else {
      heard = text
    }
  }
  LaunchedEffect(asks) {
    try {
      listen.launch(
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
          .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
          .putExtra(RecognizerIntent.EXTRA_PROMPT, "Send Vanguard to Oberon"),
      )
    } catch (_: Throwable) {
      heard = ""
    }
  }
  val said = heard ?: run {
    BackHandler(onBack = onClose)
    Box(Modifier.fillMaxSize()) {
      StarfieldBackground(dim = 0.3f)
      Frame(top = "SPEAK AN ORDER", topInk = Color(0xFFCFF5F1)) { s ->
        Text("LISTENING…", color = Teal, fontSize = tp(s, 18f), fontFamily = GameFont, modifier = Modifier.align(Alignment.Center))
      }
    }
    return
  }
  val parsed = remember(said, ui.command, ui.worlds) { VoiceParse.parse(said, ui.command, ui.worlds) }
  val g = parsed.group
  val p = parsed.place
  if (g != null && p != null) {
    SendConfirm(ui, vm, g, p, heard = said, onDone = onClose, onBack = onClose, onAgain = { heard = null; asks++ })
    return
  }
  BackHandler(onBack = onClose)
  Box(Modifier.fillMaxSize()) {
    StarfieldBackground(dim = 0.3f)
    Frame(top = "SPEAK AN ORDER", topInk = Color(0xFFCFF5F1)) { s ->
      Column(Modifier.align(Alignment.Center).width(u(s, 300f)), horizontalAlignment = Alignment.CenterHorizontally) {
        if (said.isNotEmpty()) {
          Text("“$said”", color = Ink, fontSize = tp(s, 16f), fontStyle = FontStyle.Italic, textAlign = TextAlign.Center, maxLines = 3)
        }
        if (g != null && parsed.retreat) {
          Text("RETREAT ${g.title}", color = Warn, fontSize = tp(s, 16f), fontFamily = GameFont, textAlign = TextAlign.Center, modifier = Modifier.padding(top = u(s, 8f)))
          OrderStatus(ui)
          HoldButton("RETREAT", Warn, Modifier.width(u(s, 220f)).padding(top = u(s, 8f)), filled = true, height = u(s, 50f), enabled = ui.command?.orders == true && !ui.ordering) {
            vm.order(Orders.order("retreat") { put("ship_ids", Orders.ids(g.ids)) }, "Retreating")
            onClose()
          }
        } else {
          Text(
            when {
              said.isEmpty() -> "This watch has no speech input"
              g == null -> "Didn't catch which fleet"
              else -> "Didn't catch where to"
            },
            color = Warn, fontSize = tp(s, 14f), fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, modifier = Modifier.padding(top = u(s, 8f)),
          )
          Text("Say a fleet, a captain or a hull, then a world: “send Vanguard to Oberon”.", color = Sub, fontSize = tp(s, 11f), textAlign = TextAlign.Center)
        }
        if (said.isNotEmpty()) {
          Text(
            "SAY IT AGAIN", color = Sub, fontSize = tp(s, 13f), fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(top = u(s, 12f)).clickable { heard = null; asks++ },
          )
        }
      }
    }
  }
}
