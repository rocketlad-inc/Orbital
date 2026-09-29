// ============================================================
// adminFormat — the words and numbers the admin dashboards share:
// action labels, play time, "3h ago". Split out of AdminAnalytics.tsx
// when the overview moved to AdminOverview.tsx, so neither file has to
// import the other.
// ============================================================

// Event kinds are normalized route strings ("POST bodies/build") -
// meaningful to the server, gibberish on a dashboard. Known kinds get
// hand-written labels; unknown ones get a generic de-HTTP-ing so a new
// route never shows a raw method verb again.
export const KIND_LABELS: Record<string, string> = {
  'POST bodies/build': 'Build ship',
  'POST bodies/settlement': 'Found colony',
  'POST bodies/ram': 'Asteroid ram',
  'POST settlements/buildings': 'Queue building',
  'DELETE settlements/buildings': 'Cancel building',
  'POST settlements/collector': 'Build collector',
  'DELETE settlements': 'Abandon settlement',
  'PATCH settlements': 'Rename settlement',
  'POST research': 'Set research',
  'POST trades': 'Propose trade',
  'POST trades/accept': 'Accept trade',
  'POST trades/decline': 'Decline trade',
  'POST trades/counter': 'Counter trade',
  'POST trades/cancel': 'Cancel trade',
  'POST trades/deliveries/assign': 'Assign trade delivery',
  'POST trade-routes': 'Create trade route',
  'DELETE trade-routes': 'Cancel trade route',
  'POST fleets': 'Form fleet',
  'PATCH fleets': 'Edit fleet',
  'DELETE fleets': 'Disband fleet',
  'POST fleets/orders': 'Fleet orders',
  'POST designs': 'Save ship design',
  'PATCH designs': 'Edit ship design',
  'DELETE designs': 'Delete ship design',
  'POST captains': 'Recruit captain',
  'PATCH captains': 'Edit captain',
  'POST captains/assign': 'Assign captain',
  'POST senate/proposals': 'Raise senate proposal',
  'POST senate/proposals/vote': 'Senate vote',
  'POST senate/proposals/withdraw': 'Withdraw proposal',
  'POST senate/sliders': 'Senate sliders',
  'POST ships/orders': 'Ship standing orders',
  'PATCH ships': 'Rename ship',
  'POST ships/transfer': 'Ship transfer',
  'POST ships/detonate': 'Detonate ship',
  'DELETE builds': 'Cancel ship build',
  'DELETE nodes': 'Cancel maneuver',
  'POST build-list': 'Set build list',
  'POST dyson/initiate': 'Begin Dyson project',
  'POST pacts': 'Pact action',
  'POST treaties/break': 'Break treaty',
  'POST turn/commit': 'Commit turn',
  'ui/trades': 'Open trade panel',
  'ui/recap': 'Play recap',
};
export function labelForKind(kind: string): string {
  if (KIND_LABELS[kind]) return KIND_LABELS[kind];
  if (kind.startsWith('ui/')) return `Open ${kind.slice(3)} panel`;
  const m = kind.match(/^(GET|POST|PATCH|PUT|DELETE)\s+(.*)$/);
  if (!m) return kind;
  const verb = { POST: '', PATCH: 'Edit ', PUT: 'Edit ', DELETE: 'Cancel ', GET: 'View ' }[m[1]] ?? '';
  const noun = m[2].replace(/[/-]/g, ' ');
  return (verb + noun).trim().replace(/^./, c => c.toUpperCase());
}

// Heartbeats arrive once per active minute, so a count of them IS
// minutes of play. Format 90 -> "1h 30m".
export function playTime(minutes: number): string {
  if (!minutes) return '—';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function ago(now: number, ms: number | null | undefined): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
