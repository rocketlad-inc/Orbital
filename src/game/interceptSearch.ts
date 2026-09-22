// ============================================================
// Search for the intercept list.
//
// A live board offered 192 intercept targets in one scroll box — "it
// also definitely needs a search bar" (Noah). One query matches the
// hull, its owner, or where it is going, so "stonekin", "mega" and
// "jupiter" all find the same Mega Destroyer, and "yours" finds your own.
// ============================================================

export interface InterceptSearchFields {
  shipName: string;
  /** Owner's empire name, or "yours" for the viewer's own hulls. */
  ownerName: string;
  destName: string;
}

/** Every item whose ship, owner or destination contains the query,
 *  case-insensitively. A blank query returns the list unchanged. */
export function filterIntercepts<T>(
  items: T[],
  query: string,
  fields: (item: T) => InterceptSearchFields,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => {
    const f = fields(item);
    return [f.shipName, f.ownerName, f.destName]
      .some((s) => (s ?? '').toLowerCase().includes(needle));
  });
}
