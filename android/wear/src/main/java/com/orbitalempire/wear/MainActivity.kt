package com.orbitalempire.wear

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.ambient.AmbientLifecycleObserver
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Orbital on the wrist.
 *
 * FIVE PAGES, NAMED ON THE RIM: DECISIONS · HOME · FLEETS · MAP · REALM.
 * The app opens on HOME, with what needs you one swipe left and your
 * fleets one swipe right; the bottom arc names the page either side, so
 * the pages are places rather than dots. Everything else -- a fleet's
 * orders, where to send it, the senate, diplomacy, the yards, a world's
 * Porthole -- opens OVER the pages as a sheet, and back closes it.
 *
 * THE WATCH REFETCHES ON EVERY RESUME, and on a slow beat only while a
 * page is on screen. A tick is minutes long and a player looks at a watch
 * for a moment; raising your wrist is the refresh.
 */
class MainActivity : ComponentActivity() {

  /** The destination a tile, complication or alert asked for (Dest). */
  private val requested = mutableIntStateOf(Dest.HOME)

  /** Bumped on every deep link, so a second tap asking for the SAME place
   *  still moves there. */
  private val navNonce = mutableIntStateOf(0)

  private val requestedPorthole = mutableStateOf<String?>(null)
  private val requestedOrders = mutableStateOf<String?>(null)
  /** An alert's subject (battle:<id>, bill:<id>, trade:<id>): its card. */
  private val requestedRef = mutableStateOf<String?>(null)

  /** DEBUG BUILDS ONLY: a sheet to open straight away ("sendto:<ship>",
   *  "research", "lookup", "mapactions:<body>", "build:<body>",
   *  "ticklanded"), so the review rig can photograph each one. */
  private val requestedSheet = mutableStateOf<String?>(null)

  // ALWAYS-ON (AmbientScreen): the fight stays on the dimmed face.
  private val ambient = mutableStateOf(false)
  private val lowBit = mutableStateOf(false)
  private val ambientNudge = mutableIntStateOf(0)
  private val ambientCallback = object : AmbientLifecycleObserver.AmbientLifecycleCallback {
    override fun onEnterAmbient(ambientDetails: AmbientLifecycleObserver.AmbientDetails) {
      lowBit.value = ambientDetails.deviceHasLowBitAmbient
      ambient.value = true
    }

    override fun onUpdateAmbient() {
      ambientNudge.intValue++
    }

    override fun onExitAmbient() {
      ambient.value = false
    }
  }
  private val ambientObserver = AmbientLifecycleObserver(this, ambientCallback)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    lifecycle.addObserver(ambientObserver)
    take(intent)
    val fxDemo = intent?.getBooleanExtra(EXTRA_FX_DEMO, false) == true
    // A REAL EMPIRE FROM FILES (debug builds only): the review rig pushes a
    // player's own documents into files/fixture and photographs every
    // screen drawing them, without the watch holding anyone's token.
    val fixture = debuggable() && intent?.getBooleanExtra(EXTRA_FIXTURE, false) == true
    setContent {
      OrbitalWearTheme {
        // A STAGED EMPIRE, for photographing the app (FxDemo): nothing
        // reaches this but the smoke run's intent extra.
        OrbitalWearApp(
          requested = requested.intValue,
          requestedPorthole = if (fxDemo && requestedPorthole.value == null && !intent.hasExtra(EXTRA_PAGE)) FxDemo.BODY else requestedPorthole.value,
          requestedOrders = requestedOrders.value,
          requestedRef = requestedRef.value,
          navNonce = navNonce.intValue,
          demo = fxDemo,
          fixture = fixture,
          requestedSheet = requestedSheet.value,
          ambient = ambient.value,
          lowBit = lowBit.value,
          ambientNudge = ambientNudge.intValue,
        )
      }
    }
  }

  override fun onResume() {
    super.onResume()
    AppVisible.on = true
  }

  override fun onPause() {
    AppVisible.on = false
    super.onPause()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    take(intent)
    navNonce.intValue++
  }

  private fun take(i: Intent?) {
    // THE HARDWARE SHORTCUT: "Orbital Decisions" is a second launcher
    // entry (an activity-alias) a player can put on a double-press of the
    // Home key, straight into the one screen worth a physical button.
    val viaShortcut = i?.component?.className?.endsWith(".DecisionsShortcut") == true
    requested.intValue = when {
      viaShortcut -> Dest.DECISIONS
      i?.hasExtra(EXTRA_PAGE) == true -> i.getIntExtra(EXTRA_PAGE, Dest.HOME).coerceIn(0, Dest.LAST)
      i?.getStringExtra(EXTRA_REF) != null -> Dest.DECISIONS
      else -> requested.intValue
    }
    requestedPorthole.value = i?.getStringExtra(EXTRA_PORTHOLE)
    requestedOrders.value = i?.getStringExtra(EXTRA_ORDERS)
    requestedRef.value = i?.getStringExtra(EXTRA_REF)
    requestedSheet.value = if (debuggable()) i?.getStringExtra(EXTRA_SHEET) else null
  }

  private fun debuggable(): Boolean =
    (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0

  companion object {
    /** Where to open: a Dest code. The old page numbers (0 empire, 1
     *  battles, 2 senate, 3 systems, 4 territory, 5 comms, 6 yards) keep
     *  their meaning, so a tile placed before this build still lands. */
    const val EXTRA_PAGE = "page"

    /** Draw a staged battle instead of the app, for CI's photographs. */
    const val EXTRA_FX_DEMO = "fxdemo"

    /** A body id to open the Porthole on. */
    const val EXTRA_PORTHOLE = "porthole"

    /** A ship id to open its fleet's orders on. */
    const val EXTRA_ORDERS = "orders"

    /** An alert's subject: its Decision card. */
    const val EXTRA_REF = "ref"

    /** Debug builds only: draw the documents in files/fixture (Fixture). */
    const val EXTRA_FIXTURE = "fixture"

    /** Debug builds only: a sheet to open (requestedSheet). */
    const val EXTRA_SHEET = "sheet"
  }
}

