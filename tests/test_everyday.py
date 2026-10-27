"""D. Everyday use: coming back, other pages, reloads, restarts, updates, tabs, private windows."""

import time

from selenium.webdriver.common.action_chains import ActionChains

from harness import Browser, api_log, ctl
from test_collections import card_names, go_collections, new_collection
from test_first_use import open_loaded


def test_coming_back_only_tops_up(browser):
    b = browser
    ctl(total=300, years_span_days=1)
    open_loaded(b)
    assert b.status_text() == "All 300 bookmarks loaded"
    before = int(b.count_text())
    time.sleep(1.5)  # saved copy written
    ctl(added=3, clearlog=1)  # bookmarks -1..-3; -1 is text only
    b.go("https://x.com/i/bookmarks")
    b.open_gallery_with_ball()
    b.wait(lambda d: (b.status_text() or "").startswith("Up to date"), 15, f"status: {b.status_text()}")
    assert b.status_text() == "Up to date · 2 new"
    assert len(api_log()) <= 3, f"should only top up, made {len(api_log())} requests"
    b.wait(lambda d: int(b.count_text()) == before + 2, 5, f"count stayed {b.count_text()}")
    # The new one is first (newest bookmark).
    first = b.js("return [...document.querySelectorAll('.xbg-grid .xbg-tile')].find(t=>parseFloat(t.style.top)===0&&parseFloat(t.style.left)===0).dataset.key")
    assert first == "media/P-3m0x", first


def test_saved_copy_on_home_page(browser):
    b = browser
    open_loaded(b)
    n = b.count_text()
    time.sleep(1.5)
    ctl(clearlog=1)
    b.go("https://x.com/home")
    b.open_gallery_with_ball()
    time.sleep(0.5)
    assert b.count_text() == n
    assert b.status_text().startswith("Saved copy")
    assert b.tile_count() > 0
    assert api_log() == [], "home page shouldn't ask X for bookmarks"
    b.shot("D2-saved-copy")


def test_ball_on_home_with_nothing_saved_goes_to_bookmarks(browser):
    b = browser
    b.go("https://x.com/home")
    b.js("window.__sameDocument = true")
    b.open_gallery_with_ball()
    b.wait(lambda d: d.current_url == "https://x.com/i/bookmarks", 5)
    b.wait(lambda d: (b.status_text() or "").startswith("All"), 15)
    assert b.js("return window.__sameDocument === true"), "page was reloaded instead of moved"
    assert b.tile_count() > 0


def test_reload_keeps_your_place(browser):
    b = browser
    ctl(total=400)
    open_loaded(b)
    b.js("document.querySelector('#xbg-overlay .xbg-scroll').scrollTop = 1500")
    time.sleep(1)
    b.d.refresh()
    b.wait(lambda d: b.gallery_open(), 10, "gallery didn't come back after reload")
    time.sleep(1)
    top = b.js("return document.querySelector('#xbg-overlay .xbg-scroll').scrollTop")
    assert abs(top - 1500) < 60, top


def test_reload_with_post_open(browser):
    b = browser
    open_loaded(b)
    tile = b.qa(".xbg-grid .xbg-tile")[6]
    key = tile.get_attribute("data-key")
    tile.click()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    time.sleep(0.6)
    b.d.refresh()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 10, "the open post didn't come back")
    time.sleep(0.5)
    centre = b.js(
        "const m=innerHeight/2; for (const p of document.querySelectorAll('.xbg-post')) {const r=p.getBoundingClientRect(); if (r.top<=m && r.bottom>=m) return p.dataset.key;} return null"
    )
    assert centre == key


def test_restart_firefox_keeps_everything():
    b = Browser()
    profile = b.profile_dir
    try:
        open_loaded(b)
        n = b.count_text()
        new_collection(b, "Survives restart")
        b.click('.xbg-bar .xbg-close[aria-label="Options"]')
        b.click_text("Dark mode", ".xbg-setting")
        b.click_text("Done", ".xbg-sheet button")
        time.sleep(1.5)
        b.quit(keep_profile=True)
        b = Browser(profile_dir=profile)
        ctl(clearlog=1)
        b.go("https://x.com/home")
        b.open_gallery_with_ball()
        time.sleep(0.5)
        assert b.count_text() == n
        assert b.js("return document.getElementById('xbg-overlay').classList.contains('xbg-light')")
        go_collections(b)
        assert "Survives restart" in card_names(b)
        assert not b.console_errors()
    finally:
        b.quit()
        import shutil
        shutil.rmtree(profile, ignore_errors=True)


