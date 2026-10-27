# X Bookmarks Gallery (Firefox extension)

Shows the photos and videos from your X (Twitter) bookmarks as a full-screen,
Instagram-style 4-column grid on x.com, with collections, search, filters,
month/year views, a post feed with video, and a full-screen "reels" viewer.
The owner isn't technical: explain things plainly and ask only for real decisions.

## Layout
- `extension/` — the extension source (Manifest V3, Firefox 128+ desktop and Android).
  - `manifest.json` — id `x-bookmarks-gallery@local`; no background script.
  - `inject.js` — runs in the **page** (`"world": "MAIN"`). Hooks X's own
    fetch/XHR, spots the first `graphql/.../Bookmarks` request, then asks for
    every following page itself (100 at a time, paced by X's rate-limit
    headers, remembers where it got to in `localStorage.xbg_resume`). Posts
    media to content.js with `window.postMessage({__xbg: true, ...})`.
  - `content.js` — the gallery UI (built on first open), floating ball,
    collections, saving (`browser.storage.local`), scroll-the-page fallback.
  - `styles.css` — everything scoped under `#xbg-overlay` / `#xbg-ball`.
  - `popup.html/js` — toolbar popup: Open gallery, Go to my bookmarks, ball on/off.
  - `options.html/js` — settings page in about:addons (switches, saved-data
    summary, back up / restore / unhide all, how-to guide). Same storage.
- `tests/` — Selenium + pytest suite driving real Firefox Nightly.
  - `mock_x/` — a stand-in for x.com / pbs.twimg.com / video.twimg.com on
    127.0.0.1:443 (`server.py` + `app.html`). Tests change its behaviour with
    `ctl(...)` (total bookmarks, failures, rate limits, slow, broken JSON…).
  - `harness.py` — starts Nightly with the extension as a temporary add-on,
    plus helpers (open extension pages, read storage, fake file picker,
    revoke x.com access, allow private windows, offline, zoom).
  - `TEST_PLAN.md` — the scenarios; each `test_*.py` file covers a group.
- `dist/` — built package (`web-ext build`), rename `.zip` → `.xpi` to install.

### Storage keys (storage.local)
`xbg_settings` (also collSort, showHidden, videoSound, videoSpeed, lastBackup,
backupBase, backupSnooze, backupRemind), `xbg_collections`
([{id,name,keys, used?, cover?, pending?: [status ids not loaded yet]}]),
`xbg_hidden` ([status ids hidden from All posts]), `xbg_items` (media of
collection posts not in the saved copy), `xbg_cache` (meta) + `xbg_cache_N`
chunks of 5,000 items, `xbg_cache_partial*` while a long load is unfinished.
Page-side: `sessionStorage.xbg_spot` (where you were), `xbg_open`, `xbg_full`.

## Build, load, run
- Lint: `cd extension && web-ext lint` (must stay 0 errors / 0 warnings apart
  from the data_collection_permissions min-version note, see below).
- Try it: `cd extension && web-ext run --firefox=/opt/ffn/firefox/firefox`
  (real x.com needs a logged-in X account).
- Package: `cd extension && web-ext build --artifacts-dir ../dist`.
- Manual install in Nightly: about:debugging → This Nightly → Load Temporary
  Add-on → `extension/manifest.json`.

## Running the tests (Firefox Nightly)
One-time setup on a fresh machine (what this session did):
```
# Firefox Nightly
mkdir -p /opt/ffn && cd /opt/ffn && curl -sSL -o n.tar.xz "https://download.mozilla.org/?product=firefox-nightly-latest-ssl&os=linux64&lang=en-US" && tar xf n.tar.xz
# geckodriver (Selenium's driver for Firefox) — GitHub API may be blocked; use a fixed version
curl -sSL https://github.com/mozilla/geckodriver/releases/download/v0.36.0/geckodriver-v0.36.0-linux64.tar.gz | tar xz -C /usr/local/bin
npm i -g web-ext
pip3 install -r tests/requirements.txt
```
Then, as root (the mock server binds port 443):
```
tests/run.sh                 # everything (~10 min, 70+ tests, includes web-ext lint)
tests/run.sh -k popup        # one group
tests/run.sh -x -k "tops_up" # one test, stop at first failure
```
`FIREFOX_NIGHTLY=/path/to/firefox` overrides the binary. Screenshots of every
test's last screen and Firefox's console logs land in `tests/artifacts/`.
Every test also fails if the extension logged any error to the console or page.

