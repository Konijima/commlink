# commlink Android client

The native Android app: a background subscriber that holds a WebSocket to a commlink
server and turns incoming messages into system notifications — with no Google Play
Services, Firebase, or FCM.

> **Early.** The app subscribes and turns what arrives into notifications, but it has no
> settings screen to configure it from yet, and it does not reconnect when the connection
> drops. Both are next in [`../TODO.md`](../TODO.md).

## Stack

- **Language:** Kotlin
- **Min SDK:** 26 (Android 8.0) — the release that introduced notification channels, which
  the app wants one of per priority. Compiled and targeted against SDK 35.
- **UI:** Jetpack Compose (dark theme)
- **Networking:** OkHttp (WebSocket)
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

Both commands run in CI on every pull request, which also checks the wrapper jar this
repository ships against Gradle's published checksums — the jar is a binary every clone
executes, so it is verified rather than trusted. Change the wrapper with
`./gradlew wrapper --gradle-version <version>`, never by hand.

## How it connects

`SubscriberService` is a foreground service holding **one** WebSocket for every topic you
subscribe to — the server multiplexes them, and names the topic in each frame, so a second
topic costs no second connection. It is a foreground service because that is the only way
Android lets an app keep a socket open while nobody is looking at it; the persistent
notification you see is the price, and it is posted on a low-importance channel so it makes
no sound. Each message that arrives becomes a notification of its own.

The token travels on the handshake as `Authorization: Bearer …`, never in the URL, because a
query string is what proxies and access logs write down.

## Pointing a debug build at a server

There is no settings screen yet. Until there is, a **debug** build takes the server, the
token and the topics from its launch intent:

```sh
adb install app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n io.github.konijima.commlink/.MainActivity \
    -e server "https://push.example.com" \
    -e token "$TOKEN" \
    -e topic "alerts,builds"
```

The app subscribes, remembers what it was given, and reconnects to it if the system restarts
the service. Publish to one of those topics and the message arrives as a notification:

```sh
curl -H "Authorization: Bearer $TOKEN" -H "X-Title: Disk full" \
     -d "/ is at 98%" https://push.example.com/alerts
```

This is a developer's affordance, not a way to configure the app: a launch intent is
something any app on the device can send, and this one carries the token, so it is compiled
out of a release build.

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
