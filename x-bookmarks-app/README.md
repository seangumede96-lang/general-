# Bookmarks Gallery (Android app)

An Android app that opens X (x.com) full screen with the Bookmarks Gallery
built in: the same grid, collections, month/year views, post feed and floating
ball as the browser extension in `../twitter-gallery`. The gallery's scripts
are copied from that folder at build time, so both stay in step.

## Install

1. Download `x-bookmarks-app-vX.Y.Z.apk` on your phone and open it.
2. If Android asks, allow installing apps from that source (Files / Firefox).
3. Open **Bookmarks Gallery** and log in to X with your username/email and
   password (Google/Apple sign-in usually doesn't work inside apps like this).
4. Tap the blue bookmark ball to open the gallery.

New versions install over the old one and keep your collections only if
every build is signed with the same key. The key (`keystore/release.jks` and
`keystore/keystore.properties`) is deliberately kept out of git; keep a copy
somewhere safe and put it back in `keystore/` before building.

## How it works

- `MainActivity.java` shows x.com in a WebView and runs the gallery scripts
  before X's own scripts on every x.com page (androidx.webkit document-start
  scripts).
- `assets/app-shim.js` stands in for the browser-extension storage API; the
  app keeps collections and settings on the phone (`Bridge`).
- The phone's back button/gesture steps back in the page, which the gallery
  uses to close the post feed, menus, or selection.
- Links outside X open in your normal browser.

## Build

Needs JDK 17+, Gradle 8.9+, and the Android SDK (platform 35):

```
gradle assembleRelease
# -> app/build/outputs/apk/release/app-release.apk
```
