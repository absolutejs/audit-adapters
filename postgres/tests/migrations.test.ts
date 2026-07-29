import { afterAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  AUDIT_POSTGRES_MIGRATION_JOURNAL_TABLE,
  auditPostgresMigrationPlan,
  getAuditPostgresSchemaSql,
  runAuditPostgresMigrations,
} from "../src";

describe("audit Postgres migrations", () => {
  test("returns deterministic package-owned schema SQL", () => {
    const first = getAuditPostgresSchemaSql();
    const second = getAuditPostgresSchemaSql();

    expect(first).toBe(second);
    expect(first).toContain("CREATE TABLE IF NOT EXISTS audit_events");
    expect(first).toContain("CREATE INDEX IF NOT EXISTS audit_events_at_idx");
    expect(first).toContain("CREATE INDEX IF NOT EXISTS audit_events_kind_idx");
    expect(first).toContain(
      "CREATE INDEX IF NOT EXISTS audit_events_actor_idx",
    );
    expect(auditPostgresMigrationPlan()).toEqual([
      {
        digest:
          "f4d7dd981c4bbdcac48027c4cd315cd25507e6318b01de682845caca9cb70c10",
        id: "0001_init",
        sql: first,
      },
    ]);
  });

  test("runs the journaled migration through an injected client without owning it", async () => {
    const queries: string[] = [];
    const client = {
      query: (sql: string) => {
        queries.push(sql);
        return Promise.resolve({ rows: [] });
      },
    };

    await runAuditPostgresMigrations({ client });
    await runAuditPostgresMigrations({ client });

    expect(queries).toHaveLength(4);
    expect(queries[0]).toContain(
      `CREATE TABLE IF NOT EXISTS ${AUDIT_POSTGRES_MIGRATION_JOURNAL_TABLE}`,
    );
    expect(queries[1]).toContain("pg_advisory_xact_lock");
    expect(queries[1]).toContain("0001_init");
    expect(queries[1]).toContain(auditPostgresMigrationPlan()[0]!.digest);
    expect(queries[1]).toContain(getAuditPostgresSchemaSql());
    expect(queries[2]).toBe(queries[0]);
    expect(queries[3]).toBe(queries[1]);
  });

  test("rejects unsafe custom table identifiers", async () => {
    expect(() =>
      getAuditPostgresSchemaSql({ table: "events; DROP TABLE users" }),
    ).toThrow(/invalid table name/);

    await expect(
      runAuditPostgresMigrations({
        client: { query: () => Promise.resolve() },
        table: "events-with-punctuation",
      }),
    ).rejects.toThrow(/invalid table name/);

    expect(() =>
      getAuditPostgresSchemaSql({ table: `events_${"a".repeat(54)}` }),
    ).toThrow(/at most 53 characters/);
  });
});

const PG_URL = process.env.AUDIT_PG_TEST_URL;
const integrationSql =
  PG_URL === undefined ? undefined : postgres(PG_URL, { max: 8 });
const INTEGRATION_TABLE = `t_audit_migration_${Date.now()}`;

afterAll(async () => {
  if (integrationSql === undefined) return;
  await integrationSql.unsafe(`DROP TABLE IF EXISTS ${INTEGRATION_TABLE}`);
  await integrationSql`
    DELETE FROM audit_postgres_migrations
    WHERE table_name = ${INTEGRATION_TABLE}
  `;
  await integrationSql.end();
});

describe.skipIf(PG_URL === undefined)(
  "audit Postgres migrations — real PostgreSQL",
  () => {
    test("creates, journals, adopts, and verifies the schema concurrently", async () => {
      if (integrationSql === undefined)
        throw new Error("AUDIT_PG_TEST_URL is required");

      const client = {
        query: (text: string) => integrationSql.unsafe(text),
      };
      await Promise.all(
        Array.from({ length: 8 }, () =>
          runAuditPostgresMigrations({
            client,
            table: INTEGRATION_TABLE,
          }),
        ),
      );

      const tables = await integrationSql<{ name: string }[]>`
        SELECT to_regclass(${INTEGRATION_TABLE})::text AS name
      `;
      expect(tables[0]?.name).toBe(INTEGRATION_TABLE);

      const indexes = await integrationSql<{ indexname: string }[]>`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = ${INTEGRATION_TABLE}
      `;
      expect(indexes.map(({ indexname }) => indexname).sort()).toEqual([
        `${INTEGRATION_TABLE}_actor_idx`,
        `${INTEGRATION_TABLE}_at_idx`,
        `${INTEGRATION_TABLE}_kind_idx`,
        `${INTEGRATION_TABLE}_pkey`,
      ]);

      const journal = await integrationSql<
        {
          digest: string;
          id: string;
          table_name: string;
        }[]
      >`
        SELECT table_name, id, digest
        FROM audit_postgres_migrations
        WHERE table_name = ${INTEGRATION_TABLE}
      `;
      expect(Array.from(journal)).toEqual([
        {
          digest: auditPostgresMigrationPlan({
            table: INTEGRATION_TABLE,
          })[0]!.digest,
          id: "0001_init",
          table_name: INTEGRATION_TABLE,
        },
      ]);

      await integrationSql`
        UPDATE audit_postgres_migrations
        SET digest = 'tampered'
        WHERE table_name = ${INTEGRATION_TABLE}
          AND id = '0001_init'
      `;
      await expect(
        runAuditPostgresMigrations({
          client,
          table: INTEGRATION_TABLE,
        }),
      ).rejects.toThrow(/changed after it was applied/);
    });
  },
);
