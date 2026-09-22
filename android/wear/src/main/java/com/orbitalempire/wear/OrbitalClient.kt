package com.orbitalempire.wear

import android.content.Context
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom

/**
 * Everything the watch does over the network, and the one secret it
 * keeps.
 *
 * HttpURLConnection AND NOT A CLIENT LIBRARY, for the same reason the
 * widget uses it: this makes three kinds of request in total, all of
 * them small, and a watch pays for every kilobyte of APK in install
 * size on a device with very little of it.
 *
 * THE TOKEN IS THE ONLY THING STORED. It is a capability, not a
 * session: it renders this player's cards, reads this state document
 * and casts a senate vote on a bill already open (migrations 0134,
 * 0136). It cannot be exchanged for a login, which is exactly why it is
 * the thing that lives on a device that has no lock screen worth the
 * name.
 */
object OrbitalClient {

  private const val TAG = "OrbitalWear"
  const val BASE = "https://orbital-empire.com"
  private const val PREFS = "orbital_wear"
  private const val KEY_TOKEN = "token"
  private const val KEY_CODE = "pairing_code"
  private const val KEY_CODE_SINCE = "pairing_since"

  /** The server drops an unclaimed pairing after ten minutes, so a code
   *  older than that is not worth polling for and a fresh one is minted
   *  instead. Matches PAIR_TTL_MS in worker/widget.js. */
  private const val CODE_TTL_MS = 10L * 60L * 1000L

  private const val TIMEOUT_MS = 12_000

  private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun token(c: Context): String? = prefs(c).getString(KEY_TOKEN, null)

  fun hasToken(c: Context): Boolean = token(c) != null

  fun forget(c: Context) {
    prefs(c).edit().clear().apply()
  }

