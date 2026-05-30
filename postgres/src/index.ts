/**
 * @absolutejs/audit-postgres — Postgres-backed `AuditSink` for
 * `@absolutejs/audit`. Durable, queryable, and uses the same
 * `metadata.__integrity` field for tamper-evidence as the in-memory
 * sink (jsonb round-trip preserves the chain by design).
 *
 * Accepts any `postgres`-style tag-template client. Verified shapes:
 *
 *   - `porsager/postgres` (`postgres('postgres://...')`) — the de facto
 *     2026 Bun-friendly Postgres driver.
 *   - `@neondatabase/serverless` (`neon('postgres://...')`) — exposes
 *     the same tag-template API over HTTP for serverless / Lambda /
 *     Workers contexts where TCP isn't available.
 *
 * The adapter doesn't pull in Drizzle — the surface is small enough
 * (one table, four operations) that a raw tagged-template SQL surface
 * stays readable and avoids dragging a 200KB ORM into the dependency
 * graph of every consumer.
 *
 * Schema (lazy — created on first append; idempotent):
 *
 *   CREATE TABLE IF NOT EXISTS audit_events (
 *     id        bigserial PRIMARY KEY,
 *     at        bigint    NOT NULL,
 *     kind      text      NOT NULL,
 *     actor     text,
 *     target    text,
 *     metadata  jsonb
 *   );
 *   -- (at DESC) is the dominant query pattern (recent-first lists)
 *   CREATE INDEX IF NOT EXISTS audit_events_at_idx       ON audit_events (at DESC);
 *   CREATE INDEX IF NOT EXISTS audit_events_kind_idx     ON audit_events (kind);
 *   CREATE INDEX IF NOT EXISTS audit_events_actor_idx    ON audit_events (actor) WHERE actor IS NOT NULL;
 */
import type { AuditEvent, AuditEventFilter, AuditSink } from '@absolutejs/audit';

/**
 * Minimal subset of `postgres`'s `Sql` type the adapter uses. Declaring
 * it locally (rather than `import type { Sql } from 'postgres'`) keeps
 * `postgres` as a truly optional peer — Neon serverless users don't
 * have to install it.
 */
export type PostgresTag = {
	<T = unknown>(
		strings: TemplateStringsArray,
		...values: unknown[]
	): Promise<T[]> & { count: number };
	unsafe: (sql: string) => Promise<unknown[]>;
};

/** Strict identifier validation — used for `table` in the DDL. Defends
 *  against SQL injection while letting the caller customize the table
 *  name. */
const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export type CreatePostgresAuditSinkOptions = {
	/**
	 * The SQL tag template. Either `postgres('postgres://...')` from
	 * `postgres` OR `neon('postgres://...')` from `@neondatabase/serverless`
	 * — both implement the same shape.
	 */
	sql: PostgresTag;
	/**
	 * Table name. Defaults to `'audit_events'`. Validated against
	 * `/^[a-zA-Z_][a-zA-Z0-9_]*$/` — any other shape throws to defend
	 * against injection (the table name has to be interpolated into the
	 * DDL string, not as a parameter).
	 */
	table?: string;
	/**
	 * Run `CREATE TABLE IF NOT EXISTS` on first `append` / `list` /
	 * `prune`. Default `true`. Set `false` if you manage the schema
	 * yourself (migrations); the adapter then assumes the table exists.
	 */
	ensureSchema?: boolean;
};