## Bugs found and fixed (Oct 2026, v1.13.0 → 1.13.1)
1. **"Go to my bookmarks" left X stuck on the home timeline (Firefox only).**
   The popstate nudge to X's router carried an object made in the content
   script; X's router can't read it in Firefox ("Permission denied to access
   property key"). Now passes `history.state`. (Also used by the ball,
   Refresh and Reload all bookmarks.)
2. **Popup "Open gallery" with no X tab only opened the page**, asking you to
   click again. New tab gets `#xbg-open`; content.js opens the gallery and
   tidies the hash.
3. **web-ext lint warnings**: missing `data_collection_permissions` (now
   `required: ["none"]`), dynamic `innerHTML` in the sort button.
4. **Delete-collection question opened over the still-open menu**: see-through,
   buttons overlapping; the deleted collection's menu stayed open afterwards.
5. **Extension update with X open**: Firefox kills the old content script but
   leaves its DOM → two balls (one dead) and a dead, un-closable gallery.
   start() now removes `#xbg-ball` / `#xbg-overlay` leftovers.
6. **Settings changed in one tab reverted by another tab** (each saved its
   stale copy). All tabs now adopt settings from `storage.onChanged`.
7. **Collections made in one tab deleted by another tab** (data loss). Tabs
   now adopt collection changes from `storage.onChanged`, ignoring their own writes.
8. **"All loaded" shown when X refused to send bookmarks** (scroll fallback ran
   dry). Now "Couldn't load everything", or "X didn't send your bookmarks" +
   "Reload to try again" when nothing came at all (was "Loading…" forever).
