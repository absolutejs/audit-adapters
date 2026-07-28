const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export type AuditPostgresMigrationClient = {
  query: (sql: string) => PromiseLike<unknown>;
};

export type AuditPostgresSchemaOptions = {
  /** Table name. Defaults to `audit_events`. */
  table?: string;
};

export type RunAuditPostgresMigrationsOptions = AuditPostgresSchemaOptions & {
  /**
   * An injected PostgreSQL client. The runner does not create, close, or
   * otherwise take ownership of it.
   */
  client: AuditPostgresMigrationClient;
};

const validatedTable = (table = "audit_events") => {
  if (!IDENTIFIER.test(table)) {
    throw new Error(
      `[audit-postgres] invalid table name "${table}"; must match ${IDENTIFIER.source}`,
    );
  }
  return table;
};

/**
 * Return the package-owned, idempotent PostgreSQL schema migration.
 *
 * The result is deterministic for a given validated table name so deployment
 * tooling can apply the adapter schema without importing it into an
 * application-owned Drizzle schema.
 */
export const getAuditPostgresSchemaSql = (
  options: AuditPostgresSchemaOptions = {},
) => {
  const table = validatedTable(options.table);
  return `
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
};

/**
 * Apply the package-owned schema through an injected PostgreSQL client.
 *
 * The migration is idempotent and the caller retains client lifecycle
 * ownership.
 */
export const runAuditPostgresMigrations = async ({
  client,
  table,
}: RunAuditPostgresMigrationsOptions): Promise<void> => {
  await client.query(getAuditPostgresSchemaSql({ table }));
};