  /**
   * This watch's pairing code, minting one if there is none or the last
   * has gone stale.
   *
   * 24 RANDOM BYTES, URL-SAFE, GENERATED HERE. The code is the only
   * secret in the pairing and it never leaves the watch except inside
   * the URL the watch itself asks the phone to open. Whoever holds it
   * can claim the token it becomes -- once -- which is why it is long
   * enough not to be guessed and short-lived enough not to be worth
   * keeping.
   */
  fun pairingCode(c: Context): String {
    val p = prefs(c)
    val have = p.getString(KEY_CODE, null)
    val since = p.getLong(KEY_CODE_SINCE, 0L)
    if (have != null && System.currentTimeMillis() - since < CODE_TTL_MS) return have
    val raw = ByteArray(24)
    SecureRandom().nextBytes(raw)
    val code = Base64.encodeToString(raw, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    p.edit()
      .putString(KEY_CODE, code)
      .putLong(KEY_CODE_SINCE, System.currentTimeMillis())
      .apply()
    return code
  }

  /**
   * The URL the phone is asked to open.
   *
   * IT IS THE GAME ITSELF, not a connect page: the web shell binds the
   * code from its own head while it loads (see public/index.html), so
   * the player's phone shows the game rather than an interstitial. `ws`
   * is what this device is asking to be allowed to do -- 'wear' being
   * the card's capability plus a senate vote -- and the grant happens
   * behind the session cookie on the other side.
   */
  fun handoffUrl(c: Context): String = "$BASE/?w=${pairingCode(c)}&ws=wear"

  /**
   * Ask the server whether the phone has bound our code yet.
   *
   * ONE-SHOT ON THE SERVER: the first successful claim marks the
   * pairing used, so a successful poll must persist what it got or the
   * token is gone for good. Hence the store happening here rather than
   * at the call site.
   */
  suspend fun claimPairing(c: Context): Boolean = withContext(Dispatchers.IO) {
    val code = prefs(c).getString(KEY_CODE, null) ?: return@withContext false
    try {
      val body = get("$BASE/widget/pair/$code") ?: return@withContext false
      val o = JSONObject(body)
      if (!o.optBoolean("ok", false)) return@withContext false
      val token = o.optString("token", "")
      if (!token.matches(Regex("[A-Za-z0-9_-]{8,64}"))) return@withContext false
      // A DOWNGRADED SCOPE IS NOT A PAIRING. If the browser bound the
      // code as a plain card token -- an old build of the web shell,
      // say, that does not know about ?ws= -- then every watch route
      // will answer 403 and the player would see a paired watch that
      // shows nothing. Refusing here keeps them on the connect screen,
      // which is at least a screen with an instruction on it.
      if (o.optString("scope", "card") != "wear") {
        Log.w(TAG, "pairing came back as a card token; not a watch pairing")
        return@withContext false
      }
      prefs(c).edit()
        .putString(KEY_TOKEN, token)
        .remove(KEY_CODE).remove(KEY_CODE_SINCE)
        .apply()
      true
    } catch (t: Throwable) {
      Log.w(TAG, "pairing poll failed", t)
      false
    }
  }

  /** Result of a state fetch: the document, or why there isn't one. */
  sealed class Fetch {
    data class Ok(val state: WearState) : Fetch()
    /** The token is gone, revoked, or not a watch token. The caller
     *  drops it and goes back to pairing: there is nothing a retry can
     *  do, and retrying forever is how a watch flattens its battery. */
    object Unpaired : Fetch()
    data class Failed(val message: String) : Fetch()
  }

  @Volatile private var last: WearState? = null
  @Volatile private var lastAt = 0L

  /**
   * The state, from the last fetch if it is fresh enough, else a new one.
   *
   * FOR THE COMPLICATIONS: a face can carry several of them, and the
   * system asks each one separately -- often straight after the app or a
   * tile has just fetched and pushed an update. Without this, a face with
   * six Orbital complications cost six identical requests.
   */
  suspend fun stateFresh(c: Context, maxAgeMs: Long = 60_000L): WearState? {
    val have = last
    if (have != null && System.currentTimeMillis() - lastAt < maxAgeMs) return have
    return (state(c) as? Fetch.Ok)?.state ?: last
  }

  suspend fun state(c: Context): Fetch = withContext(Dispatchers.IO) {
    val token = token(c) ?: return@withContext Fetch.Unpaired
    try {
      val conn = open("$BASE/wear/$token/state.json")
      try {
        when (val code = conn.responseCode) {
          200 -> Fetch.Ok(parseWearState(conn.inputStream.bufferedReader().use(BufferedReader::readText)))
            .also { last = it.state; lastAt = System.currentTimeMillis() }
          403, 404 -> {
            forget(c)
            Fetch.Unpaired
          }
          else -> Fetch.Failed("Server said $code")
        }
      } finally {
        conn.disconnect()
      }
    } catch (t: Throwable) {
      Log.w(TAG, "state fetch failed", t)
      Fetch.Failed("No connection")
    }
  }

  /** Result of a vote: the redrawn bill, or a reason to show. */
  /**
   * Every system and every orbit you are in, for the Systems page and the
   * Porthole. Null on any failure: the page keeps what it last drew, and
   * the state fetch (which runs on the same token) is what decides
   * whether the watch is still paired.
   */
  suspend fun worlds(c: Context): Worlds? = withContext(Dispatchers.IO) {
    val token = token(c) ?: return@withContext null
    try {
      val conn = open("$BASE/wear/$token/worlds.json")
      try {
        if (conn.responseCode != 200) null
        else parseWorlds(conn.inputStream.bufferedReader().use(BufferedReader::readText))
      } finally {
        conn.disconnect()
      }
    } catch (t: Throwable) {
      Log.w(TAG, "worlds fetch failed", t)
      null
    }
  }

  sealed class Voted {
    data class Ok(val bill: Bill?) : Voted()
    data class Failed(val message: String) : Voted()
  }

  /**
   * Cast a vote.
   *
   * THE SERVER DECIDES WHETHER IT COUNTS. The watch knows the bill's
   * window from a document that is up to a minute old, so a vote can
   * land after the window shuts however carefully the UI is written --
   * which is why the refusal comes back as a message to show rather
   * than something to assert cannot happen.
   */
  suspend fun vote(c: Context, proposalId: String, choice: String): Voted = withContext(Dispatchers.IO) {
    val token = token(c) ?: return@withContext Voted.Failed("Not connected")
    try {
      val conn = open("$BASE/wear/$token/vote")
      conn.requestMethod = "POST"
      conn.doOutput = true
      conn.setRequestProperty("content-type", "application/json")
      val payload = JSONObject()
        .put("proposalId", proposalId)
        .put("vote", choice)
        .toString()
      conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
      try {
        if (conn.responseCode == 200) {
          val o = JSONObject(conn.inputStream.bufferedReader().use(BufferedReader::readText))
          val bill = o.optJSONObject("bill")
          Voted.Ok(if (bill == null) null else parseBill(bill))
        } else {
          // The server's own message, not a generic one: "this proposal
          // is not in its voting window" is the difference between a
          // player thinking the watch is broken and knowing they were
          // a minute late.
          val text = conn.errorStream?.bufferedReader()?.use(BufferedReader::readText)
          Voted.Failed(messageFrom(text) ?: "Vote refused")
        }
      } finally {
        conn.disconnect()
      }
    } catch (t: Throwable) {
      Log.w(TAG, "vote failed", t)
      Voted.Failed("No connection")
    }
  }

  private fun messageFrom(body: String?): String? = try {
    body?.let { JSONObject(it).optJSONObject("error")?.optString("message") }?.ifEmpty { null }
  } catch (t: Throwable) {
    null
  }

  private fun open(url: String): HttpURLConnection =
    (URL(url).openConnection() as HttpURLConnection).apply {
      connectTimeout = TIMEOUT_MS
      readTimeout = TIMEOUT_MS
      // A watch on a flaky Bluetooth-proxied link retries at the
      // transport level for a long time; the timeouts above are what
      // actually bound a request.
      useCaches = false
      setRequestProperty("accept", "application/json")
    }

  private fun get(url: String): String? {
    val conn = open(url)
    return try {
      if (conn.responseCode != 200) null
      else conn.inputStream.bufferedReader().use(BufferedReader::readText)
    } finally {
      conn.disconnect()
    }
  }
}
