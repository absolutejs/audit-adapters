/**
 * @absolutejs/audit-s3 — S3-compatible `AuditSink` for `@absolutejs/audit`.
 *
 * S3 objects are immutable (no real "append"), so the sink buffers events
 * in memory and flushes them as JSONL files keyed by time. Object keys
 * are lexically sortable so `aws s3 ls` (or any equivalent) returns
 * events in chronological order; the date prefix makes lifecycle policies
 * straightforward ("delete `audit/2026-01-*` after 7 years").
 *
 * **Driver-agnostic.** Takes a narrow `put(key, body)` callback so it
 * works with AWS SDK v3, Cloudflare R2 (via fetch + signed URLs or the
 * R2 Workers binding), Backblaze B2's S3-compatible API, MinIO, or
 * anything else that exposes "put a string at a key" semantics. No
 * `@aws-sdk/client-s3` hard dependency.
 *
 * **Flush triggers** (whichever fires first):
 *   - **Size**: `maxBatchSize` events buffered (default 1000) OR
 *     `maxBatchBytes` of serialized JSONL (default 5MB).
 *   - **Time**: `flushIntervalMs` since last flush (default 5_000).
 *   - **Manual**: `await sink.flush()` from the caller.
 *   - **Close**: `await sink.close()` drains the buffer + clears the
 *     interval timer.
 *
 * **Tamper-evidence works across batches automatically.** The integrity
 * chain (`@absolutejs/audit`'s `withIntegrity()`) computes a hash on
 * every `append()` against the prior event's hash. The S3 sink only
 * buffers + flushes — it doesn't touch the chain. So events split
 * across multiple JSONL files still verify end-to-end via `verifyChain`.
 *
 * **No `list` / `prune`** by design. Reading audit logs out of S3 is a
 * separate operation (Athena, `s3 ls`, etc.); enforcing retention is
 * S3 lifecycle policies. The sink is write-only — pair with a
 * `memorySink` (hot tail for queries) or `audit-postgres` (queryable
 * durable companion) when the host needs `list`.
 *
 * **Crash safety.** Unflushed events are lost on process kill. For
 * stricter durability, pair with a synchronous sink (Postgres) for
 * critical events; the S3 sink is the long-term archive, not the
 * source of truth between flushes. Lower `flushIntervalMs` to shrink
 * the loss window at the cost of more S3 PUTs.
 */
import type { AuditEvent, AuditSink } from '@absolutejs/audit';

/**
 * The single S3 operation the sink needs. Implement against your
 * preferred SDK; the sink calls `put(key, body, contentType)` with
 * `'application/x-ndjson'` and expects a resolved Promise on success
 * or a rejection on failure.
 */
export type S3PutFn = (
	key: string,
	body: string,
	contentType: string
) => Promise<void>;

export type S3KeyOptions = {
	/** First event's `at` in the batch. */
	batchStart: number;
	/** Last event's `at` in the batch. */
	batchEnd: number;
	/** How many events the batch contains. */
	eventCount: number;
};

export type CreateS3AuditSinkOptions = {
	/**
	 * The S3 PUT operation. Receives the object key (relative to whatever
	 * bucket your put implementation targets), the serialized JSONL body,
	 * and a content-type hint (`'application/x-ndjson'`).
	 */
	put: S3PutFn;
	/**
	 * Key prefix. Default `'audit/'`. Useful when one bucket holds
	 * multiple audit streams — `'audit/tenant-A/'`, `'audit/system/'`, etc.
	 */
	prefix?: string;
	/**
	 * Build the object key from batch metadata. Default produces keys
	 * like `audit/2026-05-30/19-42-15.123-abcd1234.jsonl`. The default
	 * is intentionally sortable end-to-end so `s3 ls --prefix audit/`
	 * returns chronological order; override only when you need a
	 * different layout (e.g., per-tenant fan-out, hourly partitions).
	 */
	keyFor?: (params: S3KeyOptions) => string;
	/** Flush when the buffer reaches this many events. Default 1000. */
	maxBatchSize?: number;
	/** Flush when serialized JSONL would exceed this many bytes. Default 5MB. */
	maxBatchBytes?: number;
	/**
	 * Flush every N ms regardless of buffer state. Set to `0` or
	 * `Infinity` to disable the timer (size/manual-only flushing).
	 * Default 5000.
	 */
	flushIntervalMs?: number;
	/**
	 * Called when a PUT fails. Default `console.error`. The batch is
	 * NOT retried automatically — wire your own retry queue via this
	 * hook if you need at-least-once.
	 */
	onPutError?: (error: unknown, key: string, events: AuditEvent[]) => void;
	/** Override `Date.now` for tests. */
	clock?: () => number;
};

const TWO = 2;
const FOUR = 4;
const TEN = 10;

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/**
 * Default object-key generator. Produces lexically-sortable keys of
 * the form `<prefix><YYYY-MM-DD>/<HH-MM-SS>.<ms>-<rand>.jsonl`. The
 * date prefix is the natural lifecycle-policy boundary; the time
 * suffix is unique within the millisecond via a random tail so two
 * flushes at the same instant don't collide.
 */