9. **Back after closing a menu changed X's page under the open gallery**
   (menu used up the gallery's history step). Step is put back while the gallery is open.
10. **Bookmarks loaded in the background weren't saved if you'd left the
    bookmarks page** before it finished. inject.js now tags loads of the main
    list (`status.main`) and saving goes by that, not the current URL.
11. **Popup failed silently with x.com access switched off** (about:addons →
    Permissions): it kept opening new X tabs. Now explains and offers "Allow
    access to X" (permissions.request), then opens the gallery.
12. **White scrollbar strip down the dark gallery** — added `color-scheme` and
    `scrollbar-color` on `#xbg-overlay`.

## Fixed from real-phone feedback (Oct 27 2026, `tests/test_phone_feedback.py`)
13. **Status line cut off on a phone** ("Partly loaded … · open your bookmar…")
    and it pushed Select / ⋯ off screen. The status now has its own full-width
    line under the title and wraps to two lines; the title has `min-width: 0`.
14. **Import/restore result was a one-line toast running off both sides.** Now
    an action-sheet popup like the delete question (`infoSheet()`: "Import
    finished" + message lines + OK). All toasts also wrap within the screen.
15. **Saved post's button was a plain white circle** (white background + white
    icon). Now the same dark circle as "open post", with a white filled bookmark.
16. **"Open post on X" did nothing visible.** X catches clicks on any x.com link
    at the page level and routed to the post *behind* the gallery (address bar
    changed, gallery stayed). Owner chose: open in the **same tab**. A
    window-level capture listener (added at document_start, before X's) takes
    the click; `showPostOnX()` hides the gallery as is (`away`), pauses videos
    and moves X to the post (pushState + popstate nudge). Back to the
    bookmarks URL — or the ball — brings it back on the same post
    (`comeBack()`); the gallery's own back steps stay untouched underneath.
    Modified clicks / long-press "open in new tab" still work (target=_blank).
    The mock now intercepts link clicks like X, so the test reproduces it.

## Features added in 1.14 (all in `tests/test_new_features.py`, `tests/test_zoom_centre.py`)
- **Undo** in toasts (`toast(text, {label, run})`): delete collection, remove
  posts, quick save, hide.
- **Loading progress**: time left / speed, Pause / Continue (also tap the
  ring; inject.js `pause`/`resume`; progress saved on pause), "Continue
  loading" for an unfinished load on other pages.
- **Collections page**: search, sort (Your order / Recently used / Name /
  Most posts, also used by "Save to…"), "Change order…" drag (pointer events,
  edge auto-scroll), "Choose cover".
- **Quick save**: long-press the save button or double-tap a picture → the
  collection used last (`c.used`); swipe a post left → "Save to…".
- **Hide posts** (eye button, Settings → Show hidden posts), **"In Trips,
  Faves"** under a post, **Unsorted** filter chip (header: "N unsorted").
- **Pending imports**: posts named in an import but not loaded yet wait in
  `c.pending` and join when they load (`resolvePending`); such saves are
  throttled to every 10s (`saveCollections(true)`).
- **Video**: sound choice remembered (falls back to muted if Firefox blocks
  sound), speed button, hold for 2×.
- **Backup reminder** a week after the last backup (Back up now / Not now = 3 days).
- **Check the connection to X** (Settings): inject.js reports lastOk / lastError.
- **Settings page** in about:addons (`options_ui`).
- **Post viewer snaps** each post to the middle of the feed area; **zoom**
  view (pinch / magnifier / wheel / drag / double-tap; pinch smaller closes).

## Still open / not verified
- **Real x.com is not tested** — only the mock, built from how inject.js reads
  X's responses. If X changes its GraphQL shape or headers, only a manual
  check on real x.com will show it. Worth a quick real-account check after changes.
- **Minimum Firefox version decision**: `data_collection_permissions` needs
  Firefox 140 (Android 142). Kept `strict_min_version` 128 (the key is just
  ignored there) — lint reports that one note; `tests/test_lint.py` allows
  only that. Raising the minimum to 140/142 would silence it but drop older
  Firefox users: owner's call.
- **Touch gestures** are now played back with synthetic TouchEvents
  (`harness.swipe()`, `pinch()` in test_zoom_centre.py; needs the
  `dom.w3c_touch_events.enabled` pref). Real-finger quirks of Firefox for
  Android (momentum scrolling, OS back gesture) still need a check on a phone.
- **Signing**: an unsigned .xpi installs on regular Firefox only temporarily.
  Signing needs the owner's addons.mozilla.org account and API keys
  (`web-ext sign`) — not done.
- **Firefox for Android** itself isn't tested; phone-sized layout is (via zoom).
- After a reload, the gallery reopens where you were even if you typed a
  different X address in that tab within 12h (`xbg_spot` doesn't check the
  path). Intended for Android background reloads; left as is.
- Private windows: Firefox keeps extensions out unless the user ticks "Run in
  Private Windows"; when allowed, everything works.

## Rules learned (don't repeat these mistakes)
- **Firefox content scripts can't hand objects to page code.** Anything given
  to the page (event `state`/`detail`, postMessage payloads read by the page,
  callbacks) must be a page object (`history.state`, `cloneInto`) or plain
  data. Make the mock read such objects like X does so it fails loudly.
- **Extension updates leave dead DOM behind** in open tabs (Firefox injects the
  new content script, old listeners are gone). Always clean leftovers on start.
- **Every tab holds its own copy of stored data.** Anything saved as a whole
  object (settings, collections) must be re-read on `storage.onChanged`.
- Don't decide "saved for the main list" from `location` — loads outlive pages.
- `permissions.request()` must be the first await in the click handler.
- Selenium/Marionette specifics: can't `get()` moz-extension URLs (open them
  via chrome context, needs `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`); `"\n"` in
  send_keys is not Enter (use `Keys.ENTER`); grid tiles are absolutely
  positioned, so DOM order ≠ screen order (use `first_tile_key()`); the
  status says "All loaded" ~0.7s before the grid redraws; windows can't be
  narrower than ~500px (use `zoom()` for phone width); the native file picker
  needs `fake_file_picker()`; `permissions.request` needs the
  `extensions.webextOptionalPermissionPrompts=false` pref.
- Check screenshots by sampling pixels when a style "should" work — the
  computed CSS said `color-scheme: dark` while the scrollbar was still white.
- **X hijacks clicks on x.com links anywhere in its page** (our overlay is in
  its document). Any link we show must be handled by us first (window capture
  listener registered at document_start), never left to the browser default.
- Check UI on a phone-width page (`zoom(1.3)` on a 500px window): nowrap text
  that's fine on desktop gets cut off there. Measure with `on_screen()`;
  inline elements report 0 width, so measure their block parent.
- **Scroll snapping changes programmatic scrolling**: with `scroll-snap-type`
  Firefox keeps the snapped post in place when content is added above, so
  never add "scrollHeight difference" on top — measure an anchor post before
  and after instead.
- New UI that reuses class names (`.xbg-search-input`, `.xbg-sort`) breaks
  loose test selectors: scope them (`.xbg-bar .xbg-sort`).
- Sheets slide in for ~0.2s: `click_text()` retries until clickable; use it
  for buttons in sheets/popups.
- Long-running state (pending ids, collections) can be megabytes: throttle
  writes that happen by themselves during loading.
- Commit after each verified fix; run the whole suite + lint before committing.
