# Contributing

Thanks for your interest in commlink. This is a small, focused project — a self-hosted
push-notification server and a native Android client — and contributions that keep it
minimal and dependency-light are very welcome.

## Development

The repository is a monorepo:

- `server/` — Node.js + TypeScript (pnpm workspace).
- `android/` — Kotlin / Gradle (see `android/README.md`).

### Server

Requirements: Node.js 22+ and [pnpm](https://pnpm.io).

```bash
cd server
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint + prettier --check
pnpm format        # prettier --write (rewrite files in place)
pnpm dev           # run locally on http://127.0.0.1:4500
pnpm build         # compile to dist/
pnpm smoke         # boot the compiled server and check /healthz
```

`pnpm dev` and `pnpm test` run the TypeScript sources through a loader that resolves
imports more leniently than Node does. `pnpm smoke` starts the compiled output, which
is the only check that catches a build that compiles but cannot start.

New server behaviour should land with tests. Keep the dependency surface small — this
project intentionally avoids heavy frameworks and proprietary services.

### Android

Requirements: a JDK (17 or newer) and an Android SDK with platform 35. Gradle itself comes
from the wrapper — see `android/README.md` for pointing the build at your SDK.

```bash
cd android
./gradlew test           # unit tests, on the JVM: no device or emulator needed
./gradlew assembleDebug  # app/build/outputs/apk/debug/app-debug.apk
```

CI runs both on every pull request, and checks the committed Gradle wrapper jar against
Gradle's published checksums. If you change the wrapper, regenerate it with
`./gradlew wrapper --gradle-version <version>` rather than editing it by hand — a wrapper
jar is a binary that every clone executes, so a hand-made one is refused.

## Branching & pull requests

- Branch off `develop`: `feature/<area>-<slug>`, `fix/<slug>`, or `chore/<slug>`.
- `main` is the release branch; `develop` is where work integrates. Both are protected.
- Open pull requests against `develop`. CI must be green before merge.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): imperative summary` (≤ 72 chars). Types: `feat`, `fix`, `chore`, `docs`,
`refactor`, `test`, `perf`, `build`, `ci`. Explain **why** in the body; keep commits
small and atomic.

## Code style

- TypeScript is strict; prefer explicit types at module boundaries.
- [ESLint](https://eslint.org) and [Prettier](https://prettier.io) enforce the style;
  `pnpm lint` checks both and `pnpm format` rewrites files to match. CI runs `pnpm lint`
  alongside `pnpm typecheck`, `pnpm test` and `pnpm smoke`, so run them before opening a
  pull request. The Android app is covered by its own CI job (`./gradlew test` and
  `./gradlew assembleDebug`); run those before opening a pull request that touches it.
- No secrets in the repo — configuration comes from environment variables (see
  `server/.env.example`).
