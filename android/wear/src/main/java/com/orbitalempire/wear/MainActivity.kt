package com.orbitalempire.wear

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.platform.LocalContext
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
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.TimeText
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.mutableLongStateOf
import androidx.wear.compose.material.Text

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

  /** A ship to open the orders sheet on straight away. */
  private val requestedOrders = mutableStateOf<String?>(null)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    requestedPage.intValue = pageFrom(intent)
    requestedPorthole.value = intent?.getStringExtra(EXTRA_PORTHOLE)
    requestedOrders.value = intent?.getStringExtra(EXTRA_ORDERS)
    val fxDemo = intent?.getBooleanExtra(EXTRA_FX_DEMO, false) == true
    setContent {
      OrbitalWearTheme {
        // A STAGED EMPIRE, for photographing the app: the CI faction
        // holds two ships and no shipyard, so every screen shoots as an
        // empty state, and a real two-sided fight is an hour of ticks
        // away. Nothing reaches this but the smoke run's intent extra,
        // and the view model stops fetching while it is set.
        OrbitalWearApp(
          requestedPage = requestedPage.intValue,
          requestedPorthole = if (fxDemo && requestedPorthole.value == null && !intent.hasExtra(EXTRA_PAGE)) FxDemo.BODY else requestedPorthole.value,
          requestedOrders = requestedOrders.value,
          demo = fxDemo,
        )
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
    requestedOrders.value = intent.getStringExtra(EXTRA_ORDERS)
  }

  private fun pageFrom(i: Intent?): Int = (i?.getIntExtra(EXTRA_PAGE, 0) ?: 0).coerceIn(0, PAGES - 1)

  companion object {
    /** Which page to open on: 0 empire, 1 battles, 2 senate. Each tile
     *  opens the screen it summarises. */
    const val EXTRA_PAGE = "page"

    /** Draw a staged battle instead of the app: the effects, where CI
     *  can photograph them. Set by .github/scripts/wear-smoke.sh only. */
    const val EXTRA_FX_DEMO = "fxdemo"

    /** A body id to open the Porthole on, over the Systems page. */
    const val EXTRA_PORTHOLE = "porthole"

    /** A ship id to open the orders sheet on. */
    const val EXTRA_ORDERS = "orders"

    /** Empire, Battles, Senate, Systems, Comms, Yards. */
    const val PAGES = 7
  }
}

