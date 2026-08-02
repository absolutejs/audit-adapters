# AbsoluteJS Audit Adapters

Production integrations for `@absolutejs/audit`. Install only the adapters your application needs; every package implements the core audit contracts without coupling the application to a storage or web framework.

## Packages

| Package                      | Purpose                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `@absolutejs/audit-elysia`   | Emits one structured audit event for every Elysia request, including error paths and optional OpenTelemetry correlation. |
| `@absolutejs/audit-postgres` | Durable PostgreSQL audit history with Drizzle and tagged-template adapters, JSONB metadata, and indexed queries.         |
| `@absolutejs/audit-s3`       | Buffered JSONL audit archives for S3-compatible storage, including R2, B2, and MinIO.                                    |

## Choose an adapter

Use the Elysia adapter at the request boundary, PostgreSQL when operators need searchable history, and S3-compatible storage for inexpensive long-term or WORM retention. Applications can compose multiple sinks when they need both operational queries and compliance archives.

```sh
bun add @absolutejs/audit @absolutejs/audit-elysia @absolutejs/audit-postgres
```

Each package has its own README with setup, configuration, and operational guidance.
