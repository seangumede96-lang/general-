# Roost

An Android app that runs several independent, permanently signed-in instances of X (x.com)
side by side, behind an app-only fingerprint / 4-digit passcode lock.

## How it works

- **Instances** – each account is a `WebView` bound to its own on-disk profile
  (`androidx.webkit` multi-profile), so cookies, storage and cache never mix. Every account opens
  in its own Recents entry and can be pinned to the home screen as its own icon.
- **Always signed in** – session cookies are persisted to the profile and flushed whenever a
  window leaves the foreground. Nothing clears them except "Sign out & delete".
- **App lock** – the passcode is a salted PBKDF2 hash in the app's private storage; fingerprint
  uses `BiometricPrompt` in biometric-only mode with "Use passcode" as the fallback. The app
  never uses device-credential auth, the keyguard, auth-bound Keystore keys or device-admin
  policies, so it cannot make Android require a screen lock.

Roost is an unofficial client: it loads the x.com website and ships none of X's code or branding.

## Build

    ./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
    ./gradlew testDebugUnitTest lintDebug

Requires JDK 17+ and the Android SDK (platform 35). Extra accounts need a recent
"Android System WebView" on the phone.

## Updating without losing logins

Every build is signed with `signing/roost.keystore`, so a newer APK installs straight over the
old one and all accounts stay signed in. Do not replace that file, and bump `versionCode` in
`app/build.gradle.kts` for each release. Never uninstall to update: uninstalling erases the
saved sessions.
