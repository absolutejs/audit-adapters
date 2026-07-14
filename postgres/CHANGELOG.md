# Changelog

## [0.0.3] — 2026-07-14

- `list({ limit })` now selects the most recent matching rows and returns that
  window oldest-first, matching `@absolutejs/audit@0.0.5` and allowing stable
  integrity writers to resume from the correct chain head after restart.
- Corrects the public `PostgresTag` type to accept the thenable query helpers
  returned by postgres-js, Neon, and Bun SQL rather than requiring a concrete
  `Promise` with an unused `count` property.

## [0.0.1] — 2026-05-30

Initial preview. Postgres-backed `AuditSink` for `@absolutejs/audit`.

### Surface

- **`createPostgresAuditSink({ sql, table?, ensureSchema? })`** — returns
  an `AuditSink` implementing `append` / `list` / `prune`. Accepts any
  postgres-js-compatible tag template (`postgres('postgres://...')`) OR
  `@neondatabase/serverless`'s `neon('postgres://...')` (same shape).
- Lazy schema creation (idempotent `CREATE TABLE IF NOT EXISTS` + indexes
  on first call). Pass `ensureSchema: false` if migrations are external.
- `list` filters: `kind` substring, `actor` exact, `since`/`until`
  window, `limit`. Returns `AuditEvent[]` oldest-first to compose with
  `verifyChain`.
- `prune(before)` uses `RETURNING id` for portable row counts (works
  identically on postgres-js + Neon).
- Strict table-name validation (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`) prevents
  injection through the customizable identifier.

### Tested

12 real-PG integration tests including: round-trip, jsonb metadata,
kind/actor/window/limit filters, prune count, schema idempotency,
`ensureSchema: false`, invalid table name rejection, integrity chain
verified through jsonb round-trip, 20 concurrent appends serialize
correctly.

### License

Apache 2.0 (Tier B substrate-adjacent — rides `@absolutejs/audit`
Tier A).
