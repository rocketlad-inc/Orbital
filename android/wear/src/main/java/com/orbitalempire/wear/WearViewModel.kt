package com.orbitalempire.wear

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.wear.remote.interactions.RemoteActivityHelper
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.concurrent.Executor
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * The screen's whole state, and the only thing that changes it.
 *
 * THE PAIRING POLL IS THE REASON THIS IS A VIEW MODEL rather than a
 * handful of remember{} in the composable. It is a loop that has to
 * survive the watch turning its screen off mid-pairing -- which happens
 * constantly, because the player is looking at their phone at the time.
 * A coroutine tied to composition dies at that moment and the player
 * comes back to a watch still asking to be connected, having thrown the
 * token away.
 */
class WearViewModel(app: Application) : AndroidViewModel(app) {

  private val _ui = MutableStateFlow(UiState())
  val ui: StateFlow<UiState> = _ui.asStateFlow()

  private var pollJob: Job? = null

  data class UiState(
    val paired: Boolean = false,
    val loading: Boolean = true,
    /** True from the moment the phone is asked to open the game until a
     *  token lands or the attempt is given up on. */
    val pairing: Boolean = false,
    val error: String? = null,
    val state: WearState = WearState(),
    /** The bill a vote is in flight for, so its row can disable its own
     *  buttons without freezing the rest of the list. */
    val voting: String? = null,
    val notice: String? = null,
    /** The systems and the orbits, for the Systems page and the Porthole.
     *  Null until the first fetch; kept on a failed refetch. */
    val worlds: Worlds? = null,
    val board: Board? = null,
    /** Orders, diplomacy and shipyards (command.json). */
    val command: Command? = null,
    /** An order in flight, so its screen can show it rather than a second tap. */
    val ordering: Boolean = false,
    /** When [state] was fetched; and whether the last try failed, so the
     *  screens say how old what they show is (Cache). */
    val stateAt: Long = 0L,
    val offline: Boolean = false,
  )

  /** Staged data, for photographing the app (FxDemo). Set only by an
   *  intent extra, and while it is set nothing fetches: a screen can
   *  never mix a staged empire with a real one. */
  private var demo = false

  fun seedDemo() {
    demo = true
    _ui.value = _ui.value.copy(
      paired = true,
      loading = false,
      state = FxDemo.state,
      worlds = FxDemo.worlds,
      board = FxDemo.board,
    )
  }

  /**
   * A REAL EMPIRE FROM FILES, for the review rig (debug builds only; see
   * MainActivity.EXTRA_FIXTURE). The documents a player's watch would
   * fetch -- state, command, worlds, standings, destinations -- are read
   * from files/fixture, and nothing fetches while they are up. The clock
   * is moved to now, keeping the time left in the tick they were taken in.
   */
  fun seedFixture() {
    demo = true
    val app = getApplication<Application>()
    Fixture.dir = java.io.File(app.filesDir, "fixture")
    fun read(n: String): String? = Fixture.read(n)
    val now = System.currentTimeMillis()
    val st = try { read("state")?.let { parseWearState(it) } } catch (t: Throwable) { null } ?: WearState()
    val shifted = if (st.serverNow > 0 && st.nextTickAt > 0) {
      st.copy(serverNow = now, nextTickAt = now + (st.nextTickAt - st.serverNow))
    } else st
    _ui.value = _ui.value.copy(
      paired = true,
      loading = false,
      error = null,
      state = shifted,
      command = try { read("command")?.let { parseCommand(it) } } catch (t: Throwable) { null },
      worlds = try { read("worlds")?.let { parseWorlds(it) } } catch (t: Throwable) { null },
      board = try { read("standings")?.let { parseBoard(it) } } catch (t: Throwable) { null },
      stateAt = now,
      offline = false,
    )
  }

  init {
    // THE LAST EMPIRE THIS WATCH SAW, straight away: a watch out of signal
    // shows it marked with its age instead of a spinner.
    val app = getApplication<Application>()
    if (OrbitalClient.hasToken(app)) {
      try {
        val st = Cache.get(app, "state")
        val cm = Cache.get(app, "command")
        _ui.value = _ui.value.copy(
          paired = st != null || _ui.value.paired,
          state = st?.let { parseWearState(it.first) } ?: _ui.value.state,
          stateAt = st?.second ?: 0L,
          command = cm?.let { parseCommand(it.first) },
        )
      } catch (t: Throwable) {
        Log.w("OrbitalWear", "cache unreadable", t)
      }
    }
    refresh()
  }

  /** Ask the player, on their phone, to allow orders from this watch: a
   *  fresh pairing with the 'wear_orders' scope. Declined, the watch stays
   *  paired as it was, read-only. */
  /**
   * A watch paired before orders were part of pairing, healing itself.
   *
   * NOTHING ASKS THE PLAYER HERE. The question is asked once, on the
   * phone, when the watch pairs (public/index.html); a watch already
   * holding a token for this account has been through it, and the
   * server grants the upgrade on the strength of that token
   * (worker/wearRequests.js). So an old pairing quietly becomes a
   * working one instead of growing a button that explains itself.
   */
  fun requestOrders() = connect("wear_orders")