/**
 * Every place the app can be opened on. Pages first by their old numbers,
 * then the new pages; SENATE, TERRITORY, COMMS and YARDS are sheets over
 * REALM now, and BATTLES is the Decisions stack.
 */
object Dest {
  const val HOME = 0
  const val BATTLES = 1
  const val SENATE = 2
  const val MAP = 3
  const val TERRITORY = 4
  const val COMMS = 5
  const val YARDS = 6
  const val DECISIONS = 7
  const val FLEETS = 8
  const val REALM = 9
  const val LAST = 9

  fun page(d: Int): Int = when (d) {
    DECISIONS, BATTLES -> P_DECISIONS
    FLEETS -> P_FLEETS
    MAP -> P_MAP
    REALM, SENATE, TERRITORY, COMMS, YARDS -> P_REALM
    else -> P_HOME
  }

  fun sheet(d: Int): Sheet? = when (d) {
    SENATE -> Sheet.Senate
    TERRITORY -> Sheet.Territory
    COMMS -> Sheet.Comms
    YARDS -> Sheet.Yards
    else -> null
  }
}

private const val P_DECISIONS = 0
private const val P_HOME = 1
private const val P_FLEETS = 2
private const val P_MAP = 3
private const val P_REALM = 4
private val PAGE_NAMES = listOf("DECISIONS", "HOME", "FLEETS", "MAP", "REALM")

/** What can open over the pages. */
sealed class Sheet {
  object Senate : Sheet()
  object Comms : Sheet()
  object Yards : Sheet()
  object Territory : Sheet()
  object Research : Sheet()
  object Voice : Sheet()
  object LookUp : Sheet()
  data class Porthole(val body: String) : Sheet()
  data class Orders(val ship: String) : Sheet()
  data class SendTo(val ship: String) : Sheet()
  data class MapPick(val ship: String) : Sheet()
  data class Confirm(val ship: String, val body: String) : Sheet()
  data class MapActions(val body: String) : Sheet()
  data class Build(val body: String) : Sheet()
}

