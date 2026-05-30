# @absolutejs/audit-postgres

Postgres-backed `AuditSink` for [@absolutejs/audit](https://github.com/absolutejs/audit).

Durable, queryable, and uses the same `metadata.__integrity` field for
tamper-evidence as the in-memory sink — jsonb preserves the chain through
the round-trip.

## Install

```sh
bun add @absolutejs/audit @absolutejs/audit-postgres
bun add postgres        # OR
bun add @neondatabase/serverless
```

`postgres` and `@neondatabase/serverless` are **optional peer deps** — bring
whichever one you already have. Both implement the tagged-template SQL shape
the adapter accepts.

## Usage

### postgres.js

```ts
import postgres from 'postgres';
import { createAudit, withIntegrity } from '@absolutejs/audit';
import { createPostgresAuditSink } from '@absolutejs/audit-postgres';

const sql = postgres(process.env.DATABASE_URL!);

const audit = createAudit({
  sinks: [
    withIntegrity(
      createPostgresAuditSink({ sql }),
      { secret: process.env.AUDIT_SECRET, writerId: 'shard-A' }
    ),
  ],
});

await audit.append({
  kind: 'billing.invoice.created',
  actor: 'system',
  target: invoice.id,
  metadata: { amountCents: invoice.amountCents },
});
```

### Neon serverless (Lambda / Workers)

```ts
import { neon } from '@neondatabase/serverless';
import { createPostgresAuditSink } from '@absolutejs/audit-postgres';

const sql = neon(process.env.NEON_URL!);
const sink = createPostgresAuditSink({ sql });
```

Same adapter; the only difference is the SQL tag template.

## Schema

The adapter creates this lazily on first `append` / `list` / `prune`:

```sql
CREATE TABLE IF NOT EXISTS audit_events (
  id        bigserial PRIMARY KEY,
  at        bigint    NOT NULL,
  kind      text      NOT NULL,
  actor     text,
  target    text,
  metadata  jsonb
);
CREATE INDEX IF NOT EXISTS audit_events_at_idx       ON audit_events (at DESC);
CREATE INDEX IF NOT EXISTS audit_events_kind_idx     ON audit_events (kind);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx    ON audit_events (actor) WHERE actor IS NOT NULL;
```

- `metadata` is `jsonb` — the `__integrity` chain field rides here untouched
  by the round-trip.
- All three indexes are partial-or-full to cover the common filter paths
  (recent-first lists; per-kind filters; per-actor lookups).
- The table name is customizable via the `table` option (strictly validated
  against `/^[a-zA-Z_][a-zA-Z0-9_]*$/` to defend against injection — the
  identifier has to be interpolated into the DDL, not parameterized).
- Pass `ensureSchema: false` if you manage migrations yourself.

## API

```ts
type CreatePostgresAuditSinkOptions = {
  sql: PostgresTag;          // postgres-js or @neondatabase/serverless
  table?: string;            // default 'audit_events'
  ensureSchema?: boolean;    // default true
};

const createPostgresAuditSink: (options) => AuditSink;
```

Returns a standard `AuditSink` implementing `append`, `list` (with `kind` /
`actor` / `since` / `until` / `limit` filters), and `prune(before)`.

## Behavior notes

- **Lazy schema.** First call to any method runs the DDL once; subsequent
  calls skip.
- **Portable row counts.** `prune` uses `RETURNING id` and counts the returned
  array, so it works the same on postgres-js (which exposes `.count`) and
  Neon serverless (which doesn't expose row count the same way).
- **`bigint` `at` column.** Wall-clock `Date.now()` won't exceed
  `Number.MAX_SAFE_INTEGER` for centuries; the row is normalized back to a
  JS `number` on read regardless of driver configuration.
- **`metadata` jsonb-as-string fallback.** Some driver setups return jsonb as
  a string; the sink parses on read so callers never see a `string`.

## Test setup

```sh
docker run -d --name pg -p 54330:5432 -e POSTGRES_PASSWORD=postgres postgres:16
docker exec pg psql -U postgres -c 'CREATE DATABASE audit_postgres_tests'
bun test
```

Override the DSN via `AUDIT_PG_TEST_URL` to point at your own Postgres.

## License

[Apache 2.0](../LICENSE). Substrate-adjacent: this adapter only has value
riding `@absolutejs/audit` (which is BSL Tier A). Per the AbsoluteJS
licensing policy, adapters that only ride a Tier A host stay
permissive — see [the policy](https://github.com/absolutejs/...) for the
full reasoning.