  private var healing = false

  fun healOrders() {
    if (healing || demo) return
    healing = true
    viewModelScope.launch {
      val app = getApplication<Application>()
      val code = OrbitalClient.pairingCode(app, fresh = true)
      if (OrbitalClient.requestOrders(app, code)) {
        // The token lands in the pairing the watch already polls.
        if (OrbitalClient.claimPairing(app)) refreshCommand()
      }
      healing = false
    }
  }

  fun refreshCommand() {
    if (demo) return
    viewModelScope.launch {
      val c = Orders.command(getApplication<Application>()) ?: return@launch
      if (demo) return@launch
      _ui.value = _ui.value.copy(command = c)
      // Paired before orders came with pairing: fix it, silently, once.
      if (!c.orders) healOrders()
    }
  }

  /**
   * Send one order, then refetch what it changed. The result is the game's
   * own words: a refusal reads as the game would say it ("carries no
   * Detonator"), a success as [done].
   */
  fun order(order: org.json.JSONObject, done: String) {
    if (_ui.value.ordering) return
    viewModelScope.launch {
      _ui.value = _ui.value.copy(ordering = true, error = null, notice = null)
      val r = Orders.send(getApplication<Application>(), order)
      _ui.value = _ui.value.copy(
        ordering = false,
        notice = if (r.ok) done else null,
        error = if (r.ok) null else r.message,
      )
      refreshCommand()
      refreshWorlds()
      refresh()
    }
  }

  /** Refetch the board. Called while the Territory page is on screen. */
  fun refreshBoard() {
    if (demo) return
    viewModelScope.launch {
      val b = Standings.board(getApplication<Application>()) ?: return@launch
      if (demo) return@launch
      _ui.value = _ui.value.copy(board = b)
    }
  }

  /** Refetch the systems and orbits. Called on a 30s beat while the
   *  Systems page or a Porthole is on screen, and never otherwise. */
  fun refreshWorlds() {
    if (demo) return
    viewModelScope.launch {
      val w = OrbitalClient.worlds(getApplication<Application>()) ?: return@launch
      if (demo) return@launch
      _ui.value = _ui.value.copy(worlds = w)
    }
  }

  fun refresh() {
    if (demo) return
    // The sky face's location, while the app is in front and allowed to
    // take one: the complications cannot, from the background. Quiet and
    // cheap when the saved fix is under three hours old (SkyLocation).
    viewModelScope.launch { SkyLocation.refresh(getApplication<Application>()) }
    viewModelScope.launch {
      _ui.value = _ui.value.copy(loading = true, error = null)
      if (!OrbitalClient.hasToken(getApplication<Application>())) {
        _ui.value = _ui.value.copy(loading = false, paired = false)
        return@launch
      }
      val fetched = OrbitalClient.state(getApplication<Application>())
      // seedDemo may have landed while this was in flight.
      if (demo) return@launch
      when (val r = fetched) {
        is OrbitalClient.Fetch.Ok -> {
          _ui.value = _ui.value.copy(loading = false, paired = true, state = r.state, error = null, stateAt = System.currentTimeMillis(), offline = false)
          BattleStations.sync(getApplication<Application>(), r.state)
          OrbitalComplication.refreshAll(getApplication<Application>())
          // The watch's own alerts: keep the schedule, book the look for
          // just after the next tick, and collect anything new now.
          AlertWorker.ensure(getApplication<Application>())
          AlertWorker.onState(getApplication<Application>(), r.state)
          AlertWorker.kick(getApplication<Application>())
        }
        OrbitalClient.Fetch.Unpaired -> {
          _ui.value = UiState(loading = false, paired = false)
          AlertWorker.stop(getApplication<Application>())
        }
        is OrbitalClient.Fetch.Failed ->
          _ui.value = _ui.value.copy(loading = false, error = if (_ui.value.stateAt > 0L) null else r.message, offline = true)
      }
    }
  }

