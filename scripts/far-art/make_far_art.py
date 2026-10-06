"""Globe art for the far systems, built the way the invented Sol worlds were:
each from a real spacecraft surface map (NASA/USGS public domain; Solar
System Scope CC BY 4.0), transformed and recoloured into its own identity.

Raw and terraformed twins get the SAME geometric transform, so the
topography lines up when the game crossfades one into the other.

Writes, per world:
  public/surfaces/hi/<id>.webp   double-res flat map (spinning, big draws)
  public/surfaces/<id>.webp      flat map
  public/globes/<id>.webp        512px pre-rendered sphere (still-worlds)
  ...and the same three for <id>_tf where the world can be terraformed.

Run from the repo root (needs Python with numpy and Pillow built with WebP):
  PUB=public SRC=public python scripts/far-art/make_far_art.py [world ...]
  PUB=public SRC=public python scripts/far-art/make_star_art.py
then `npm run art:version` so clients drop their cached copies. Point PUB
at a scratch folder first to review before overwriting. The sources are
Sol's own maps, so regenerating never reads its own output.
"""
import os, sys
import numpy as np
from PIL import Image
from sphere import render_sphere

PUB = os.environ['PUB']            # .../public of the worktree we MEAN
SRC = os.environ.get('SRC', PUB)   # sources are the shipped maps

def load(path):
    return np.asarray(Image.open(path).convert('RGB'), dtype=np.float32) / 255.0

def src_map(key, hi=True):
    p = f'{SRC}/surfaces/hi/{key}.webp' if hi else f'{SRC}/surfaces/{key}.webp'
    if hi and not os.path.exists(p):
        p = f'{SRC}/surfaces/{key}.webp'
    return load(p)

def lum(m):
    return m[..., 0] * 0.299 + m[..., 1] * 0.587 + m[..., 2] * 0.114

def hexrgb(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], np.float32) / 255

def gradient_map(L, stops):
    """stops: [(pos, '#hex'), ...] sorted by pos. Maps luminance to colour."""
    pos = np.array([p for p, _ in stops], np.float32)
    cols = np.stack([hexrgb(c) for _, c in stops])
    out = np.empty(L.shape + (3,), np.float32)
    for ch in range(3):
        out[..., ch] = np.interp(L, pos, cols[:, ch])
    return out

def stretch(L, lo=2, hi=98):
    a, b = np.percentile(L, lo), np.percentile(L, hi)
    return np.clip((L - a) / max(b - a, 1e-6), 0, 1)

def transform(m, roll=0.0, mirror=False, flip=False):
    """Geometric identity change. roll: fraction of a turn."""
    if mirror: m = m[:, ::-1]
    if flip: m = m[::-1]
    if roll: m = np.roll(m, int(roll * m.shape[1]), axis=1)
    return m

