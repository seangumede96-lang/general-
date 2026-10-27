"""E. Mistakes a real user makes."""

import random
import time

from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.keys import Keys

from harness import api_log, ctl
from test_collections import new_collection, open_collection
from test_first_use import open_loaded


def to_bookmarks_from_home(b):
    b.go("https://x.com/home")
    b.click("#nav-bookmarks")  # X's own link: no page load
    b.wait(lambda d: len(b.qa("article")) >= 20, 10)
    b.wait(lambda d: b.visible("#xbg-ball"), 10)


def back(b):
    b.d.back()
    time.sleep(0.6)


def esc(b):
    ActionChains(b.d).send_keys(Keys.ESCAPE).perform()
    time.sleep(0.4)


def test_double_click_ball_then_back_leaves_normally(browser):
    b = browser
    to_bookmarks_from_home(b)
    ActionChains(b.d).double_click(b.q("#xbg-ball")).perform()
    b.wait(lambda d: b.gallery_open(), 5)
    b.wait(lambda d: (b.status_text() or "").startswith("All"), 15)
    b.click('.xbg-close[aria-label="Close gallery"]')
    time.sleep(0.6)
    assert not b.gallery_open()
    back(b)
    assert b.d.current_url == "https://x.com/home", f"Back went to {b.d.current_url}"


def test_open_close_fast_many_times(browser):
    b = browser
    to_bookmarks_from_home(b)
    for _ in range(6):
        ActionChains(b.d).click(b.q("#xbg-ball")).perform()
        ActionChains(b.d).click(b.q('#xbg-overlay .xbg-close[aria-label="Close gallery"]')).perform()
    time.sleep(1.5)
    assert not b.gallery_open()
    assert b.d.current_url == "https://x.com/i/bookmarks"
    back(b)
    assert b.d.current_url == "https://x.com/home", f"Back went to {b.d.current_url}"


def test_back_button_steps_out_one_level_at_a_time(browser):
    b = browser
    to_bookmarks_from_home(b)
    b.open_gallery_with_ball()
    b.wait(lambda d: (b.status_text() or "").startswith("All"), 15)
    ActionChains(b.d).double_click(b.qa(".xbg-grid .xbg-tile")[3]).perform()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    back(b)
    assert not b.visible(".xbg-lightbox") and b.gallery_open(), "Back should close the post, not the gallery"
    b.click_text("Select", ".xbg-text-btn")
    b.qa(".xbg-grid .xbg-tile")[0].click()
    back(b)
    assert b.gallery_open() and not b.visible(".xbg-select-bar"), "Back should end selecting"
    b.click(".xbg-sort")
    back(b)
    assert b.gallery_open() and not b.qa("#xbg-overlay .xbg-backdrop"), "Back should close the menu"
    back(b)
    assert not b.gallery_open() and b.d.current_url == "https://x.com/i/bookmarks"
    back(b)
    assert b.d.current_url == "https://x.com/home"


def test_back_from_a_collection(browser):
    b = browser
    open_loaded(b)
    new_collection(b, "Inside")
    open_collection(b, "Inside")
    back(b)
    time.sleep(0.5)
    assert b.gallery_open()
    assert b.js("return document.querySelector('.xbg-tab[data-view=collections]').classList.contains('xbg-on')")


def test_escape_key(browser):
    b = browser
    open_loaded(b)
    b.qa(".xbg-grid .xbg-tile")[1].click()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    esc(b)
    assert not b.visible(".xbg-lightbox") and b.gallery_open()
    b.q(".xbg-search-input").send_keys("sunset")
    b.wait(lambda d: "found" in b.count_text(), 5)
    esc(b)
    assert b.q(".xbg-search-input").get_attribute("value") == "" and b.gallery_open()
    esc(b)
    assert not b.gallery_open()


def test_fast_clicking_filters_and_layouts(browser):
    b = browser
    ctl(total=200)
    open_loaded(b)
    rnd = random.Random(4)
    buttons = ['.xbg-chip[data-filter="all"]', '.xbg-chip[data-filter="photo"]', '.xbg-chip[data-filter="video"]',
               '[data-layout="grid"]', '[data-layout="months"]', '[data-layout="years"]']
    for _ in range(40):
        b.js("document.querySelector(arguments[0]).click()", rnd.choice(buttons))
    b.js("document.querySelector('[data-layout=grid]').click(); document.querySelector('.xbg-chip[data-filter=video]').click()")
    time.sleep(0.6)
    kinds = set(b.js("return [...document.querySelectorAll('.xbg-grid .xbg-tile')].map(t=>t.getAttribute('aria-label'))"))
    assert kinds == {"Video"}
    assert b.js("return document.querySelector('.xbg-chip[data-filter=video]').classList.contains('xbg-on')")
    b.shot("E2-after-fast-clicks")


def test_fast_tab_switching(browser):
    b = browser
    open_loaded(b)
    for _ in range(10):
        b.js("document.querySelector('.xbg-tab[data-view=collections]').click(); document.querySelector('.xbg-tab[data-view=all]').click()")
    time.sleep(0.5)
    assert b.tile_count() > 0
    assert b.js("return document.querySelector('.xbg-tab[data-view=all]').classList.contains('xbg-on')")


def test_odd_search_text(browser):
    b = browser
    open_loaded(b)
    box = b.q(".xbg-search-input")
    for text in ["(.*[", "\\", "<b>bold</b>", "'; DROP TABLE", "🎌", "日本語"]:
        box.clear()
        box.send_keys(text)
        time.sleep(0.4)
        assert b.gallery_open()
    box.clear()
    box.send_keys("<script>")
    b.wait(lambda d: "found" in b.count_text() and int(b.count_text().split()[0]) > 0, 5)
    box.clear()
    box.send_keys("x" * 500)
    time.sleep(0.4)
    assert len(box.get_attribute("value")) <= 500
    assert b.count_text() == "0 found"
    assert "Nothing matches" in b.q(".xbg-empty").text


def test_leaving_bookmarks_while_loading(browser):
    ctl(total=900, delay_ms=250)
    b = browser
    b.go("https://x.com/i/bookmarks")
    b.wait(lambda d: len(api_log()) >= 2, 10)
    b.click('nav a[href="/home"]')  # leave in the middle
    b.wait(lambda d: b.js("return document.title") == "Home / X", 5)
    # The background load carries on; once it's done, the saved copy holds everything.
    b.wait(lambda d: len(api_log()) >= 10, 30)
    time.sleep(3)
    cache = b.storage().get("xbg_cache") or {}
    assert cache.get("posts") == 900, f"saved copy after finishing on another page: {cache}"
    b.open_gallery_with_ball()
    time.sleep(0.5)
    assert int(b.count_text().replace(",", "")) > 700


def test_visiting_a_bookmark_folder_keeps_the_saved_copy(browser):
    b = browser
    open_loaded(b)
    time.sleep(1.5)
    before = b.storage()["xbg_cache"]["posts"]
    b.click('.xbg-close[aria-label="Close gallery"]')
    b.go("https://x.com/i/bookmarks/12345")
    b.wait(lambda d: len(b.qa("article")) >= 10, 10)
    time.sleep(3)
    assert b.storage()["xbg_cache"]["posts"] == before == 60, "a folder replaced the saved copy of all bookmarks"
