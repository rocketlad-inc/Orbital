"""Find hulls that jump on screen in a Studio take.

    node scripts/studio.mjs film <game> shot.json --out DIR --trace ...
    python scripts/jump-check.py DIR [--px 3] [--top 25]

Lorne, 2026-10-21: ships "jumping around a lot in space, I'd like that to
happen 0% of the time". The page records where it drew every hull each
frame (world units) and the zoom (trace.jsonl). A hull moving smoothly has
a small SECOND difference frame to frame; a jump is a spike in it. This
reports every spike over --px screen pixels, worst first, with the frame
(and its time) so it can be looked at.
"""
import json
import math
import sys
from collections import defaultdict


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)
    d = args[0]
    px = float(args[args.index('--px') + 1]) if '--px' in args else 3.0
    top = int(args[args.index('--top') + 1]) if '--top' in args else 25
    fps = 30.0
    frames = []
    with open(f'{d}/trace.jsonl', encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if line:
                frames.append(json.loads(line))
    pos = defaultdict(dict)    # id -> k -> (x, y)
    scale = {}
    tick = {}
    for fr in frames:
        k = fr['k']
        scale[k] = fr.get('scale') or 0
        tick[k] = fr.get('t')
        for sid, x, y in fr.get('ships') or []:
            pos[sid][k] = (x, y)
    spikes = []
    for sid, by in pos.items():
        ks = sorted(by)
        for a, b, c in zip(ks, ks[1:], ks[2:]):
            if not (b == a + 1 and c == b + 1):
                continue
            (x0, y0), (x1, y1), (x2, y2) = by[a], by[b], by[c]
            jx = (x2 - x1) - (x1 - x0)
            jy = (y2 - y1) - (y1 - y0)
            jerk = math.hypot(jx, jy) * (scale.get(c) or 0)
            step = math.hypot(x2 - x1, y2 - y1) * (scale.get(c) or 0)
            if jerk > px:
                spikes.append((jerk, c, sid, step))
    spikes.sort(reverse=True)
    hulls = len(pos)
    print(f'{len(frames)} frames, {hulls} hulls, {len(spikes)} spikes over {px}px')
    for jerk, k, sid, step in spikes[:top]:
        t = tick.get(k)
        print(f'  {jerk:7.1f}px  frame {k:5d} ({k / fps:5.2f}s, T{t:.2f})  step {step:6.1f}px  {sid}'
              if t is not None else f'  {jerk:7.1f}px  frame {k:5d}  {sid}')
    by_frame = defaultdict(int)
    for _, k, _, _ in spikes:
        by_frame[k] += 1
    worst = sorted(by_frame.items(), key=lambda kv: -kv[1])[:10]
    if worst:
        print('frames with the most jumping hulls:', ', '.join(f'{k} ({k / fps:.2f}s) x{n}' for k, n in worst))


if __name__ == '__main__':
    main()
