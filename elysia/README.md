# @absolutejs/audit-elysia

Elysia plugin that emits one structured audit event per HTTP request into
[@absolutejs/audit](https://github.com/absolutejs/audit).

## Why this exists

The Elysia ecosystem already has:

- **`@elysiajs/server-timing`** — emits an IETF `Server-Timing` response
  header with per-lifecycle-phase durations. Performance instrumentation
  visible in browser devtools. **Off by default in production.** Useful,
  but not compliance-shaped.
- **`@elysiajs/opentelemetry`** — wires the request lifecycle into OTel
  spans. Distributed tracing exported to Jaeger / Honeycomb / Axiom /
  Datadog. **Sampled, ephemeral.** Useful, but not retention-shaped.

Neither is structured audit. Audit is "an append-only event per request,
tamper-evident when paired with `withIntegrity`, queryable, and retained
for compliance" — a separate concern. This plugin fills that gap. **No
official `@elysiajs/audit` exists**; the community has logging plugins
(`logestic`, `logixlysia`, etc.) but none are structured tamper-evident
audit pipelines.

Install all three side-by-side if you want all three.

## Install

```sh
bun add @absolutejs/audit @absolutejs/audit-elysia elysia
```

## Usage

```ts
import { Elysia } from 'elysia';
import { createAudit, memorySink, withIntegrity } from '@absolutejs/audit';
import { auditElysia } from '@absolutejs/audit-elysia';

const audit = createAudit({
  sinks: [withIntegrity(memorySink(), { secret: process.env.AUDIT_SECRET })],
});

new Elysia()
  .use(auditElysia({
    audit,
    actor: (ctx) => ctx.request.headers.get('x-user-id') ?? undefined,
  }))
  .get('/', () => 'ok')
  .get('/admin', () => 'secret')
  .listen(3000);
```

Every request — `200`, `4xx`, `5xx`, even handlers that throw — emits one
audit event with shape:

```ts
{
  at: 1748623380000,
  kind: 'http.request.ok',           // .ok | .client_error | .error
  actor: 'user-42',                  // from your `actor` resolver (optional)
  target: 'GET /admin',
  metadata: {
    requestId: 'a4f9...',
    durationMs: 12,
  }
}
```

## API

```ts
auditElysia({
  audit,                       // required — the Audit handle
  actor?: (ctx) => string | undefined | Promise<...>,
  exclude?: ({ request }) => boolean | Promise<boolean>,
  redact?: (req) => Record<string, unknown> | undefined,
  correlateOtelTraceId?: boolean,
  kind?: string,               // default 'http.request'
  requestIdHeader?: string | null, // default 'x-request-id'
});
```

Exclude high-frequency operational traffic from the compliance stream:

```ts
auditElysia({
  audit,
  exclude: ({ request }) =>
    ['/healthz', '/readyz', '/metrics'].includes(new URL(request.url).pathname),
});
```

An exclusion callback that throws fails closed: the request is audited.

### `actor`

Resolve the actor identifier (userId / session / api-key fingerprint) from
the request. Errors are swallowed — a misbehaving resolver doesn't break
the response. Default: no `actor` field on the emitted event.

### `redact`

Build the `metadata` payload. Receives `{ method, path, status,
durationMs, headers }` and returns whatever you want in metadata:

```ts
redact: (req) => ({
  durationMs: req.durationMs,
  userAgent: req.headers['user-agent'],
  // omit anything you don't want logged
})
```

The plugin does **not** capture request or response bodies by default —
PII redaction surface area is too speculative to ship without a real
consumer asking. Add it through `redact` (or call `audit.append` directly
from a handler) when you need it.

### `correlateOtelTraceId`

If `true`, the plugin tries to read the active OTel trace id via
`@opentelemetry/api` (if installed) and attaches it as `metadata.traceId`.
Falls back silently when OTel isn't installed. **Default `false`** —
opt-in because not every app runs OTel, and we don't want a hidden dynamic
import in the request hot path.

When combined with `@elysiajs/opentelemetry`, this is the principled
bridge: every audit row carries the trace_id of the span that produced it,
so SREs investigating a flagged audit row can pivot to the trace.

### `kind`

Override the event kind namespace. Default `'http.request'` — the plugin
appends `.ok` / `.client_error` / `.error` based on response status.
Override to differentiate audit streams:

```ts
auditElysia({ audit, kind: 'api.request' })   // emits api.request.ok / .client_error / .error
auditElysia({ audit, kind: 'admin.request' }) // for an admin-routes-only sub-app
```

### `requestIdHeader`

Header name to extract a client-supplied request id from. Default
`'x-request-id'`. Pass `null` to always mint a UUID.

## Which hook does it use?

`onAfterResponse` — the only Elysia lifecycle hook that fires once per
request **including error paths**. Verified via Elysia 1.4 docs and tested
with handlers that throw. `onRequest` is also wired (to stamp the wall-
clock start), but the emission is in `onAfterResponse`.

The plugin scopes both hooks to `'global'` so they apply to every route
registered on the parent app, not just routes defined on the plugin.

## What's NOT in 0.0.1

- **Body capture / redaction config schema** — speculative. Add via
  `redact` for now; we'll formalize once a real consumer's needs are
  clear.
- **Per-route opt-out** — every request on the mounted app emits. Two
  separate `auditElysia()` instances on different sub-apps can give
  per-prefix scoping.
- **Sampling** — every request emits. Audit isn't a place to sample.

## License

[Apache 2.0](../LICENSE). Substrate-adjacent — rides
`@absolutejs/audit` (BSL Tier A) and `elysia` (MIT).