export const createPostgresAuditSink = (
	options: CreatePostgresAuditSinkOptions
): AuditSink => {
	const table = options.table ?? 'audit_events';
	if (!IDENTIFIER.test(table)) {
		throw new Error(
			`[audit-postgres] invalid table name "${table}"; must match ${IDENTIFIER.source}`
		);
	}
	const { sql } = options;
	const shouldEnsureSchema = options.ensureSchema ?? true;

	let schemaReady: Promise<void> | undefined;
	const ensureSchema = (): Promise<void> => {
		if (!shouldEnsureSchema) return Promise.resolve();
		if (schemaReady !== undefined) return schemaReady;
		// Concatenate DDL — postgres-js's `unsafe()` runs multi-statement.
		// All four statements are idempotent (`IF NOT EXISTS`).
		const ddl = `
			CREATE TABLE IF NOT EXISTS ${table} (
				id bigserial PRIMARY KEY,
				at bigint NOT NULL,
				kind text NOT NULL,
				actor text,
				target text,
				metadata jsonb
			);
			CREATE INDEX IF NOT EXISTS ${table}_at_idx ON ${table} (at DESC);
			CREATE INDEX IF NOT EXISTS ${table}_kind_idx ON ${table} (kind);
			CREATE INDEX IF NOT EXISTS ${table}_actor_idx ON ${table} (actor) WHERE actor IS NOT NULL;
		`;
		schemaReady = sql.unsafe(ddl).then(() => undefined);
		return schemaReady;
	};

	// Build a parametrized WHERE clause from the filter. Returns SQL
	// fragments + binds; the caller assembles a final query string.
	// Done as raw fragments (not postgres-js's fragment helpers) so the
	// adapter works against both postgres-js and Neon's tag template
	// without a divergent path — they both accept positional ${} binds.
	const buildList = async (filter?: AuditEventFilter): Promise<AuditEvent[]> => {
		await ensureSchema();
		// Tag-template-style: every branch is its own templated query.
		// Postgres planner caches the prepared plans so the branching
		// cost is negligible per call. Verbose but type-safe and uses
		// the ${} binds correctly.
		const limit = filter?.limit ?? 100;
		const kind = filter?.kind;
		const actor = filter?.actor;
		const since = filter?.since;
		const until = filter?.until;
		// We narrow to the four most common shapes; less common combos
		// fall through to the full WHERE branch. There's no security
		// concern with adding more branches — the binds are still
		// parametrized everywhere.
		const rows = await sql<{
			at: number | string;
			kind: string;
			actor: string | null;
			target: string | null;
			metadata: unknown;
		}>`
			SELECT at, kind, actor, target, metadata
			FROM ${sql.unsafe(table)}
			WHERE
				(${kind ?? null}::text IS NULL OR kind LIKE '%' || ${kind ?? ''} || '%')
				AND (${actor ?? null}::text IS NULL OR actor = ${actor ?? null})
				AND (${since ?? null}::bigint IS NULL OR at >= ${since ?? 0})
				AND (${until ?? null}::bigint IS NULL OR at <= ${until ?? 0})
			ORDER BY at ASC, id ASC
			LIMIT ${limit}
		`;
		// postgres-js returns `bigint` columns as strings under some
		// driver configurations. Normalize to JS number — audit events
		// won't exceed Number.MAX_SAFE_INTEGER for centuries (it's a
		// wall-clock ms).
		return rows.map((row) => {
			const event: AuditEvent = {
				at: typeof row.at === 'string' ? Number(row.at) : row.at,
				kind: row.kind
			};
			if (row.actor !== null) event.actor = row.actor;
			if (row.target !== null) event.target = row.target;
			if (row.metadata !== null) {
				// jsonb may come back as string under some configurations;
				// normalize the same way sync-bus-pg's spill path does.
				event.metadata =
					typeof row.metadata === 'string'
						? (JSON.parse(row.metadata) as Record<string, unknown>)
						: (row.metadata as Record<string, unknown>);
			}
			return event;
		});
	};

	return {
		append: async (event) => {
			await ensureSchema();
			const metadataSerialized =
				event.metadata !== undefined
					? JSON.stringify(event.metadata)
					: null;
			await sql`
				INSERT INTO ${sql.unsafe(table)} (at, kind, actor, target, metadata)
				VALUES (
					${event.at},
					${event.kind},
					${event.actor ?? null},
					${event.target ?? null},
					${metadataSerialized}::jsonb
				)
			`;
		},
		list: buildList,
		name: 'postgres',
		prune: async (before) => {
			await ensureSchema();
			// RETURNING id so the result array length is the deleted
			// count, portably across postgres-js and Neon serverless
			// (their DELETE/UPDATE row-count surfaces differ otherwise).
			const result = await sql<{ id: string }>`
				DELETE FROM ${sql.unsafe(table)}
				WHERE at < ${before}
				RETURNING id
			`;
			return result.length;
		}
	};
};
