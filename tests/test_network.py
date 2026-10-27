"""F. Different pages, and trouble from X or the network."""

import time

from harness import Browser, api_log, ctl
from test_first_use import open_loaded


def wait_status(b, prefix, timeout=20):
    b.wait(lambda d: (b.status_text() or "").startswith(prefix), timeout, f"status stayed {b.status_text()!r}")


def test_x_refuses_big_pages_carries_on_at_normal_size(browser):
    ctl(total=120, reject_big=1)
    b = browser
    open_loaded(b)
    assert b.status_text() == "All 120 bookmarks loaded"
    counts = [r["count"] for r in api_log()]
    assert 20 in counts[1:] and counts.count(100) == 1, counts


def test_rate_limited_waits_then_carries_on(browser):
    ctl(total=120, rate_limit_once=1)
    b = browser
    b.go("https://x.com/i/bookmarks")
    b.open_gallery_with_ball()
    wait_status(b, "X asked for a pause", 10)
    b.shot("F3-paused")
    wait_status(b, "All 120", 30)


def test_paging_fails_falls_back_to_scrolling(browser):
    ctl(total=60, fail=500, fail_after=1)  # first page fine, the rest refused
    b = browser
    b.go("https://x.com/i/bookmarks")
    b.open_gallery_with_ball()
    b.wait(lambda d: b.tile_count() > 0, 10)
    b.shot("F1-failing")
    # It must not end up claiming everything loaded when it didn't.
    time.sleep(20)
    status = b.status_text()
    b.shot("F1-after")
    assert status == "Couldn’t load everything", f"says {status!r} though only the first page came through"


def test_x_fails_completely(browser):
    ctl(fail=500)
    b = browser
    b.go("https://x.com/i/bookmarks")
    b.wait(lambda d: b.qa("#load-error"), 10)  # X's own page shows its error
    b.open_gallery_with_ball()
    time.sleep(20)
    status, empty = b.status_text(), b.q(".xbg-empty").text
    b.shot("F1-x-down")
    assert not status.startswith("All"), f"status {status!r} while nothing loaded"
    assert "Loading your bookmarks" not in empty, f"still says {empty!r} long after X gave up"
    assert status == "X didn’t send your bookmarks"
    # The offered retry works once X is back.
    ctl(fail=0)
    b.click_text("Reload to try again", ".xbg-empty button")
    b.open_gallery_with_ball()
    wait_status(b, "All 60", 20)


def test_broken_json_page(browser):
    ctl(total=120, bad_json_paged=1)
    b = browser
    b.go("https://x.com/i/bookmarks")
    b.open_gallery_with_ball()
    b.wait(lambda d: b.tile_count() > 0, 10)
    time.sleep(3)
    assert b.page_errors() == []


def test_slow_page_and_slow_api(browser):
    ctl(total=80, page_delay_ms=3000, delay_ms=800)
    b = browser
    b.go("https://x.com/i/bookmarks")
    b.open_gallery_with_ball()
    wait_status(b, "All 80", 30)


def test_fetch_based_page(browser):
    ctl(total=150, transport="fetch")
    b = browser
    open_loaded(b)
    assert b.status_text() == "All 150 bookmarks loaded"


def test_large_library(browser):
    ctl(total=3000, years_span_days=1)
    b = browser
    b.go("https://x.com/i/bookmarks")
    b.open_gallery_with_ball()
    t0 = time.time()
    wait_status(b, "All 3,000", 120)
    load_s = time.time() - t0
    n = int(b.count_text().replace(",", ""))
    assert n > 2400
    # Only tiles near the screen exist in the page.
    assert b.tile_count() < 200
    # Scrolling a long way is quick and draws tiles there.
    t = time.time()
    b.js("const s=document.querySelector('#xbg-overlay .xbg-scroll'); s.scrollTop = s.scrollHeight/2;")
    time.sleep(0.3)
    assert b.tile_count() > 0
    b.js("const s=document.querySelector('#xbg-overlay .xbg-scroll'); s.scrollTop = s.scrollHeight;")
    time.sleep(0.3)
    assert b.tile_count() > 0
    b.shot("F6-large-bottom")
    # Search across thousands is responsive.
    t = time.time()
    b.q(".xbg-search-input").send_keys("noodles")
    b.wait(lambda d: "found" in b.count_text(), 5)
    assert time.time() - t < 3
    print(f"3000 bookmarks loaded in {load_s:.1f}s")


def test_pictures_that_fail_to_load(browser):
    ctl(total=60, missing_every=4)
    b = browser
    open_loaded(b)
    time.sleep(2)
    broken = b.js("return document.querySelectorAll('#xbg-overlay .xbg-grid .xbg-broken').length")
    assert broken > 0
    b.shot("F7-broken")


def test_offline_saved_copy(browser):
    b = browser
    open_loaded(b)
    time.sleep(1.5)
    b.go("https://x.com/home")
    b.go_offline(True)
    try:
        b.open_gallery_with_ball()
        time.sleep(2)
        assert b.tile_count() > 0
        assert b.status_text().startswith("Saved copy")
        b.shot("F-offline")
    finally:
        b.go_offline(False)


def test_not_on_other_sites_or_firefox_pages(browser):
    b = browser
    b.go("https://example.com/")
    time.sleep(1)
    assert not b.qa("#xbg-ball")
    b.go("about:addons", False)
    time.sleep(1)
    b.go("about:blank", False)
    b.open_ext_page("popup.html")
    b.click("#goto")  # no X tab: opens one
    b.wait(lambda d: any(True for _ in d.window_handles), 5)
