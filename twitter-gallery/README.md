# X Bookmarks Gallery (browser extension)

Shows the photos and videos from your X bookmarks in a 3-column, Instagram-style
grid. Tap any item for a full-screen viewer (swipe up/down to move between posts)
with an **Open post** button.

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
2. Tap the floating blue **▦** ball, or open the extension from the menu
   and tap **Open gallery**. The header shows "Loading all bookmarks…" until
   everything is in, then "All loaded".

## Browsing

- **Floating ball**: a blue ball appears on every X page. Drag it anywhere (it
  snaps to the side); tap it to open the gallery. Away from your bookmarks it
  shows the saved copy from last time (tap **Refresh** to update). Turn it
  off in the extension's popup.
- **Swipe** left/right to switch between **All posts** and **Collections**.
- The header hides as you scroll down and comes back when you scroll up.
- **⇅ Newest / Oldest** sorts posts, by when you bookmarked them or when they
  were posted.
- **Grid / Months / Years**: Months groups posts under month headings; Years
  shows a card per year. In both, a bar under the header lists the years —
  tap one to see only that year, then a second bar lists its months — tap
  one to see only that month.
- In the full-screen viewer, **swipe up** for the next post and **down** for
  the previous one (or use the ▲ ▼ buttons).
- **Long-press** a post to start selecting; tap more to add them.

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
