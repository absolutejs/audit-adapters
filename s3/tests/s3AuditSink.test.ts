import { describe, expect, test } from 'bun:test';
import {
	createAudit,
	verifyChain,
	withIntegrity,
	type AuditEvent
} from '@absolutejs/audit';
import { createS3AuditSink, defaultKeyFor } from '../src/index';

const makeMockPut = () => {
	const puts: { key: string; body: string; contentType: string }[] = [];
	const put = async (key: string, body: string, contentType: string) => {
		puts.push({ body, contentType, key });
	};
	return { put, puts };
};

const parseJsonl = (body: string): AuditEvent[] =>
	body
		.split('\n')
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as AuditEvent);

describe('createS3AuditSink — buffering + flush triggers', () => {
	test('buffers events; does not PUT until size threshold', async () => {
		const { put, puts } = makeMockPut();
		const sink = createS3AuditSink({
			flushIntervalMs: 0,
			maxBatchSize: 3,
			put
		});
		await sink.append({ at: 1, kind: 'a' });
		await sink.append({ at: 2, kind: 'b' });
		expect(puts).toHaveLength(0);
		await sink.append({ at: 3, kind: 'c' });
		// Size threshold reached — flush fires.
		await sink.flush?.();
		expect(puts).toHaveLength(1);
		const events = parseJsonl(puts[0]!.body);
		expect(events).toHaveLength(3);
	});

	test('flushes on size — maxBatchBytes', async () => {
		const { put, puts } = makeMockPut();
		const sink = createS3AuditSink({
			flushIntervalMs: 0,
			maxBatchBytes: 80, // small enough that 2 events overflow
			maxBatchSize: 1000,
			put
		});
		await sink.append({
			at: 1,
			kind: 'a',
			metadata: { padding: 'x'.repeat(30) }
		});
		await sink.append({
			at: 2,
			kind: 'b',
			metadata: { padding: 'y'.repeat(30) }
		});
		await sink.flush?.();
		expect(puts.length).toBeGreaterThanOrEqual(1);
		const allEvents = puts.flatMap((p) => parseJsonl(p.body));
		expect(allEvents).toHaveLength(2);
	});

	test('flush() drains the buffer', async () => {
		const { put, puts } = makeMockPut();
		const sink = createS3AuditSink({
			flushIntervalMs: 0,
			maxBatchSize: 1000,
			put
		});
		await sink.append({ at: 1, kind: 'a' });
		await sink.append({ at: 2, kind: 'b' });
		expect(puts).toHaveLength(0);
		await sink.flush?.();
		expect(puts).toHaveLength(1);
		expect(parseJsonl(puts[0]!.body)).toHaveLength(2);
	});

	test('close() flushes pending events and refuses further appends', async () => {
		const { put, puts } = makeMockPut();
		const sink = createS3AuditSink({
			flushIntervalMs: 0,
			maxBatchSize: 1000,
			put
		});
		await sink.append({ at: 1, kind: 'a' });
		await sink.close?.();
		expect(puts).toHaveLength(1);
		expect(() => sink.append({ at: 2, kind: 'late' })).toThrow(
			/sink is closed/
		);
	});

	test('empty flush is a no-op', async () => {
		const { put, puts } = makeMockPut();
		const sink = createS3AuditSink({ flushIntervalMs: 0, put });
		await sink.flush?.();
		expect(puts).toHaveLength(0);
	});

	test('content type is application/x-ndjson', async () => {
		const { put, puts } = makeMockPut();
		const sink = createS3AuditSink({ flushIntervalMs: 0, put });
		await sink.append({ at: 1, kind: 'a' });
		await sink.flush?.();
		expect(puts[0]!.contentType).toBe('application/x-ndjson');
	});

	test('JSONL body — one event per line, trailing newline', async () => {
		const { put, puts } = makeMockPut();
		const sink = createS3AuditSink({ flushIntervalMs: 0, put });
		await sink.append({ at: 1, kind: 'a' });
		await sink.append({ at: 2, kind: 'b' });
		await sink.append({ at: 3, kind: 'c' });
		await sink.flush?.();
		expect(puts).toHaveLength(1);
		const lines = puts[0]!.body.split('\n');
		expect(lines[lines.length - 1]).toBe(''); // trailing newline
		expect(lines.filter((line) => line.length > 0)).toHaveLength(3);
	});

	test('multiple flushes produce multiple objects', async () => {
		const { put, puts } = makeMockPut();
		const sink = createS3AuditSink({ flushIntervalMs: 0, put });
		await sink.append({ at: 1, kind: 'a' });
		await sink.flush?.();
		await sink.append({ at: 2, kind: 'b' });
		await sink.flush?.();
		expect(puts).toHaveLength(2);
	});
});