@Composable
fun OrbitalWearApp(
  vm: WearViewModel = viewModel(),
  requestedPage: Int = 0,
  requestedPorthole: String? = null,
  requestedOrders: String? = null,
  /** Staged data instead of the player's, for store shots (FxDemo). */
  demo: Boolean = false,
) {
  if (demo) remember { vm.seedDemo(); true }
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

  // BATTLE STATIONS NEEDS NOTIFICATIONS, and Wear asks at runtime. Once,
  // after pairing -- asking on the pairing screen would be asking a
  // stranger -- and never again if declined: the rest of the app works
  // without it, and a watch that nags is a watch that gets muted.
  val ctx = LocalContext.current
  val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
  LaunchedEffect(ui.paired) {
    if (!ui.paired || Build.VERSION.SDK_INT < 33) return@LaunchedEffect
    val prefs = ctx.getSharedPreferences("orbital_wear_ui", android.content.Context.MODE_PRIVATE)
    val granted = ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    if (!granted && !prefs.getBoolean("asked_notifications", false)) {
      prefs.edit().putBoolean("asked_notifications", true).apply()
      ask.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
  }

  Scaffold(
    timeText = { TimeText() },
    modifier = Modifier.fillMaxSize().background(Ground),
  ) {
    when {
      !ui.paired -> PairingScreen(ui, vm)
      else -> PagedScreens(ui, vm, requestedPage, requestedPorthole, requestedOrders)
    }
  }
}

@Composable
private fun PagedScreens(
  ui: WearViewModel.UiState,
  vm: WearViewModel,
  requestedPage: Int,
  requestedPorthole: String?,
  requestedOrders: String?,
) {
  val pager = rememberPagerState(initialPage = requestedPage) { MainActivity.PAGES }
  LaunchedEffect(requestedPage) { pager.scrollToPage(requestedPage) }
  // The Porthole opens OVER the pager, on a world picked in Systems, and
  // back closes it onto the same system.
  var porthole by remember { mutableStateOf<String?>(null) }
  // ORDERS: the ship whose orders are open; the ships a SEND is for (the
  // Systems page then picks the world); the world picked, awaiting HOLD.
  var ordersFor by remember { mutableStateOf<String?>(null) }
  var sendIds by remember { mutableStateOf<List<String>?>(null) }
  var sendTo by remember { mutableStateOf<String?>(null) }
  LaunchedEffect(requestedOrders) { if (requestedOrders != null) ordersFor = requestedOrders }
  LaunchedEffect(requestedPorthole) {
    if (requestedPorthole != null) {
      pager.scrollToPage(SYSTEMS_PAGE)
      porthole = requestedPorthole
    }
  }
  val looking = pager.currentPage == SYSTEMS_PAGE || porthole != null || sendIds != null
  // The board is cheap and changes on a tick; refetched while shown.
  val boarding = pager.currentPage == TERRITORY_PAGE
  LaunchedEffect(boarding) {
    while (boarding) {
      vm.refreshBoard()
      delay(60_000)
    }
  }
  // Orders, diplomacy and yards refetch on the same 30s beat while shown.
  val commanding = pager.currentPage >= COMMS_PAGE || ordersFor != null || porthole != null
  LaunchedEffect(commanding) {
    while (commanding) {
      vm.refreshCommand()
      delay(30_000)
    }
  }
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
        3 -> SystemsScreen(ui.worlds, active = pager.currentPage == SYSTEMS_PAGE && porthole == null && sendIds == null) { porthole = it }
        4 -> TerritoryScreen(ui.board)
        5 -> CommsScreen(ui, vm)
        else -> YardsScreen(ui, vm)
      }
    }
    if (porthole == null) {
      // THE CLOCK EVERY PAGE IS READ AGAINST. A turn is an hour and
      // nothing in this game resolves until one lands, so "how long have
      // I got" is the question behind every screen -- and it was only
      // answered on Empire. It sits over the page dots, which is the one
      // strip of a round screen no page draws in.
      Column(
        modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
      ) {
        TickFooter(ui.state)
        PageDots(count = MainActivity.PAGES, current = pager.currentPage)
      }
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
        onShip = { ordersFor = it },
      )
    }
    val ship = ordersFor
    if (ship != null && sendIds == null) {
      ShipOrdersScreen(ui, vm, ship, onSend = { ids -> sendIds = ids }, onClose = { ordersFor = null })
    }
    val picking = sendIds
    if (picking != null && sendTo == null) {
      // The Systems page, as the destination picker: turn the bezel to a
      // system, tap the world to send them to.
      Box(Modifier.fillMaxSize().background(Ground)) {
        androidx.activity.compose.BackHandler { sendIds = null }
        SystemsScreen(ui.worlds, active = true) { sendTo = it }
        androidx.wear.compose.material.Text(
          "SEND TO: TAP A WORLD",
          color = Good,
          fontSize = 9.sp,
          modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 14.dp),
        )
      }
    }
    val target = sendTo
    if (picking != null && target != null) {
      SendConfirmScreen(
        ui, vm, picking, target,
        onDone = { sendTo = null; sendIds = null; ordersFor = null },
        onBack = { sendTo = null },
      )
    }
  }
}

private const val SYSTEMS_PAGE = 3
private const val TERRITORY_PAGE = 4
private const val COMMS_PAGE = 5

@Composable
/**
 * How long until the turn lands, counted down on the watch's own clock
 * against the SERVER's -- a watch four minutes fast would otherwise show
 * a tick that has already happened as still to come.
 *
 * Ticks once a second while a page is on screen and never otherwise: it
 * is one short string, and the pager is only up while a wrist is raised.
 */
@Composable
private fun TickFooter(s: WearState) {
  if (!s.isLive || s.nextTickAt <= 0L) return
  var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
  LaunchedEffect(s.nextTickAt) {
    while (true) {
      now = System.currentTimeMillis()
      delay(1_000)
    }
  }
  val skew = if (s.serverNow > 0) s.serverNow - now else 0L
  val left = s.nextTickAt - (now + skew)
  val text = when {
    left <= 0L -> "TICK ${s.tick + 1} ANY MOMENT"
    left < 60_000L -> "TICK ${s.tick + 1} IN ${left / 1000}S"
    left < 3_600_000L -> "TICK ${s.tick + 1} IN ${left / 60_000}M"
    else -> "TICK ${s.tick + 1} IN ${left / 3_600_000}H ${(left % 3_600_000) / 60_000}M"
  }
  Text(
    text,
    color = if (left in 1..120_000L) Warn else Dim,
    fontSize = 8.sp,
    maxLines = 1,
    modifier = Modifier.padding(bottom = 2.dp),
  )
}

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
