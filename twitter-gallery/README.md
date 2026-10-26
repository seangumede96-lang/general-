# X Bookmarks Gallery (browser extension)

Shows the photos and videos from your X bookmarks in a 4-column, Instagram-style
grid. Tap any item to open a feed of posts you can scroll freely, like Instagram:
posts run edge to edge, with the account name and date over each picture and
round Save / Open post buttons side by side at the bottom.

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
2. Tap the floating round bookmark ball, or open the extension from the menu
   and tap **Open gallery**. A ring like the iPhone's App Store
   download circle fills up beside the count ("31%  12,400 of ~40,000"; the
   total is from your last full load, since X doesn't say how many you have;
   the first time, the ring spins beside a live count), then the header says
   "All 40,000 bookmarks loaded".

## Browsing

- **Floating ball**: a round ball appears on every X page. Drag it anywhere (it
  snaps to the side); tap it to open the gallery. Away from your bookmarks it
  shows the saved copy from last time (tap **Refresh** to update). Turn it
  off in the extension's popup.
- **Swipe** left/right to switch between **All posts** and **Collections**.
- The header hides as you scroll down and comes back when you scroll up. A
  round button (drag it to either side) switches the header off completely and
  back on; the choice is remembered.
- **⇅ Newest / Oldest** sorts posts, by when you bookmarked them or when they
  were posted.
- **Grid / Months / Years**: Months groups posts under month headings; Years
  shows a card per year. In both, a bar under the header lists the years —
  tap one to see only that year, then a second bar lists its months — tap
  one to see only that month.
- Tapping a post opens a scrolling feed starting at that post; scroll up or
  down freely and stop anywhere. Videos play (muted) while on screen.
- Your phone's back gesture/button closes the feed (or a menu) and cancels
  selecting. You can also leave the feed by swiping it
  to the right, or with the ‹ button.
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

## Speed with big libraries

- Bookmarks are fetched 100 at a time (X's page usually asks for 20), falling
  back to X's own size if it refuses, and paced by X's rate-limit headers
  rather than a fixed wait.
- The grid only draws the rows near the screen and works out every tile's
  position up front, so tens of thousands of posts scroll smoothly.
- Thumbnails are requested once a fast fling slows down; recently passed tiles
  are kept so scrolling back is instant. Photos fade in over a grey placeholder.
- An iPhone-style fast-scroll handle on the right (with a month label and
  ↑ / ↓ buttons to jump to the very top or bottom).

## Look

- White accents in dark mode, red in light mode (⋯ → Settings → Dark mode).
- iPhone-style selection tick, bottom confirmation sheet, and a cracked-Polaroid
  tile for pictures X won't serve.
- Tapping a post opens the feed with it in the middle of the screen; Collections
  and each collection reopen where you left them.

## Very large libraries (100,000+ bookmarks)

- X allows about 500 requests per 15 minutes, so 200,000 bookmarks take
  roughly an hour. When X asks for a pause the header says how long
  ("continuing in 12 min"), and loading carries on by itself.
- Progress is kept every 10,000 bookmarks. If the tab is closed or reloaded,
  the next visit to the bookmarks page shows what was found and carries on
  from there (within 24 hours).
- The saved copy is stored in pieces of 5,000, so saving and opening it never
  freezes the browser.

## Coming back to the bookmarks page

With a complete saved copy, opening the bookmarks page again (for example
after Android paused the browser) only checks for new bookmarks: it fetches
from the newest end until two pages bring nothing new, usually one or two
requests, and adds anything new to the saved copy. A full reload runs when
the saved copy is a week old, or from ⋯ → **Reload all bookmarks from X**
(which also catches bookmarks you've removed).

## Sorting bookmarks into folders

⋯ → **Export all bookmarks for sorting** saves every loaded post once (its id,
author, text, type and dates, plus its media keys) as
`x-bookmarks-all-<date>.json.gz` (compressed, so about a sixth of the size;
plain `.json` on browsers without compression support).
Once the posts are sorted, ⋯ → **Import sorted folders** reads the result (a
collections backup whose folders may list post ids in `posts` instead of
media `keys`) and adds each folder as a collection. Existing
collections are kept; a folder with the same id gets the new posts added.
