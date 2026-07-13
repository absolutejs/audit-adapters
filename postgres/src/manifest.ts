import { defineImplementation, defineManifest } from '@absolutejs/manifest';
import { Type } from '@sinclair/typebox';
import type { CreatePostgresAuditSinkOptions } from './index';

/* `sql` is instance-valued (the tag-template client) → built in the wiring
 * from DATABASE_URL; only table/ensureSchema are settings. */
export const manifest = defineManifest<CreatePostgresAuditSinkOptions>()({
	contract: 1,
	identity: {
		accent: '#336791',
		category: 'compliance',
		description:
			'Postgres-backed `AuditSink` for `@absolutejs/audit`. Accepts any postgres-js-compatible tag template (porsager/postgres or @neondatabase/serverless). Lazy idempotent schema, jsonb metadata (hash-chain links round-trip intact), indexed for recent-first queries.',
		docsUrl: 'https://github.com/absolutejs/audit-adapters/tree/main/postgres',
		name: '@absolutejs/audit-postgres',
		tagline: 'Store your audit log in your Postgres database.'
	},
	implements: [
		defineImplementation<CreatePostgresAuditSinkOptions>()({
			contract: 'audit/sink',
			factory: 'createPostgresAuditSink',
			from: '@absolutejs/audit-postgres',
			requires: {
				env: [
					{
						description:
							'Postgres connection string (audit events live here)',
						example: 'postgres://user:pass@host/db',
						key: 'DATABASE_URL',
						secret: true
					}
				],
				peers: [
					{
						name: '@neondatabase/serverless',
						range: '>=0.10.0',
						reason: 'HTTP tag-template Postgres client (swap for `postgres` over TCP if you prefer)'
					}
				],
				services: [
					{
						description: 'Stores the append-only audit event table',
						id: 'postgres'
					}
				]
			},
			settings: Type.Object({
				ensureSchema: Type.Optional(
					Type.Boolean({
						default: true,
						description:
							'Create the audit table and indexes automatically on first write. Turn off if you manage schema through migrations.',
						title: 'Create tables automatically'
					})
				),
				table: Type.Optional(
					Type.String({
						default: 'audit_events',
						description: 'Name of the table events are stored in.',
						pattern: '^[a-zA-Z_][a-zA-Z0-9_]*$',
						title: 'Table name'
					})
				)
			}),
			title: 'Your Postgres database (durable + queryable)',
			wiring: {
				code: "createPostgresAuditSink({ sql: neon(${env.DATABASE_URL} ?? ''), ...${settings} })",
				imports: [
					{
						from: '@absolutejs/audit-postgres',
						names: ['createPostgresAuditSink']
					},
					{ from: '@neondatabase/serverless', names: ['neon'] }
				]
			}
		})
	],
	settings: Type.Object({}),
	wiring: []
});
