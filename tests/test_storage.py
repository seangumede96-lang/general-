"""G. Saved data: shape, several tabs writing, and damaged data."""

import time

from harness import Browser
from test_collections import card_names, go_collections, new_collection
from test_first_use import open_loaded


def test_storage_shape(browser):
    b = browser
    open_loaded(b)
    n = int(b.count_text())
    new_collection(b, "Shape")
    time.sleep(1.5)
    s = b.storage()
    assert "xbg_settings" not in s or isinstance(s["xbg_settings"], dict)
    assert s["xbg_collections"][0]["name"] == "Shape"
    assert s["xbg_cache"]["chunks"] == 1 and s["xbg_cache"]["posts"] == 60
    assert len(s["xbg_cache_0"]) == n
    assert all(k in s["xbg_cache_0"][0] for k in ("key", "type", "thumb", "tweet"))


def test_collections_made_in_two_tabs_are_both_kept(browser):
    b = browser
    open_loaded(b)
    time.sleep(1.5)
    tab_a = b.d.current_window_handle
    b.d.switch_to.new_window("tab")
    tab_b = b.d.current_window_handle
    b.go("https://x.com/home")
    b.open_gallery_with_ball()
    # Tab A makes one collection...
    b.d.switch_to.window(tab_a)
    new_collection(b, "From tab A")
    time.sleep(1)
    # ...then tab B (open since before) makes another.
    b.d.switch_to.window(tab_b)
    new_collection(b, "From tab B")
    time.sleep(1)
    names = [c["name"] for c in b.storage()["xbg_collections"]]
    assert sorted(names) == ["From tab A", "From tab B"], f"a collection was lost: {names}"
    # And tab B shows both.
    assert {"From tab A", "From tab B"} <= set(card_names(b))


def test_damaged_saved_data_still_opens():
    b = Browser()
    try:
        b.go("https://x.com/home")
        b.set_storage({
            "xbg_settings": "garbage",
            "xbg_collections": {"not": "a list"},
            "xbg_items": None,
            "xbg_cache": {"chunks": "lots", "at": "yesterday", "posts": -5},
            "xbg_cache_0": "nope",
        })
        b.go("https://x.com/i/bookmarks")
        b.open_gallery_with_ball()
        b.wait(lambda d: (b.status_text() or "").startswith("All"), 15)
        assert b.tile_count() > 0
        go_collections(b)
        new_collection(b, "After damage")
        assert "After damage" in card_names(b)
        assert not b.console_errors() and not b.page_errors()
    finally:
        b.quit()


def test_collection_post_kept_after_unbookmarking(browser):
    """A post in a collection keeps showing even after it leaves your X bookmarks."""
    from harness import ctl
    from test_collections import open_collection
    b = browser
    open_loaded(b)
    new_collection(b, "Keepers")
    b.click('.xbg-tab[data-view="all"]')
    time.sleep(0.4)
    b.click_text("Select", ".xbg-text-btn")
    b.qa(".xbg-grid .xbg-tile")[0].click()
    b.click_text("Add to collection", ".xbg-select-bar button")
    b.click_text("Keepers\n0 posts", ".xbg-pick")
    b.click_text("Done", ".xbg-sheet button")
    time.sleep(1.5)
    # The newest bookmark is removed on X; a full reload follows.
    ctl(added=-1)
    b.click('.xbg-bar .xbg-close[aria-label="Options"]')
    b.click_text("Reload all bookmarks from X", ".xbg-sheet button")
    b.wait(lambda d: (b.status_text() or "").startswith("All 59"), 15, f"status {b.status_text()}")
    time.sleep(1.5)
    open_collection(b, "Keepers")
    assert b.count_text() == "1"
    assert b.tile_count() == 1, "the post vanished from the collection"