@Composable
fun OrbitalWearApp(
  vm: WearViewModel = viewModel(),
  requested: Int = Dest.HOME,
  requestedPorthole: String? = null,
  requestedOrders: String? = null,
  requestedRef: String? = null,
  navNonce: Int = 0,
  demo: Boolean = false,
  fixture: Boolean = false,
  requestedSheet: String? = null,
  ambient: Boolean = false,
  lowBit: Boolean = false,
  ambientNudge: Int = 0,
) {
  if (demo) remember { vm.seedDemo(); true }
  if (fixture) remember { vm.seedFixture(); true }
  val ui by vm.ui.collectAsStateWithLifecycle()

  LifecycleResumeEffect(Unit) {
    vm.refresh()
    vm.refreshCommand()
    onPauseOrDispose { }
  }

  // Notifications need a runtime yes on Wear 4+. Asked once, after
  // pairing, and never again if declined.
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

  if (ambient && ui.paired) {
    // The dimmed face is updated about once a minute; the state behind it
    // is refetched every five.
    LaunchedEffect(ambientNudge) { if (ambientNudge % 5 == 0) vm.refresh() }
    AmbientScreen(ui.state, ambientNudge, lowBit)
    return
  }

  if (!ui.paired) {
    Scaffold(timeText = { TimeText() }, modifier = Modifier.fillMaxSize().background(Ground)) {
      PairingScreen(ui, vm)
    }
    return
  }

  val rim = remember { RimHold() }
  CompositionLocalProvider(LocalRimHold provides rim) {
    Box(Modifier.fillMaxSize().background(Ground)) {
      PagedScreens(ui, vm, requested, requestedPorthole, requestedOrders, requestedRef, navNonce, requestedSheet)
      RimHoldRing(rim)
    }
  }
}

