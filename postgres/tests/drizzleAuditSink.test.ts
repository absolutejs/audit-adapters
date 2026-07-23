import { createAudit, verifyChain, withIntegrity } from "@absolutejs/audit";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import { createDrizzleAuditSink } from "../src/drizzle";

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
  return drizzle({ client });
};

let db: Awaited<ReturnType<typeof createTestDatabase>>;

beforeEach(async () => {
  db = await createTestDatabase();
});

describe("createDrizzleAuditSink", () => {
  test("filters and orders recent events through the schema", async () => {
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
    const base = createDrizzleAuditSink({ db });
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
    expect(await verifyChain(events, "drizzle-integrity-secret")).toEqual({
      ok: true,
    });
    expect(await base.prune?.(150)).toBe(1);
    expect((await base.list?.())?.map((event) => event.kind)).toEqual([
      "current",
    ]);
    await audit.close();
  });

  test("rejects unbounded query limits", async () => {
    const sink = createDrizzleAuditSink({ db });
    expect(sink.list?.({ limit: 0 })).rejects.toThrow(
      "Audit query limit must be an integer from 1 through 1000",
    );
  });
});
