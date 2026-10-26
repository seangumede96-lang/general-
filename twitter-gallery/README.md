# X Bookmarks Gallery (browser extension)

Shows the photos and videos from your X bookmarks in a 3-column, Instagram-style
grid. Tap any item for a full-screen viewer (swipe left/right to move, swipe
down to close) with an **Open post** button.

No X API is needed. While you're logged in at <https://x.com/i/bookmarks>, the
extension reads the bookmark data the page already loads (this gives playable
video links), and also collects media from the posts visible on screen.

## Install on Android

1. Install a browser that supports Chrome extensions from a .zip
   (Kiwi Browser was discontinued in 2025; Lemur Browser is a common alternative).
2. Download `twitter-gallery.zip` (files must be at the top level of the zip).
3. Browser menu → **Extensions** → turn on **Developer mode** → **+ (from .zip)** → pick the zip.

## Use

1. Open <https://x.com/i/bookmarks> and log in.
2. Tap the blue **▦** button (bottom right), or open the extension from the menu
   and tap **Open gallery**.
3. Tap **Load more** to keep loading older bookmarks automatically.

## Files

`manifest.json`, `inject.js` (reads X's bookmark data), `content.js` (gallery),
`styles.css`, `popup.html` + `popup.js` (menu popup).