describe('defaultKeyFor — sortable lexical keys', () => {
	test('produces audit/<date>/<time>-<rand>.jsonl', () => {
		const keyFor = defaultKeyFor('audit/');
		const key = keyFor({
			batchEnd: 1748623380000,
			batchStart: 1748623335000, // 2025-05-30T17:22:15Z
			eventCount: 5
		});
		expect(key).toMatch(
			/^audit\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}\.\d{3}-[0-9a-f]+\.jsonl$/
		);
	});

	test('two keys produced microseconds apart still sort chronologically', () => {
		const keyFor = defaultKeyFor('audit/');
		const earlier = keyFor({
			batchEnd: 1748623335000,
			batchStart: 1748623335000,
			eventCount: 1
		});
		const later = keyFor({
			batchEnd: 1748623336000,
			batchStart: 1748623336000,
			eventCount: 1
		});
		expect(earlier < later).toBe(true);
	});

	test('custom prefix replaces the default', () => {
		const keyFor = defaultKeyFor('tenant-A/audit/');
		const key = keyFor({
			batchEnd: 1748623335000,
			batchStart: 1748623335000,
			eventCount: 1
		});
		expect(key.startsWith('tenant-A/audit/')).toBe(true);
	});
});

describe('integrity chain survives batch boundaries', () => {
	test('verifyChain works across multiple S3 batches', async () => {
		const { put, puts } = makeMockPut();
		const s3Sink = createS3AuditSink({
			flushIntervalMs: 0,
			maxBatchSize: 5, // force flush every 5 events
			put
		});
		const sink = withIntegrity(s3Sink, { secret: 'k' });
		const audit = createAudit({ sinks: [sink] });
		// 12 events → 3 batches (5 + 5 + 2 on close).
		for (let i = 0; i < 12; i++) {
			await audit.append({ kind: `evt-${i}` });
		}
		await audit.close();
		// Re-assemble the chain from the JSONL files in lexical-sort
		// order (which is chronological order).
		puts.sort((a, b) => a.key.localeCompare(b.key));
		const all = puts.flatMap((p) => parseJsonl(p.body));
		expect(all).toHaveLength(12);
		const result = await verifyChain(all, 'k');
		expect(result.ok).toBe(true);
	});
});

describe('onPutError — failures don\'t lose subsequent appends', () => {
	test('a failed flush keeps the sink usable; new appends still buffer', async () => {
		const errors: { error: unknown; key: string; events: AuditEvent[] }[] =
			[];
		let firstCall = true;
		const put: typeof errors extends never ? never : Parameters<typeof createS3AuditSink>[0]['put'] = async (
			_key,
			_body,
			_contentType
		) => {
			if (firstCall) {
				firstCall = false;
				throw new Error('throttled');
			}
		};
		const sink = createS3AuditSink({
			flushIntervalMs: 0,
			maxBatchSize: 1000,
			onPutError: (error, key, events) => {
				errors.push({ error, events, key });
			},
			put
		});
		await sink.append({ at: 1, kind: 'lost' });
		await sink.flush?.();
		expect(errors).toHaveLength(1);
		expect((errors[0]!.error as Error).message).toBe('throttled');
		// New appends still work.
		await sink.append({ at: 2, kind: 'ok' });
		await sink.flush?.();
		// First batch was lost (no retry); second batch went through fine.
		expect(errors).toHaveLength(1);
	});
});
