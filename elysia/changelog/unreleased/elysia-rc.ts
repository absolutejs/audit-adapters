import type { Change } from '@absolutejs/changelog';

export const change: Change = {
	detail: "Elysia 2.0.0-rc.0 renamed every lifecycle hook to its `on` form and removed setup/cleanup (now onStart/onStop). This package now builds and tests against Elysia 2.0.0-rc.0 and requires `elysia ^2.0.0-rc.0`, which also accepts later release candidates and 2.0.0. Its plugin's hooks are renamed to match.",
	kind: 'breaking',
	migration: { instruction: "Upgrade `elysia` and every `@elysia/*` package to 2.0.0-rc.0 or later, then rename lifecycle hooks in your own server: request \u2192 onRequest, beforeHandle \u2192 onBeforeHandle, afterHandle \u2192 onAfterHandle, afterResponse \u2192 onAfterResponse, error \u2192 onError, parse \u2192 onParse, transform \u2192 onTransform; setup/cleanup \u2192 onStart/onStop. absolutejs/scripts codemods/elysia-rc-hooks.ts does the renames (run it before upgrading Elysia).", manual: true },
	summary: 'Requires Elysia 2.0.0-rc.0',
	symbols: ["auditElysia"]
};
