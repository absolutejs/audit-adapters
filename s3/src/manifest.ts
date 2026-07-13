import { defineManifest } from '@absolutejs/manifest';
import { Type } from '@sinclair/typebox';
import type { CreateS3AuditSinkOptions } from './index';

/* Plain AdapterImplementation literal (no defineImplementation checker):
 * the sink's factory takes a `put` callback rather than bucket/credentials,
 * so the settings here (bucket/endpoint/region) configure the S3 client the
 * wiring builds around it — they intentionally don't map 1:1 onto
 * CreateS3AuditSinkOptions. Same pattern as @absolutejs/blob's s3 entry. */
export const manifest = defineManifest<CreateS3AuditSinkOptions>()({
	contract: 1,
	identity: {
		accent: '#f59e0b',
		category: 'compliance',
		description:
			'S3-compatible `AuditSink` for `@absolutejs/audit`. Buffered JSONL batches with time-sortable object keys (AWS S3, Cloudflare R2, Backblaze B2, MinIO); WORM-bucket-friendly for compliance retention. Write-only archive — pair with a queryable sink for lookups.',
		docsUrl: 'https://github.com/absolutejs/audit-adapters/tree/main/s3',
		name: '@absolutejs/audit-s3',
		tagline: 'Archive your audit log in cheap cloud storage, for years.'
	},
	implements: [
		{
			contract: 'audit/sink',
			factory: 'createS3AuditSink',
			from: '@absolutejs/audit-s3',
			requires: {
				env: [
					{
						description:
							'Access key id for your storage provider',
						key: 'S3_ACCESS_KEY_ID',
						secret: true
					},
					{
						description:
							'Secret access key for your storage provider',
						key: 'S3_SECRET_ACCESS_KEY',
						secret: true
					}
				],
				peers: [
					{
						name: '@aws-sdk/client-s3',
						range: '^3.0.0',
						reason: 'S3 wire protocol client'
					}
				]
			},
			settings: Type.Object({
				bucket: Type.String({
					description: 'The bucket audit batches are written to.',
					title: 'Bucket name'
				}),
				endpoint: Type.Optional(
					Type.String({
						description:
							'Only needed for non-AWS providers (Cloudflare R2, Backblaze B2, MinIO, Wasabi).',
						examples: [
							'https://<account>.r2.cloudflarestorage.com'
						],
						format: 'uri',
						title: 'Service URL'
					})
				),
				flushIntervalMs: Type.Optional(
					Type.Integer({
						default: 5000,
						description:
							'How often buffered events are written out, in milliseconds. Events buffered between flushes are lost if the process is killed — lower this to shrink the loss window.',
						minimum: 100,
						title: 'Flush every'
					})
				),
				prefix: Type.Optional(
					Type.String({
						default: 'audit/',
						description:
							'Object-key prefix — lets one bucket hold multiple audit streams.',
						title: 'Key prefix'
					})
				),
				region: Type.Optional(
					Type.String({
						default: 'auto',
						description: "Your provider's region. Use 'auto' for R2.",
						title: 'Region'
					})
				)
			}),
			title: 'Cloud storage archive (AWS S3, Cloudflare R2, Backblaze B2, MinIO)',
			wiring: {
				code: [
					'(() => {',
					'\tconst aws = new S3Client({',
					'\t\tcredentials: {',
					'\t\t\taccessKeyId: ${env.S3_ACCESS_KEY_ID} ?? "",',
					'\t\t\tsecretAccessKey: ${env.S3_SECRET_ACCESS_KEY} ?? ""',
					'\t\t},',
					'\t\tendpoint: ${settings.endpoint},',
					'\t\tregion: ${settings.region}',
					'\t});',
					'\treturn createS3AuditSink({',
					'\t\tflushIntervalMs: ${settings.flushIntervalMs},',
					'\t\tprefix: ${settings.prefix},',
					'\t\tput: async (key, body, contentType) => {',
					'\t\t\tawait aws.send(new PutObjectCommand({ Body: body, Bucket: ${settings.bucket}, ContentType: contentType, Key: key }));',
					'\t\t}',
					'\t});',
					'})()'
				].join('\n'),
				imports: [
					{
						from: '@aws-sdk/client-s3',
						names: ['PutObjectCommand', 'S3Client']
					},
					{
						from: '@absolutejs/audit-s3',
						names: ['createS3AuditSink']
					}
				]
			}
		}
	],
	settings: Type.Object({}),
	wiring: []
});
