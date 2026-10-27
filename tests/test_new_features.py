"""New features (v1.14): each used the way a person would, through the UI."""

import json
import time

from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.keys import Keys

from harness import Browser, api_log, ctl
from test_collections import card_names, go_collections, new_collection, open_collection, select_tiles
from test_first_use import open_loaded


def toast_text(b):
    return b.js("const t=document.querySelector('#xbg-overlay .xbg-toast'); return t && !t.classList.contains('xbg-hidden') ? t.textContent : ''")


def fill_collection(b, name, n):
    """Make a collection and put the first n posts of All posts in it."""
    new_collection(b, name)
    b.click('.xbg-tab[data-view="all"]')
    time.sleep(0.4)
    keys = select_tiles(b, n)
    b.click_text("Add to collection", ".xbg-select-bar button")
    b.js("[...document.querySelectorAll('.xbg-sheet .xbg-pick')].find(p=>p.querySelector('.xbg-pick-name').firstChild.textContent===arguments[0]).click()", name)
    b.click_text("Done", ".xbg-sheet button")
    time.sleep(0.5)
    return keys


# --- Undo ---------------------------------------------------------------------

def test_undo_delete_collection(browser):
    b = browser
    open_loaded(b)
    keys = fill_collection(b, "Oops", 3)
    open_collection(b, "Oops")
    b.click('.xbg-bar .xbg-close[aria-label="Options"]')
    b.click_text("Delete collection", ".xbg-sheet button")
    time.sleep(0.4)  # the question slides up
    b.click_text("Delete", ".xbg-alert button")
    time.sleep(0.5)
    assert "Oops" not in card_names(b)
    assert "Deleted “Oops”" in toast_text(b)
    b.shot("U-undo-toast")
    b.click(".xbg-toast .xbg-toast-action")
    time.sleep(0.6)
    assert "Oops" in card_names(b)
    open_collection(b, "Oops")
    assert b.count_text() == "3"
    time.sleep(0.6)
    stored = b.storage()["xbg_collections"]
    assert stored[0]["name"] == "Oops" and sorted(stored[0]["keys"]) == sorted(keys)


def test_undo_remove_posts(browser):
    b = browser
    open_loaded(b)
    fill_collection(b, "Three", 3)
    open_collection(b, "Three")
    order = b.js("return [...document.querySelectorAll('.xbg-grid .xbg-tile')].sort((a,b)=>parseFloat(a.style.top)-parseFloat(b.style.top)||parseFloat(a.style.left)-parseFloat(b.style.left)).map(t=>t.dataset.key)")
    b.click_text("Select", ".xbg-text-btn")
    b.qa(".xbg-grid .xbg-tile")[0].click()
    b.qa(".xbg-grid .xbg-tile")[1].click()
    b.click_text("Remove", ".xbg-select-bar button")
    time.sleep(0.4)
    assert b.count_text() == "1"
    b.click(".xbg-toast .xbg-toast-action")
    time.sleep(0.5)
    assert b.count_text() == "3"
    again = b.js("return [...document.querySelectorAll('.xbg-grid .xbg-tile')].sort((a,b)=>parseFloat(a.style.top)-parseFloat(b.style.top)||parseFloat(a.style.left)-parseFloat(b.style.left)).map(t=>t.dataset.key)")
    assert again == order, "undo should put the posts back in the same order"


def test_toast_without_undo_disappears(browser):
    b = browser
    open_loaded(b)
    new_collection(b, "Plain")
    b.click('.xbg-bar .xbg-close[aria-label="Options"]')
    b.click_text("Reload all bookmarks from X", ".xbg-sheet button")
    time.sleep(0.3)
    assert toast_text(b) and not b.qa(".xbg-toast .xbg-toast-action")
    time.sleep(4.5)
    assert not toast_text(b)


# --- Loading progress: pause, continue, time left -----------------------------

def status_link(b):
    return b.js("const l=[...document.querySelectorAll('.xbg-bar .xbg-status .xbg-link')].find(x=>!x.classList.contains('xbg-hidden')); return l ? l.textContent : null")


