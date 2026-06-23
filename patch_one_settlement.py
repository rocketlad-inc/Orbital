"""Enforce one city + one station per body — client + server + error message."""
from pathlib import Path


def patch(path_str, old, new, label):
    p = Path(path_str)
    text = p.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"MISS: {label} ({path_str})")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"OK:   {label}")


# ----- 1) BodyInspector: compute bodyHasCity/bodyHasStation -----
patch(
    "src/components/BodyInspector.tsx",
    "  const cityAllowed = canHostCity(body);\n  const stationAllowed = canHostStation(body);",
    "  const cityAllowed = canHostCity(body);\n"
    "  const stationAllowed = canHostStation(body);\n"
    "\n"
    "  // One-of-each rule: a body hosts at most one city and one station\n"
    "  // total (regardless of owner). Once a settlement of that type lands,\n"
    "  // the corresponding deploy button disappears.\n"
    "  const bodyHasCity = gameState.settlements.some(\n"
    "    s => s.bodyId === bodyId && s.type === 'city',\n"
    "  );\n"
    "  const bodyHasStation = gameState.settlements.some(\n"
    "    s => s.bodyId === bodyId && s.type === 'station',\n"
    "  );",
    "BodyInspector: bodyHasCity/Station vars",
)

# ----- 2) BodyInspector: gate the city deploy button -----
patch(
    "src/components/BodyInspector.tsx",
    "            {cityAllowed && (!typeFilter || typeFilter === 'city') && (",
    "            {cityAllowed && !bodyHasCity && (!typeFilter || typeFilter === 'city') && (",
    "BodyInspector: city button gate",
)

# ----- 3) BodyInspector: gate the station deploy button -----
patch(
    "src/components/BodyInspector.tsx",
    "            {stationAllowed && (!typeFilter || typeFilter === 'station') && (",
    "            {stationAllowed && !bodyHasStation && (!typeFilter || typeFilter === 'station') && (",
    "BodyInspector: station button gate",
)

# ----- 4) BodyInspector: gate the no-freighter hint -----
patch(
    "src/components/BodyInspector.tsx",
    "          {!canBuildHere && (cityAllowed || stationAllowed) && (\n"
    "            <div className=\"deploy-hint\">{noFreighterHint}</div>\n"
    "          )}",
    "          {!canBuildHere && ((cityAllowed && !bodyHasCity) || (stationAllowed && !bodyHasStation)) && (\n"
    "            <div className=\"deploy-hint\">{noFreighterHint}</div>\n"
    "          )}",
    "BodyInspector: deploy-hint gate",
)

# ----- 5) gameContext: SP deploySettlement guard -----
patch(
    "src/state/gameContext.tsx",
    "    // Body type gate\n"
    "    if (type === 'city' && !canHostCity(body)) {\n"
    "      logger.warn('ACTION', `deploySettlement: ${body.name} can't host a city`, { bodyType: body.type });\n"
    "      return false;\n"
    "    }\n"
    "    if (type === 'station' && !canHostStation(body)) {\n"
    "      logger.warn('ACTION', `deploySettlement: ${body.name} can't host a station`, { bodyType: body.type });\n"
    "      return false;\n"
    "    }",
    "    // Body type gate\n"
    "    if (type === 'city' && !canHostCity(body)) {\n"
    "      logger.warn('ACTION', `deploySettlement: ${body.name} can't host a city`, { bodyType: body.type });\n"
    "      return false;\n"
    "    }\n"
    "    if (type === 'station' && !canHostStation(body)) {\n"
    "      logger.warn('ACTION', `deploySettlement: ${body.name} can't host a station`, { bodyType: body.type });\n"
    "      return false;\n"
    "    }\n"
    "\n"
    "    // One-of-each rule — a body has at most one city + one station total,\n"
    "    // regardless of owner. UI mirrors this by hiding the deploy button.\n"
    "    const alreadyHas = gameState.settlements.some(s => s.bodyId === bodyId && s.type === type);\n"
    "    if (alreadyHas) {\n"
    "      logger.warn('ACTION', `deploySettlement: ${body.name} already has a ${type}`);\n"
    "      return false;\n"
    "    }",
    "gameContext: SP guard",
)

# ----- 6) worker/actions.js: server-side guard -----
patch(
    "worker/actions.js",
    "  // Surface settlements require a landable surface — no gas giants or the star.\n"
    "  if (type === 'city' && (bodyRow.type === 'star' || bodyRow.type === 'gas-giant' || bodyRow.type === 'ice-giant')) {\n"
    "    return err(409, 'no_surface', 'cannot found a city on this body type');\n"
    "  }",
    "  // Surface settlements require a landable surface — no gas giants or the star.\n"
    "  if (type === 'city' && (bodyRow.type === 'star' || bodyRow.type === 'gas-giant' || bodyRow.type === 'ice-giant')) {\n"
    "    return err(409, 'no_surface', 'cannot found a city on this body type');\n"
    "  }\n"
    "\n"
    "  // One-of-each rule: a body hosts at most one city + one station total,\n"
    "  // regardless of owner. UI hides the deploy button when this rule\n"
    "  // applies, but a stale client could still POST so we gate server-side.\n"
    "  const existing = await env.DB\n"
    "    .prepare(\n"
    "      `SELECT 1 AS x FROM game_settlements\n"
    "        WHERE game_id = ? AND body_id = ? AND type = ?\n"
    "          AND destroyed_at_tick IS NULL\n"
    "        LIMIT 1`,\n"
    "    )\n"
    "    .bind(gameId, bodyId, type)\n"
    "    .first();\n"
    "  if (existing) {\n"
    "    return err(409, 'already_settled', `body already has a ${type}`);\n"
    "  }",
    "worker/actions.js: server guard",
)

# ----- 7) errorMessages.ts: humanize 'already_settled' -----
patch(
    "src/multiplayer/errorMessages.ts",
    "    case 'no_surface':\n"
    "      return 'Server: a city cannot be deployed on this body type (stars / gas giants / ice giants have no surface).';",
    "    case 'no_surface':\n"
    "      return 'Server: a city cannot be deployed on this body type (stars / gas giants / ice giants have no surface).';\n"
    "\n"
    "    case 'already_settled':\n"
    "      return 'Server: that body already has one of this type. Each body hosts at most one city + one station.';",
    "errorMessages: already_settled mapping",
)

print("\nAll patches applied.")