export const defaultKeyFor =
	(prefix: string) =>
	(params: S3KeyOptions): string => {
		const date = new Date(params.batchStart);
		const datePart = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, TWO)}-${pad(date.getUTCDate(), TWO)}`;
		const timePart = `${pad(date.getUTCHours(), TWO)}-${pad(date.getUTCMinutes(), TWO)}-${pad(date.getUTCSeconds(), TWO)}.${pad(date.getUTCMilliseconds(), 3)}`;
		// 8 hex chars of randomness — collision probability is
		// negligible for two flushes at the same millisecond.
		const rand = Math.floor(Math.random() * 0xffffffff)
			.toString(16)
			.padStart(8, '0');
		return `${prefix}${datePart}/${timePart}-${rand}.jsonl`;
	};

const DEFAULTS = {
	flushIntervalMs: 5000,
	maxBatchBytes: 5_000_000,
	maxBatchSize: 1000,
	prefix: 'audit/'
};

const CONTENT_TYPE = 'application/x-ndjson';

export const createS3AuditSink = (
	options: CreateS3AuditSinkOptions
): AuditSink => {
	const prefix = options.prefix ?? DEFAULTS.prefix;
	const maxBatchSize = options.maxBatchSize ?? DEFAULTS.maxBatchSize;
	const maxBatchBytes = options.maxBatchBytes ?? DEFAULTS.maxBatchBytes;
	const flushIntervalMs =
		options.flushIntervalMs ?? DEFAULTS.flushIntervalMs;
	const keyFor = options.keyFor ?? defaultKeyFor(prefix);
	const clock = options.clock ?? Date.now;
	const onPutError =
		options.onPutError ??
		((error, key) =>
			console.error(`[audit-s3] PUT failed for "${key}":`, error));
	const { put } = options;

	type Buffered = { event: AuditEvent; line: string; bytes: number };
	let buffer: Buffered[] = [];
	let bufferedBytes = 0;
	let closed = false;
	// A single in-flight flush chain so concurrent flush() calls don't
	// race on `buffer`. Each flush takes a SNAPSHOT of the buffer and
	// clears it synchronously before the PUT awaits.
	let flushChain: Promise<void> = Promise.resolve();
	let timer: ReturnType<typeof setInterval> | undefined;

	const doFlush = async (): Promise<void> => {
		if (buffer.length === 0) return;
		// Snapshot + clear synchronously. New appends during the PUT
		// land in a fresh buffer that flushes on the next trigger.
		const snapshot = buffer;
		buffer = [];
		bufferedBytes = 0;
		const events = snapshot.map((b) => b.event);
		const body = snapshot.map((b) => b.line).join('\n') + '\n';
		const batchStart = events[0]!.at;
		const batchEnd = events[events.length - 1]!.at;
		const key = keyFor({
			batchEnd,
			batchStart,
			eventCount: events.length
		});
		try {
			await put(key, body, CONTENT_TYPE);
		} catch (error) {
			onPutError(error, key, events);
		}
	};

	// Chain flushes so a concurrent flush waits for the prior one. A
	// throw doesn't poison the chain — `doFlush` already catches via
	// `onPutError`.
	const flush = (): Promise<void> => {
		const next = flushChain.then(() => doFlush());
		flushChain = next.catch(() => {});
		return next;
	};

	// Initialize the periodic timer if enabled. `unref()` lets the
	// process exit even if the timer is pending — flushes during
	// shutdown go through `close()` which awaits the final flush.
	if (
		flushIntervalMs > 0 &&
		Number.isFinite(flushIntervalMs) &&
		typeof setInterval !== 'undefined'
	) {
		timer = setInterval(() => {
			void flush();
		}, flushIntervalMs);
		// In Node/Bun, `unref()` exists on the returned Timer object.
		if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
			(timer as { unref: () => void }).unref();
		}
	}

	return {
		append: (event) => {
			if (closed) {
				throw new Error('[audit-s3] sink is closed');
			}
			const line = JSON.stringify(event);
			const bytes = line.length + 1; // +1 for the newline
			buffer.push({ bytes, event, line });
			bufferedBytes += bytes;
			// Synchronous size-based trigger. Fire-and-forget the flush;
			// `flush()` is chained so the next size trigger queues behind
			// the in-flight PUT instead of racing.
			if (
				buffer.length >= maxBatchSize ||
				bufferedBytes >= maxBatchBytes
			) {
				void flush();
			}
		},
		close: async () => {
			if (closed) return;
			closed = true;
			if (timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
			// Final flush — wait for any pending flush PLUS one more so
			// the buffer drains.
			await flush();
			await flushChain;
		},
		flush: async () => {
			await flush();
		},
		name: 's3'
	};
};

// `clock` is currently only available through the option, not exposed
// in the returned API. Reserve the export in case a tested-driven user
// needs it via the default keyFor.
export { DEFAULTS as S3_AUDIT_SINK_DEFAULTS };
