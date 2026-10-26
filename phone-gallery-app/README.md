# Phone Gallery (Android app)

The photos and videos on your phone in an Instagram-style gallery, built from
the X Bookmarks Gallery (`../twitter-gallery`):

- 4-column grid with All / Photos / Videos, newest/oldest sorting (by date
  taken or date added), and Grid / Months / Years with a year and month bar.
- **Albums** tab: albums you make (long-press to select, then "Add to album",
  or the bookmark button on a photo), plus the phone's own folders (Camera,
  Screenshots, WhatsApp…).
- Tap a photo for a freely scrolling feed of just the pictures; tap one to
  open it full screen, (just that one), where tapping shows/hides iPhone-style
  buttons (back, ⋯, Share, Star · Info · Album, Delete). Files that can't be
  shown get a dark cracked-Polaroid tile with "Open with another app".
- ★ Star photos (Starred album), share one or many, and delete to the
  phone's own recycle bin (kept 30 days) with a Recycle bin album to restore
  or delete forever. Android asks to confirm each delete unless you allow
  "media management" (⋯ on the All tab → "Delete without asking each time").
- ⋯ on the All tab: switch folders (e.g. Screenshots) off to keep them out of
  All; they still open from Albums.
- Albums page laid out like the phone's gallery (All, Camera, Starred,
  Videos, Screenshots; your albums; more albums with small one-off folders
  combined into "Others"; Media types and Recycle bin).
- Settings (⋯): dark/light mode, combining small folders, folders in All.
- A floating AssistiveTouch-style button hides/shows the header.
- Returning to the app only reloads when photos actually changed (Android's
  media change counter), and then updates in place.
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

Needs Android 11+ on the phone. To build: JDK 17+, Gradle 8.9+, the Android SDK (platform 35), and the signing key
in `keystore/` (kept out of git):

```
gradle assembleRelease
# -> app/build/outputs/apk/release/app-release.apk
```
