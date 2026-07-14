import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test
} from 'bun:test';
import postgres from 'postgres';
import {
	createAudit,
	verifyChain,
	withIntegrity
} from '@absolutejs/audit';
import { createPostgresAuditSink } from '../src/index';

const PG_URL =
	process.env.AUDIT_PG_TEST_URL ??
	'postgresql://postgres:postgres@localhost:54330/audit_postgres_tests';

const sql = postgres(PG_URL, { max: 8 });

// Use a unique table per test run so concurrent test invocations don't
// step on each other's prune/list assertions.
const TEST_TABLE = `t_audit_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

beforeAll(async () => {
	// Sanity: the connection works.
	await sql`SELECT 1`;
});

afterAll(async () => {
	await sql.unsafe(`DROP TABLE IF EXISTS ${TEST_TABLE}`);
	await sql.end();
});

afterEach(async () => {
	await sql.unsafe(`TRUNCATE TABLE ${TEST_TABLE}`).catch(() => {});
});

describe('createPostgresAuditSink — 0.0.1 (real PG)', () => {
	test('append + list round-trip', async () => {
		const sink = createPostgresAuditSink({ sql, table: TEST_TABLE });
		await sink.append({ at: 1000, kind: 'auth.login', actor: 'alice' });
		await sink.append({
			at: 2000,
			actor: 'bob',
			kind: 'auth.logout'
		});
		const events = (await sink.list?.()) ?? [];
		expect(events).toHaveLength(2);
		expect(events[0]!.kind).toBe('auth.login');
		expect(events[0]!.actor).toBe('alice');
		expect(events[1]!.kind).toBe('auth.logout');
	});

	test('preserves metadata jsonb round-trip', async () => {
		const sink = createPostgresAuditSink({ sql, table: TEST_TABLE });
		await sink.append({
			at: 1000,
			kind: 'evt',
			metadata: { count: 42, nested: { ok: true }, tag: 'demo' }
		});
		const events = (await sink.list?.()) ?? [];
		expect(events[0]!.metadata).toEqual({
			count: 42,
			nested: { ok: true },
			tag: 'demo'
		});
	});

	test('list filters by kind substring', async () => {
		const sink = createPostgresAuditSink({ sql, table: TEST_TABLE });
		await sink.append({ at: 1, kind: 'auth.login' });
		await sink.append({ at: 2, kind: 'auth.logout' });
		await sink.append({ at: 3, kind: 'sync.insert' });
		const auth = (await sink.list?.({ kind: 'auth' })) ?? [];
		expect(auth).toHaveLength(2);
		const sync = (await sink.list?.({ kind: 'sync' })) ?? [];
		expect(sync).toHaveLength(1);
	});

	test('list filters by actor exact match', async () => {
		const sink = createPostgresAuditSink({ sql, table: TEST_TABLE });
		await sink.append({ at: 1, actor: 'alice', kind: 'evt' });
		await sink.append({ at: 2, actor: 'bob', kind: 'evt' });
		await sink.append({ at: 3, actor: 'alice', kind: 'evt' });
		const alice = (await sink.list?.({ actor: 'alice' })) ?? [];
		expect(alice).toHaveLength(2);
	});

	test('list filters by since / until window', async () => {
		const sink = createPostgresAuditSink({ sql, table: TEST_TABLE });
		await sink.append({ at: 100, kind: 'a' });
		await sink.append({ at: 200, kind: 'b' });
		await sink.append({ at: 300, kind: 'c' });
		const window = (await sink.list?.({ since: 150, until: 250 })) ?? [];
		expect(window).toHaveLength(1);
		expect(window[0]!.kind).toBe('b');
	});

	test('list limit caps row count', async () => {
		const sink = createPostgresAuditSink({ sql, table: TEST_TABLE });
		for (let i = 0; i < 25; i++) {
			await sink.append({ at: 1000 + i, kind: 'evt' });
		}
		const limited = (await sink.list?.({ limit: 5 })) ?? [];
		expect(limited).toHaveLength(5);
		expect(limited.map((event) => event.at)).toEqual([
			1020,
			1021,
			1022,
			1023,
			1024
		]);
	});

	test('prune deletes events older than cutoff and returns count', async () => {
		const sink = createPostgresAuditSink({ sql, table: TEST_TABLE });
		await sink.append({ at: 100, kind: 'old-1' });
		await sink.append({ at: 200, kind: 'old-2' });
		await sink.append({ at: 300, kind: 'new' });
		const deleted = await sink.prune?.(250);
		expect(deleted).toBe(2);
		const remaining = (await sink.list?.()) ?? [];
		expect(remaining).toHaveLength(1);
		expect(remaining[0]!.kind).toBe('new');
	});

	test('idempotent schema creation — second sink against same table works', async () => {
		const a = createPostgresAuditSink({ sql, table: TEST_TABLE });
		await a.append({ at: 1, kind: 'first' });
		const b = createPostgresAuditSink({ sql, table: TEST_TABLE });
		await b.append({ at: 2, kind: 'second' });
		const events = (await b.list?.()) ?? [];
		expect(events).toHaveLength(2);
	});

	test('ensureSchema: false skips DDL (caller manages schema)', async () => {
		// Pre-create the table manually so the sink can use it without
		// running its own DDL. We use the existing table the previous
		// test created.
		const sink = createPostgresAuditSink({
			ensureSchema: false,
			sql,
			table: TEST_TABLE
		});
		await sink.append({ at: 1, kind: 'evt' });
		const events = (await sink.list?.()) ?? [];
		expect(events).toHaveLength(1);
	});

	test('refuses invalid table names', () => {
		expect(() =>
			createPostgresAuditSink({
				sql,
				table: 'evil; DROP TABLE users; --'
			})
		).toThrow(/invalid table name/);
	});

	test('integrity chain survives jsonb round-trip', async () => {
		const base = createPostgresAuditSink({ sql, table: TEST_TABLE });
		const sink = withIntegrity(base, { secret: 'top-secret' });
		const audit = createAudit({ sinks: [sink] });
		await audit.append({ kind: 'a' });
		await audit.append({ kind: 'b', metadata: { x: 1 } });
		await audit.append({ kind: 'c' });
		const events = (await base.list?.()) ?? [];
		expect(events).toHaveLength(3);
		const result = await verifyChain(events, 'top-secret');
		expect(result.ok).toBe(true);
	});

	test('concurrent appends serialize correctly through PG', async () => {
		const base = createPostgresAuditSink({ sql, table: TEST_TABLE });
		const sink = withIntegrity(base, { secret: 'k' });
		const audit = createAudit({ sinks: [sink] });
		// 20 concurrent appends — the integrity wrapper serializes them.
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				audit.append({ kind: `evt-${i}` })
			)
		);
		const events = (await base.list?.()) ?? [];
		expect(events).toHaveLength(20);
		const result = await verifyChain(events, 'k');
		expect(result.ok).toBe(true);
	});
});