@Composable
private fun PagedScreens(
  ui: WearViewModel.UiState,
  vm: WearViewModel,
  requested: Int,
  requestedPorthole: String?,
  requestedOrders: String?,
  requestedRef: String?,
  navNonce: Int,
  requestedSheet: String? = null,
) {
  val ctx = LocalContext.current
  val pager = rememberPagerState(initialPage = Dest.page(requested)) { PAGE_NAMES.size }
  val scope = rememberCoroutineScope()
  val sheets = remember { mutableStateListOf<Sheet>() }
  fun push(s: Sheet) { if (sheets.lastOrNull() != s) sheets.add(s) }
  fun pop() { if (sheets.isNotEmpty()) sheets.removeAt(sheets.lastIndex) }

  // A DEEP LINK: the page, then the sheet it names (if any) over it.
  LaunchedEffect(requested, navNonce) {
    pager.scrollToPage(Dest.page(requested))
    Dest.sheet(requested)?.let { sheets.clear(); push(it) }
  }
  LaunchedEffect(requestedOrders, navNonce) { if (requestedOrders != null) push(Sheet.Orders(requestedOrders)) }
  LaunchedEffect(requestedPorthole, navNonce) {
    if (requestedPorthole != null) {
      pager.scrollToPage(P_MAP)
      push(Sheet.Porthole(requestedPorthole))
    }
  }

  val need = remember(ui.state, ui.command) { decisionsOf(ui.state, ui.command) }
  val nav = Nav(
    watch = { push(Sheet.Porthole(it)) },
    orders = { push(Sheet.Orders(it)) },
    send = { g -> push(Sheet.SendTo(g.lead.id)) },
    research = { push(Sheet.Research) },
    go = { d ->
      val sheet = Dest.sheet(d)
      if (sheet != null) push(sheet) else {
        sheets.clear()
        scope.launch { pager.animateScrollToPage(Dest.page(d)) }
      }
    },
    voice = { push(Sheet.Voice) },
    lookUp = { push(Sheet.LookUp) },
    build = { y -> push(Sheet.Build(y.body)) },
  )

  // THE BEATS, only while on screen. Orders, diplomacy and yards every 30
  // seconds (every page reads them now: Home counts what needs you from
  // them); the orbits every 30 while a map or a Porthole is up, else
  // every two minutes for names and sprites; the board while Realm or
  // Territory shows it.
  WhileVisible(Unit) {
    while (true) {
      vm.refreshCommand()
      delay(30_000)
    }
  }
  val top = sheets.lastOrNull()
  val looking = pager.currentPage == P_MAP || top is Sheet.Porthole || top is Sheet.MapPick
  WhileVisible(looking) {
    while (true) {
      vm.refreshWorlds()
      delay(if (looking) 30_000 else 120_000)
    }
  }
  val boarding = pager.currentPage == P_REALM || top is Sheet.Territory
  WhileVisible(boarding) {
    while (boarding) {
      vm.refreshBoard()
      delay(60_000)
    }
  }
  // AND THE MOMENT THE TICK LANDS, because that is when everything
  // happens: asked again a second and a half after it is due.
  val nextTickAt = ui.state.nextTickAt
  LaunchedEffect(nextTickAt) {
    if (nextTickAt <= 0L) return@LaunchedEffect
    val skew = if (ui.state.serverNow > 0) ui.state.serverNow - System.currentTimeMillis() else 0L
    val wait = nextTickAt - (System.currentTimeMillis() + skew) + 1_500
    if (wait > 0) delay(wait)
    vm.refresh()
    vm.refreshCommand()
    vm.refreshWorlds()
  }

  // THE TICK LANDED, if it landed while this watch was looking (or in the
  // last quarter hour): its own screen and its own buzz.
  var landed by remember { mutableStateOf(false) }
  // The review rig's sheet, opened once the documents are in.
  LaunchedEffect(requestedSheet, navNonce) {
    val spec = requestedSheet ?: return@LaunchedEffect
    val arg = spec.substringAfter(':', "")
    when (spec.substringBefore(':')) {
      "sendto" -> push(Sheet.SendTo(arg))
      "research" -> push(Sheet.Research)
      "lookup" -> push(Sheet.LookUp)
      "mapactions" -> push(Sheet.MapActions(arg))
      "build" -> push(Sheet.Build(arg))
      "porthole" -> push(Sheet.Porthole(arg))
      "ticklanded" -> landed = true
    }
  }
  val landedTick = ui.state.lastTick?.tick
  LaunchedEffect(landedTick, ui.stateAt) {
    val t = landedTick ?: return@LaunchedEffect
    if (ui.offline || ui.stateAt <= 0L || System.currentTimeMillis() - ui.stateAt > 60_000L) return@LaunchedEffect
    val len = if (ui.state.tickMs > 0) ui.state.tickMs else 3_600_000L
    val skew = if (ui.state.serverNow > 0) ui.state.serverNow - System.currentTimeMillis() else 0L
    val since = System.currentTimeMillis() + skew - (ui.state.nextTickAt - len)
    val fresh = ui.state.nextTickAt > 0 && since in 0..15 * 60_000L
    if (TickSeen.isNew(ctx, t) && fresh) landed = true
  }

  Box(Modifier.fillMaxSize()) {
    StarfieldBackground()
    HorizontalPager(state = pager, modifier = Modifier.fillMaxSize(), userScrollEnabled = sheets.isEmpty()) { page ->
      when (page) {
        P_DECISIONS -> DecisionsScreen(ui, vm, nav, requestedRef, navNonce, active = pager.currentPage == P_DECISIONS && sheets.isEmpty())
        P_HOME -> HomeScreen(ui, nav, need)
        P_FLEETS -> FleetsScreen(ui, nav)
        P_MAP -> Box(Modifier.fillMaxSize()) {
          SystemsScreen(
            ui.worlds,
            active = pager.currentPage == P_MAP && sheets.isEmpty(),
            onLongPress = { push(Sheet.MapActions(it)) },
          ) { push(Sheet.Porthole(it)) }
        }
        else -> RealmScreen(ui, nav)
      }
    }
    if (top == null) {
      PageNames(pager.currentPage)
      Offline(ui)
    } else {
      // SWIPE RIGHT CLOSES A SHEET, the gesture every Wear app answers to;
      // the review found the back key was the only way out of any of them.
      // The page underneath shows through as the sheet slides away.
      androidx.compose.runtime.key(top) {
        androidx.wear.compose.material.SwipeToDismissBox(onDismissed = { pop() }) { isBackground ->
          if (!isBackground) {
            SheetHost(top, ui, vm, nav, onPop = { pop() }, onReplace = { s -> pop(); push(s) }, onClear = { sheets.clear() })
          }
        }
      }
    }
    if (landed) {
      TickLandsOverlay(
        ui.state, need.size,
        onDecisions = { landed = false; sheets.clear(); scope.launch { pager.animateScrollToPage(P_DECISIONS) } },
        onDismiss = { landed = false },
      )
    }
  }
}

