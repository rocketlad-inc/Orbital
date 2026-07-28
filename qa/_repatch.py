import io, re

# ---------- FleetPanel: ApiResult error shape ----------
p = 'src/components/FleetPanel.tsx'
s = io.open(p, encoding='utf-8').read()
bad = """    if (!res.ok) {
      const errObj = res.error as { code?: string; message?: string } | string | undefined;
      const code = typeof errObj === 'object' ? errObj?.code : res.code;
      const msg = typeof errObj === 'string' ? errObj : errObj?.message;
      setFleetErr(code === 'fleet_leaderless'
        ? 'Fleet is leaderless — promote a captain first.'
        : (msg ?? 'fleet action failed'));
    }"""
good = """    if (!res.ok) {
      setFleetErr(res.error?.code === 'fleet_leaderless'
        ? 'Fleet is leaderless — promote a captain first.'
        : (res.error?.message ?? 'fleet action failed'));
    }"""
assert bad in s
s = s.replace(bad, good, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('FleetPanel err ok')

# ---------- situation report: re-apply fleet_leaderless on the NEW file ----------
p = 'src/hooks/useSituationItems.ts'
s = io.open(p, encoding='utf-8').read()
assert 'fleet_leaderless' not in s, 'already applied?'

# 1. category union — append after idle_captain terminator line
m = re.search(r"  \| 'idle_captain';([^\n]*)\n", s)
assert m
s = s.replace(m.group(0),
  "  | 'idle_captain'" + m.group(1) + "\n  | 'fleet_leaderless'; // a fleet lost its flagship — promote a captain\n", 1)

# 2. TIER_OF — after the idle_captain entry
m = re.search(r"\n(  idle_captain: +'[a-z]+',)", s)
assert m
s = s.replace(m.group(1),
  m.group(1) + "\n  // A beheaded fleet refuses new common orders until you promote —\n  // a decision by construction (DESIGN-fleets.md).\n  fleet_leaderless: 'decision',", 1)

# 3. CATEGORY_LABEL — after idle_captain label
m = re.search(r"\n(  idle_captain: +'[^']+',)", s[s.index('CATEGORY_LABEL'):])
assert m
s = s.replace(m.group(1),
  m.group(1) + "\n  fleet_leaderless: 'Fleets without a flag',", 1)

# 4. derive block
a = "    // --- One row per entity: NOW suppresses the rest ---"
assert a in s
block = """    // ---- Fleets without a flag (DESIGN-fleets.md) ----
    // Condition-based, no stamp: the row exists exactly while the fleet
    // is leaderless and clears the instant a captain is promoted.
    try {
      for (const f of gameState.fleets ?? []) {
        if (f.ownedBy !== factionId || !f.leaderless) continue;
        const anchor = f.shipIds[0];
        push({
          id: `fleet_leaderless:${f.id}`,
          category: 'fleet_leaderless',
          title: `${f.name} is leaderless`,
          subtitle: 'Promote a member captain to restore command',
          focus: anchor ? { kind: 'ship', shipId: anchor } : undefined,
          severity: 'warn',
        });
      }
    } catch { /* defensive */ }

""" + a
s = s.replace(a, block, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('situation re-applied')
