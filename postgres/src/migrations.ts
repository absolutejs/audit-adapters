import { createHash } from "node:crypto";

const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_TABLE_IDENTIFIER_LENGTH = 53;

export const AUDIT_POSTGRES_MIGRATION_JOURNAL_TABLE =
  "audit_postgres_migrations";

export type AuditPostgresMigration = {
  digest: string;
  id: string;
  sql: string;
};

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
  if (!IDENTIFIER.test(table) || table.length > MAX_TABLE_IDENTIFIER_LENGTH) {
    throw new Error(
      `[audit-postgres] invalid table name "${table}"; must match ${IDENTIFIER.source} and be at most ${MAX_TABLE_IDENTIFIER_LENGTH} characters`,
    );
  }
  return table;
};

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

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

export const auditPostgresMigrationPlan = (
  options: AuditPostgresSchemaOptions = {},
): AuditPostgresMigration[] => {
  const sql = getAuditPostgresSchemaSql(options);

  return [{ digest: digest(sql), id: "0001_init", sql }];
};

const journalSql = `
  DO $audit_postgres_journal$
  BEGIN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('@absolutejs/audit-postgres:journal', 0)
    );
    EXECUTE $audit_postgres_journal_schema$
      CREATE TABLE IF NOT EXISTS ${AUDIT_POSTGRES_MIGRATION_JOURNAL_TABLE} (
        table_name text NOT NULL,
        id text NOT NULL,
        digest text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (table_name, id)
      )
    $audit_postgres_journal_schema$;
  END
  $audit_postgres_journal$
`;

const applyMigrationSql = (
  table: string,
  migration: AuditPostgresMigration,
) => `
  DO $audit_postgres_migration$
  DECLARE
    recorded_digest text;
  BEGIN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(${sqlLiteral(`@absolutejs/audit-postgres:${table}`)}, 0)
    );

    SELECT digest
      INTO recorded_digest
      FROM ${AUDIT_POSTGRES_MIGRATION_JOURNAL_TABLE}
      WHERE table_name = ${sqlLiteral(table)}
        AND id = ${sqlLiteral(migration.id)}
      FOR UPDATE;

    IF recorded_digest IS NULL THEN
      EXECUTE $audit_postgres_schema$${migration.sql}$audit_postgres_schema$;
      INSERT INTO ${AUDIT_POSTGRES_MIGRATION_JOURNAL_TABLE}
        (table_name, id, digest)
      VALUES (
        ${sqlLiteral(table)},
        ${sqlLiteral(migration.id)},
        ${sqlLiteral(migration.digest)}
      );
    ELSIF recorded_digest <> ${sqlLiteral(migration.digest)} THEN
      RAISE EXCEPTION
        USING
          ERRCODE = '23000',
          MESSAGE = ${sqlLiteral(
            `[audit-postgres] migration ${migration.id} for ${table} changed after it was applied`,
          )};
    END IF;
  END
  $audit_postgres_migration$
`;

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
  const validated = validatedTable(table);
  await client.query(journalSql);

  for (const migration of auditPostgresMigrationPlan({ table: validated })) {
    await client.query(applyMigrationSql(validated, migration));
  }
};
