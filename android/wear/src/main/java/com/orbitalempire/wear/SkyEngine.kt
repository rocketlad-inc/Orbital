package com.orbitalempire.wear

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * WHERE THE SUN, THE MOON AND THE PLANETS ARE IN YOUR SKY, computed on
 * the watch with no network: altitude above the horizon and compass
 * azimuth for any moment and place.
 *
 * THE PLANETS are JPL's "Approximate Positions of the Planets" (Standish,
 * Table 1, valid 1800-2050): Keplerian elements with linear rates, the
 * Earth-Moon barycentre standing in for Earth. THE MOON is a truncated
 * Meeus series with topocentric parallax, which matters: seen from the
 * ground it sits up to a degree lower than from Earth's centre.
 *
 * CHECKED AGAINST JPL HORIZONS before it shipped: every body at three
 * dates from Atlanta and Sydney, 54 comparisons, worst error 0.079 deg
 * (Saturn), the Moon within 0.03 deg. Positions are airless, like
 * Horizons' default; atmospheric refraction lifts a body by about half a
 * degree at the horizon, which the rise/set thresholds account for.
 */
object SkyEngine {

  private const val RAD = PI / 180.0
  private const val DEG = 180.0 / PI

  enum class Body(val label: String) {
    SUN("Sun"), MOON("Moon"), MERCURY("Mercury"), VENUS("Venus"), MARS("Mars"),
    JUPITER("Jupiter"), SATURN("Saturn"), URANUS("Uranus"), NEPTUNE("Neptune");

    val isPlanet: Boolean get() = this != SUN && this != MOON
  }

  /** The naked-eye planets, for "what's up" lists. */
  val BRIGHT_PLANETS = listOf(Body.MERCURY, Body.VENUS, Body.MARS, Body.JUPITER, Body.SATURN)

  data class Position(val alt: Double, val az: Double)

  data class MoonPhase(val fraction: Double, val waxing: Boolean) {
    /** A short name for the phase, as a complication title can carry. */
    val name: String
      get() = when {
        fraction < 0.03 -> "NEW"
        fraction > 0.97 -> "FULL"
        abs(fraction - 0.5) < 0.04 -> if (waxing) "1ST QTR" else "3RD QTR"
        fraction < 0.5 -> if (waxing) "WAX CRES" else "WAN CRES"
        else -> if (waxing) "WAX GIB" else "WAN GIB"
      }
  }

  // a, e, I, L, longPeri, longNode, then their rates per Julian century.
  private val ELEMENTS: Map<Body?, DoubleArray> = mapOf(
    Body.MERCURY to doubleArrayOf(0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593,
      0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081),
    Body.VENUS to doubleArrayOf(0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255,
      0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418),
    null to doubleArrayOf(1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0,
      0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0),
    Body.MARS to doubleArrayOf(1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
      0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343),
    Body.JUPITER to doubleArrayOf(5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
      -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106),
    Body.SATURN to doubleArrayOf(9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448,
      -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794),
    Body.URANUS to doubleArrayOf(19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503,
      -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589),
    Body.NEPTUNE to doubleArrayOf(30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574,
      0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664),
  )

  fun norm360(x: Double): Double = ((x % 360.0) + 360.0) % 360.0

  private fun jd(ms: Long): Double = ms / 86400000.0 + 2440587.5
  fun centuries(ms: Long): Double = (jd(ms) - 2451545.0) / 36525.0

