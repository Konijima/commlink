# Known issues

Tracked bugs and rough edges. Newest first. When filing one, note how to reproduce it
and how severe it is so it can be prioritized against the roadmap.

Format:

```
### <id> — <short title>   [open|fixed]   severity: low|medium|high
Repro: <the shortest reliable way to trigger it>
Notes: <cause, workaround, or fix once known>
```

---

### 1 — the built server cannot start   [open]   severity: high
Repro: `pnpm -C server build && pnpm -C server start`

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/dist/app'
imported from .../server/dist/server.js
```

Notes: the package is `"type": "module"`, so Node's ESM loader needs a file extension on
every relative import. `tsconfig.json` sets `"moduleResolution": "Bundler"`, which lets
the source write `from './app'` and emits it unchanged, so nothing resolves at runtime.
Only the compiled output is affected — `pnpm dev` (tsx) and `pnpm test` (vitest) resolve
extensionless imports themselves, which is why the suite is green.

This breaks the documented deployment: `deploy/commlink-server.service` runs
`node dist/server.js`. Fix by switching the build to `"moduleResolution": "NodeNext"`
and writing `./app.js` in the imports, then keep it honest with a CI step that builds
and boots the server rather than only type-checking it.
