# commlink Android client

The native Android app: a background subscriber that holds a WebSocket to a commlink
server and turns incoming messages into system notifications — with no Google Play
Services, Firebase, or FCM.

> **Not built yet.** This directory is a placeholder; the app is scheduled after the
> server is complete. See [`../TODO.md`](../TODO.md).

## Planned stack

- **Language:** Kotlin
- **Min SDK:** 26 (Android 8.0); target the latest stable SDK
- **UI:** Jetpack Compose (dark theme)
- **Networking:** OkHttp (WebSocket)
- **Persistence:** Room
- **No** proprietary dependencies — builds from an AOSP-compatible toolchain.

## Build requirements (for when work starts)

- JDK 17
- Android SDK (command-line tools or Android Studio). The SDK is **not** required to work
  on the server and will be set up when app development begins.
- A standard Gradle project; `./gradlew assembleRelease` will produce a signed APK.

## Application id

The app will use a reverse-DNS application id. Default: `io.github.konijima.commlink`
(to be confirmed before the first release).

## Distribution

Sideload only — no app store. Release builds are signed with a local keystore; signing
configuration is read from `keystore.properties`, which is git-ignored. Keystore creation
steps will be documented here once the build is in place.
