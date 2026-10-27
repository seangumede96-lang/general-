"""A. Normal first-time use: install, open, use each feature as intended."""

import time

from harness import api_log, ctl


def open_loaded(b, total=60):
    b.go("https://x.com/i/bookmarks")
    b.wait(lambda d: "loaded" in (b.js("return document.body.innerText") or "") or b.js("return !!window.__xbgHooked"), 10)
    b.open_gallery_with_ball()
    b.wait(lambda d: (b.status_text() or "").startswith("All"), 20, "bookmarks never finished loading")


def test_ball_shows_on_x_and_page_still_works(browser):
    b = browser
    b.go("https://x.com/home")
    b.wait(lambda d: b.visible("#xbg-ball"), 10)
    assert len(b.qa("article")) == 5, "X's own page content should be untouched"
    # X's own navigation still works with the extension in the page.
    b.click("#nav-bookmarks")
    b.wait(lambda d: len(b.qa("article")) >= 20, 10)


def test_loads_every_bookmark_and_counts_media(browser):
    b = browser
    ctl(total=250)
    open_loaded(b)
    assert b.status_text() == "All 250 bookmarks loaded"
    # 250 posts: every 6th has no media, every 5th of the rest has 2 photos.
    expected = 0
    for g in range(250):
        if g % 6 == 5:
            continue
        expected += 2 if (g % 7 != 3 and g % 11 != 4 and g % 5 == 0) else 1
    assert b.count_text() == str(expected)
    reqs = api_log()
    assert reqs[0]["cursor"] is None and reqs[0]["count"] == 20
    assert all(r["count"] == 100 for r in reqs[1:]), "later pages should ask for 100 at a time"
    assert all(r["auth"] == "Bearer MOCKTOKEN" for r in reqs), "requests must reuse the page's own login headers"
    b.shot("A2-loaded")


def test_photo_and_video_filters(browser):
    b = browser
    open_loaded(b)
    all_n = int(b.count_text())
    b.click('.xbg-chip[data-filter="video"]')
    time.sleep(0.3)
    kinds = b.js("return [...document.querySelectorAll('.xbg-grid .xbg-tile')].map(t=>t.getAttribute('aria-label'))")
    assert kinds and set(kinds) == {"Video"}
    b.shot("A3-videos")
    b.click('.xbg-chip[data-filter="photo"]')
    time.sleep(0.3)
    kinds = b.js("return [...document.querySelectorAll('.xbg-grid .xbg-tile')].map(t=>t.getAttribute('aria-label'))")
    assert kinds and set(kinds) == {"Photo"}
    b.click('.xbg-chip[data-filter="all"]')
    assert int(b.count_text()) == all_n


def test_sort_oldest_first_and_back(browser):
    b = browser
    open_loaded(b)
    first_newest = b.js("return document.querySelector('.xbg-grid .xbg-tile').dataset.key")
    b.click(".xbg-sort")
    b.click_text("Oldest first", ".xbg-pick")
    time.sleep(0.3)
    first_oldest = b.js("return document.querySelector('.xbg-grid .xbg-tile').dataset.key")
    assert first_oldest != first_newest
    assert "Oldest" in b.q(".xbg-sort").text
    b.click(".xbg-sort")
    b.click_text("Newest first", ".xbg-pick")
    time.sleep(0.3)
    assert b.js("return document.querySelector('.xbg-grid .xbg-tile').dataset.key") == first_newest


def test_months_and_years_views(browser):
    b = browser
    ctl(total=300)  # 5 days apart: spans several years
    open_loaded(b)
    b.click('[data-layout="months"]')
    time.sleep(0.4)
    headers = b.js("return [...document.querySelectorAll('.xbg-grid .xbg-section span:first-child')].map(s=>s.textContent)")
    assert headers, "Months view should show month headings"
    years = b.js("return [...document.querySelectorAll('.xbg-periods .xbg-period-row:first-child .xbg-pchip')].map(c=>c.firstChild.textContent)")
    assert years[0] == "All years" and len(years) >= 4
    b.shot("A4-months")
    b.click('[data-layout="years"]')
    time.sleep(0.4)
    cards = b.qa(".xbg-cards:not(.xbg-hidden) .xbg-card")
    assert len(cards) >= 4
    b.shot("A4-years")
    year = cards[1].find_element("css selector", ".xbg-card-name").text
    cards[1].click()
    time.sleep(0.4)
    assert b.js("return document.querySelector('[data-layout=months]').classList.contains('xbg-on')")
    month_headers = b.js("return [...document.querySelectorAll('.xbg-grid .xbg-section span:first-child')].map(s=>s.textContent)")
    assert month_headers and all(year in h for h in month_headers), month_headers