/**
 * A loop that runs only while the app is on screen. A LaunchedEffect alone
 * outlives onStop -- the composition is kept -- and a 30-second poll left
 * running in the background is a battery bill for a screen nobody sees.
 */
@Composable
private fun WhileVisible(key: Any?, block: suspend kotlinx.coroutines.CoroutineScope.() -> Unit) {
  val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
  LaunchedEffect(key) { lifecycle.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.STARTED, block) }
}

/** The sheet on top of the stack. */
@Composable
private fun SheetHost(
  top: Sheet,
  ui: WearViewModel.UiState,
  vm: WearViewModel,
  nav: Nav,
  onPop: () -> Unit,
  onReplace: (Sheet) -> Unit,
  onClear: () -> Unit,
) {
  val cmd = ui.command
  when (top) {
    is Sheet.Senate -> Over(onPop, "SENATE") { SenateScreen(ui, vm) }
    is Sheet.Comms -> Over(onPop, "DIPLOMACY") { CommsScreen(ui, vm) }
    is Sheet.Yards -> Over(onPop, "YARDS") { YardsScreen(ui, vm) }
    is Sheet.Territory -> Over(onPop, "TERRITORY") { TerritoryScreen(ui.board) }
    is Sheet.Research -> ResearchPicker(ui, vm, onClose = onPop)
    is Sheet.Voice -> VoiceOrderSheet(ui, vm, onClose = onPop)
    is Sheet.LookUp -> LookUpScreen(ui.state.capital, onClose = onPop)
    is Sheet.Porthole -> {
      val w = ui.worlds
      if (w == null) Over(onPop) { None("SCANNING…") } else PortholeScreen(
        worlds = w,
        bodyId = top.body,
        onStep = { d ->
          val ids = w.worlds.map { it.id }
          if (ids.isNotEmpty()) {
            val i = ids.indexOf(top.body)
            onReplace(Sheet.Porthole(ids[((if (i < 0) 0 else i + d) % ids.size + ids.size) % ids.size]))
          }
        },
        onClose = onPop,
        onShip = { nav.orders(it) },
      )
    }
    is Sheet.Orders -> FleetOrdersScreen(ui, vm, top.ship, nav, onClose = onPop)
    is Sheet.SendTo -> {
      val g = cmd?.let { groupOf(it, top.ship) }
      if (g == null) Over(onPop) { None("SHIP NOT FOUND") } else SendToScreen(
        ui, vm, g,
        onPickMap = { onReplace(Sheet.MapPick(top.ship)) },
        onDone = onClear,
        onClose = onPop,
      )
    }
    is Sheet.MapPick -> Over(onPop) {
      Box(Modifier.fillMaxSize()) {
        SystemsScreen(ui.worlds, active = true) { body -> onReplace(Sheet.Confirm(top.ship, body)) }
        Text("SEND TO: TAP A WORLD", color = Good, fontSize = 9.sp, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 14.dp))
      }
    }
    is Sheet.Confirm -> {
      val g = cmd?.let { groupOf(it, top.ship) }
      val p = placeOf(ui.worlds, top.body)
      if (g == null || p == null) Over(onPop) { None("SHIP NOT FOUND") } else SendConfirm(ui, vm, g, p, heard = null, onDone = onClear, onBack = onPop)
    }
    is Sheet.MapActions -> MapActionsSheet(ui, vm, top.body, nav, onClose = onPop)
    is Sheet.Build -> {
      val y = cmd?.yards?.firstOrNull { it.body == top.body }
      Over(onPop) {
        if (cmd == null || y == null) None("NO YARD HERE") else Frame(top = "BUILD") { s ->
          YardPicker(ui, vm, cmd, y, s, Modifier.padding(top = u(s, 60f)), onDone = onPop)
        }
      }
    }
  }
}

