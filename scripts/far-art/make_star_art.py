"""Photospheres for the far systems' stars, from Sol's real one (the solar
surface map the overhaul already ships), regraded by spectral class so
the granulation is real and only the temperature changes."""
import os
import numpy as np
from PIL import Image
from make_far_art import gradient_map, stretch, lum

PUB = os.environ['PUB']; SRC = os.environ['SRC']
sol = np.asarray(Image.open(f'{SRC}/globes/sol.webp').convert('RGBA'), np.float32) / 255
alpha = sol[..., 3:4]
L = stretch(lum(sol[..., :3]), 1, 99.5)

STARS = {
    # Alpha Centauri A: G2V, a near-twin of the Sun, a shade whiter.
    'centauri_a': [(0, '#9a5a14'), (0.35, '#e0a040'), (0.7, '#fbe0a0'), (1, '#fffaf0')],
    # Alpha Centauri B: K1V, cooler and deeper orange.
    'centauri_b': [(0, '#6a1e08'), (0.35, '#c4501a'), (0.7, '#f4a058'), (1, '#ffe4c0')],
    # HDE 226868: an O9.7 blue supergiant, the donor feeding Cygnus X-1.
    'hde_226868': [(0, '#162e78'), (0.35, '#4a7ad0'), (0.7, '#a8c8ff'), (1, '#f6f9ff')],
}
# Each its own face: the two Centauri suns sit side by side, and the same
# granulation (sunspot and all) twice over reads as a copy.
POSE = {'centauri_a': (110, False), 'centauri_b': (250, True), 'hde_226868': (35, True)}
for key, stops in STARS.items():
    rgb = gradient_map(L, stops)
    out = np.concatenate([rgb, alpha], -1)
    img = Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8), 'RGBA')
    deg, mirror = POSE[key]
    if mirror: img = img.transpose(Image.FLIP_LEFT_RIGHT)
    img = img.rotate(deg, resample=Image.BICUBIC)
    img.save(
        f'{PUB}/globes/{key}.webp', quality=88, method=6)
    print('  star', key)