def fbm(shape, seed, octaves=5, scale=6.0, wrap=True):
    """Tileable-in-longitude value noise, for clouds and shimmer."""
    rng = np.random.default_rng(seed)
    H, W = shape
    out = np.zeros(shape, np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        gw = int(scale * 2 ** o) * 2
        gh = max(2, gw // 2)
        grid = rng.random((gh + 1, gw)).astype(np.float32)
        ys = np.linspace(0, gh, H, endpoint=False)
        xs = np.linspace(0, gw, W, endpoint=False)
        y0 = np.floor(ys).astype(int); x0 = np.floor(xs).astype(int)
        fy = (ys - y0)[:, None]; fx = (xs - x0)[None, :]
        fy = fy * fy * (3 - 2 * fy); fx = fx * fx * (3 - 2 * fx)
        x1 = (x0 + 1) % gw; y1 = np.minimum(y0 + 1, gh)
        a = grid[y0][:, x0]; b = grid[y0][:, x1]
        c = grid[y1][:, x0]; d = grid[y1][:, x1]
        out += amp * ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy)
        tot += amp; amp *= 0.5
    return out / tot

def detail(base, L, k=0.35):
    """Put the source map's fine relief back over a gradient-mapped colour,
    so recolouring never flattens the real terrain."""
    blur = np.asarray(Image.fromarray((L * 255).astype(np.uint8)).resize(
        (L.shape[1] // 8, L.shape[0] // 8), Image.BILINEAR).resize(
        (L.shape[1], L.shape[0]), Image.BILINEAR), np.float32) / 255
    hp = (L - blur)[..., None]
    return np.clip(base + hp * k, 0, 1)

def tint(m, rgb, k):
    """Pull a map toward a colour by k, keeping its light and dark."""
    L = lum(m)[..., None]
    target = np.clip(L * 2 * np.array(rgb, np.float32), 0, 1)
    return np.clip(m * (1 - k) + target * k, 0, 1)

def save_set(key, flat, *, small=False, tilt=0.0, lon0=0.0, flatten=0.0):
    """Write hi + lo flat maps and the 512px sphere sprite."""
    hiW = 1024 if small else 2048
    loW = hiW // 2
    img = Image.fromarray((np.clip(flat, 0, 1) * 255).astype(np.uint8), 'RGB')
    hi = img.resize((hiW, hiW // 2), Image.LANCZOS)
    lo = img.resize((loW, loW // 2), Image.LANCZOS)
    os.makedirs(f'{PUB}/surfaces/hi', exist_ok=True)
    hi.save(f'{PUB}/surfaces/hi/{key}.webp', quality=82, method=6)
    lo.save(f'{PUB}/surfaces/{key}.webp', quality=82, method=6)
    m = np.asarray(lo, np.float32) / 255
    sprite = render_sphere(m, 512, tilt=tilt, lon0=lon0, limb=0.5, flatten=flatten, aa=2)
    sprite.save(f'{PUB}/globes/{key}.webp', quality=86, method=6)
    print(f'  {key}: hi {hi.size} lo {lo.size} globe 512')

# ---------------------------------------------------------------------
WORLDS = []

def world(fn):
    WORLDS.append(fn)
    return fn

@world
def verdant():
    # A garden under a doubled sky: jungle, open plains and dry uplands
    # by rainfall, teal shallows over drowned coasts, and real weather.
    # Ganymede's terraformed land/sea, mirrored and turned.
    T = dict(roll=0.37, mirror=True)
    tf = transform(src_map('ganymede_tf'), **T)
    L = lum(tf)
    H, W = L.shape
    sea = ((tf[..., 2] > tf[..., 1] * 1.05) & (tf[..., 2] > tf[..., 0] * 1.2)).astype(np.float32)
    ice = ((tf[..., 0] > 0.82) & (tf[..., 1] > 0.82) & (tf[..., 2] > 0.82)).astype(np.float32)
    # shallows: how close a sea pixel is to land
    soft = np.asarray(Image.fromarray((sea * 255).astype(np.uint8)).resize(
        (W // 16, H // 16), Image.BILINEAR).resize((W, H), Image.BILINEAR), np.float32) / 255
    shallow = np.clip((1 - soft) * 2.2, 0, 1) * sea
    deep = gradient_map(stretch(L), [(0, '#041a2a'), (0.6, '#0a3a4e'), (1, '#16566a')])
    shoal = np.array([0.16, 0.56, 0.56], np.float32)
    water = deep * (1 - shallow[..., None] * 0.75) + shoal * shallow[..., None] * 0.75
    rain = fbm((H, W), 21, octaves=5, scale=3)
    lat = np.abs(np.linspace(-1, 1, H))[:, None]
    wet = np.clip(rain * 1.3 - lat * 0.35, 0, 1)
    jungle = hexrgb('#123c18'); plain = hexrgb('#4c7e30'); dry = hexrgb('#9a8a52')
    land = np.where((wet > 0.55)[..., None], jungle * 1.0,
                    np.where((wet > 0.32)[..., None], plain, dry))
    blend = np.clip((wet - 0.32) * 4, 0, 1)[..., None]
    land = land * 0.6 + (jungle * blend + plain * (1 - blend)) * 0.4
    land = land * (0.75 + stretch(L)[..., None] * 0.5)
    base = water * sea[..., None] + land * (1 - sea[..., None])
    base = base * (1 - ice[..., None]) + np.array([0.9, 0.94, 0.96]) * ice[..., None]
    base = detail(base, L, 0.22)
    # weather: streaked along latitude, heavier in the storm belts
    cl = fbm((H, W * 2), 11, octaves=6, scale=5)[:, ::2]
    belts = 0.55 + 0.45 * np.cos(np.linspace(-1, 1, H) * np.pi * 3)[:, None] ** 2
    clouds = np.clip((cl * belts - 0.36) * 3.0, 0, 1)[..., None] * 0.82
    raw = base * (1 - clouds) + clouds * np.array([0.96, 0.98, 1.0])
    save_set('verdant', raw, tilt=0.12, lon0=0.6)
    # Already alive: terraforming opens it up — farmland where the dry
    # uplands were, calmer skies, the same coasts.
    farmed = base.copy()
    farm = (wet < 0.32) & (sea < 0.5)
    farmed[farm] = farmed[farm] * 0.5 + np.array([0.52, 0.6, 0.28]) * 0.5
    calm = clouds * 0.55
    save_set('verdant_tf', farmed * (1 - calm) + calm * 0.97, tilt=0.12, lon0=0.6)

@world
def cinder():
    # "Two suns have baked it to the colour of old iron." Io's volcanic
    # face in rust, oxide and charcoal; its calderas go black.
    T = dict(roll=0.21, flip=True)
    m = transform(src_map('io'), **T)
    L = stretch(lum(m))
    raw = gradient_map(L, [(0, '#140a08'), (0.25, '#3a1a10'), (0.5, '#7a3418'),
                           (0.72, '#b4582a'), (0.9, '#d8925a'), (1, '#f0d0a8')])
    save_set('cinder', detail(raw, L, 0.3), tilt=-0.08, lon0=1.1)
    tf = transform(src_map('io_tf'), **T)
    save_set('cinder_tf', tint(tf, (0.7, 0.38, 0.22), 0.25), tilt=-0.08, lon0=1.1)

@world
def echelon():
    # Supernova ejecta: a heavy-element crust in bronze and gold, with
    # Mercury's craters catching the light like hammered metal.
    T = dict(roll=0.63, mirror=True)
    m = transform(src_map('mercury'), **T)
    L = stretch(lum(m))
    raw = gradient_map(L, [(0, '#1a1208'), (0.3, '#4a3418'), (0.55, '#8a6630'),
                           (0.78, '#c89a4a'), (0.92, '#ecc878'), (1, '#fff0c0')])
    save_set('echelon', detail(raw, L, 0.35), tilt=0.06, lon0=-0.4)
    tf = transform(src_map('mercury_tf'), **T)
    save_set('echelon_tf', tint(tf, (0.78, 0.62, 0.34), 0.28), tilt=0.06, lon0=-0.4)

@world
def requiem():
    # Irradiated by the X-ray binary: dark wine-violet rock, its impact
    # scars fused to pale glass.
    T = dict(roll=0.44, flip=True)
    m = transform(src_map('callisto'), **T)
    L = stretch(lum(m))
    raw = gradient_map(L, [(0, '#0a0608'), (0.3, '#24121c'), (0.55, '#4a2638'),
                           (0.78, '#7a4a64'), (0.92, '#b896c0'), (1, '#ece0f4')])
    save_set('requiem', detail(raw, L, 0.3), tilt=-0.15, lon0=0.2)
    tf = transform(src_map('callisto_tf'), **T)
    save_set('requiem_tf', tint(tf, (0.5, 0.42, 0.62), 0.25), tilt=-0.15, lon0=0.2)

@world
def prismara():
    # Crimson's ice moon: a lavender shell with a faint pearl sheen, and
    # its fractures re-lit so they run through the spectrum as it turns.
    # Enceladus, not Europa: Europa's map is a mosaic, and the fracture
    # detector lit its rectangular tile seams as brightly as its cracks.
    T = dict(roll=0.12, mirror=True)
    m = transform(src_map('enceladus'), **T)
    L = stretch(lum(m), 1, 99.5)
    H, W = L.shape
    shell = gradient_map(L, [(0, '#4a3e74'), (0.35, '#8a7cc8'), (0.7, '#c4b0ff'), (1, '#f8f4ff')])
    blur = np.asarray(Image.fromarray((L * 255).astype(np.uint8)).resize(
        (W // 10, H // 10), Image.BILINEAR).resize((W, H), Image.BILINEAR), np.float32) / 255
    d = blur - L
    t0, t1 = np.percentile(d, 95.5), np.percentile(d, 99.2)
    cracks = np.clip((d - t0) / max(t1 - t0, 1e-6), 0, 1)   # the finest ~4%
    hue = (np.arange(W)[None, :] / W * 4 + np.arange(H)[:, None] / H * 1.5
           + fbm((H, W), 7, 4, 4) * 0.8) % 1.0
    k = hue * 6
    r = np.clip(np.abs(k - 3) - 1, 0, 1); g = np.clip(2 - np.abs(k - 2), 0, 1); b = np.clip(2 - np.abs(k - 4), 0, 1)
    prism = np.stack([r, g, b], -1) * 0.7 + 0.3
    sheen = 0.06
    raw = shell * (1 - sheen) + prism * sheen * (0.6 + 0.4 * L[..., None])
    raw = raw * (1 - cracks[..., None] * 0.9) + prism * cracks[..., None] * 0.9
    save_set('prismara', detail(raw, L, 0.2), small=True, tilt=0.1, lon0=2.0)
    tf = transform(src_map('enceladus_tf'), **T)
    save_set('prismara_tf', tint(tf, (0.5, 0.45, 0.85), 0.22), small=True, tilt=0.1, lon0=2.0)

@world
def farspire():
    # The lonely outpost at Centauri's edge: frozen lilac-grey.
    T = dict(roll=0.71)
    m = transform(src_map('charon'), **T)
    L = stretch(lum(m))
    raw = gradient_map(L, [(0, '#16141e'), (0.35, '#3c3850'), (0.65, '#7a72a0'),
                           (0.85, '#a8a0c8'), (1, '#ece8f8')])
    save_set('farspire', detail(raw, L, 0.3), small=True, tilt=0.18, lon0=-1.0)
    tf = transform(src_map('charon_tf'), **T)
    save_set('farspire_tf', tint(tf, (0.62, 0.6, 0.78), 0.2), small=True, tilt=0.18, lon0=-1.0)

@world
def reliquary():
    # Cygnus's outermost: slate, cold and dim, the colour of old stone.
    T = dict(roll=0.33, flip=True, mirror=True)
    m = transform(src_map('eris'), **T)
    L = stretch(lum(m))
    raw = gradient_map(L, [(0, '#121114'), (0.35, '#34303a'), (0.65, '#5e5868'),
                           (0.85, '#8e8898'), (1, '#d0ccd8')])
    save_set('reliquary', detail(raw, L, 0.3), small=True, tilt=-0.1, lon0=0.9)
    tf = transform(src_map('eris_tf'), **T)
    save_set('reliquary_tf', tint(tf, (0.5, 0.5, 0.58), 0.2), small=True, tilt=-0.1, lon0=0.9)

@world
def crimson():
    # A red giant of a giant: Jupiter's turbulence in oxblood, rust and
    # cream, upside down so its great storm rides the other hemisphere.
    T = dict(roll=0.55, flip=True)
    m = transform(src_map('jupiter'), **T)
    L = stretch(lum(m), 3, 97)
    raw = gradient_map(L, [(0, '#3a0a0c'), (0.3, '#741a1a'), (0.55, '#a83430'),
                           (0.75, '#cc5c4c'), (0.9, '#dea47e'), (1, '#ecd0b0')])
    save_set('crimson', detail(raw, L, 0.25), tilt=0.05, flatten=0.06)

@world
def vellichor():
    # Bleached by the X-ray binary: methane stripped, hydrogen ionised —
    # Saturn's soft bands gone pale blue-violet.
    T = dict(roll=0.18, flip=True)
    m = transform(src_map('saturn'), **T)
    L = stretch(lum(m), 1, 99)
    raw = gradient_map(L, [(0, '#1c1638'), (0.35, '#4a3c80'), (0.6, '#8870b0'),
                           (0.82, '#b4a4dc'), (1, '#ecE6fa'.lower())])
    save_set('vellichor', detail(raw, L, 0.2), tilt=-0.06, flatten=0.08)

# --- The giants' moons (2026-10-06: every gas giant holds at least three).

def glow_cracks(L, lo=94.0, hi=99.0, shrink=10):
    """The finest dark seams of a map, 0..1: what fissures look like."""
    H, W = L.shape
    blur = np.asarray(Image.fromarray((L * 255).astype(np.uint8)).resize(
        (W // shrink, H // shrink), Image.BILINEAR).resize((W, H), Image.BILINEAR), np.float32) / 255
    d = blur - L
    t0, t1 = np.percentile(d, lo), np.percentile(d, hi)
    return np.clip((d - t0) / max(t1 - t0, 1e-6), 0, 1)

@world
def scoria():
    # Crimson's tidal forge: plates of black glass split by glowing rock.
    # Venus's radar map: real lava plains, and whole (Triton's Voyager
    # coverage ends in a hard edge that lit up as a seam).
    T = dict(roll=0.58, flip=True)
    m = transform(src_map('venus'), **T)
    L = stretch(lum(m))
    rock = gradient_map(L, [(0, '#050304'), (0.45, '#140c0a'), (0.75, '#2c1c16'), (1, '#5a3c2c')])
    fire = glow_cracks(L, 91.0, 98.5, shrink=14)[..., None]
    lava = gradient_map(fire[..., 0], [(0, '#7a1c08'), (0.5, '#e05a14'), (1, '#ffd27a')])
    raw = rock * (1 - fire * 0.95) + lava * fire * 0.95
    save_set('scoria', detail(raw, L, 0.25), small=True, tilt=0.08, lon0=0.4)
    tf = transform(src_map('venus_tf'), **T)
    save_set('scoria_tf', tint(tf, (0.62, 0.4, 0.3), 0.25), small=True, tilt=0.08, lon0=0.4)

@world
def umber():
    # Crimson's outer moon: leather-dark and cratered to the horizon.
    T = dict(roll=0.27, mirror=True)
    m = transform(src_map('umbriel'), **T)
    L = stretch(lum(m))
    raw = gradient_map(L, [(0, '#120c08'), (0.35, '#3a2618'), (0.65, '#6a4a32'),
                           (0.85, '#9a7656'), (1, '#d8bc98')])
    save_set('umber', detail(raw, L, 0.32), small=True, tilt=-0.12, lon0=-0.7)
    tf = transform(src_map('umbriel_tf'), **T)
    save_set('umber_tf', tint(tf, (0.6, 0.48, 0.36), 0.22), small=True, tilt=-0.12, lon0=-0.7)

@world
def elegy():
    # A patchwork monument in ash-blue. Rhea's whole Cassini map: Miranda
    # was the obvious terraces, but half of it was never imaged.
    T = dict(roll=0.81, flip=True)
    m = transform(src_map('rhea'), **T)
    L = stretch(lum(m))
    raw = gradient_map(L, [(0, '#0e121a'), (0.35, '#2c3648'), (0.65, '#6a7890'),
                           (0.85, '#a8b4c8'), (1, '#eef2f8')])
    save_set('elegy', detail(raw, L, 0.3), small=True, tilt=0.14, lon0=1.6)
    tf = transform(src_map('rhea_tf'), **T)
    save_set('elegy_tf', tint(tf, (0.48, 0.54, 0.66), 0.22), small=True, tilt=0.14, lon0=1.6)

@world
def vesper():
    # The evening star of Cygnus: Titania's canyons in silver-violet.
    T = dict(roll=0.36, mirror=True, flip=True)
    m = transform(src_map('titania'), **T)
    L = stretch(lum(m))
    raw = gradient_map(L, [(0, '#16121e'), (0.35, '#40384e'), (0.65, '#8a7ea4'),
                           (0.85, '#c4b8dc'), (1, '#f6f2fc')])
    save_set('vesper', detail(raw, L, 0.3), small=True, tilt=-0.05, lon0=-1.4)
    tf = transform(src_map('titania_tf'), **T)
    save_set('vesper_tf', tint(tf, (0.62, 0.56, 0.74), 0.22), small=True, tilt=-0.05, lon0=-1.4)

@world
def threnody():
    # Dark indigo stone splashed with bright rays: Oberon's craters keep
    # their ejecta, so the bright end of the ramp goes nearly white.
    T = dict(roll=0.64)
    m = transform(src_map('oberon'), **T)
    L = stretch(lum(m), 2, 99.5)
    raw = gradient_map(L, [(0, '#0e0c1c'), (0.3, '#2a2850'), (0.6, '#4e4c7c'),
                           (0.85, '#9896c4'), (1, '#f2f2fe')])
    save_set('threnody', detail(raw, L, 0.3), small=True, tilt=0.2, lon0=0.9)
    tf = transform(src_map('oberon_tf'), **T)
    save_set('threnody_tf', tint(tf, (0.42, 0.42, 0.62), 0.25), small=True, tilt=0.2, lon0=0.9)

# --- The terrestrial worlds' moons (2026-10-06: no one-world systems).

def _ramp_moon(key, src, T, stops, tf_rgb, tilt, lon0, lo=2, hi=98, k=0.3, tf_k=0.22):
    m = transform(src_map(src), **T)
    L = stretch(lum(m), lo, hi)
    save_set(key, detail(gradient_map(L, stops), L, k), small=True, tilt=tilt, lon0=lon0)
    tf = transform(src_map(src + '_tf'), **T)
    save_set(key + '_tf', tint(tf, tf_rgb, tf_k), small=True, tilt=tilt, lon0=lon0)

@world
def thistle():
    # Verdant's near moon: grey-violet, frost-feathered ridges.
    _ramp_moon('thistle', 'ganymede', dict(roll=0.47, flip=True),
               [(0, '#16121c'), (0.35, '#3e3450'), (0.65, '#7a6c90'), (0.85, '#b8acc8'), (1, '#f0ecf6')],
               (0.55, 0.5, 0.64), tilt=0.1, lon0=0.3)

@world
def sorrel():
    # Rust-red, like the dry uplands it hangs over. Luna's maria in iron.
    _ramp_moon('sorrel', 'luna', dict(roll=0.19, mirror=True),
               [(0, '#1a0c08'), (0.35, '#4a2216'), (0.65, '#8a4630'), (0.85, '#c07a58'), (1, '#ecc8a8')],
               (0.66, 0.42, 0.32), tilt=-0.14, lon0=1.2)

@world
def clinker():
    # Furnace slag: Phobos in charcoal, a last glow in its grooves.
    T = dict(roll=0.33, flip=True)
    m = transform(src_map('phobos'), **T)
    L = stretch(lum(m))
    rock = gradient_map(L, [(0, '#060404'), (0.45, '#1a1210'), (0.75, '#3a2a24'), (1, '#6a5048')])
    fire = glow_cracks(L, 95.0, 99.3)[..., None]
    ember = gradient_map(fire[..., 0], [(0, '#5a1806'), (1, '#e0702a')])
    raw = rock * (1 - fire * 0.7) + ember * fire * 0.7
    save_set('clinker', detail(raw, L, 0.3), small=True, tilt=0.05, lon0=-0.8)
    tf = transform(src_map('phobos_tf'), **T)
    save_set('clinker_tf', tint(tf, (0.5, 0.38, 0.32), 0.22), small=True, tilt=0.05, lon0=-0.8)

@world
def lacrimosa():
    # Requiem's pale moon: ice the blue of old tears. Ceres's complete
    # Dawn map (Titan's showed its tile edges at the pole).
    _ramp_moon('lacrimosa', 'ceres', dict(roll=0.72),
               [(0, '#0c1420'), (0.35, '#2a4058'), (0.65, '#6a8aa8'), (0.85, '#a8c0d8'), (1, '#eef4fa')],
               (0.46, 0.56, 0.68), tilt=0.16, lon0=2.2)

@world
def sanctus():
    # Bright ivory and unreasonably calm. Deimos's smooth regolith.
    _ramp_moon('sanctus', 'deimos', dict(roll=0.58, mirror=True),
               [(0, '#2a261e'), (0.35, '#6a6250'), (0.65, '#b0a68a'), (0.85, '#e0d6bc'), (1, '#fffaf0')],
               (0.7, 0.66, 0.56), tilt=-0.08, lon0=-1.6)

@world
def gilt():
    # A gold-leafed shard of Echelon's supernova. Mars, in gold.
    _ramp_moon('gilt', 'mars', dict(roll=0.86, flip=True),
               [(0, '#2a1c08'), (0.3, '#7a5818'), (0.6, '#c09630'), (0.82, '#e8c860'), (1, '#fff6c8')],
               (0.8, 0.66, 0.3), tilt=0.12, lon0=0.7, lo=5, hi=99, k=0.35, tf_k=0.38)

# --- The far belts' asteroids (2026-10-06): the Kindling and the Ossuary.
# Rock that cannot be terraformed, so a raw map only (NO_TF_GLOBE).

def _rock(key, src, T, stops, tilt, lon0, lo=2, hi=98, k=0.35):
    m = transform(src_map(src), **T)
    L = stretch(lum(m), lo, hi)
    save_set(key, detail(gradient_map(L, stops), L, k), small=True, tilt=tilt, lon0=lon0)

@world
def flint():
    _rock('flint', 'iron_anna', dict(roll=0.31, mirror=True),
          [(0, '#100f0e'), (0.35, '#34322e'), (0.65, '#6e6a62'), (0.85, '#a8a298'), (1, '#e6e2da')], 0.12, 0.5)

@world
def tinder():
    _rock('tinder', 'styx_rock', dict(roll=0.66, flip=True),
          [(0, '#140e08'), (0.35, '#4a3420'), (0.65, '#8a6844'), (0.85, '#b8966a'), (1, '#e8d4b0')], -0.1, -0.9)

@world
def ember():
    _rock('ember', 'black_sky', dict(roll=0.14),
          [(0, '#0a0605'), (0.4, '#2a140e'), (0.7, '#6a2e18'), (0.88, '#b0603a'), (1, '#f0b088')], 0.06, 1.7)

@world
def pyrite():
    _rock('pyrite', 'midas', dict(roll=0.52, mirror=True, flip=True),
          [(0, '#1a1406'), (0.35, '#5a4816'), (0.65, '#a08a34'), (0.85, '#d0b85a'), (1, '#fff2b0')], -0.16, 0.2)

@world
def cenotaph():
    _rock('cenotaph', 'vesta', dict(roll=0.77),
          [(0, '#0c0a10'), (0.35, '#2e2a38'), (0.65, '#5e5870'), (0.85, '#9a94a8'), (1, '#e4e0ec')], 0.1, -1.2)

@world
def epitaph():
    _rock('epitaph', 'vagrant', dict(roll=0.09, flip=True),
          [(0, '#0e0c12'), (0.35, '#363042'), (0.65, '#706888'), (0.85, '#a8a0bc'), (1, '#ece8f4')], -0.08, 2.3)

@world
def votive():
    _rock('votive', 'juno', dict(roll=0.43, mirror=True),
          [(0, '#140e06'), (0.35, '#4a3614'), (0.65, '#9a7a34'), (0.85, '#d0aa5c'), (1, '#fbe6b0')], 0.14, 0.9)

@world
def marrow():
    _rock('marrow', 'augustin', dict(roll=0.88),
          [(0, '#24201a'), (0.35, '#5e584c'), (0.65, '#a49c8a'), (0.85, '#d4ccb8'), (1, '#fbf8ee')], -0.12, -0.3)

if __name__ == '__main__':
    only = set(sys.argv[1:])
    for fn in WORLDS:
        if only and fn.__name__ not in only:
            continue
        print(fn.__name__)
        fn()
