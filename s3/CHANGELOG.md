# Changelog

## [0.0.1] — 2026-05-30

Initial preview. S3-compatible `AuditSink` for `@absolutejs/audit`.

### Surface

- **`createS3AuditSink({ put, prefix?, keyFor?, maxBatchSize?, maxBatchBytes?, flushIntervalMs?, onPutError? })`** —
  returns an `AuditSink`. Takes a narrow `put(key, body, contentType)`
  callback so it works with AWS SDK v3, Cloudflare R2 (Workers binding
  or fetch + signed URLs), MinIO, Backblaze B2 — no hard SDK dep.
- **`defaultKeyFor(prefix)`** — exported separately for callers wanting
  the default key shape (`audit/<YYYY-MM-DD>/<HH-MM-SS.mmm>-<rand>.jsonl`)
  in custom `keyFor` implementations.
- **Buffered + JSONL.** One event per line, trailing newline. Flush
  triggers: size (events OR bytes), time interval, manual `flush()`,
  graceful `close()`.
- **Sortable keys.** Lexical sort = chronological. Date prefix is the
  lifecycle-policy boundary.
- **Tamper-evident across batches.** The `withIntegrity()` chain works
  unmodified — concatenate JSONL files in lexical order and verify.
- **Concurrent flushes serialize** (chained promise) so two size triggers
  don't race the buffer.

### Tested

13 tests: buffering, size+byte+manual+close triggers, content-type,
JSONL format, multi-object output, default `keyFor` shape + sortability,
12-event chain spanning 3 batches verifying end-to-end, `onPutError`
keeps the sink usable after a failed PUT.

### License

Apache 2.0 (Tier B substrate-adjacent — rides `@absolutejs/audit`
Tier A).
