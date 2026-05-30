/**
 * @absolutejs/audit-elysia — Elysia middleware that emits one
 * structured audit event per HTTP request into `@absolutejs/audit`.
 *
 * **Why a dedicated plugin (vs. composing existing ones)?**
 *
 * The Elysia ecosystem already covers two adjacent observability needs:
 *
 *   - `@elysiajs/server-timing` emits the IETF `Server-Timing` response
 *     header (lifecycle-phase durations: parse / handle / afterHandle /
 *     total). Header-only, browser-devtools-shaped, **off by default in
 *     production**. Performance instrumentation, not compliance.
 *   - `@elysiajs/opentelemetry` wires the request lifecycle into OTel
 *     spans through any configured `SpanProcessor` / `SpanExporter`.
 *     Spans are **sampled and ephemeral** — wrong shape for an
 *     append-only compliance log.
 *
 * Neither is structured audit. This plugin is the missing
 * "one append-only event per request that survives errors and is
 * tamper-evident-when-paired-with-withIntegrity" shape. It is
 * **orthogonal to both** — install all three if you want all three.
 *
 * **Why `onAfterResponse`?** It's the only Elysia lifecycle hook that
 * fires exactly once per request **including error paths** (Elysia
 * routes errors through `onError` and the resulting response still
 * flows through to `onAfterResponse`). `onRequest` fires before
 * routing (no status); `onBeforeHandle` / `onAfterHandle` skip on
 * short-circuit; `onError` only fires on errors. Pair with `onRequest`
 * to capture the wall-clock start.
 *
 * **OTel correlation is optional, not coupled.** Set
 * `correlateOtelTraceId: true` and the plugin reads the active span's
 * trace_id off `@opentelemetry/api` (if installed) — every audit event
 * then carries `metadata.traceId`, so a SRE investigating a flagged
 * audit row can pivot to the Datadog/Honeycomb trace. Without OTel
 * installed, the option is a no-op (the import is dynamic + try/catch
 * so the plugin doesn't take a hard dep).
 */
import type { Audit } from '@absolutejs/audit';
import { readActiveTraceId } from '@absolutejs/telemetry';
import { Elysia } from 'elysia';

/** Minimal subset of Elysia's request `Context` that we read. */
type ElysiaRequestContext = {
	request: Request;
	path?: string;
	route?: string;
	headers?: Record<string, string | undefined> | unknown;
	set?: { status?: number | string };
};

/**
 * Per-request state stamped at `onRequest`, consumed at
 * `onAfterResponse`. Keyed by the `Request` object — stable across
 * Elysia lifecycle hooks within one request, GC'd automatically once
 * the request is done (WeakMap entry becomes eligible when no other
 * references hold the Request).
 */
type RequestState = {
	requestId: string;
	startedAt: number;
};

export type AuditElysiaActorResolver = (
	context: ElysiaRequestContext
) => string | undefined | Promise<string | undefined>;

export type AuditElysiaRedactor = (
	event: {
		method: string;
		path: string;
		status: number;
		durationMs: number;
		headers: Record<string, string | undefined>;
	}
) => Record<string, unknown> | undefined;

export type AuditElysiaOptions = {
	/** The audit log to append every request event to. */
	audit: Audit;
	/**
	 * Resolve the actor (user id / session id / api-key id) from the
	 * request. Default: undefined (events have no `actor`). Pass
	 * `(ctx) => ctx.request.headers.get('x-user-id') ?? undefined` for
	 * a header-driven actor, or read the upstream Elysia derive value
	 * if you have an auth middleware.
	 */
	actor?: AuditElysiaActorResolver;
	/**
	 * Build the `metadata` payload of the audit event. Default:
	 * `{ requestId, durationMs }`. Return `undefined` to omit
	 * metadata entirely. Use this to redact / enrich:
	 *
	 *   redact: (req) => ({
	 *     requestId: req.requestId,
	 *     durationMs: req.durationMs,
	 *     userAgent: req.headers['user-agent'],
	 *   })
	 *
	 * The plugin does NOT capture request/response bodies by default —
	 * speculative body redaction surface is too large to ship without
	 * a real consumer asking. Add it through this hook when you need it.
	 */
	redact?: AuditElysiaRedactor;
	/**
	 * If `true`, the plugin tries to read the active OTel trace id
	 * via `@opentelemetry/api` and attaches it as `metadata.traceId`.
	 * Falls back silently when OTel isn't installed. Default `false`.
	 */
	correlateOtelTraceId?: boolean;
	/**
	 * Event `kind`. Default `'http.request'`. Override for a finer
	 * namespacing — e.g. `'api.request'` for an internal RPC API vs
	 * `'web.request'` for a public-facing app.
	 */
	kind?: string;
	/**
	 * Header to extract a client-supplied request id from. Default
	 * `'x-request-id'`. If the header is absent, the plugin mints a
	 * UUID. Set to `null` to always mint.
	 */
	requestIdHeader?: string | null;
};