/** A plain screen shown as a sheet: the starfield under it, back closes it. */
@Composable
private fun Over(onBack: () -> Unit, title: String? = null, content: @Composable () -> Unit) {
  BackHandler(onBack = onBack)
  Box(Modifier.fillMaxSize()) {
    StarfieldBackground(dim = 0.25f)
    // The older screens (Senate, Diplomacy, Yards, Territory) wear the
    // same curved title and dark band as every page, instead of a title
    // floating halfway down the list.
    if (title != null) Frame(top = title) { content() } else content()
  }
}

/** The page names on the bottom arc: the one before, this one lit, the next. */
@Composable
private fun PageNames(current: Int) {
  val ctx = LocalContext.current
  val face = remember { TileKit.audiowide(ctx.applicationContext) }
  Canvas(Modifier.fillMaxSize()) {
    // ON ITS OWN GROUND: a list scrolled under the names would put two
    // strings in the same pixels, so the bottom of the face darkens first.
    drawRect(
      androidx.compose.ui.graphics.Brush.verticalGradient(
        0f to androidx.compose.ui.graphics.Color.Transparent,
        1f to Ground.copy(alpha = 0.92f),
        startY = size.height * 0.80f,
        endY = size.height * 0.93f,
      ),
      topLeft = androidx.compose.ui.geometry.Offset(0f, size.height * 0.80f),
      size = androidx.compose.ui.geometry.Size(size.width, size.height * 0.20f),
    )
    val parts = ArrayList<Pair<String, androidx.compose.ui.graphics.Color>>()
    if (current > 0) {
      parts += PAGE_NAMES[current - 1] to Label
      parts += "  ·  " to Label
    }
    parts += PAGE_NAMES[current] to Teal
    if (current < PAGE_NAMES.lastIndex) {
      parts += "  ·  " to Label
      parts += PAGE_NAMES[current + 1] to Label
    }
    rimTextBottom(parts, size.minDimension * 0.042f, size.minDimension * 0.045f, face)
  }
}

/** OFFLINE · AS OF 12M AGO: the cached empire, marked with its age. */
@Composable
private fun Offline(ui: WearViewModel.UiState) {
  if (!ui.offline || ui.stateAt <= 0L) return
  val mins = ((System.currentTimeMillis() - ui.stateAt) / 60_000L).toInt()
  val age = when {
    mins < 1 -> "JUST NOW"
    mins < 90 -> "${mins}M AGO"
    mins < 48 * 60 -> "${mins / 60}H AGO"
    else -> "${mins / 1440}D AGO"
  }
  Box(Modifier.fillMaxSize()) {
    Text(
      "OFFLINE · AS OF $age",
      color = Warn, fontSize = 8.sp,
      modifier = Modifier
        .align(Alignment.BottomCenter)
        .padding(bottom = 30.dp)
        .clip(RoundedCornerShape(8.dp))
        .background(Ground.copy(alpha = 0.85f))
        .padding(horizontal = 6.dp, vertical = 1.dp),
    )
  }
}
