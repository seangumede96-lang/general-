"""More features: full-screen videos, export, fast-scroll, keyboard, phone-size screens."""

import gzip
import json
import os
import time

from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.keys import Keys

from harness import Browser, ctl
from test_collections import new_collection, open_collection, select_tiles
from test_first_use import open_loaded


def test_full_screen_videos_and_arrow_keys(browser):
    b = browser
    open_loaded(b)
    b.click('.xbg-chip[data-filter="video"]')
    time.sleep(0.3)
    b.qa(".xbg-grid .xbg-tile")[0].click()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    b.wait(lambda d: b.js("const v=document.querySelector('.xbg-post video'); return v && !v.paused"), 10)
    b.js("document.querySelector('.xbg-post .xbg-vbtn[aria-label=\"Full screen\"]').click()")
    b.wait(lambda d: b.qa(".xbg-reels"), 5)
    time.sleep(0.6)
    first = b.js("return document.querySelector('.xbg-reels .xbg-reel video:not([paused])') && [...document.querySelectorAll('.xbg-reels video')].find(v=>!v.paused)?.closest('.xbg-reel').dataset.key")
    ActionChains(b.d).send_keys(Keys.ARROW_DOWN).perform()
    time.sleep(1)
    playing = b.js("return [...document.querySelectorAll('.xbg-reels video')].filter(v=>!v.paused).map(v=>v.closest('.xbg-reel').dataset.key)")
    assert len(playing) == 1 and playing[0] != first, (first, playing)
    b.shot("X-reels")
    ActionChains(b.d).send_keys(Keys.ESCAPE).perform()
    time.sleep(0.6)
    assert not b.qa(".xbg-reels") and b.visible(".xbg-lightbox")


def test_export_for_sorting(browser):
    b = browser
    open_loaded(b)
    b.click('.xbg-bar .xbg-close[aria-label="Options"]')
    b.click_text("Export all bookmarks for sorting", ".xbg-sheet button")
    b.wait(lambda d: any(f.endswith((".json.gz", ".json")) for f in b.downloads()), 10, "no export file")
    name = [f for f in b.downloads() if f.endswith((".json.gz", ".json"))][0]
    raw = open(os.path.join(b.profile_dir, "downloads", name), "rb").read()
    data = json.loads(gzip.decompress(raw) if name.endswith(".gz") else raw)
    assert data["kind"] == "all-bookmarks" and len(data["posts"]) == 50
    assert "Exported 50 posts" in b.q(".xbg-toast").text


def test_jump_to_bottom_and_top(browser):
    ctl(total=400)
    b = browser
    open_loaded(b)
    b.js("const s=document.querySelector('#xbg-overlay .xbg-scroll'); s.scrollTop = 600; s.dispatchEvent(new Event('scroll'))")
    b.wait(lambda d: b.visible(".xbg-jump[aria-label='Go to the bottom']"), 5)
    b.click(".xbg-jump[aria-label='Go to the bottom']")
    time.sleep(0.4)
    assert b.js("const s=document.querySelector('#xbg-overlay .xbg-scroll'); return s.scrollTop + s.clientHeight >= s.scrollHeight - 5")
    assert b.tile_count() > 0
    b.js("document.querySelector('#xbg-overlay .xbg-scroll').dispatchEvent(new Event('scroll'))")
    b.wait(lambda d: b.visible(".xbg-jump[aria-label='Go to the top']"), 5)
    b.click(".xbg-jump[aria-label='Go to the top']")
    time.sleep(0.4)
    assert b.js("return document.querySelector('#xbg-overlay .xbg-scroll').scrollTop") == 0


def test_slash_starts_search_even_with_header_hidden(browser):
    b = browser
    open_loaded(b)
    b.click(".xbg-hbtn")
    b.click(".xbg-hbtn")  # header fully hidden
    time.sleep(0.4)
    b.js("document.activeElement.blur()")
    ActionChains(b.d).send_keys("/").perform()
    time.sleep(0.3)
    assert b.js("return document.activeElement.classList.contains('xbg-search-input')")
    assert b.visible(".xbg-bar .xbg-search-input")


