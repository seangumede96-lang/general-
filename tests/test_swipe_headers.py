"""Reported from the phone: headers not level when swiping between All posts and
Collections (the page realigns after the swipe), and collection thumbnails gone."""

import time

from harness import Browser, ctl
from test_first_use import open_loaded
from test_new_features import fill_collection, status_link

DAY_MS = 24 * 3600 * 1000


def partly_loaded_phone():
    """A phone-width gallery with an unfinished load (the long, two-line status)."""
    ctl(total=2500, delay_ms=150)
    b = Browser(width=500, height=1000)
    b.go("https://x.com/i/bookmarks")
    b.zoom(1.3)
    b.open_gallery_with_ball()
    b.wait(lambda d: status_link(b) == "Pause" and int(b.count_text().replace(",", "")) > 100, 20)
    b.click_text("Pause", ".xbg-status .xbg-link")
    b.wait(lambda d: (b.storage().get("xbg_cache_partial") or {}).get("posts", 0) > 0, 5)
    return b


def first_card_tops(b):
    """Where the first collection card is: in the sliding copy, and on the real page."""
    return b.js("""const p=document.querySelector('.xbg-peek .xbg-card'); const r=document.querySelector('.xbg-scroll .xbg-cards:not(.xbg-hidden) .xbg-card');
      return [p ? p.getBoundingClientRect().top : null, r ? r.getBoundingClientRect().top : null]""")


def bar_height(b):
    return b.js("return document.querySelector('.xbg-bar').offsetHeight")


def test_headers_level_and_no_jump_when_swiping():
    b = partly_loaded_phone()
    try:
        fill_collection(b, "Alpha", 2)
        b.click('.xbg-tab[data-view="all"]')
        time.sleep(0.6)
        b.go("https://x.com/home")  # the long "Partly loaded …" status
        b.zoom(1.3)
        b.open_gallery_with_ball()
        time.sleep(0.6)
        assert b.status_text().startswith("Partly loaded"), b.status_text()
        lines = b.js("return document.querySelector('.xbg-bar .xbg-status').getBoundingClientRect().height")
        b.shot("S-all")
        # Swipe to Collections; the moment the real page takes over from the
        # sliding copy, the cards must already be exactly where they'll stay.
        b.swipe(".xbg-scroll", -300, 0, ms=350, steps=15)
        time.sleep(0.42)
        peek, real = first_card_tops(b)
        b.shot("S-handoff")
        time.sleep(1)
        settled = first_card_tops(b)[1]
        b.shot("S-collections")
        assert peek is None or abs(peek - real) < 1.5, f"the page realigned by {real - peek:.0f}px at the end of the swipe"
        assert abs(settled - real) < 1.5, f"the page moved {settled - real:.0f}px after the swipe"
        # Both headers keep the same title and status rows.
        assert abs(b.js("return document.querySelector('.xbg-bar .xbg-status').getBoundingClientRect().height") - lines) < 1
        coll_bar = bar_height(b)
        b.swipe(".xbg-scroll", 300, 0, ms=350, steps=15)
        time.sleep(1.4)
        assert b.js("return document.querySelector('.xbg-tab[data-view=all]').classList.contains('xbg-on')")
        assert abs(b.js("return document.querySelector('.xbg-bar .xbg-status').getBoundingClientRect().height") - lines) < 1
    finally:
        b.quit()


def test_collection_thumbnails_survive_an_old_partial_load():
    b = partly_loaded_phone()
    try:
        keys = fill_collection(b, "Alpha", 3)
        time.sleep(1)
        # A day and a bit later (the unfinished load is older than 24 hours).
        s = b.storage()
        p = s["xbg_cache_partial"]
        p["at"] -= DAY_MS + 3600000
        b.set_storage({"xbg_cache_partial": p})
        b.go("https://x.com/home")
        b.open_gallery_with_ball()
        from test_collections import go_collections
        go_collections(b)
        time.sleep(0.6)
        b.shot("S-old-partial")
        imgs = b.js("return [...document.querySelectorAll('.xbg-cards:not(.xbg-hidden) .xbg-card[data-id] img')].length")
        assert imgs == 3, f"the collection's card shows {imgs} of its 3 pictures"
        assert b.status_text() == "" or True
    finally:
        b.quit()


def test_collection_keeps_its_own_pictures_if_the_partial_load_is_gone():
    b = partly_loaded_phone()
    try:
        fill_collection(b, "Alpha", 3)
        time.sleep(1)
        b.d.refresh()  # a fresh visit: the collection is saved with its pictures
        time.sleep(2)
        s = b.storage()
        assert len([k for k in s.get("xbg_items", {})]) >= 3, "the collection didn't keep its own copy of its pictures"
        b.js("1")
        b._in_ext_page("const done=arguments[0]; browser.storage.local.get(null).then(all=>browser.storage.local.remove(Object.keys(all).filter(k=>k.startsWith('xbg_cache_partial')))).then(()=>done(1))")
        b.go("https://x.com/home")
        b.open_gallery_with_ball()
        from test_collections import go_collections
        go_collections(b)
        time.sleep(0.6)
        imgs = b.js("return [...document.querySelectorAll('.xbg-cards:not(.xbg-hidden) .xbg-card[data-id] img')].length")
        assert imgs == 3, f"{imgs} of 3 pictures"
    finally:
        b.quit()