def test_pause_and_continue_loading(browser):
    ctl(total=2500, delay_ms=200)
    b = browser
    b.go("https://x.com/i/bookmarks")
    b.open_gallery_with_ball()
    b.wait(lambda d: (b.status_text() or "").startswith("Loading…") and status_link(b) == "Pause", 15)
    b.wait(lambda d: "a minute" in (b.status_text() or ""), 10, f"no speed shown: {b.status_text()}")
    b.shot("P-loading")
    b.click_text("Pause", ".xbg-status .xbg-link")
    b.wait(lambda d: (b.status_text() or "").startswith("Paused"), 5)
    assert status_link(b) == "Continue"
    time.sleep(1)  # one request may still have been on its way
    n = len(api_log())
    time.sleep(2.5)
    assert len(api_log()) == n, "X was still being asked for pages while paused"
    b.shot("P-paused")
    # What loaded so far is kept, so closing the tab now loses nothing.
    b.wait(lambda d: (b.storage().get("xbg_cache_partial") or {}).get("posts", 0) > 0, 5, "progress wasn't saved on pause")
    b.click_text("Continue", ".xbg-status .xbg-link")
    b.wait(lambda d: (b.status_text() or "").startswith("All 2,500"), 60)
    assert status_link(b) is None


def test_time_left_when_total_is_known(browser):
    ctl(total=800)
    b = browser
    b.go("https://x.com/i/bookmarks")
    b.open_gallery_with_ball()
    b.wait(lambda d: (b.status_text() or "").startswith("All 800"), 30)
    time.sleep(1.5)
    ctl(delay_ms=400)
    b.click('.xbg-bar .xbg-close[aria-label="Options"]')
    b.click_text("Reload all bookmarks from X", ".xbg-sheet button")
    b.wait(lambda d: " left" in (b.status_text() or ""), 20, f"no time left shown: {b.status_text()}")
    assert " of ~800" in b.status_text()


def test_continue_loading_from_another_page(browser):
    ctl(total=2500, delay_ms=200)
    b = browser
    b.go("https://x.com/i/bookmarks")
    b.open_gallery_with_ball()
    b.wait(lambda d: status_link(b) == "Pause" and len(api_log()) >= 4, 15)
    b.click_text("Pause", ".xbg-status .xbg-link")
    b.wait(lambda d: (b.storage().get("xbg_cache_partial") or {}).get("posts", 0) > 0, 5)
    so_far = b.storage()["xbg_cache_partial"]["posts"]
    b.go("https://x.com/home")  # a fresh page: the pause is over, the progress stays
    b.open_gallery_with_ball()
    b.wait(lambda d: (b.status_text() or "").startswith("Partly loaded"), 5)
    assert status_link(b) == "Continue loading"
    ctl(clearlog=1, delay_ms=0)
    b.click_text("Continue loading", ".xbg-status .xbg-link")
    b.wait(lambda d: (b.status_text() or "").startswith("All 2,500"), 60)
    first = api_log()[1]
    assert first["cursor"] not in (None, "cur20"), f"started again from the top instead of carrying on: {first}"


def test_ring_stops_spinning_when_paused(browser):
    ctl(total=2500, delay_ms=200)
    b = browser
    b.go("https://x.com/i/bookmarks")
    b.open_gallery_with_ball()
    b.wait(lambda d: status_link(b) == "Pause", 15)
    assert b.js("return getComputedStyle(document.querySelector('.xbg-progress .xbg-ring')).animationName") != "none"
    b.click_text("Pause", ".xbg-status .xbg-link")
    b.wait(lambda d: (b.status_text() or "").startswith("Paused"), 5)
    assert b.js("return getComputedStyle(document.querySelector('.xbg-progress .xbg-ring')).animationName") == "none"


def test_tapping_the_ring_pauses(browser):
    ctl(total=2500, delay_ms=200)
    b = browser
    b.go("https://x.com/i/bookmarks")
    b.open_gallery_with_ball()
    b.wait(lambda d: status_link(b) == "Pause", 15)
    b.click(".xbg-bar .xbg-progress")
    b.wait(lambda d: (b.status_text() or "").startswith("Paused"), 5)
    b.click(".xbg-bar .xbg-progress")
    b.wait(lambda d: (b.status_text() or "").startswith("Loading"), 5)
