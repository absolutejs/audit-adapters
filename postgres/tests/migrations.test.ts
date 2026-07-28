import { afterAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { getAuditPostgresSchemaSql, runAuditPostgresMigrations } from "../src";

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
  });

  test("runs the migration through an injected client without owning it", async () => {
    const queries: string[] = [];
    const client = {
      query: (sql: string) => {
        queries.push(sql);
        return Promise.resolve({ rows: [] });
      },
    };

    await runAuditPostgresMigrations({ client });
    await runAuditPostgresMigrations({ client });

    expect(queries).toEqual([
      getAuditPostgresSchemaSql(),
      getAuditPostgresSchemaSql(),
    ]);
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
  });
});

const PG_URL = process.env.AUDIT_PG_TEST_URL;
const integrationSql =
  PG_URL === undefined ? undefined : postgres(PG_URL, { max: 1 });
const INTEGRATION_TABLE = `t_audit_migration_${Date.now()}`;

afterAll(async () => {
  if (integrationSql === undefined) return;
  await integrationSql.unsafe(`DROP TABLE IF EXISTS ${INTEGRATION_TABLE}`);
  await integrationSql.end();
});

describe.skipIf(PG_URL === undefined)(
  "audit Postgres migrations — real PostgreSQL",
  () => {
    test("creates the table and indexes idempotently", async () => {
      if (integrationSql === undefined)
        throw new Error("AUDIT_PG_TEST_URL is required");

      const client = {
        query: (text: string) => integrationSql.unsafe(text),
      };
      await runAuditPostgresMigrations({
        client,
        table: INTEGRATION_TABLE,
      });
      await runAuditPostgresMigrations({
        client,
        table: INTEGRATION_TABLE,
      });

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
    });
  },
);
