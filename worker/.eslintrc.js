// ============================================================
// Worker-only lint. The whole point is ONE rule: no-undef.
//
// Three separate production 500s in this codebase were the same shape —
// a stale identifier left behind by a copy/paste:
//
//   worker/actions.js   `fuelCost`               (asteroid ram)
//   worker/actions.js   `me.id`                  (captain bench)
//   worker/fleets.js    `shipIds` / `flagShipId` (fleet rename)
//
// Every one was valid syntax, so `node --check` passed and the esbuild
// bundle built clean. They only exploded when a player hit the endpoint —
// and two of them threw AFTER the database write had already committed,
// so the action succeeded and reported failure, which is the worst way
// for a bug to present.
//
// root:true so this does not inherit the CRA `react-app` config from
// package.json, which targets src/ and leaves no-undef to TypeScript.
//
// Deliberately ONE rule. This is a tripwire for a known, recurring,
// ships-broken-code failure; it is not a style pass, and it must stay
// quiet enough that a real hit is never lost in the noise.
// ============================================================

module.exports = {
  root: true,
  // This file is CommonJS tooling config, not Worker source — linting it
  // as a Worker module just reports its own `module.exports`.
  ignorePatterns: ['.eslintrc.js'],
  env: {
    es2022: true,
    worker: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  // Cloudflare's runtime globals. eslint's `worker` env covers the
  // ServiceWorker basics but not the Workers-specific ones.
  globals: {
    console: 'readonly',
    crypto: 'readonly',
    TextEncoder: 'readonly',
    TextDecoder: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    Request: 'readonly',
    Response: 'readonly',
    Headers: 'readonly',
    fetch: 'readonly',
    FormData: 'readonly',
    Blob: 'readonly',
    ReadableStream: 'readonly',
    WritableStream: 'readonly',
    TransformStream: 'readonly',
    AbortController: 'readonly',
    AbortSignal: 'readonly',
    Event: 'readonly',
    EventTarget: 'readonly',
    WebSocket: 'readonly',
    WebSocketPair: 'readonly',
    DurableObject: 'readonly',
    DurableObjectState: 'readonly',
    ExecutionContext: 'readonly',
    caches: 'readonly',
    btoa: 'readonly',
    atob: 'readonly',
    Intl: 'readonly',
    structuredClone: 'readonly',
    queueMicrotask: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    performance: 'readonly',
  },
  rules: {
    'no-undef': 'error',
  },
};
