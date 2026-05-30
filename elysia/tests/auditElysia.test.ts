import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import {
	createAudit,
	memorySink,
	type AuditEvent
} from '@absolutejs/audit';
import { auditElysia } from '../src/index';

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const setupApp = (
	options: Parameters<typeof auditElysia>[0],
	configure?: (app: Elysia) => Elysia
): {
	app: Elysia;
	sink: ReturnType<typeof memorySink>;
} => {
	const sink = options.audit
		? null
		: memorySink({ max: 100 });
	const audit = options.audit ?? createAudit({ sinks: [sink!] });
	const plugin = auditElysia({ ...options, audit });
	let app = new Elysia().use(plugin);
	if (configure) app = configure(app);
	return {
		app,
		sink: (options.audit ? null : sink) as ReturnType<typeof memorySink>
	};
};

describe('auditElysia — basic emission', () => {
	test('emits one http.request.ok event per successful request', async () => {
		const sink = memorySink();
		const audit = createAudit({ sinks: [sink] });
		const app = new Elysia()
			.use(auditElysia({ audit }))
			.get('/hello', () => 'world');
		const res = await app.handle(new Request('http://localhost/hello'));
		expect(await res.text()).toBe('world');
		await settle();
		const events = (await sink.list?.()) ?? [];
		expect(events).toHaveLength(1);
		expect(events[0]!.kind).toBe('http.request.ok');
		expect(events[0]!.target).toBe('GET /hello');
		expect(events[0]!.metadata?.requestId).toBeDefined();
		expect(events[0]!.metadata?.durationMs).toBeDefined();
	});

	test('emits http.request.client_error for 4xx', async () => {
		const sink = memorySink();
		const audit = createAudit({ sinks: [sink] });
		const app = new Elysia()
			.use(auditElysia({ audit }))
			.get('/forbidden', ({ set }) => {
				set.status = 403;
				return 'no';
			});
		await app.handle(new Request('http://localhost/forbidden'));
		await settle();
		const events = (await sink.list?.()) ?? [];
		expect(events[0]!.kind).toBe('http.request.client_error');
	});

	test('emits http.request.error for 5xx (handler throws)', async () => {
		const sink = memorySink();
		const audit = createAudit({ sinks: [sink] });
		const app = new Elysia()
			.use(auditElysia({ audit }))
			.get('/boom', () => {
				throw new Error('kaboom');
			});
		await app.handle(new Request('http://localhost/boom'));
		await settle();
		const events = (await sink.list?.()) ?? [];
		expect(events).toHaveLength(1);
		expect(events[0]!.kind).toBe('http.request.error');
	});

	test('different request paths emit distinct targets', async () => {
		const sink = memorySink();
		const audit = createAudit({ sinks: [sink] });
		const app = new Elysia()
			.use(auditElysia({ audit }))
			.get('/a', () => 'a')
			.get('/b', () => 'b')
			.post('/c', () => 'c');
		await app.handle(new Request('http://localhost/a'));
		await app.handle(new Request('http://localhost/b'));
		await app.handle(
			new Request('http://localhost/c', { method: 'POST' })
		);
		await settle();
		const events = (await sink.list?.()) ?? [];
		expect(events.map((event) => event.target)).toEqual([
			'GET /a',
			'GET /b',
			'POST /c'
		]);
	});
});