const DEFAULT_KIND = 'http.request';
const DEFAULT_REQUEST_ID_HEADER = 'x-request-id';

const safeHeaders = (
	headers: unknown
): Record<string, string | undefined> => {
	if (
		headers === null ||
		headers === undefined ||
		typeof headers !== 'object'
	) {
		return {};
	}
	if (headers instanceof Headers) {
		const out: Record<string, string | undefined> = {};
		headers.forEach((value, key) => {
			out[key] = value;
		});
		return out;
	}
	return headers as Record<string, string | undefined>;
};

const coerceStatus = (value: number | string | undefined): number => {
	if (typeof value === 'number') return value;
	if (typeof value === 'string') {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : 200;
	}
	return 200;
};

export const auditElysia = (options: AuditElysiaOptions) => {
	const kind = options.kind ?? DEFAULT_KIND;
	const requestIdHeader =
		options.requestIdHeader === undefined
			? DEFAULT_REQUEST_ID_HEADER
			: options.requestIdHeader;
	const { audit, actor, redact, correlateOtelTraceId = false } = options;

	// Per-request state keyed by the Request object. WeakMap so entries
	// drop automatically once the Request is no longer referenced.
	const stateByRequest = new WeakMap<Request, RequestState>();

	return new Elysia({ name: '@absolutejs/audit-elysia' })
		.onRequest((ctx) => {
			const headers = ctx.request.headers;
			const fromHeader =
				requestIdHeader !== null
					? (headers.get(requestIdHeader) ?? undefined)
					: undefined;
			const requestId =
				fromHeader && fromHeader.length > 0
					? fromHeader
					: crypto.randomUUID();
			stateByRequest.set(ctx.request, {
				requestId,
				startedAt: Date.now()
			});
		})
		.onAfterResponse(async (ctx) => {
			const state = stateByRequest.get(ctx.request);
			if (state === undefined) return;
			stateByRequest.delete(ctx.request);
			const now = Date.now();
			const durationMs = now - state.startedAt;
			const url = new URL(
				ctx.request.url,
				'http://localhost' // base; ignored if url is absolute
			);
			const path =
				(ctx as unknown as { path?: string }).path ??
				(ctx as unknown as { route?: string }).route ??
				url.pathname;
			const status = coerceStatus(
				(ctx as unknown as { set?: { status?: number | string } }).set
					?.status
			);
			const headers = safeHeaders(ctx.request.headers);
			const method = ctx.request.method;

			let resolvedActor: string | undefined;
			if (actor !== undefined) {
				try {
					resolvedActor = await actor(
						ctx as unknown as ElysiaRequestContext
					);
				} catch {
					resolvedActor = undefined;
				}
			}

			const baseMetadata: Record<string, unknown> = {
				durationMs,
				requestId: state.requestId
			};

			let metadata: Record<string, unknown> | undefined = baseMetadata;
			if (redact !== undefined) {
				const result = redact({
					durationMs,
					headers,
					method,
					path,
					status
				});
				metadata = result;
			}

			if (correlateOtelTraceId) {
				const traceId = await readActiveTraceId();
				if (traceId !== undefined) {
					metadata = { ...(metadata ?? {}), traceId };
				}
			}

			try {
				await audit.append({
					at: now,
					...(resolvedActor !== undefined
						? { actor: resolvedActor }
						: {}),
					kind: `${kind}.${status >= 500 ? 'error' : status >= 400 ? 'client_error' : 'ok'}`,
					target: `${method} ${path}`,
					...(metadata !== undefined ? { metadata } : {})
				});
			} catch {
				// Audit append failures are swallowed at the plugin
				// boundary — they must NOT crash the response. The
				// audit's own onError hook will have fired already.
			}
		})
		// Promote the hooks to global scope so they fire for every
		// request the parent Elysia instance handles, not just routes
		// defined on the plugin itself.
		.as('global');
};
