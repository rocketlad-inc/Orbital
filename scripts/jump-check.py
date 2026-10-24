"""Find hulls that jump on screen in a Studio take.

    node scripts/studio.mjs film <game> shot.json --out DIR --trace ...
    python scripts/jump-check.py DIR [--px 6] [--top 25]

Lorne, 2026-10-21: ships "jumping around a lot in space, I'd like that to
happen 0% of the time". The page records where it drew every hull each
frame (world units) and the zoom (trace.jsonl).

A JUMP is a step out of line with the steps around it: a hull that moves
3 px a frame and then 40 px in one frame, or that jerks hard for a single
frame while moving steadily either side. Smooth acceleration (a hard burn,
an easing glide) changes the step a little every frame and is not a jump,
so this compares each frame's step and jerk against the frames around it
(a window of WIN either side) rather than against a fixed number.

Reported: every jump over --px screen pixels of excess, worst first, with
the frame, its time and tick, and the hull.
"""
import json
import math
import sys
from collections import defaultdict

WIN = 4


def median(v):
    s = sorted(v)
    n = len(s)
    return 0.0 if n == 0 else (s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2)


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)
    d = args[0]
    px = float(args[args.index('--px') + 1]) if '--px' in args else 6.0
    top = int(args[args.index('--top') + 1]) if '--top' in args else 25
    fps = 30.0
    frames = []
    with open(f'{d}/trace.jsonl', encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if line:
                frames.append(json.loads(line))
    pos = defaultdict(dict)
    scale, tick = {}, {}
    for fr in frames:
        k = fr['k']
        scale[k] = fr.get('scale') or 0
        tick[k] = fr.get('t')
        for sid, x, y in fr.get('ships') or []:
            pos[sid][k] = (x, y)

    jumps = []
    for sid, by in pos.items():
        ks = sorted(by)
        # Screen-px step vectors between consecutive frames only.
        steps = {}
        for a, b in zip(ks, ks[1:]):
            if b == a + 1:
                sc = scale.get(b) or 0
                steps[b] = ((by[b][0] - by[a][0]) * sc, (by[b][1] - by[a][1]) * sc)
        for k, (sx, sy) in steps.items():
            if (k - 1) not in steps:
                continue
            px0, py0 = steps[k - 1]
            jerk = math.hypot(sx - px0, sy - py0)
            # The usual jerk around this frame, excluding it.
            around = []
            for j in range(k - WIN, k + WIN + 1):
                if j == k or j not in steps or (j - 1) not in steps:
                    continue
                ax, ay = steps[j]
                bx, by_ = steps[j - 1]
                around.append(math.hypot(ax - bx, ay - by_))
            if len(around) < 3:
                continue
            excess = jerk - 3 * max(1.0, median(around))
            if excess > px:
                jumps.append((excess, k, sid, math.hypot(sx, sy), jerk))
    # One report per hull per event (a jump shows at k and k+1).
    jumps.sort(reverse=True)
    seen, events = set(), []
    for e in jumps:
        key = (e[2], e[1] // 3)
        if key in seen or (e[2], e[1] // 3 - 1) in seen:
            continue
        seen.add(key)
        events.append(e)
    print(f'{len(frames)} frames, {len(pos)} hulls, {len(events)} jumps over {px}px of excess')
    for excess, k, sid, step, jerk in events[:top]:
        t = tick.get(k)
        tt = f'T{t:.2f}' if t is not None else ''
        print(f'  {excess:7.1f}px  frame {k:5d} ({k / fps:5.2f}s, {tt})  step {step:6.1f}px  {sid}')
    by_frame = defaultdict(int)
    for _, k, _, _, _ in events:
        by_frame[k] += 1
    worst = sorted(by_frame.items(), key=lambda kv: -kv[1])[:12]
    if worst:
        print('frames with the most jumping hulls:', ', '.join(f'{k} ({k / fps:.2f}s) x{n}' for k, n in worst))
    sys.exit(1 if events else 0)


if __name__ == '__main__':
    main()
