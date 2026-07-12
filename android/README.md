# commlink Android client

The native Android app: a background subscriber that holds a WebSocket to a commlink
server and turns incoming messages into system notifications — with no Google Play
Services, Firebase, or FCM.

> **Early.** The Gradle project builds and its unit tests run, but the app does not
> subscribe to anything yet: it launches to a placeholder screen. The subscriber service,
> the notifications and the UI are the next items in [`../TODO.md`](../TODO.md).

## Stack

- **Language:** Kotlin
- **Min SDK:** 26 (Android 8.0) — the release that introduced notification channels, which
  the app wants one of per priority. Compiled and targeted against SDK 35.
- **UI:** Jetpack Compose (dark theme)
- **Networking:** OkHttp (WebSocket) — not wired up yet
- **Persistence:** Room — not wired up yet
- **No** proprietary dependencies: nothing from Play Services, so the app runs on an AOSP
  build.

## Building

You need a JDK (17 or newer) and an Android SDK with platform 35. Point the build at the
SDK either by exporting `ANDROID_HOME`, or by writing `local.properties` in this directory:

```properties
sdk.dir=/path/to/Android/Sdk
```

`local.properties` is machine-specific and git-ignored. Everything else — including Gradle
itself — comes from the wrapper, so there is nothing to install globally:

```sh
./gradlew test           # unit tests, on the JVM: no device or emulator needed
./gradlew assembleDebug  # app/build/outputs/apk/debug/app-debug.apk
```

The first run downloads Gradle and the build's dependencies, so give it a few minutes.

## Layout

```
android/
├── settings.gradle.kts        # the modules, and the repositories they may resolve from
├── build.gradle.kts           # the plugins, declared once for every module
├── gradle/libs.versions.toml  # every dependency version, in one place
└── app/                       # the application module
    └── src/
        ├── main/java/io/github/konijima/commlink/
        └── test/java/…        # unit tests
```

## Application id

`io.github.konijima.commlink`.

## Distribution

Sideload only — no app store. Release builds will be signed with a local keystore; the
signing configuration is read from `keystore.properties`, which is git-ignored. Keystore
creation steps will be documented here once release signing is in place —
`./gradlew assembleRelease` currently produces an unsigned build.
