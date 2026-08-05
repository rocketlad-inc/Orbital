// ============================================================================
// d1.mjs — a D1-compatible database on top of node:sqlite.
//
// The point of this file is that the balance simulator runs the REAL
// server code. Orbital's rules live in worker/room.js resolveTick, ~3600
// lines with a couple of hundred D1 calls threaded through them. Porting
// that to a standalone "sim engine" would mean maintaining two
// implementations of the game forever, and the sim would drift from the
// thing it claims to measure — you would end up balancing a model of
// Orbital rather than Orbital.
//
// So instead of moving the rules to the harness, we move the database to
// the rules. D1 is SQLite with a small async wrapper; Node 22+ ships
// SQLite in core. The whole compatibility surface is:
//
//     db.prepare(sql) -> stmt
//     stmt.bind(...args) -> NEW stmt (D1 statements are immutable)
//     stmt.first(col?) / stmt.all() / stmt.run() / stmt.raw()
//     db.batch([stmt, ...])
//     db.exec(sql)
//
// Everything is synchronous underneath and wrapped in promises, which is
// exactly what makes the sim fast: no network, no I/O wait, just SQLite
// doing what it does. A tick that costs ~200 round trips against real D1
// costs ~200 function calls here.
//
// NOT a general-purpose D1 emulator. It implements what this codebase
// actually calls. If a future query uses something missing, it will throw
// loudly rather than silently return wrong data — which is the correct
// failure for a measurement tool.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';

/** D1 returns plain objects; node:sqlite returns null-prototype ones.
 *  Spreading matters because worker code does `{...row}` and `row?.x`
 *  freely, and a null-prototype object breaks nothing — but it prints
 *  confusingly in diagnostics and fails deepEqual in comparisons. */
function plain(row) {
  return row == null ? row : { ...row };
}

class SimStatement {
  constructor(db, sql, args = null) {
    this._db = db;
    this._sql = sql;
    this._args = args;
  }

  /** D1 semantics: bind() returns a NEW statement rather than mutating.
   *  Worker code relies on this — a prepared statement is reused across
   *  a batch with different bindings. */
  bind(...args) {
    return new SimStatement(this._db, this._sql, args);
  }

  _stmt() {
    return this._db.prepare(this._sql);
  }

  async first(col) {
    const rows = this._stmt().all(...(this._args ?? []));
    const row = rows.length ? plain(rows[0]) : null;
    if (col === undefined) return row;
    return row ? row[col] : null;
  }

  async all() {
    const rows = this._stmt().all(...(this._args ?? [])).map(plain);
    return { success: true, results: rows, meta: { rows_read: rows.length } };
  }

  async raw() {
    const rows = this._stmt().all(...(this._args ?? []));
    return rows.map(r => Object.values(r));
  }

  async run() {
    const info = this._stmt().run(...(this._args ?? []));
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
      },
    };
  }
}

export class SimD1 {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    // Match D1's behaviour: foreign keys are enforced. Turning this off
    // would let the sim accept states the real server would reject, which
    // is precisely the class of bug a fidelity harness must not hide.
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = MEMORY');
    this.queries = 0;
  }

  prepare(sql) {
    this.queries += 1;
    return new SimStatement(this.db, sql);
  }

  async exec(sql) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }

  /**
   * D1 batch: all statements in one implicit transaction.
   *
   * Real D1 rolls the whole batch back on failure, and worker/room.js
   * leans on that — a tick builds a big batch of yield/HP/queue writes
   * and assumes none of it lands if one fails. Reproducing the atomicity
   * matters more than the speed here.
   */
  async batch(statements) {
    const out = [];
    this.db.exec('BEGIN');
    try {
      for (const s of statements) out.push(await s.run());
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return out;
  }

  /** Apply the same migration list the Worker runs at runtime, so the sim
   *  schema is the production schema by construction rather than by a
   *  hand-kept copy that rots. */
  applyMigrations(migrations) {
    let applied = 0;
    for (const m of migrations) {
      try {
        this.db.exec(m.sql);
        applied += 1;
      } catch (e) {
        throw new Error(`migration ${m.name} failed: ${e.message}`);
      }
    }
    return applied;
  }
}