def test_unsave_from_feed_inside_collection(browser):
    b = browser
    open_loaded(b)
    new_collection(b, "Two")
    b.click('.xbg-tab[data-view="all"]')
    time.sleep(0.4)
    select_tiles(b, 2)
    b.click_text("Add to collection", ".xbg-select-bar button")
    b.click_text("Two\n0 posts", ".xbg-pick")
    b.click_text("Done", ".xbg-sheet button")
    time.sleep(0.4)
    open_collection(b, "Two")
    b.qa(".xbg-grid .xbg-tile")[0].click()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    time.sleep(0.4)
    key = b.js("const m=innerHeight/2; for (const p of document.querySelectorAll('.xbg-post')) {const r=p.getBoundingClientRect(); if (r.top<=m && r.bottom>=m) return p.dataset.key;}")
    b.js("document.querySelector(`.xbg-post[data-key='${arguments[0]}'] .xbg-save-btn`).click()", key)
    b.click_text("Two\n2 posts\n✓", ".xbg-pick")
    b.click_text("Done", ".xbg-sheet button")
    time.sleep(0.4)
    assert not b.qa(f'.xbg-post[data-key="{key}"]'), "the removed post stayed in the feed"
    assert len(b.qa(".xbg-post")) == 1
    b.click(".xbg-feed-bar .xbg-close")
    time.sleep(0.4)
    assert b.count_text() == "1"


def test_phone_size_screen():
    b = Browser(width=500, height=1100)
    try:
        open_loaded(b)
        b.zoom(1.3)  # 500px window → ~385 CSS px, a phone's width
        time.sleep(0.5)
        assert b.js("return innerWidth") <= 400
        b.shot("P-phone-grid")
        assert b.js("return document.documentElement.scrollWidth <= innerWidth + 1"), "page scrolls sideways on a phone"
        assert b.js("return document.querySelector('#xbg-overlay .xbg-scroll').scrollWidth <= innerWidth + 1")
        # (Firefox won't make a window narrower than ~450px; use what we got.)
        size, width = b.js("const t=document.querySelector('.xbg-grid .xbg-tile'); return [t.getBoundingClientRect().width, document.querySelector('.xbg-grid').clientWidth]")
        assert abs(size - (width - 6) / 4) < 1, (size, width)  # four across
        b.qa(".xbg-grid .xbg-tile")[0].click()
        b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
        time.sleep(0.5)
        b.shot("P-phone-feed")
        b.click(".xbg-feed-bar .xbg-close")
        time.sleep(0.4)
        b.click('.xbg-tab[data-view="collections"]')
        time.sleep(0.4)
        b.shot("P-phone-collections")
        assert not b.console_errors()
    finally:
        b.quit()


def test_light_mode_screens(browser):
    b = browser
    open_loaded(b)
    b.click('.xbg-bar .xbg-close[aria-label="Options"]')
    b.click_text("Dark mode", ".xbg-setting")
    b.click_text("Done", ".xbg-sheet button")
    b.qa(".xbg-grid .xbg-tile")[0].click()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    time.sleep(0.4)
    b.shot("L-light-feed")
    b.click(".xbg-feed-bar .xbg-close")
    time.sleep(0.3)
    b.click('.xbg-tab[data-view="collections"]')
    time.sleep(0.4)
    b.shot("L-light-collections")


def test_scrollbars_match_the_theme(browser):
    """Firefox draws scrollbars light unless told the page is dark: a white
    strip down the side of the dark gallery."""
    import io
    from PIL import Image
    b = browser
    open_loaded(b)
    bar_x = b.js("const s=document.querySelector('#xbg-overlay .xbg-scroll'); return s.getBoundingClientRect().left + s.clientWidth + 2")
    im = Image.open(io.BytesIO(b.d.get_screenshot_as_png())).convert("RGB")
    track = [im.getpixel((int(bar_x), y)) for y in (300, 450, 600, 750)]
    assert not any(p == (255, 255, 255) for p in track), f"white scrollbar strip: {track}"
    assert b.js("return getComputedStyle(document.querySelector('#xbg-overlay .xbg-scroll')).colorScheme") == "dark"
    b.click('.xbg-bar .xbg-close[aria-label="Options"]')
    b.click_text("Dark mode", ".xbg-setting")
    b.click_text("Done", ".xbg-sheet button")
    assert b.js("return getComputedStyle(document.querySelector('#xbg-overlay .xbg-scroll')).colorScheme") == "light"
