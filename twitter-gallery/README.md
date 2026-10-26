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

## Files

`manifest.json`, `inject.js` (reads X's bookmark data), `content.js` (gallery),
`styles.css`, `popup.html` + `popup.js` (menu popup).
