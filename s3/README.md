# @absolutejs/audit-s3

S3-compatible `AuditSink` for [@absolutejs/audit](https://github.com/absolutejs/audit).

Buffered JSONL writes to AWS S3 / Cloudflare R2 / Backblaze B2 / MinIO — any
store with a "put a string at a key" API.

## Why S3 for audit logs

- **WORM (write-once-read-many) buckets** give legal hold for compliance
  retention (SOC2, HIPAA, FedRAMP). The hash-chain in
  `@absolutejs/audit`'s `withIntegrity()` gives tamper-evidence; WORM
  prevents deletion even by an admin.
- **Lifecycle policies** handle retention windows without a cron job.
  "Move to Glacier after 90 days, delete after 7 years" is one bucket
  policy.
- **Cheap.** Cold-tier storage costs cents/GB-month.
- **Queryable later** via Athena, DuckDB, or `s3 ls | xargs cat`.

S3 objects are immutable, so the sink buffers events and flushes as JSONL
files keyed by time. Object keys are lexically sortable; `s3 ls audit/`
returns events in chronological order.

## Install

```sh
bun add @absolutejs/audit @absolutejs/audit-s3
# Bring whichever S3 client you already use — no SDK lock-in:
bun add @aws-sdk/client-s3      # OR
# (Cloudflare R2 Workers binding — no install)
```

## Usage

### AWS SDK v3

```ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createAudit, withIntegrity, memorySink } from '@absolutejs/audit';
import { createS3AuditSink } from '@absolutejs/audit-s3';

const s3 = new S3Client({ region: 'us-east-1' });

const audit = createAudit({
  sinks: [
    memorySink({ max: 1000 }),                          // hot tail for queries
    withIntegrity(                                       // tamper-evident
      createS3AuditSink({
        put: async (key, body, contentType) => {
          await s3.send(new PutObjectCommand({
            Bucket: 'my-audit-bucket',
            Key: key,
            Body: body,
            ContentType: contentType,
          }));
        },
        prefix: 'audit/prod/',
        flushIntervalMs: 5_000,
      }),
      { secret: process.env.AUDIT_SECRET, writerId: 'shard-A' }
    ),
  ],
});

await audit.append({
  kind: 'auth.login',
  actor: 'user-123',
  metadata: { ip: '10.0.0.1' },
});

// On graceful shutdown:
await audit.close();
```

### Cloudflare R2 (Workers)

```ts
import { createS3AuditSink } from '@absolutejs/audit-s3';

const sink = createS3AuditSink({
  put: async (key, body, contentType) => {
    await env.AUDIT_BUCKET.put(key, body, { httpMetadata: { contentType } });
  },
});
```

### MinIO

Same as AWS SDK — MinIO speaks S3 protocol. Point the `S3Client` at your
MinIO endpoint and the adapter doesn't care.

## Object key layout

Default `keyFor` produces:

```
audit/2026-05-30/19-42-15.123-abcd1234.jsonl
```

- **Date prefix** (`2026-05-30/`) — lifecycle policies key off this.
- **Time component** (`19-42-15.123-`) — UTC `HH-MM-SS.mmm`. Lexical sort
  = chronological order.
- **8 hex chars random tail** — collision-resistant for two flushes at
  the same millisecond.
- **`.jsonl`** — one JSON-encoded event per line, trailing newline.

Override via the `keyFor` option for tenant-fan-out or hourly partitions.

## Flush triggers

Whichever fires first:

| Trigger | Default | Option |
|---|---|---|
| Buffer reaches event count | 1000 | `maxBatchSize` |
| Buffer reaches byte count | 5_000_000 (5 MB) | `maxBatchBytes` |
| Time since last flush | 5_000 ms | `flushIntervalMs` |
| Manual | (caller) | `await sink.flush()` |
| Close | (caller) | `await sink.close()` |

Set `flushIntervalMs: 0` to disable the periodic timer (size-only flushing).

## Crash safety

Unflushed events are **lost** on process kill. For stricter durability,
pair the S3 sink with a synchronous sink (Postgres) for critical events
— S3 is the long-term archive, not the source of truth between flushes.
Lower `flushIntervalMs` to shrink the loss window at the cost of more
S3 PUTs.

## What this sink does NOT do

- **`list` / `prune`** — not implemented. Read audit logs out of S3 via
  Athena / `s3 ls` / DuckDB; enforce retention via S3 lifecycle policies.
  The sink is write-only.
- **Retry on PUT failure** — `onPutError` callback fires once; the batch
  is dropped. Wire your own retry queue if you need at-least-once.
- **Multipart upload** — every batch is one PUT. If your batches grow
  past S3's 5GB PutObject limit you have other problems.

## Integrity across batches

The tamper-evident chain from `withIntegrity()` works across batch
boundaries automatically. Each event is hashed at append time against
the prior event's hash; the S3 sink only buffers + flushes — it doesn't
touch the chain. To verify a chain that spans multiple S3 objects:

```ts
import { verifyChain } from '@absolutejs/audit';

// Pull every JSONL object back, sort lexically (= chronologically), flatten:
const allEvents = orderedJsonlBodies.flatMap(body =>
  body.split('\n').filter(Boolean).map(line => JSON.parse(line))
);
const result = await verifyChain(allEvents, secret);
// { ok: true } or { ok: false, brokenAt: <index> }
```

## License

[Apache 2.0](../LICENSE). Substrate-adjacent — rides `@absolutejs/audit`
(BSL Tier A).