  /** Heliocentric ecliptic J2000 position in au; `null` is the Earth. */
  private fun helio(body: Body?, t: Double): DoubleArray {
    val el = ELEMENTS.getValue(body)
    val a = el[0] + el[6] * t
    val e = el[1] + el[7] * t
    val inc = (el[2] + el[8] * t) * RAD
    val l = el[3] + el[9] * t
    val peri = el[4] + el[10] * t
    val node = el[5] + el[11] * t
    val w = (peri - node) * RAD
    val o = node * RAD
    var m = norm360(l - peri)
    if (m > 180) m -= 360
    m *= RAD
    var ea = m + e * sin(m)
    for (i in 0 until 12) {
      val d = (ea - e * sin(ea) - m) / (1 - e * cos(ea))
      ea -= d
      if (abs(d) < 1e-10) break
    }
    val xp = a * (cos(ea) - e)
    val yp = a * sqrt(1 - e * e) * sin(ea)
    val cw = cos(w); val sw = sin(w); val co = cos(o); val so = sin(o); val ci = cos(inc); val si = sin(inc)
    return doubleArrayOf(
      (cw * co - sw * so * ci) * xp + (-sw * co - cw * so * ci) * yp,
      (cw * so + sw * co * ci) * xp + (-sw * so + cw * co * ci) * yp,
      (sw * si) * xp + (cw * si) * yp,
    )
  }

  private class Ecl(val lon: Double, val lat: Double, val dist: Double)

  /** Geocentric ecliptic of date (distance in au) for a planet or the Sun. */
  private fun planetEcl(body: Body, t: Double): Ecl {
    val earth = helio(null, t)
    val v = if (body == Body.SUN) {
      doubleArrayOf(-earth[0], -earth[1], -earth[2])
    } else {
      val p = helio(body, t)
      doubleArrayOf(p[0] - earth[0], p[1] - earth[1], p[2] - earth[2])
    }
    val dist = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    // J2000 to date: general precession in longitude.
    val lon = norm360(atan2(v[1], v[0]) * DEG + 1.3969713 * t)
    return Ecl(lon, asin(v[2] / dist) * DEG, dist)
  }

  /** The Moon's ecliptic of date; distance in km. */
  private fun moonEcl(t: Double): Ecl {
    val lp = 218.3164477 + 481267.88123421 * t
    val d = (297.8501921 + 445267.1114034 * t) * RAD
    val m = (357.5291092 + 35999.0502909 * t) * RAD
    val mp = (134.9633964 + 477198.8675055 * t) * RAD
    val f = (93.2720950 + 483202.0175233 * t) * RAD
    val lon = lp +
      6.288774 * sin(mp) + 1.274027 * sin(2 * d - mp) + 0.658314 * sin(2 * d) +
      0.213618 * sin(2 * mp) - 0.185116 * sin(m) - 0.114332 * sin(2 * f) +
      0.058793 * sin(2 * d - 2 * mp) + 0.057066 * sin(2 * d - m - mp) +
      0.053322 * sin(2 * d + mp) + 0.045758 * sin(2 * d - m) -
      0.040923 * sin(m - mp) - 0.034720 * sin(d) - 0.030383 * sin(m + mp) +
      0.015327 * sin(2 * d - 2 * f) - 0.012528 * sin(mp + 2 * f) + 0.010980 * sin(mp - 2 * f) +
      0.010675 * sin(4 * d - mp) + 0.010034 * sin(3 * mp) + 0.008548 * sin(4 * d - 2 * mp)
    val lat = 5.128122 * sin(f) + 0.280602 * sin(mp + f) + 0.277693 * sin(mp - f) +
      0.173237 * sin(2 * d - f) + 0.055413 * sin(2 * d - mp + f) + 0.046271 * sin(2 * d - mp - f) +
      0.032573 * sin(2 * d + f) + 0.017198 * sin(2 * mp + f)
    val distKm = 385000.56 - 20905.355 * cos(mp) - 3699.111 * cos(2 * d - mp) -
      2955.968 * cos(2 * d) - 569.925 * cos(2 * mp) + 48.888 * cos(m) - 3.149 * cos(2 * f) +
      246.158 * cos(2 * d - 2 * mp) - 152.138 * cos(2 * d - m - mp) - 170.733 * cos(2 * d + mp)
    return Ecl(norm360(lon), lat, distKm)
  }

