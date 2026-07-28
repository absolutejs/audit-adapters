import type {
  AuditEvent,
  AuditEventFilter,
  AuditSink,
} from "@absolutejs/audit";
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  lt,
  lte,
  type SQL,
} from "drizzle-orm";
import {
  bigint,
  bigserial,
  customType,
  index,
  pgTable,
  text,
  type PgAsyncDatabase,
} from "drizzle-orm/pg-core";

const portableJsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  fromDriver: (value) =>
    typeof value === "string" ? JSON.parse(value) : value,
  toDriver: (value) => JSON.stringify(value),
});

const bunSqlJsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  fromDriver: (value) =>
    typeof value === "string" ? JSON.parse(value) : value,
  toDriver: (value) => value,
});

const createAuditEventsTable = (metadata: ReturnType<typeof portableJsonb>) =>
  pgTable(
    "audit_events",
    {
      actor: text(),
      at: bigint({ mode: "number" }).notNull(),
      id: bigserial({ mode: "number" }).primaryKey(),
      kind: text().notNull(),
      metadata: metadata.$type<Record<string, unknown>>(),
      target: text(),
    },
    (table) => [
      index("audit_events_at_idx").on(table.at.desc()),
      index("audit_events_kind_idx").on(table.kind),
      index("audit_events_actor_idx")
        .on(table.actor)
        .where(isNotNull(table.actor)),
    ],
  );

/**
 * The portable postgres.js/Neon table mapping retained for backward
 * compatibility. Use `auditEventsBunSql` with Bun SQL so native JSONB values
 * are passed to Bun's driver without pre-stringification.
 */
export const auditEvents = createAuditEventsTable(portableJsonb());

/** Bun SQL table mapping for native object/array JSONB parameters. */
export const auditEventsBunSql = createAuditEventsTable(bunSqlJsonb());

export const auditDrizzleSchema = { auditEvents };
export const auditBunSqlDrizzleSchema = { auditEvents: auditEventsBunSql };

type AnyPgDatabase = PgAsyncDatabase<any, any>;

export type CreateDrizzleAuditSinkOptions<DB extends AnyPgDatabase> = {
  /**
   * A Drizzle Postgres database whose migrations include `auditEvents`.
   * The sink never creates or mutates schema at application runtime.
   */
  db: DB;
  /**
   * Package-owned table mapping. Defaults to the portable postgres.js mapping.
   * Pass `auditEventsBunSql` when the Drizzle database uses Bun SQL.
   */
  table?: typeof auditEvents;
};

const boundedLimit = (value = 100) => {
  if (!Number.isInteger(value) || value < 1 || value > 1_000)
    throw new Error("Audit query limit must be an integer from 1 through 1000");
  return value;
};

const eventFromRow = (row: typeof auditEvents.$inferSelect): AuditEvent => {
  const event: AuditEvent = {
    at: row.at,
    kind: row.kind,
  };
  if (row.actor !== null) event.actor = row.actor;
  if (row.target !== null) event.target = row.target;
  if (row.metadata !== null) event.metadata = row.metadata;
  return event;
};

export const createDrizzleAuditSink = <DB extends AnyPgDatabase>({
  db,
  table = auditEvents,
}: CreateDrizzleAuditSinkOptions<DB>): AuditSink => ({
  append: async (event) => {
    await db.insert(table).values({
      actor: event.actor,
      at: event.at,
      kind: event.kind,
      metadata: event.metadata,
      target: event.target,
    });
  },
  list: async (filter?: AuditEventFilter) => {
    const conditions: SQL[] = [];
    if (filter?.actor !== undefined)
      conditions.push(eq(table.actor, filter.actor));
    if (filter?.kind !== undefined)
      conditions.push(ilike(table.kind, `%${filter.kind}%`));
    if (filter?.since !== undefined)
      conditions.push(gte(table.at, filter.since));
    if (filter?.until !== undefined)
      conditions.push(lte(table.at, filter.until));

    const rows = await db
      .select()
      .from(table)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(table.at), desc(table.id))
      .limit(boundedLimit(filter?.limit));

    return rows.reverse().map(eventFromRow);
  },
  name: "drizzle-postgres",
  prune: async (before) =>
    (
      await db
        .delete(table)
        .where(lt(table.at, before))
        .returning({ id: table.id })
    ).length,
});

export const createBunSqlDrizzleAuditSink = <DB extends AnyPgDatabase>({
  db,
}: Omit<CreateDrizzleAuditSinkOptions<DB>, "table">): AuditSink =>
  createDrizzleAuditSink({ db, table: auditEventsBunSql });
