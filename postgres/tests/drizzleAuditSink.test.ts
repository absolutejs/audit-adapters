import { createAudit, verifyChain, withIntegrity } from "@absolutejs/audit";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import {
  createBunSqlDrizzleAuditSink,
  createDrizzleAuditSink,
  runAuditPostgresMigrations,
} from "../src";

const createTestDatabase = async () => {
  const client = new PGlite();
  await client.exec(`
		CREATE TABLE audit_events (
			id bigserial PRIMARY KEY,
			at bigint NOT NULL,
			kind text NOT NULL,
			actor text,
			target text,
			metadata jsonb
		);
	`);
  return { client, db: drizzle({ client }) };
};

let database: Awaited<ReturnType<typeof createTestDatabase>>;

beforeEach(async () => {
  database = await createTestDatabase();
});

describe("createDrizzleAuditSink", () => {
  test("filters and orders recent events through the schema", async () => {
    const { db } = database;
    const sink = createDrizzleAuditSink({ db });
    await sink.append({
      actor: "alice",
      at: 100,
      kind: "auth.login",
      target: "session-1",
    });
    await sink.append({
      actor: "bob",
      at: 200,
      kind: "sync.insert",
    });
    await sink.append({
      actor: "alice",
      at: 300,
      kind: "auth.logout",
    });

    expect(await sink.list?.({ actor: "alice", kind: "auth" })).toEqual([
      {
        actor: "alice",
        at: 100,
        kind: "auth.login",
        target: "session-1",
      },
      {
        actor: "alice",
        at: 300,
        kind: "auth.logout",
      },
    ]);
    const limited = await sink.list?.({ limit: 2 });
    expect(limited?.map((event) => event.at)).toEqual([200, 300]);
    const window = await sink.list?.({ since: 150, until: 250 });
    expect(window?.map((event) => event.kind)).toEqual(["sync.insert"]);
  });

  test("retains native JSONB integrity metadata and prunes by cutoff", async () => {
    const { client, db } = database;
    const base = createBunSqlDrizzleAuditSink({ db });
    const sink = withIntegrity(base, {
      secret: "drizzle-integrity-secret",
      writerId: "drizzle-test",
    });
    const audit = createAudit({ sinks: [sink] });
    await audit.append({ at: 100, kind: "old" });
    await audit.append({
      at: 200,
      kind: "current",
      metadata: { nested: { retained: true } },
    });
    await audit.flush();

    const events = (await base.list?.()) ?? [];
    expect(events[1]?.metadata?.nested).toEqual({ retained: true });
    const storage = await client.query<{ metadataType: string }>(`
      SELECT jsonb_typeof(metadata) AS "metadataType"
      FROM audit_events
      WHERE kind = 'current'
    `);
    expect(storage.rows[0]?.metadataType).toBe("object");
    expect(await verifyChain(events, "drizzle-integrity-secret")).toEqual({
      ok: true,
    });
    expect(await base.prune?.(150)).toBe(1);
    expect((await base.list?.())?.map((event) => event.kind)).toEqual([
      "current",
    ]);
    await audit.close();
  });

  test("reads metadata rows written by the legacy string codec", async () => {
    const { client, db } = database;
    await client.query(
      `
        INSERT INTO audit_events (at, kind, metadata)
        VALUES (100, 'legacy', $1::jsonb)
      `,
      [JSON.stringify(JSON.stringify({ retained: true }))],
    );

    const sink = createBunSqlDrizzleAuditSink({ db });
    expect(await sink.list?.()).toEqual([
      {
        at: 100,
        kind: "legacy",
        metadata: { retained: true },
      },
    ]);
  });

  test("rejects unbounded query limits", async () => {
    const { db } = database;
    const sink = createDrizzleAuditSink({ db });
    expect(sink.list?.({ limit: 0 })).rejects.toThrow(
      "Audit query limit must be an integer from 1 through 1000",
    );
  });
});

const PG_URL = process.env.AUDIT_PG_TEST_URL;
const integrationSql =
  PG_URL === undefined ? undefined : postgres(PG_URL, { max: 1 });

afterAll(async () => {
  if (integrationSql === undefined) return;
  await integrationSql`DROP TABLE IF EXISTS audit_events`;
  await integrationSql.end();
});

describe.skipIf(PG_URL === undefined)(
  "createDrizzleAuditSink — real PostgreSQL",
  () => {
    test("stores metadata as a native JSONB object", async () => {
      if (integrationSql === undefined)
        throw new Error("AUDIT_PG_TEST_URL is required");

      await runAuditPostgresMigrations({
        client: {
          query: (text) => integrationSql.unsafe(text),
        },
      });
      const db = drizzlePostgres({ client: integrationSql });
      const sink = createDrizzleAuditSink({ db });
      await sink.append({
        at: 100,
        kind: "native-jsonb",
        metadata: { nested: { retained: true } },
      });

      const storage = await integrationSql<{ metadataType: string }[]>`
        SELECT jsonb_typeof(metadata) AS "metadataType"
        FROM audit_events
        WHERE kind = 'native-jsonb'
      `;
      expect(storage[0]?.metadataType).toBe("object");
    });
  },
);
