# Phone Gallery (Android app)

The photos and videos on your phone in an Instagram-style gallery, built from
the X Bookmarks Gallery (`../twitter-gallery`):

- 3-column grid with All / Photos / Videos, newest/oldest sorting (by date
  taken or date added), and Grid / Months / Years with a year and month bar.
- **Albums** tab: albums you make (long-press to select, then "Add to album",
  or the bookmark button on a photo), plus the phone's own folders (Camera,
  Screenshots, WhatsApp…).
- Tap a photo for a freely scrolling feed with Add to album and Share buttons;
  videos play muted while on screen and show their length in the grid.
- Swipe between tabs; the phone's back button closes menus, the feed,
  selection, then albums, then the app.
- Albums can be backed up to Downloads and restored.

Nothing is uploaded: the app only reads the phone's media library.

## How it works

`assets/web/` is the gallery page. `MainActivity.java` shows it in a WebView
and serves it, through one made-up local address, the media list
(`Android.getMedia()`), thumbnails (`/thumb/…`), full files (`/media/…`, with
range requests so videos can be skipped through, and HEIC photos converted to
JPEG), album storage, sharing and saving backups.

## Build

Needs JDK 17+, Gradle 8.9+, the Android SDK (platform 35), and the signing key
in `keystore/` (kept out of git):

```
gradle assembleRelease
# -> app/build/outputs/apk/release/app-release.apk
```