  /** Ecliptic of date to right ascension / declination, in degrees. */
  fun eclToEq(lon: Double, lat: Double, t: Double): DoubleArray {
    val eps = (23.439291 - 0.0130042 * t) * RAD
    val l = lon * RAD; val b = lat * RAD
    val x = cos(b) * cos(l)
    val y = cos(b) * sin(l) * cos(eps) - sin(b) * sin(eps)
    val z = cos(b) * sin(l) * sin(eps) + sin(b) * cos(eps)
    return doubleArrayOf(norm360(atan2(y, x) * DEG), asin(z) * DEG)
  }

  private fun gmst(ms: Long): Double {
    val d = jd(ms) - 2451545.0
    val t = d / 36525.0
    return norm360(280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - t * t * t / 38710000.0)
  }

  /** RA/Dec (degrees) to altitude/azimuth (azimuth from north through east). */
  fun altAz(ra: Double, dec: Double, ms: Long, lat: Double, lon: Double): Position {
    val h = (gmst(ms) + lon - ra) * RAD
    val phi = lat * RAD; val d = dec * RAD
    val alt = asin(sin(phi) * sin(d) + cos(phi) * cos(d) * cos(h))
    val az = atan2(-cos(d) * sin(h), sin(d) * cos(phi) - cos(d) * sin(phi) * cos(h))
    return Position(alt * DEG, norm360(az * DEG))
  }

  /** Where [body] stands in the sky of an observer at lat/lon. */
  fun position(body: Body, ms: Long, lat: Double, lon: Double): Position {
    val t = centuries(ms)
    if (body == Body.MOON) {
      val m = moonEcl(t)
      val eq = eclToEq(m.lon, m.lat, t)
      val h = altAz(eq[0], eq[1], ms, lat, lon)
      val par = asin(6378.14 / m.dist) * DEG
      return Position(h.alt - par * cos(h.alt * RAD), h.az)
    }
    val p = planetEcl(body, t)
    val eq = eclToEq(p.lon, p.lat, t)
    return altAz(eq[0], eq[1], ms, lat, lon)
  }

  fun moonPhase(ms: Long): MoonPhase {
    val t = centuries(ms)
    val m = moonEcl(t)
    val sun = planetEcl(Body.SUN, t)
    val elong = norm360(m.lon - sun.lon)
    val psi = kotlin.math.acos(cos(m.lat * RAD) * cos((m.lon - sun.lon) * RAD))
    val au = 149597870.7
    val i = atan2(sun.dist * au * sin(psi), m.dist - sun.dist * au * cos(psi))
    return MoonPhase((1 + cos(i)) / 2, elong < 180)
  }

  /** Altitude a body's centre has at rising/setting, refraction included. */
  fun horizonFor(body: Body): Double = when (body) {
    Body.SUN -> -0.833
    Body.MOON -> 0.125
    else -> -0.5667
  }

  /**
   * The next moment after [from] that [body] crosses [h0] degrees going
   * up ([rising]) or down, within [hours]; null if it doesn't (the
   * midnight sun, or a planet that stays up).
   */
  fun nextCrossing(
    body: Body, from: Long, lat: Double, lon: Double,
    h0: Double, rising: Boolean, hours: Int = 36,
  ): Long? {
    val step = 10 * 60_000L
    var t0 = from
    var a0 = position(body, t0, lat, lon).alt - h0
    var t = from + step
    while (t <= from + hours * 3_600_000L) {
      val a1 = position(body, t, lat, lon).alt - h0
      if ((rising && a0 < 0 && a1 >= 0) || (!rising && a0 > 0 && a1 <= 0)) {
        var lo = t0; var hi = t
        repeat(20) {
          val mid = (lo + hi) / 2
          val am = position(body, mid, lat, lon).alt - h0
          if ((am < 0) == rising) lo = mid else hi = mid
        }
        return (lo + hi) / 2
      }
      t0 = t; a0 = a1; t += step
    }
    return null
  }
}