def test_search_words_name_and_clear(browser):
    b = browser
    open_loaded(b)
    total = b.count_text()
    box = b.q(".xbg-search-input")
    box.send_keys("noodles")
    b.wait(lambda d: "found" in b.count_text(), 5)
    n = int(b.count_text().split()[0])
    assert n > 0
    box.clear()
    b.js("arguments[0].dispatchEvent(new Event('input'))", box)
    box.send_keys("@dave_vids")
    b.wait(lambda d: "found" in b.count_text() and int(b.count_text().split()[0]) > 0, 5)
    box.send_keys(" zzzznotthere")
    b.wait(lambda d: b.count_text() == "0 found", 5)
    assert "Nothing matches" in b.q(".xbg-empty").text
    b.shot("A5-nomatch")
    b.click_text("Clear search", ".xbg-empty button")
    b.wait(lambda d: b.count_text() == total, 5)
    assert b.q(".xbg-search-input").get_attribute("value") == ""


def test_emoji_search(browser):
    b = browser
    open_loaded(b)
    box = b.q(".xbg-search-input")
    box.send_keys("🍜")
    b.wait(lambda d: "found" in b.count_text(), 5)
    assert int(b.count_text().split()[0]) > 0


def test_tap_picture_opens_feed_on_that_post_and_back(browser):
    b = browser
    open_loaded(b)
    tiles = b.qa(".xbg-grid .xbg-tile")
    key = tiles[5].get_attribute("data-key")
    tiles[5].click()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    time.sleep(0.5)
    centre = b.js(
        "const m=innerHeight/2; for (const p of document.querySelectorAll('.xbg-post')) {const r=p.getBoundingClientRect(); if (r.top<=m && r.bottom>=m) return p.dataset.key;} return null"
    )
    assert centre == key
    b.shot("A6-feed")
    b.click(".xbg-feed-bar .xbg-close")
    b.wait(lambda d: not b.visible(".xbg-lightbox"), 5)
    assert b.gallery_open()


def test_video_plays_in_feed(browser):
    b = browser
    open_loaded(b)
    b.click('.xbg-chip[data-filter="video"]')
    time.sleep(0.3)
    b.qa(".xbg-grid .xbg-tile")[0].click()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    b.wait(lambda d: b.js("const v=document.querySelector('.xbg-post video'); return v && !v.paused && v.currentTime>0"), 10, "video never played")
    assert b.js("return document.querySelector('.xbg-post video').muted"), "feed videos start muted"
    b.shot("A6-video")


def test_header_button_cycles(browser):
    b = browser
    open_loaded(b)
    b.click(".xbg-hbtn")
    time.sleep(0.4)
    assert b.js("return document.getElementById('xbg-overlay').classList.contains('xbg-filters-off')")
    b.click(".xbg-hbtn")
    time.sleep(0.4)
    assert b.js("return document.getElementById('xbg-overlay').classList.contains('xbg-header-off')")
    b.shot("A7-header-hidden")
    b.click(".xbg-hbtn")
    time.sleep(0.4)
    assert not b.js("const o=document.getElementById('xbg-overlay'); return o.classList.contains('xbg-header-off') || o.classList.contains('xbg-filters-off')")


def test_light_mode(browser):
    b = browser
    open_loaded(b)
    b.click('.xbg-bar .xbg-close[aria-label="Options"]')
    b.click_text("Dark mode", ".xbg-setting")
    time.sleep(0.3)
    assert b.js("return document.getElementById('xbg-overlay').classList.contains('xbg-light')")
    b.click_text("Done", ".xbg-sheet button")
    b.shot("A8-light")
    assert b.storage()["xbg_settings"]["theme"] == "light"


def test_close_gallery_returns_to_x(browser):
    b = browser
    open_loaded(b)
    b.click('.xbg-close[aria-label="Close gallery"]')
    b.wait(lambda d: not b.gallery_open(), 5)
    assert b.visible("#xbg-ball")
    assert b.d.current_url == "https://x.com/i/bookmarks"
