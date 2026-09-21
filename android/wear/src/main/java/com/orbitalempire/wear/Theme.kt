package com.orbitalempire.wear

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.wear.compose.material.Colors
import androidx.wear.compose.material.MaterialTheme

/**
 * The game's palette, not a watch palette.
 *
 * THESE ARE THE WIDGET CARD'S OWN CONSTANTS, to the byte: INK, DIM,
 * ALARM, WARN, GOOD and GROUND out of worker/heraldPng.js's callers. A
 * player who has the home-screen card and the watch is looking at one
 * game, and a slightly different red on the wrist is the kind of thing
 * that reads as two products rather than two surfaces.
 *
 * WEAR OS WANTS BLACK, AND GETS IT. On an OLED watch a true black pixel
 * is an unlit pixel, which is battery and which is why every Wear design
 * guide asks for it. GROUND is 080C13 rather than 000000 because the
 * game's own background is, and the difference is a few microamps
 * against a surface that stops looking like Orbital.
 */
val Ink = Color(0xFFE2ECF5)
val Dim = Color(0xFF7D92A6)
val Alarm = Color(0xFFFF6A60)
val Warn = Color(0xFFFFCA48)
val Good = Color(0xFF7FFFA1)
val Ground = Color(0xFF080C13)
val Trough = Color(0xFF16202C)

/** Metal, credits and science, in the order EconomyPanel lists them and
 *  with the colours the web client uses for each pill. */
val MetalInk = Color(0xFFB8C6D4)
val CreditInk = Color(0xFFFFCA48)
val ScienceInk = Color(0xFF6FD3FF)

private val OrbitalColors = Colors(
  primary = Color(0xFF4ECDC4),
  primaryVariant = Color(0xFF2E8B85),
  secondary = Warn,
  secondaryVariant = Color(0xFFB88A2E),
  background = Ground,
  surface = Trough,
  error = Alarm,
  onPrimary = Ground,
  onSecondary = Ground,
  onBackground = Ink,
  onSurface = Ink,
  onSurfaceVariant = Dim,
  onError = Ground,
)

@Composable
fun OrbitalWearTheme(content: @Composable () -> Unit) {
  MaterialTheme(colors = OrbitalColors, content = content)
}

/**
 * A faction's own colour, or the default teal if the server sent
 * something unparseable.
 *
 * EMPIRE IDENTITY IS THE ONE THING THAT MUST NOT DRIFT, which is the
 * rule the battle card states and the reason this never falls back to a
 * theme colour: two factions rendering as the same teal because both
 * their hex strings had a stray space is worse than one of them being
 * obviously wrong.
 */
fun factionColor(hex: String): Color = try {
  val h = hex.trim().removePrefix("#")
  when (h.length) {
    6 -> Color("FF$h".toLong(16).toInt())
    8 -> Color(h.toLong(16).toInt())
    else -> Color(0xFF4ECDC4)
  }
} catch (t: Throwable) {
  Color(0xFF4ECDC4)
}

/**
 * The health ramp, shared with the situation log, the outliner and the
 * battle card: green down through amber to red, and GREY FOR UNKNOWN.
 * A colour means one thing everywhere in this game, and "I cannot see
 * how hurt that ship is" is not a shade of red.
 */
fun healthColor(hp: Double?): Color = when {
  hp == null -> Dim
  hp >= 66 -> Good
  hp >= 33 -> Warn
  else -> Alarm
}
