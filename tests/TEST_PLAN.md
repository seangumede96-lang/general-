# Test plan — X Bookmarks Gallery in Firefox Nightly

Every scenario runs in real Firefox Nightly through Selenium against the mock
X server (`tests/mock_x`). The test file that covers each one is in brackets.

## A. First-time use [test_first_use.py]
- A1 Install → the floating bookmark ball shows on x.com pages, nothing breaks the page.
- A2 Open the bookmarks page → every page of bookmarks loads in the background; the gallery shows every photo/video, the count matches, and the status says "All N bookmarks loaded".
- A3 Photos / Videos filters, Newest / Oldest, "I bookmarked it" / "It was posted".
- A4 Months view with year/month chips; Years view; tapping a year card.
- A5 Search by words, by @name, emoji, no matches, clear search.
- A6 Tap a picture → the post feed opens on that post; a video plays; back to the grid.
- A7 Header button: hide filters → hide header → show all.
- A8 Light / dark mode.

## B. Popup [test_popup.py]
- B1 "Open gallery" with no X tab open → opens the bookmarks in a new tab.
- B2 "Open gallery" with an X tab → the gallery opens in that tab.
- B3 "Go to my bookmarks" from X's home page → moves to the bookmarks without a page load.
- B4 Floating-button switch: off hides the ball on open X tabs at once, and stays off.
- B5 X tab opened before the extension was installed / page not reloaded → helpful message.

## C. Collections [test_collections.py]
- C1 Create a collection, add posts with Select → Add to collection.
- C2 Save button in the post feed.
- C3 Rename, remove posts, delete a collection.
- C4 Mistakes: empty name, spaces only, very long name, emoji and HTML in names.
- C5 Back up collections and restore from the file; restore a file that isn't a backup.

## D. Everyday use [test_everyday.py]
- D1 Come back to the bookmarks → only a quick top-up (1–2 requests); new bookmarks appear.
- D2 Open the gallery on X's home page → the saved copy shows without loading.
- D3 Reload the page with the gallery open → it comes back in the same place.
- D4 Restart Firefox → collections, settings and the saved copy survive.
- D5 Reload / update the extension → data survives.
- D6 Two X tabs at once; twitter.com as well as x.com.
- D7 Private browsing window.

## E. Mistakes a real user makes [test_mistakes.py]
- E1 Double-click the ball; open/close the gallery fast; double-click a tile.
- E2 Clicking filters, layouts and tabs quickly.
- E3 Browser Back while the feed / selection / a collection is open; Escape key.
- E4 Odd search text: emoji, regex characters, very long text, HTML.
- E5 Leaving the bookmarks page in the middle of loading.

## F. Pages and network trouble [test_network.py]
- F1 X refuses the API (500) → gallery falls back to scrolling the page and says so.
- F2 X refuses big pages (400 for count 100) → carries on at normal size.
- F3 Rate limited (429) → waits, then carries on.
- F4 Broken JSON from X.
- F5 Slow page and slow API.
- F6 Very large library (several thousand bookmarks) — loads, scrolls, stays responsive.
- F7 Pictures that fail to load → broken-picture tile, no crash.
- F8 Firefox's own pages (about:…) and non-X sites — extension stays out.

## G. Saved data [test_storage.py]
- G1 Settings, collections and saved copy written to storage.local in the expected shape.
- G2 Corrupted / unexpected stored values → the gallery still opens.

## Always checked
- No errors from the extension in the Browser Console log or the page.
- `web-ext lint` stays at 0 errors / 0 warnings.
