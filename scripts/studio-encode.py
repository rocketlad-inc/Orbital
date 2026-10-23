#!/usr/bin/env python
# studio-encode.py — frames from `studio.mjs film` into a GIF and a WebP.
#
#   python scripts/studio-encode.py <frames dir> [--name NAME] [--width 960]
#                                   [--gif-fps 15] [--webp-fps 30] [--out DIR]
#
# The Reddit clips were encoded this way (2026-09). The frames are exact
# (a stepped clock, one PNG per 1/30 s), so there is no denoising and no
# trimming: holds and moves are scripted to the frame. GIF at 15 fps,
# because that is the rate every viewer plays; WebP at the full 30 fps.
# One palette for the whole GIF, built from a spread of frames, so colours
# do not flicker; unchanged pixels become transparent over the previous
# frame, so a still frame compresses to almost nothing. Needs Pillow and
# numpy.
import argparse, json, os
from PIL import Image, ImageDraw, ImageFont, ImageEnhance
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

def font(path, size):
    for f in (path, 'C:/Windows/Fonts/bahnschrift.ttf', 'C:/Windows/Fonts/segoeui.ttf'):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            continue
    return ImageFont.load_default()

def end_card(last, fps):
    """Frames that take the clip's last frame to its end card."""
    if not a.end_title:
        return []
    w, h = last.size
    title = font(os.path.join(HERE, 'assets', 'Audiowide-Regular.ttf'), max(12, round(w * 0.085)))
    line = font('C:/Windows/Fonts/bahnschrift.ttf', max(10, round(w * 0.03)))
    n, fade = max(1, round(a.end_seconds * fps)), max(1, round(0.6 * fps))
    out = []
    for i in range(n):
        u = min(1.0, i / fade)
        e = u * u * (3 - 2 * u)
        im = ImageEnhance.Brightness(last).enhance(1 - 0.7 * e).convert('RGBA')
        txt = Image.new('RGBA', im.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(txt)
        tw = d.textlength(a.end_title, font=title)
        d.text(((w - tw) / 2, h * 0.36), a.end_title, font=title, fill=(235, 244, 255, round(255 * e)))
        if a.end_line:
            lw = d.textlength(a.end_line, font=line)
            d.text(((w - lw) / 2, h * 0.36 + w * 0.115), a.end_line, font=line, fill=(150, 200, 235, round(255 * e)))
        out.append(Image.alpha_composite(im, txt).convert('RGB'))
    return out

p = argparse.ArgumentParser()
p.add_argument('dir')
p.add_argument('--name', default=None)
p.add_argument('--width', type=int, default=960)
p.add_argument('--gif-fps', type=float, default=15)
p.add_argument('--webp-fps', type=float, default=30)
p.add_argument('--out', default=None)
p.add_argument('--no-gif', action='store_true')
# Time-lapse: 2 plays the take twice as fast by sampling every other moment.
p.add_argument('--speed', type=float, default=1.0)
# An end card: the last frame dims and the title and line fade in over it.
# A feed clip with no name on it is an ad for nothing (judges, 2026-10-22).
p.add_argument('--end-title', default=None)
p.add_argument('--end-line', default='')
p.add_argument('--end-seconds', type=float, default=2.5)
a = p.parse_args()

src = a.dir
name = a.name or os.path.basename(os.path.normpath(src))
out_dir = a.out or os.path.dirname(os.path.normpath(src)) or '.'
frames = json.load(open(os.path.join(src, 'frames.json')))
times = [(f['t'] - frames[0]['t']) / max(0.1, a.speed) for f in frames]
end = times[-1] + (times[1] - times[0] if len(times) > 1 else 1 / 30 / max(0.1, a.speed))

def pick(fps):
    n = int(round(end * fps))
    out, j = [], 0
    for k in range(n):
        t = k / fps
        while j + 1 < len(times) and times[j + 1] <= t + 1e-9:
            j += 1
        out.append(frames[j]['f'])
    return out

def load(f):
    im = Image.open(os.path.join(src, f)).convert('RGB')
    h = round(im.height * a.width / im.width)
    return im.resize((a.width, h - h % 2), Image.LANCZOS)

# WebP, full rate.
wf = [load(f) for f in pick(a.webp_fps)]
wf += end_card(wf[-1], a.webp_fps)
webp = os.path.join(out_dir, name + '.webp')
# libwebp's animation encoder now and then fails a long take with
# "WebPEncodingError: 1" and then takes the same frames on a retry.
for attempt in range(4):
    try:
        wf[0].save(webp, save_all=True, append_images=wf[1:], duration=round(1000 / a.webp_fps), loop=0, quality=82, method=4)
        break
    except RuntimeError as e:
        if attempt == 3:
            raise
        print(f"webp encode failed ({e}); trying again")
print(f"{webp}: {len(wf)} frames @ {a.webp_fps:g}fps, {wf[0].size[0]}x{wf[0].size[1]}, {os.path.getsize(webp) // 1024}KB")

if a.no_gif:
    raise SystemExit(0)

# GIF: shared palette, transparent repeats.
gf = [load(f) for f in pick(a.gif_fps)]
gf += end_card(gf[-1], a.gif_fps)
sample = gf[:: max(1, len(gf) // 12)][:12]
sw, sh = sample[0].size
tile = Image.new('RGB', (sw, sh * len(sample)))
for i, im in enumerate(sample):
    tile.paste(im, (0, i * sh))
pal = tile.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
pal.putpalette((pal.getpalette() + [0] * 768)[:765] + [255, 0, 255])   # slot 255 is transparency
idx = [np.asarray(im.quantize(palette=pal, dither=Image.Dither.NONE)) for im in gf]
TRANSP = 255
palette = pal.getpalette()[:255 * 3] + [0, 0, 0]
q = []
for i, fa in enumerate(idx):
    o = fa.copy()
    if i > 0:
        o[fa == idx[i - 1]] = TRANSP
    im = Image.fromarray(o.astype(np.uint8), 'P')
    im.putpalette(palette)
    q.append(im)
gif = os.path.join(out_dir, name + '.gif')
q[0].save(gif, save_all=True, append_images=q[1:], duration=round(1000 / a.gif_fps), loop=0, optimize=False, disposal=1, transparency=TRANSP)
print(f"{gif}: {len(q)} frames @ {a.gif_fps:g}fps, {os.path.getsize(gif) // 1024}KB")