  /**
   * Ask the phone to open the game with this watch's pairing code.
   *
   * WHY THE PHONE AND NOT THE WATCH. A token can only be minted by a
   * signed-in session, and the session lives in a cookie in a browser.
   * A watch has no browser, and even if it did, signing in on one is an
   * email address typed a letter at a time on a screen the size of a
   * stamp.
   *
   * WHY RemoteActivityHelper AND NOT A DATA LAYER MESSAGE. The obvious
   * build is a MessageClient send to a WearableListenerService on the
   * phone, which starts the game. That service cannot start an
   * activity: it is a background process, and background activity
   * starts have been blocked since Android 10 -- so the phone-side half
   * has to become a notification the player then has to find and tap.
   * RemoteActivityHelper hands the intent to the system's own wearable
   * services, which may start it, and the phone app's autoVerify filter
   * on orbital-empire.com means it opens in the game rather than in a
   * browser tab. One call, no phone-side code, and nothing new in the
   * phone APK at all.
   */
  fun connect(scope: String = "wear_orders") {
    val app = getApplication<Application>()
    _ui.value = _ui.value.copy(pairing = true, error = null, notice = null)
    // EVERY ASK TAKES A NEW CODE. The old one has already been bound and
    // claimed, and the server is one-shot, so reusing it meant a 409 on
    // the phone and a poll that never came good -- the "it opens the app
    // but nothing happens" report.
    val code = OrbitalClient.pairingCode(app, fresh = true)
    // A second tap replaces the first attempt rather than racing it:
    // two polls against one code means one of them claims the token and
    // the other sees the one-shot pairing already used.
    pollJob?.cancel()
    pollJob = viewModelScope.launch {
      // AN UPGRADE NEEDS NOBODY. A watch already paired to the account
      // files the ask against its own token, and the server grants it on
      // the spot -- the phone is told, not asked. Only a FIRST pairing
      // goes through the launch URL, where the confirm still guards the
      // one path a stranger's link could reach.
      val allowed = scope == "wear_orders" && OrbitalClient.requestOrders(app, code)
      if (allowed) {
        _ui.value = _ui.value.copy(notice = "Orders allowed")
        awaitPairing()
        return@launch
      }
      val asked = false
      try {
        val intent = Intent(Intent.ACTION_VIEW)
          .addCategory(Intent.CATEGORY_BROWSABLE)
          .setData(Uri.parse(OrbitalClient.handoffUrl(app, scope)))
        RemoteActivityHelper(app).startRemoteActivity(intent, null).awaitDone()
        _ui.value = _ui.value.copy(notice = if (asked) "Answer on your phone" else "Check your phone")
      } catch (t: Throwable) {
        Log.w("OrbitalWear", "could not hand off to the phone", t)
        // The ask is already filed, so a phone this watch cannot reach
        // directly still gets the question the next time the game is
        // opened. Only a first pairing is actually stuck here.
        if (!asked) {
          _ui.value = _ui.value.copy(pairing = false, error = "Could not reach your phone")
          return@launch
        }
        _ui.value = _ui.value.copy(notice = "Open Orbital on your phone to allow it")
      }
      awaitPairing()
    }
  }

  /**
   * Poll for the token the phone is about to mint.
   *
   * SLOW, AND WITH AN END. The player has to unlock a phone, wait for
   * the game to load and possibly sign in, so the first useful answer
   * is many seconds away and polling hard would only cost battery. Two
   * seconds between tries for three minutes covers an unhurried
   * pairing; past that the server has dropped the code anyway (ten
   * minutes, but a player who wandered off is better served by a button
   * than by a watch still quietly polling in their pocket).
   */
  private suspend fun awaitPairing() {
    val app = getApplication<Application>()
    val deadline = System.currentTimeMillis() + 3L * 60L * 1000L
    while (System.currentTimeMillis() < deadline) {
      delay(2_000)
      if (OrbitalClient.claimPairing(app)) {
        _ui.value = _ui.value.copy(pairing = false, notice = null)
        refresh()
        return
      }
    }
    _ui.value = _ui.value.copy(
      pairing = false,
      notice = null,
      error = "Not connected yet. Try again.",
    )
  }

  /**
   * Cast a vote, and fold the server's own answer back into the list.
   *
   * NO OPTIMISTIC UPDATE. Showing the vote as cast and quietly reverting
   * it would be the wrong lie on the one screen in this app that
   * changes the game: a player glancing at a watch needs "it is done"
   * to mean it. So the row shows a spinner until the server has said
   * so, which on a watch link is under a second.
   */
  fun vote(bill: Bill, choice: String) {
    if (_ui.value.voting != null) return
    _ui.value = _ui.value.copy(voting = bill.id, error = null)
    viewModelScope.launch {
      when (val r = OrbitalClient.vote(getApplication<Application>(), bill.id, choice)) {
        is OrbitalClient.Voted.Ok -> {
          val updated = r.bill
          val senate = _ui.value.state.senate.map { if (it.id == bill.id && updated != null) updated else it }
          _ui.value = _ui.value.copy(
            voting = null,
            state = _ui.value.state.copy(senate = senate),
          )
        }
        is OrbitalClient.Voted.Failed ->
          _ui.value = _ui.value.copy(voting = null, error = r.message)
      }
    }
  }

  fun dismissError() {
    _ui.value = _ui.value.copy(error = null)
  }

  fun disconnect() {
    OrbitalClient.forget(getApplication<Application>())
    AlertWorker.stop(getApplication<Application>())
    _ui.value = UiState(loading = false, paired = false)
  }
}

/**
 * Await a ListenableFuture without pulling in kotlinx-coroutines-guava.
 *
 * That artifact would drag Guava proper into a watch APK to provide one
 * `await()`, and install size on a watch is a real budget. The future
 * here completes on the wearable service's own thread, so the listener
 * runs directly rather than being posted anywhere.
 */
private suspend fun ListenableFuture<Void>.awaitDone(): Unit =
  suspendCancellableCoroutine { cont ->
    addListener(
      {
        try {
          get()
          cont.resume(Unit)
        } catch (t: Throwable) {
          cont.resumeWithException(t)
        }
      },
      Executor { it.run() },
    )
    cont.invokeOnCancellation { cancel(false) }
  }
