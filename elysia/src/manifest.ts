import { defineManifest } from '@absolutejs/manifest';
import { Type } from '@sinclair/typebox';
import type { AuditElysiaOptions } from './index';

/* Serializable subset of AuditElysiaOptions: kind / requestIdHeader /
 * correlateOtelTraceId. `audit` is instance-valued (the createAudit handle
 * from @absolutejs/audit) and `actor` / `redact` are function-valued →
 * wiring concerns. Contract v1 has no placeholder for another package's
 * wired instance, so the recipe references a module-scope `audit` binding
 * with a TODO (same pattern as auth's getUser). */
export const manifest = defineManifest<AuditElysiaOptions>()({
	contract: 1,
	identity: {
		accent: '#7c3aed',
		category: 'compliance',
		description:
			'Elysia plugin emitting one structured audit event per HTTP request into `@absolutejs/audit`. Wires onRequest + onAfterResponse so success AND error paths are captured; optional OTel trace-id correlation. Orthogonal to server-timing (perf headers) and opentelemetry (sampled tracing).',
		docsUrl: 'https://github.com/absolutejs/audit-adapters/tree/main/elysia',
		name: '@absolutejs/audit-elysia',
		tagline: 'Record every request your server handles in the audit log.'
	},
	requires: {
		peers: [
			{
				name: '@absolutejs/audit',
				range: '>=0.0.1',
				reason: 'the audit log requests are recorded into'
			},
			{ name: 'elysia', range: '>=1.4.0', reason: 'plugin host' }
		]
	},
	settings: Type.Object({
		correlateOtelTraceId: Type.Optional(
			Type.Boolean({
				default: false,
				description:
					'Attach the active OpenTelemetry trace id to every request event, so audit rows link straight to traces. No-op when OTel is not installed.',
				title: 'Link events to traces',
				'x-group': 'advanced'
			})
		),
		kind: Type.Optional(
			Type.String({
				default: 'http.request',
				description:
					"Namespace for request events — '<kind>.ok', '<kind>.client_error', '<kind>.error' by response status.",
				title: 'Event kind prefix',
				'x-group': 'advanced'
			})
		),
		requestIdHeader: Type.Optional(
			Type.Union([Type.String(), Type.Null()], {
				default: 'x-request-id',
				description:
					'Header a client-supplied request id is read from; a UUID is minted when absent. Set to null to always mint.',
				title: 'Request id header',
				'x-group': 'advanced'
			})
		)
	}),
	wiring: [
		{
			id: 'default',
			server: {
				code: [
					'.use(',
					'\tauditElysia({',
					'\t\t// TODO: pass the `audit` instance created via @absolutejs/audit.',
					'\t\taudit,',
					'\t\t...${settings}',
					'\t})',
					')'
				].join('\n'),
				imports: [
					{
						from: '@absolutejs/audit-elysia',
						names: ['auditElysia']
					}
				],
				placement: 'server-plugin'
			},
			title: 'Audit every HTTP request'
		}
	]
});