def test_extension_update_while_x_is_open(browser):
    b = browser
    open_loaded(b)
    new_collection(b, "Before update")
    b.click('.xbg-close[aria-label="Close gallery"]')
    time.sleep(1)
    b.install()  # same id again: Firefox treats it as an update
    time.sleep(1.5)
    balls = b.js("return [...document.querySelectorAll('#xbg-ball')].filter(e=>!e.classList.contains('xbg-hidden')).length")
    assert balls == 1, f"{balls} floating buttons after the update"
    overlays = b.js("return document.querySelectorAll('#xbg-overlay').length")
    assert overlays <= 1, f"{overlays} galleries in the page after the update"
    b.click("#xbg-ball")
    b.wait(lambda d: b.gallery_open(), 5, "the floating button stopped working after the update")
    b.wait(lambda d: b.tile_count() > 0, 10)
    go_collections(b)
    assert "Before update" in card_names(b)
    b.shot("D5-after-update")


def test_extension_update_with_gallery_open(browser):
    b = browser
    open_loaded(b)
    b.install()
    time.sleep(1.5)
    overlays = b.js("return [...document.querySelectorAll('#xbg-overlay')].filter(e=>!e.classList.contains('xbg-hidden')).length")
    b.shot("D5-update-open")
    # The old gallery can't work any more; it must not be left covering X.
    if overlays:
        b.click('.xbg-close[aria-label="Close gallery"]')
        time.sleep(0.5)
        assert not b.gallery_open(), "a dead gallery is stuck over the page"


def test_settings_from_one_tab_not_undone_by_another(browser):
    b = browser
    open_loaded(b)
    time.sleep(1.5)
    tab_a = b.d.current_window_handle
    b.d.switch_to.new_window("tab")
    tab_b = b.d.current_window_handle
    b.go("https://x.com/home")
    b.wait(lambda d: b.visible("#xbg-ball"), 10)
    # Tab A: light mode.
    b.d.switch_to.window(tab_a)
    b.click('.xbg-bar .xbg-close[aria-label="Options"]')
    b.click_text("Dark mode", ".xbg-setting")
    b.click_text("Done", ".xbg-sheet button")
    time.sleep(0.5)
    # Tab B: move the floating button (saves its settings).
    b.d.switch_to.window(tab_b)
    ball = b.q("#xbg-ball")
    ActionChains(b.d).move_to_element(ball).click_and_hold().move_by_offset(-600, -100).release().perform()
    time.sleep(0.8)
    assert b.storage()["xbg_settings"]["theme"] == "light", "moving the button in another tab switched dark mode back on"
    b.open_gallery_with_ball()
    assert b.js("return document.getElementById('xbg-overlay').classList.contains('xbg-light')")


def test_two_x_tabs_both_work(browser):
    b = browser
    open_loaded(b)
    time.sleep(1.5)
    b.d.switch_to.new_window("tab")
    b.go("https://x.com/i/bookmarks")
    b.open_gallery_with_ball()
    b.wait(lambda d: (b.status_text() or "").startswith(("All", "Up to date")), 15)
    assert b.tile_count() > 0


def test_twitter_com(browser):
    b = browser
    b.go("https://twitter.com/i/bookmarks")
    b.open_gallery_with_ball()
    b.wait(lambda d: (b.status_text() or "").startswith("All"), 15)
    assert b.tile_count() > 0
    href = b.js("return document.querySelector('.xbg-grid .xbg-tile') && 1")
    assert href


def test_private_window_off_by_default():
    # Firefox keeps extensions out of private windows until you allow them.
    b = Browser(private=True)
    try:
        b.go("https://x.com/i/bookmarks")
        time.sleep(2)
        assert not b.qa("#xbg-ball")
    finally:
        b.quit()


def test_private_window_when_allowed():
    b = Browser(private=True)
    try:
        b.allow_private()
        open_loaded(b)
        assert b.tile_count() > 0
        new_collection(b, "Private")
        assert "Private" in card_names(b)
        assert not b.console_errors()
    finally:
        b.quit()
