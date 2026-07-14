# Changelog

## [0.0.4] — 2026-07-14

- Aligns the runtime and development `@absolutejs/telemetry` dependency with
  `^0.1.1`, preventing duplicate telemetry installations in hosts using the
  current official OpenTelemetry provider bridge.
- No runtime API changes.

## [0.0.2] — 2026-05-30

### Refactored — use `@absolutejs/telemetry.readActiveTraceId`

Internal cleanup. The dynamic-optional `@opentelemetry/api` import for
reading the active span's trace id moved out of audit-elysia and into
`@absolutejs/telemetry@0.0.3`'s `readActiveTraceId()` helper.
Behavior is unchanged — `correlateOtelTraceId: true` still attaches
`metadata.traceId` to every audit event when an OTel span is active.

`@absolutejs/telemetry@^0.0.3` added as a regular dep (250 LOC, zero
transitive deps — no consumer-side peer-dep gymnastics).

13 tests still green.

## [0.0.1] — 2026-05-30

Initial preview. Elysia plugin that emits one structured audit event per
HTTP request into `@absolutejs/audit`.

Fills the open gap surfaced by the deep-research audit:

- `@elysiajs/server-timing` is performance instrumentation (off by
  default in production, header-only).
- `@elysiajs/opentelemetry` is sampled tracing (ephemeral spans).
- Community has ~12 logging plugins; none ship structured tamper-evident
  audit.

### Surface

- **`auditElysia({ audit, actor?, redact?, correlateOtelTraceId?, kind?, requestIdHeader? })`** —
  returns an Elysia plugin. Hooks `onRequest` (stamps requestId +
  startedAt into a WeakMap keyed by the Request) + `onAfterResponse`
  (emits the audit event). Both hooks promoted to `as('global')` so
  they apply to every route on the parent app.
- **Event kind suffix** based on status: `.ok` (<400) /
  `.client_error` (4xx) / `.error` (5xx). Override the namespace via
  `kind` option.
- **`requestId` extraction** from `x-request-id` header (or custom
  header). Mints a UUID when absent. `requestIdHeader: null` always
  mints.
- **OTel trace correlation** via dynamic, optional `@opentelemetry/api`
  import — `correlateOtelTraceId: true` attaches `metadata.traceId`
  when an active span exists. No-op when OTel isn't installed.
- **Failure isolation**: actor resolver throwing or audit pipeline
  failing doesn't crash the response. The audit's own `onError` hook
  catches sink failures upstream of the plugin.

### Tested

13 tests driving a real Elysia instance via `app.handle()`:

- emit on success / 4xx / thrown 5xx
- different routes emit distinct targets
- requestId from header / minted / custom header / always-mint
- actor resolver success + throw-safe
- redact override
- custom kind namespacing
- failing audit sink doesn't break the response

### License

Apache 2.0 (Tier B substrate-adjacent — rides `@absolutejs/audit`
Tier A + `elysia` MIT).
