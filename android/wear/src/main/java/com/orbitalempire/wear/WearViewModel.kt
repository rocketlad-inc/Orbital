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
  )

  init {
    refresh()
  }

  /** Refetch the systems and orbits. Called on a 30s beat while the
   *  Systems page or a Porthole is on screen, and never otherwise. */
  fun refreshWorlds() {
    viewModelScope.launch {
      val w = OrbitalClient.worlds(getApplication<Application>()) ?: return@launch
      _ui.value = _ui.value.copy(worlds = w)
    }
  }

  fun refresh() {
    viewModelScope.launch {
      _ui.value = _ui.value.copy(loading = true, error = null)
      if (!OrbitalClient.hasToken(getApplication<Application>())) {
        _ui.value = _ui.value.copy(loading = false, paired = false)
        return@launch
      }
      when (val r = OrbitalClient.state(getApplication<Application>())) {
        is OrbitalClient.Fetch.Ok -> {
          _ui.value = _ui.value.copy(loading = false, paired = true, state = r.state, error = null)
          BattleStations.sync(getApplication<Application>(), r.state)
          OrbitalComplication.refreshAll(getApplication<Application>())
        }
        OrbitalClient.Fetch.Unpaired ->
          _ui.value = UiState(loading = false, paired = false)
        is OrbitalClient.Fetch.Failed ->
          _ui.value = _ui.value.copy(loading = false, error = r.message)
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
  fun connect() {
    val app = getApplication<Application>()
    _ui.value = _ui.value.copy(pairing = true, error = null, notice = null)
    // A second tap replaces the first attempt rather than racing it:
    // two polls against one code means one of them claims the token and
    // the other sees the one-shot pairing already used.
    pollJob?.cancel()
    pollJob = viewModelScope.launch {
      try {
        val intent = Intent(Intent.ACTION_VIEW)
          .addCategory(Intent.CATEGORY_BROWSABLE)
          .setData(Uri.parse(OrbitalClient.handoffUrl(app)))
        RemoteActivityHelper(app).startRemoteActivity(intent, null).awaitDone()
        _ui.value = _ui.value.copy(notice = "Check your phone")
      } catch (t: Throwable) {
        Log.w("OrbitalWear", "could not hand off to the phone", t)
        _ui.value = _ui.value.copy(
          pairing = false,
          error = "Could not reach your phone",
        )
        return@launch
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
