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

export const auditEvents = pgTable(
  "audit_events",
  {
    actor: text(),
    at: bigint({ mode: "number" }).notNull(),
    id: bigserial({ mode: "number" }).primaryKey(),
    kind: text().notNull(),
    metadata: portableJsonb().$type<Record<string, unknown>>(),
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

export const auditDrizzleSchema = { auditEvents };

type AnyPgDatabase = PgAsyncDatabase<any, any>;

export type CreateDrizzleAuditSinkOptions<DB extends AnyPgDatabase> = {
  /**
   * A Drizzle Postgres database whose migrations include `auditEvents`.
   * The sink never creates or mutates schema at application runtime.
   */
  db: DB;
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
}: CreateDrizzleAuditSinkOptions<DB>): AuditSink => ({
  append: async (event) => {
    await db.insert(auditEvents).values({
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
      conditions.push(eq(auditEvents.actor, filter.actor));
    if (filter?.kind !== undefined)
      conditions.push(ilike(auditEvents.kind, `%${filter.kind}%`));
    if (filter?.since !== undefined)
      conditions.push(gte(auditEvents.at, filter.since));
    if (filter?.until !== undefined)
      conditions.push(lte(auditEvents.at, filter.until));

    const rows = await db
      .select()
      .from(auditEvents)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(auditEvents.at), desc(auditEvents.id))
      .limit(boundedLimit(filter?.limit));

    return rows.reverse().map(eventFromRow);
  },
  name: "drizzle-postgres",
  prune: async (before) =>
    (
      await db
        .delete(auditEvents)
        .where(lt(auditEvents.at, before))
        .returning({ id: auditEvents.id })
    ).length,
});
