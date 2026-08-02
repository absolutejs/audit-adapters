# @absolutejs/audit-postgres

Postgres-backed `AuditSink` for [@absolutejs/audit](https://github.com/absolutejs/audit)
with first-class Drizzle and tagged-template adapters.

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

### Drizzle

Re-export the package-owned table from your application schema so your normal
Drizzle migration workflow owns its lifecycle:

```ts
export { auditEvents } from "@absolutejs/audit-postgres";
```

Then pass any Drizzle Postgres database:

```ts
import { createAudit, withIntegrity } from "@absolutejs/audit";
import { createDrizzleAuditSink } from "@absolutejs/audit-postgres";

const audit = createAudit({
  sinks: [
    withIntegrity(createDrizzleAuditSink({ db }), {
      secret: process.env.AUDIT_SECRET,
      writerId: "shard-A",
    }),
  ],
});
```

When the Drizzle database uses Bun SQL, opt into the Bun-native JSONB mapping
and sink so object and array parameters are not pre-stringified:

```ts
export { auditEventsBunSql as auditEvents } from "@absolutejs/audit-postgres";

import { createBunSqlDrizzleAuditSink } from "@absolutejs/audit-postgres";

const sink = createBunSqlDrizzleAuditSink({ db });
```

`auditBunSqlDrizzleSchema` provides the same mapping as a schema object. The
default `auditEvents`, `auditDrizzleSchema`, and `createDrizzleAuditSink`
exports retain their existing postgres.js-compatible codec. Select the mapping
from the configured database driver rather than the JavaScript runtime:
postgres.js can itself run under Bun.

The Drizzle adapter deliberately never runs DDL at application runtime. It
exports `auditEvents` and `auditDrizzleSchema`, uses native typed JSONB, and
implements the same recent-window, actor, kind, time-range, and prune behavior
as the tagged-template adapter.

If your application intentionally keeps package-owned tables out of its
Drizzle schema, apply this adapter's migration through your existing
PostgreSQL client instead:

```ts
import { runAuditPostgresMigrations } from "@absolutejs/audit-postgres";

await runAuditPostgresMigrations({
  client: {
    query: (text) => sql.unsafe(text),
  },
});
```

The runner uses an atomic, digest-checked `0001_init` migration for each
validated table name and records it in `audit_postgres_migrations`. Concurrent
runners serialize with a transaction-scoped advisory lock. Existing tables
created through the lazy adapter are safely adopted by the first runner.
Changing an applied migration's SQL fails closed. The runner never creates or
closes the injected client. `getAuditPostgresSchemaSql({ table? })` exposes the
same deterministic, validated SQL for migration systems that apply SQL
themselves, while `auditPostgresMigrationPlan({ table? })` exposes the numbered
ID, SQL, and SHA-256 digest.

### postgres.js

```ts
import postgres from "postgres";
import { createAudit, withIntegrity } from "@absolutejs/audit";
import { createPostgresAuditSink } from "@absolutejs/audit-postgres";

const sql = postgres(process.env.DATABASE_URL!);

const audit = createAudit({
  sinks: [
    withIntegrity(createPostgresAuditSink({ sql }), {
      secret: process.env.AUDIT_SECRET,
      writerId: "shard-A",
    }),
  ],
});

await audit.append({
  kind: "billing.invoice.created",
  actor: "system",
  target: invoice.id,
  metadata: { amountCents: invoice.amountCents },
});
```

### Neon serverless (Lambda / Workers)

```ts
import { neon } from "@neondatabase/serverless";
import { createPostgresAuditSink } from "@absolutejs/audit-postgres";

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
  against `/^[a-zA-Z_][a-zA-Z0-9_]*$/` and limited to 53 characters to defend
  against injection and PostgreSQL index-name truncation — the identifier has
  to be interpolated into the DDL, not parameterized).
- Pass `ensureSchema: false` if you manage migrations yourself.

## API

```ts
const auditEvents: PgTable;
const auditEventsBunSql: PgTable;
const auditDrizzleSchema: { auditEvents: typeof auditEvents };
const auditBunSqlDrizzleSchema: {
  auditEvents: typeof auditEventsBunSql;
};
const createDrizzleAuditSink: ({ db }) => AuditSink;
const createBunSqlDrizzleAuditSink: ({ db }) => AuditSink;
const getAuditPostgresSchemaSql: ({ table? }) => string;
const auditPostgresMigrationPlan: ({ table? }) => Array<{
  id: string;
  sql: string;
  digest: string;
}>;
const runAuditPostgresMigrations: ({ client, table? }) => Promise<void>;

type CreatePostgresAuditSinkOptions = {
  sql: PostgresTag; // postgres-js or @neondatabase/serverless
  table?: string; // default 'audit_events'
  ensureSchema?: boolean; // default true
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

The Drizzle adapter's PGlite suite is self-contained:

```sh
bun test tests/drizzleAuditSink.test.ts
```

The tagged-template compatibility suite uses a real Postgres service:

```sh
docker run -d --name pg -p 54330:5432 -e POSTGRES_PASSWORD=postgres postgres:16
docker exec pg psql -U postgres -c 'CREATE DATABASE audit_postgres_tests'
bun test
```

Override the DSN via `AUDIT_PG_TEST_URL` to point at your own Postgres.

## License

Apache 2.0. Substrate-adjacent: this adapter only has value
riding `@absolutejs/audit` (which is BSL Tier A). Per the AbsoluteJS
licensing policy, adapters that only ride a Tier A host stay
permissive — see [the policy](https://github.com/absolutejs/...) for the
full reasoning.