describe('auditElysia — requestId', () => {
	test('extracts requestId from x-request-id header when present', async () => {
		const sink = memorySink();
		const audit = createAudit({ sinks: [sink] });
		const app = new Elysia()
			.use(auditElysia({ audit }))
			.get('/', () => 'ok');
		await app.handle(
			new Request('http://localhost/', {
				headers: { 'x-request-id': 'req-from-client-abc' }
			})
		);
		await settle();
		const events = (await sink.list?.()) ?? [];
		expect(events[0]!.metadata?.requestId).toBe('req-from-client-abc');
	});

	test('mints a uuid when header is absent', async () => {
		const sink = memorySink();
		const audit = createAudit({ sinks: [sink] });
		const app = new Elysia()
			.use(auditElysia({ audit }))
			.get('/', () => 'ok');
		await app.handle(new Request('http://localhost/'));
		await settle();
		const events = (await sink.list?.()) ?? [];
		expect(events[0]!.metadata?.requestId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-/i
		);
	});

	test('requestIdHeader: null always mints', async () => {
		const sink = memorySink();
		const audit = createAudit({ sinks: [sink] });
		const app = new Elysia()
			.use(auditElysia({ audit, requestIdHeader: null }))
			.get('/', () => 'ok');
		await app.handle(
			new Request('http://localhost/', {
				headers: { 'x-request-id': 'should-be-ignored' }
			})
		);
		await settle();
		const events = (await sink.list?.()) ?? [];
		expect(events[0]!.metadata?.requestId).not.toBe('should-be-ignored');
	});

	test('custom requestIdHeader is honored', async () => {
		const sink = memorySink();
		const audit = createAudit({ sinks: [sink] });
		const app = new Elysia()
			.use(
				auditElysia({ audit, requestIdHeader: 'x-trace-id' })
			)
			.get('/', () => 'ok');
		await app.handle(
			new Request('http://localhost/', {
				headers: { 'x-trace-id': 'trace-xyz' }
			})
		);
		await settle();
		const events = (await sink.list?.()) ?? [];
		expect(events[0]!.metadata?.requestId).toBe('trace-xyz');
	});
});

describe('auditElysia — actor resolver', () => {
	test('resolves actor from a header', async () => {
		const sink = memorySink();
		const audit = createAudit({ sinks: [sink] });
		const app = new Elysia()
			.use(
				auditElysia({
					actor: (ctx) =>
						ctx.request.headers.get('x-user-id') ?? undefined,
					audit
				})
			)
			.get('/', () => 'ok');
		await app.handle(
			new Request('http://localhost/', {
				headers: { 'x-user-id': 'user-42' }
			})
		);
		await settle();
		const events = (await sink.list?.()) ?? [];
		expect(events[0]!.actor).toBe('user-42');
	});

	test('actor resolver throwing does not crash the request', async () => {
		const sink = memorySink();
		const audit = createAudit({ sinks: [sink] });
		const app = new Elysia()
			.use(
				auditElysia({
					actor: () => {
						throw new Error('lookup failed');
					},
					audit
				})
			)
			.get('/', () => 'ok');
		const res = await app.handle(new Request('http://localhost/'));
		expect(await res.text()).toBe('ok');
		await settle();
		const events = (await sink.list?.()) ?? [];
		// Event still emitted; actor omitted.
		expect(events).toHaveLength(1);
		expect(events[0]!.actor).toBeUndefined();
	});
});

describe('auditElysia — redact + custom kind', () => {
	test('redact overrides the metadata payload', async () => {
		const sink = memorySink();
		const audit = createAudit({ sinks: [sink] });
		const app = new Elysia()
			.use(
				auditElysia({
					audit,
					redact: (req) => ({
						durationMs: req.durationMs,
						method: req.method,
						path: req.path,
						status: req.status,
						userAgent: req.headers['user-agent']
					})
				})
			)
			.get('/', () => 'ok');
		await app.handle(
			new Request('http://localhost/', {
				headers: { 'user-agent': 'jest/1.0' }
			})
		);
		await settle();
		const events = (await sink.list?.()) ?? [];
		expect(events[0]!.metadata).toMatchObject({
			method: 'GET',
			path: '/',
			status: 200,
			userAgent: 'jest/1.0'
		});
		expect(events[0]!.metadata?.requestId).toBeUndefined();
	});

	test('custom kind namespacing', async () => {
		const sink = memorySink();
		const audit = createAudit({ sinks: [sink] });
		const app = new Elysia()
			.use(auditElysia({ audit, kind: 'api.request' }))
			.get('/', () => 'ok');
		await app.handle(new Request('http://localhost/'));
		await settle();
		const events = (await sink.list?.()) ?? [];
		expect(events[0]!.kind).toBe('api.request.ok');
	});
});

describe('auditElysia — failure isolation', () => {
	test('a failing audit sink does not break the response', async () => {
		const sink: AuditEvent[] = [];
		const audit = createAudit({
			onError: () => {
				/* swallow */
			},
			sinks: [
				{
					append: () => {
						throw new Error('sink down');
					},
					name: 'broken'
				}
			]
		});
		const app = new Elysia()
			.use(auditElysia({ audit }))
			.get('/', () => 'still-works');
		const res = await app.handle(new Request('http://localhost/'));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('still-works');
		// Sanity: we have a stable response even if audit pipeline collapsed.
		expect(sink).toHaveLength(0);
	});
});
