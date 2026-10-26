# X Bookmarks Gallery (browser extension)

Shows the photos and videos from your X bookmarks in a 3-column, Instagram-style
grid. Tap any item for a full-screen viewer (swipe left/right to move, swipe
down to close) with an **Open post** button.

No X API is needed. When you open <https://x.com/i/bookmarks> while logged in,
the extension notes how the page asks X for its first batch of bookmarks, then
asks for every following batch the same way in the background, so all your
bookmarks load without scrolling. If X refuses those requests, the gallery
scrolls the bookmarks page for you while it's open.

## Install on Android

1. Install a browser that supports Chrome extensions from a .zip
   (Kiwi Browser was discontinued in 2025; Lemur Browser is a common alternative).
2. Download `twitter-gallery.zip` (files must be at the top level of the zip).
3. Browser menu → **Extensions** → turn on **Developer mode** → **+ (from .zip)** → pick the zip.

## Use

1. Open <https://x.com/i/bookmarks> and log in.
2. Tap the blue **▦** button (bottom left), or open the extension from the menu
   and tap **Open gallery**. The header shows "Loading all bookmarks…" until
   everything is in, then "All loaded".

## Collections

Like Instagram's saved collections, but stored on your phone (inside the
extension, not on X):

- **Collections** tab → **New collection** to make one.
- In **All posts**, tap **Select**, tap some posts, then **Add to collection**.
- Or open any post and tap **＋ Save**.
- Inside a collection: **Select** → **Remove** takes posts out; **⋯** renames
  or deletes the collection (posts stay in your bookmarks).
- **Back up collections** (bottom of the Collections tab) downloads a file;
  **Restore from backup** loads it again. Back up before removing the
  extension, because removing it deletes its saved data.

## Files

`manifest.json`, `inject.js` (reads X's bookmark data), `content.js` (gallery),
`styles.css`, `popup.html` + `popup.js` (menu popup).
