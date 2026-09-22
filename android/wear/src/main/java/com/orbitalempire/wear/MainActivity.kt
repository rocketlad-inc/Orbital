package com.orbitalempire.wear

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.TimeText

/**
 * Orbital on the wrist.
 *
 * THREE PAGES, SWIPED, AND NOT A MENU. A watch interaction is about a
 * second long. A list of destinations spends that second choosing, and
 * the player looks up having learned nothing -- so the three things
 * worth a glance are each one swipe from the last: what the empire is
 * earning, what is on fire, and what is waiting for a vote. That is
 * also the order they matter in when nothing is wrong.
 *
 * THE WATCH REFETCHES ON EVERY RESUME AND NEVER ON A TIMER. A tick is
 * minutes long and a player looks at a watch for a moment; a poll loop
 * would spend battery keeping a screen fresh that nobody is looking at.
 * Raising your wrist is the refresh.
 */
class MainActivity : ComponentActivity() {

  /** The page a tile tap asked for; a new tap while open moves the pager. */
  private val requestedPage = mutableIntStateOf(0)

  /** A world to open a Porthole on straight away (a battle alert). */
  private val requestedPorthole = mutableStateOf<String?>(null)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    requestedPage.intValue = pageFrom(intent)
    requestedPorthole.value = intent?.getStringExtra(EXTRA_PORTHOLE)
    setContent {
      OrbitalWearTheme {
        OrbitalWearApp(requestedPage = requestedPage.intValue, requestedPorthole = requestedPorthole.value)
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    // Only a tap that NAMES a page moves the pager; a battle alert that
    // names a world opens its Porthole over wherever the player was.
    if (intent.hasExtra(EXTRA_PAGE)) requestedPage.intValue = pageFrom(intent)
    requestedPorthole.value = intent.getStringExtra(EXTRA_PORTHOLE)
  }

  private fun pageFrom(i: Intent?): Int = (i?.getIntExtra(EXTRA_PAGE, 0) ?: 0).coerceIn(0, PAGES - 1)

  companion object {
    /** Which page to open on: 0 empire, 1 battles, 2 senate. Each tile
     *  opens the screen it summarises. */
    const val EXTRA_PAGE = "page"

    /** A body id to open the Porthole on, over the Systems page. */
    const val EXTRA_PORTHOLE = "porthole"

    /** Empire, Battles, Senate, Systems. */
    const val PAGES = 4
  }
}

@Composable
fun OrbitalWearApp(vm: WearViewModel = viewModel(), requestedPage: Int = 0, requestedPorthole: String? = null) {
  val ui by vm.ui.collectAsStateWithLifecycle()

  // RAISING YOUR WRIST IS THE REFRESH. collectAsStateWithLifecycle
  // already stops collecting while the app is stopped; this is the
  // other half -- asking for a fresh document every time the watch
  // comes back, because the one on screen is from whenever the player
  // last looked, and on a watch that is usually hours ago.
  LifecycleResumeEffect(Unit) {
    vm.refresh()
    onPauseOrDispose { }
  }

  Scaffold(
    timeText = { TimeText() },
    modifier = Modifier.fillMaxSize().background(Ground),
  ) {
    when {
      !ui.paired -> PairingScreen(ui, vm)
      else -> PagedScreens(ui, vm, requestedPage, requestedPorthole)
    }
  }
}

@Composable
private fun PagedScreens(ui: WearViewModel.UiState, vm: WearViewModel, requestedPage: Int, requestedPorthole: String?) {
  val pager = rememberPagerState(initialPage = requestedPage) { MainActivity.PAGES }
  LaunchedEffect(requestedPage) { pager.scrollToPage(requestedPage) }
  // The Porthole opens OVER the pager, on a world picked in Systems, and
  // back closes it onto the same system.
  var porthole by remember { mutableStateOf<String?>(null) }
  LaunchedEffect(requestedPorthole) {
    if (requestedPorthole != null) {
      pager.scrollToPage(SYSTEMS_PAGE)
      porthole = requestedPorthole
    }
  }
  val looking = pager.currentPage == SYSTEMS_PAGE || porthole != null
  // Orbits are refetched every 30s while they are on screen and never
  // otherwise -- a tick is minutes; the motion is drawn locally.
  LaunchedEffect(looking) {
    while (looking) {
      vm.refreshWorlds()
      delay(30_000)
    }
  }
  Box(Modifier.fillMaxSize()) {
    HorizontalPager(state = pager, modifier = Modifier.fillMaxSize(), userScrollEnabled = porthole == null) { page ->
      when (page) {
        0 -> EmpireScreen(ui, vm)
        1 -> BattlesScreen(ui)
        2 -> SenateScreen(ui, vm)
        else -> SystemsScreen(ui.worlds, active = pager.currentPage == SYSTEMS_PAGE && porthole == null) { porthole = it }
      }
    }
    if (porthole == null) {
      PageDots(
        count = MainActivity.PAGES,
        current = pager.currentPage,
        modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 4.dp),
      )
    }
    val w = ui.worlds
    val open = porthole
    if (w != null && open != null) {
      PortholeScreen(
        worlds = w,
        bodyId = open,
        // The bezel, inside a Porthole, steps between the worlds your
        // ships are at -- burning ones first, as the feed orders them.
        onStep = { d ->
          val ids = w.worlds.map { it.id }
          if (ids.isNotEmpty()) {
            val i = ids.indexOf(open)
            porthole = ids[((if (i < 0) 0 else i + d) % ids.size + ids.size) % ids.size]
          }
        },
        onClose = { porthole = null },
      )
    }
  }
}

private const val SYSTEMS_PAGE = 3

@Composable
private fun PageDots(count: Int, current: Int, modifier: Modifier = Modifier) {
  Row(
    modifier = modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.Center,
  ) {
    repeat(count) { i ->
      Box(
        Modifier
          .padding(horizontal = 3.dp)
          .size(if (i == current) 6.dp else 4.dp)
          .clip(CircleShape)
          .background(if (i == current) Ink else Trough),
      )
    }
  }
}
