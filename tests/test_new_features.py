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


# --- Collections page: search, order, arranging, covers -----------------------

def coll_names(b):
    return b.js("return [...document.querySelectorAll('#xbg-overlay > .xbg-scroll .xbg-cards:not(.xbg-hidden) .xbg-card[data-id] .xbg-card-name')].map(e=>e.textContent)")


def make_three(b):
    """Zebra (3 posts), apple (1 post), Mango (2 posts), made in that order."""
    fill_collection(b, "Zebra", 3)
    fill_collection(b, "apple", 1)
    fill_collection(b, "Mango", 2)
    go_collections(b)


def test_search_collections(browser):
    b = browser
    open_loaded(b)
    make_three(b)
    box = b.q(".xbg-coll-bar .xbg-search-input")
    box.send_keys("an")
    time.sleep(0.3)
    assert coll_names(b) == ["Mango"]
    box.send_keys("zzz")
    time.sleep(0.3)
    assert coll_names(b) == [] and "No collection is called" in b.q(".xbg-empty").text
    b.shot("C-search-none")
    box.send_keys(Keys.ESCAPE)
    time.sleep(0.3)
    assert b.gallery_open(), "Escape in the collection search closed the gallery"
    assert len(coll_names(b)) == 3 and box.get_attribute("value") == ""


def pick_sort(b, label):
    b.click(".xbg-coll-bar .xbg-sort")
    b.click_text(label, ".xbg-sheet .xbg-pick")
    time.sleep(0.3)


def test_sort_collections(browser):
    b = browser
    open_loaded(b)
    make_three(b)
    assert coll_names(b) == ["Zebra", "apple", "Mango"]  # your order: as made
    pick_sort(b, "Name (A–Z)")
    assert coll_names(b) == ["apple", "Mango", "Zebra"]
    pick_sort(b, "Most posts")
    assert coll_names(b) == ["Zebra", "Mango", "apple"]
    pick_sort(b, "Recently used")
    assert coll_names(b) == ["Mango", "apple", "Zebra"]
    assert "Recently used" in b.q(".xbg-coll-bar .xbg-sort").text
    # The "Save to…" list follows the same order.
    b.click('.xbg-tab[data-view="all"]')
    time.sleep(0.4)
    b.qa(".xbg-grid .xbg-tile")[8].click()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    time.sleep(0.4)
    b.js("document.querySelector('.xbg-post .xbg-save-btn').click()")
    names = b.js("return [...document.querySelectorAll('.xbg-sheet .xbg-pick .xbg-pick-name')].map(n=>n.firstChild.textContent)")
    assert names == ["New collection", "Mango", "apple", "Zebra"], names
    assert b.storage()["xbg_settings"]["collSort"] == "recent"


def test_drag_collections_into_order(browser):
    b = browser
    open_loaded(b)
    make_three(b)
    pick_sort(b, "Name (A–Z)")
    b.click(".xbg-coll-bar .xbg-sort")
    b.click_text("Change order…", ".xbg-sheet button")
    time.sleep(0.4)
    assert b.visible(".xbg-coll-done")
    assert coll_names(b) == ["Zebra", "apple", "Mango"], "arranging starts from your own order"
    assert not b.js("return [...document.querySelectorAll('.xbg-cards:not(.xbg-hidden) .xbg-card .xbg-card-name')].some(e=>e.textContent==='New collection')")
    b.shot("C-reorder")
    cards = {c.find_element("css selector", ".xbg-card-name").text: c for c in b.qa(".xbg-cards:not(.xbg-hidden) .xbg-card[data-id]")}
    # Drag Mango onto Zebra's spot (front).
    ActionChains(b.d).click_and_hold(cards["Mango"]).pause(0.2).move_to_element(cards["apple"]).pause(0.2).move_to_element(cards["Zebra"]).pause(0.2).release().perform()
    time.sleep(0.4)
    assert coll_names(b) == ["Mango", "Zebra", "apple"]
    # Tapping a card while arranging doesn't open it.
    cards = {c.find_element("css selector", ".xbg-card-name").text: c for c in b.qa(".xbg-cards:not(.xbg-hidden) .xbg-card[data-id]")}
    cards["apple"].click()
    time.sleep(0.4)
    assert b.visible(".xbg-coll-done")
    b.click(".xbg-coll-done")
    time.sleep(0.6)
    assert not b.visible(".xbg-coll-done") and "Your order" in b.q(".xbg-coll-bar .xbg-sort").text
    # Kept after a reload.
    b.d.refresh()
    b.open_gallery_with_ball()
    go_collections(b)
    assert coll_names(b) == ["Mango", "Zebra", "apple"]


def test_choose_cover(browser):
    b = browser
    open_loaded(b)
    keys = fill_collection(b, "Covered", 3)
    open_collection(b, "Covered")
    b.click('.xbg-bar .xbg-close[aria-label="Options"]')
    b.click_text("Choose cover", ".xbg-sheet button")
    time.sleep(0.4)
    picks = b.qa(".xbg-cover-pick")
    assert len(picks) == 3
    b.shot("C-cover-chooser")
    chosen = picks[2].get_attribute("data-key")
    picks[2].click()
    time.sleep(0.4)
    b.click(".xbg-bar .xbg-close[aria-label='Back']")
    time.sleep(0.8)
    first = b.js("const c=[...document.querySelectorAll('.xbg-cards:not(.xbg-hidden) .xbg-card[data-id]')].find(c=>c.querySelector('.xbg-card-name').textContent==='Covered'); return c.querySelector('img').getAttribute('src')")
    item = [i for i in b.storage()["xbg_cache_0"] if i["key"] == chosen][0]
    assert first == item["thumb"], "the card doesn't start with the chosen picture"
    assert [c for c in b.storage()["xbg_collections"] if c["name"] == "Covered"][0]["cover"] == chosen


# --- Quick save and gestures --------------------------------------------------

def open_post(b, index):
    tile = b.qa(".xbg-grid .xbg-tile")[index]
    key = tile.get_attribute("data-key")
    tile.click()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    time.sleep(0.5)
    return key, f'.xbg-post[data-key="{key}"]'


def in_collection(b, name):
    return [c for c in b.storage()["xbg_collections"] if c["name"] == name][0]["keys"]


def test_long_press_save_goes_to_last_collection(browser):
    b = browser
    open_loaded(b)
    fill_collection(b, "Older", 1)
    fill_collection(b, "Latest", 1)  # used last
    b.click('.xbg-tab[data-view="all"]')
    time.sleep(0.4)
    key, post = open_post(b, 9)
    b.js(f"document.querySelector('{post} .xbg-post-media').classList.add('xbg-ui-on')")
    time.sleep(0.3)
    ActionChains(b.d).click_and_hold(b.q(f"{post} .xbg-save-btn")).pause(0.8).release().perform()
    time.sleep(0.5)
    assert not b.qa("#xbg-overlay .xbg-backdrop"), "a long-press shouldn't open the picker"
    assert toast_text(b).startswith("Saved to “Latest”")
    assert "xbg-on" in b.q(f"{post} .xbg-save-btn").get_attribute("class")
    time.sleep(0.6)
    assert key in in_collection(b, "Latest") and key not in in_collection(b, "Older")
    # Undo takes it out again.
    b.click(".xbg-toast .xbg-toast-action")
    time.sleep(0.8)
    assert key not in in_collection(b, "Latest")
    assert "xbg-on" not in b.q(f"{post} .xbg-save-btn").get_attribute("class")
    # A normal tap still opens the picker.
    b.q(f"{post} .xbg-save-btn").click()
    b.wait(lambda d: b.visible(".xbg-sheet"), 3)


def test_long_press_with_no_collections_opens_picker(browser):
    b = browser
    open_loaded(b)
    key, post = open_post(b, 2)
    b.js(f"document.querySelector('{post} .xbg-post-media').classList.add('xbg-ui-on')")
    time.sleep(0.3)
    ActionChains(b.d).click_and_hold(b.q(f"{post} .xbg-save-btn")).pause(0.8).release().perform()
    b.wait(lambda d: b.visible(".xbg-sheet"), 3)


def test_double_tap_saves(browser):
    b = browser
    open_loaded(b)
    fill_collection(b, "Hearts", 1)
    b.click('.xbg-tab[data-view="all"]')
    time.sleep(0.4)
    key, post = open_post(b, 6)
    ActionChains(b.d).double_click(b.q(f"{post} .xbg-post-media")).perform()
    time.sleep(0.15)
    assert b.qa(f"{post} .xbg-pop"), "no bookmark popped up"
    b.shot("G-double-tap")
    time.sleep(0.8)
    assert key in in_collection(b, "Hearts")
    assert not b.js(f"return document.querySelector('{post} .xbg-post-media').classList.contains('xbg-ui-on')"), "a double-tap also toggled the buttons"
    # A single tap still shows the buttons.
    b.q(f"{post} .xbg-post-media").click()
    time.sleep(0.5)
    assert b.js(f"return document.querySelector('{post} .xbg-post-media').classList.contains('xbg-ui-on')")


def test_swipe_left_opens_save_to(browser):
    b = browser
    open_loaded(b)
    key, post = open_post(b, 3)
    b.swipe(post + " .xbg-post-media", -160, 5)
    b.wait(lambda d: b.visible(".xbg-sheet"), 3, "swiping left didn't open Save to…")
    assert b.q(".xbg-sheet-title").text == "Save to…"
    b.click_text("Done", ".xbg-sheet button")
    time.sleep(0.4)
    assert b.visible(".xbg-lightbox"), "the feed closed"
    # A short swipe does nothing.
    b.swipe(post + " .xbg-post-media", -40, 0)
    time.sleep(0.4)
    assert not b.visible(".xbg-sheet")


# Gestures that were already there, now testable with touch.

def test_swipe_right_closes_the_feed(browser):
    b = browser
    open_loaded(b)
    key, post = open_post(b, 3)
    b.swipe(post + " .xbg-post-media", 400, 5, start=None)
    time.sleep(0.6)
    assert not b.visible(".xbg-lightbox") and b.gallery_open()


def test_swipe_between_all_posts_and_collections(browser):
    b = browser
    open_loaded(b)
    b.swipe(".xbg-scroll", -600, 0, ms=300)
    time.sleep(1)
    assert b.js("return document.querySelector('.xbg-tab[data-view=collections]').classList.contains('xbg-on')")
    b.swipe(".xbg-scroll", 600, 0, ms=300)
    time.sleep(1)
    assert b.js("return document.querySelector('.xbg-tab[data-view=all]').classList.contains('xbg-on')")


def test_long_press_tile_starts_selecting(browser):
    b = browser
    open_loaded(b)
    tile = b.qa(".xbg-grid .xbg-tile")[1]
    b.swipe(tile, 0, 0, ms=700, steps=2)  # finger held still for 0.7s
    time.sleep(0.3)
    assert b.visible(".xbg-select-bar") and b.q(".xbg-select-info").text == "1 selected"


# --- Hide posts; which collections; "Not in a collection" ---------------------

def visible_keys(b):
    return set(b.js("return [...document.querySelectorAll('.xbg-grid .xbg-tile')].map(t=>t.dataset.key)"))


def test_hide_a_post_and_bring_it_back(browser):
    b = browser
    open_loaded(b)
    total = int(b.count_text())
    key, post = open_post(b, 2)
    b.js(f"document.querySelector('{post} .xbg-post-media').classList.add('xbg-ui-on')")
    time.sleep(0.3)
    b.q(f"{post} .xbg-hide-btn").click()
    time.sleep(0.5)
    assert toast_text(b).startswith("Hidden from All posts")
    assert not b.qa(post), "the hidden post stayed in the feed"
    b.click(".xbg-feed-bar .xbg-close")
    time.sleep(0.5)
    assert key not in visible_keys(b) and int(b.count_text()) == total - 1
    time.sleep(0.5)
    assert len(b.storage()["xbg_hidden"]) == 1
    # Survives a reload.
    b.d.refresh()
    b.open_gallery_with_ball()
    b.wait(lambda d: (b.status_text() or "").startswith(("All", "Up to date")), 15)
    time.sleep(1)
    assert key not in visible_keys(b)
    # "Show hidden posts" shows it faded, and from there it can be un-hidden.
    b.click('.xbg-bar .xbg-close[aria-label="Options"]')
    b.click_text("Show hidden posts\n1 post hidden", ".xbg-setting")
    b.click_text("Done", ".xbg-sheet button")
    time.sleep(0.5)
    assert key in visible_keys(b)
    assert "xbg-hidden-post" in b.q(f'.xbg-tile[data-key="{key}"]').get_attribute("class")
    b.shot("H-hidden-shown")
    b.q(f'.xbg-tile[data-key="{key}"]').click()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    time.sleep(0.4)
    b.js(f"document.querySelector('{post} .xbg-post-media').classList.add('xbg-ui-on')")
    assert b.q(f"{post} .xbg-hide-btn").get_attribute("aria-label") == "Show in All posts again"
    b.q(f"{post} .xbg-hide-btn").click()
    time.sleep(0.5)
    assert b.storage()["xbg_hidden"] == []


def test_undo_hide(browser):
    b = browser
    open_loaded(b)
    key, post = open_post(b, 1)
    b.js(f"document.querySelector('{post} .xbg-post-media').classList.add('xbg-ui-on')")
    b.q(f"{post} .xbg-hide-btn").click()
    time.sleep(0.4)
    b.click(".xbg-toast .xbg-toast-action")
    time.sleep(0.5)
    b.click(".xbg-feed-bar .xbg-close")
    time.sleep(0.5)
    assert key in visible_keys(b)


def test_hidden_post_stays_in_its_collection(browser):
    b = browser
    open_loaded(b)
    keys = fill_collection(b, "Keep", 1)
    b.click('.xbg-tab[data-view="all"]')
    time.sleep(0.4)
    b.q(f'.xbg-tile[data-key="{keys[0]}"]').click()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    time.sleep(0.4)
    post = f'.xbg-post[data-key="{keys[0]}"]'
    b.js(f"document.querySelector('{post} .xbg-post-media').classList.add('xbg-ui-on')")
    b.q(f"{post} .xbg-hide-btn").click()
    time.sleep(0.4)
    b.click(".xbg-feed-bar .xbg-close")
    time.sleep(0.4)
    open_collection(b, "Keep")
    assert b.count_text() == "1" and keys[0] in visible_keys(b)


def test_post_shows_which_collections_it_is_in(browser):
    b = browser
    open_loaded(b)
    keys = fill_collection(b, "Trips", 1)
    new_collection(b, "Faves")
    b.click('.xbg-tab[data-view="all"]')
    time.sleep(0.4)
    b.q(f'.xbg-tile[data-key="{keys[0]}"]').click()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    time.sleep(0.4)
    post = f'.xbg-post[data-key="{keys[0]}"]'
    assert b.q(f"{post} .xbg-post-in").text == "In Trips"
    b.js(f"document.querySelector('{post} .xbg-save-btn').click()")
    b.click_text("Faves\n0 posts", ".xbg-pick")
    b.click_text("Done", ".xbg-sheet button")
    time.sleep(0.4)
    assert b.q(f"{post} .xbg-post-in").text in ("In Trips, Faves", "In Faves, Trips")
    b.shot("H-in-collections")


def test_not_in_a_collection_filter(browser):
    b = browser
    open_loaded(b)
    total = int(b.count_text())
    keys = fill_collection(b, "Sorted", 3)
    b.click('.xbg-tab[data-view="all"]')
    time.sleep(0.4)
    b.click_text("Unsorted", ".xbg-chip")
    time.sleep(0.5)
    shown = visible_keys(b)
    assert not (set(keys) & shown)
    assert b.count_text() == f"{total - 3} unsorted"
    assert b.q(".xbg-unsorted").get_attribute("aria-pressed") == "true"
    # Works with Photos/Videos, and switches off again.
    b.click('.xbg-chip[data-filter="video"]')
    time.sleep(0.4)
    assert set(b.js("return [...document.querySelectorAll('.xbg-grid .xbg-tile')].map(t=>t.getAttribute('aria-label'))")) <= {"Video"}
    b.click('.xbg-chip[data-filter="all"]')
    b.click_text("Unsorted", ".xbg-chip")
    time.sleep(0.4)
    assert int(b.count_text()) == total


def test_filter_chips_fit_on_a_phone():
    b = Browser(width=500, height=1000)
    try:
        open_loaded(b)
        b.zoom(1.3)
        time.sleep(0.5)
        b.shot("H-phone-chips")
        # Nothing pushes the page sideways; the Newest button stays on screen.
        assert b.js("return document.querySelector('.xbg-bar').scrollWidth <= document.querySelector('.xbg-bar').clientWidth + 1")
        assert b.js("const r=document.querySelector('.xbg-bar .xbg-sort').getBoundingClientRect(); return r.right <= document.querySelector('.xbg-bar').getBoundingClientRect().right + 1")
        # Every filter chip is fully on screen (none hidden off the edge).
        assert b.js("const row=document.querySelector('.xbg-bar .xbg-chips'); return row.scrollWidth <= row.clientWidth + 1"), "some filter chips are cut off"
    finally:
        b.quit()


# --- Imported posts that weren't loaded yet -----------------------------------

def post_id(g):
    return str(1790000000000000000 + (g + 1000) * 7919)


def test_imported_posts_are_added_when_they_load(browser, tmp_path):
    b = browser
    ctl(total=60)
    open_loaded(b)
    time.sleep(1)
    # A sorted-folders file: posts 0-2 are loaded; 100, 102, 103 aren't bookmarked yet.
    f = tmp_path / "sorted.json"
    f.write_text(json.dumps({"collections": [{"id": "f1", "name": "Folder", "posts": [post_id(g) for g in (0, 1, 2, 100, 102, 103)]}]}))
    b.fake_file_picker(str(f))
    go_collections(b)
    b.click_text("Restore from backup", ".xbg-empty button")
    b.wait(lambda d: b.visible(".xbg-alert"), 10)
    text = b.q(".xbg-alert").text
    assert "3 of the 6 posts" in text and "other 3 will be added" in text, text
    b.shot("I-import-pending")
    b.click_text("OK", ".xbg-alert button")
    open_collection(b, "Folder")
    before = int(b.count_text())
    assert b.status_text() == "3 more posts will appear as your bookmarks load", b.status_text()
    time.sleep(0.6)
    stored = b.storage()["xbg_collections"][0]
    assert sorted(stored["pending"]) == sorted(post_id(g) for g in (100, 102, 103))
    # Later those posts get bookmarked on X, and the bookmarks load again.
    b.click(".xbg-bar .xbg-close[aria-label='Back']")
    time.sleep(0.6)
    ctl(total=120)
    b.click('.xbg-tab[data-view="all"]')
    time.sleep(0.4)
    b.click('.xbg-bar .xbg-close[aria-label="Options"]')
    b.click_text("Reload all bookmarks from X", ".xbg-sheet button")
    b.wait(lambda d: (b.status_text() or "").startswith("All 120"), 30)
    time.sleep(1.5)
    open_collection(b, "Folder")
    b.wait(lambda d: "pending" not in b.storage()["xbg_collections"][0], 15, "the found posts were never saved")
    # Post 100 has two photos, 102 one photo, 103 a GIF.
    assert int(b.count_text()) == before + 4, b.count_text()
    assert not b.status_text()
    stored = b.storage()["xbg_collections"][0]
    assert "pending" not in stored
    # Still there after a reload of the page.
    b.d.refresh()
    b.wait(lambda d: b.gallery_open(), 10)  # comes back inside the collection
    time.sleep(1)
    assert b.js("return document.querySelector('.xbg-title span').textContent") == "Folder"
    assert int(b.count_text()) == before + 4


def test_big_import_with_many_waiting_posts_stays_quick(browser, tmp_path):
    b = browser
    ctl(total=600, years_span_days=1)
    b.go("https://x.com/home")
    # 50,000 posts named, only some exist yet.
    f = tmp_path / "big.json"
    ids = [post_id(g) for g in range(0, 50000, 5)] * 5
    f.write_text(json.dumps({"collections": [{"id": f"b{i}", "name": f"Big {i}", "posts": ids[i::5]} for i in range(5)]}))
    b.go("https://x.com/i/bookmarks")
    b.open_gallery_with_ball()
    b.wait(lambda d: (b.status_text() or "").startswith("All 600"), 30)
    b.fake_file_picker(str(f))
    go_collections(b)
    t = time.time()
    b.click_text("Restore from backup", ".xbg-empty button")
    b.wait(lambda d: b.visible(".xbg-alert"), 20)
    assert time.time() - t < 8, "import took too long"
    b.click_text("OK", ".xbg-alert button")
    # Loading everything again with all those posts waiting stays quick.
    b.click('.xbg-tab[data-view="all"]')
    time.sleep(0.4)
    ctl(total=900)
    t = time.time()
    b.click('.xbg-bar .xbg-close[aria-label="Options"]')
    b.click_text("Reload all bookmarks from X", ".xbg-sheet button")
    b.wait(lambda d: (b.status_text() or "").startswith("All 900"), 60)
    print(f"reload with 50,000 waiting: {time.time() - t:.1f}s")
    assert time.time() - t < 40
    time.sleep(11)  # the background save
    stored = b.storage()["xbg_collections"]
    assert len(stored) == 5 and all(len(c.get("pending", [])) < 2000 for c in stored)


# --- Video: sound remembered, speed, hold for 2× ------------------------------

def open_video(b):
    b.click('.xbg-chip[data-filter="video"]')
    time.sleep(0.3)
    tile = b.qa(".xbg-grid .xbg-tile")[0]
    key = tile.get_attribute("data-key")
    tile.click()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    post = f'.xbg-post[data-key="{key}"]'
    b.wait(lambda d: b.js(f"const v=document.querySelector('{post} video'); return v && !v.paused"), 10)
    return post


def test_sound_choice_is_remembered(browser):
    b = browser
    open_loaded(b)
    post = open_video(b)
    assert b.js(f"return document.querySelector('{post} video').muted")
    b.js(f"document.querySelector('{post} .xbg-vbtn[aria-label=Sound]').click()")
    time.sleep(0.3)
    assert not b.js(f"return document.querySelector('{post} video').muted")
    time.sleep(0.5)
    assert b.storage()["xbg_settings"]["videoSound"] is True
    # Next time a video opens, it has sound.
    b.click(".xbg-feed-bar .xbg-close")
    time.sleep(0.5)
    tile = b.qa(".xbg-grid .xbg-tile")[1]
    key = tile.get_attribute("data-key")
    tile.click()
    p2 = f'.xbg-post[data-key="{key}"]'
    b.wait(lambda d: b.js(f"const v=document.querySelector('{p2} video'); return v && !v.paused"), 10)
    assert not b.js(f"return document.querySelector('{p2} video').muted"), "the next video started muted"
    assert b.js(f"return document.querySelector('{p2} .xbg-vbtn[aria-label=Sound] path').getAttribute('d')").startswith("M3 9h4l5-4v14l-5-4H3zM15.5")


def test_speed_button(browser):
    b = browser
    open_loaded(b)
    post = open_video(b)
    rate = lambda: b.js(f"return document.querySelector('{post} video').playbackRate")
    btn = f"{post} .xbg-vspeed"
    b.js(f"document.querySelector('{post} .xbg-post-media').classList.add('xbg-ui-on')")
    assert b.q(btn).text == "1×" and rate() == 1
    b.q(btn).click()
    assert b.q(btn).text == "1.5×" and rate() == 1.5
    b.q(btn).click()
    assert b.q(btn).text == "2×" and rate() == 2
    b.shot("V-speed")
    time.sleep(0.5)
    assert b.storage()["xbg_settings"]["videoSpeed"] == 2
    b.q(btn).click()
    b.q(btn).click()
    assert b.q(btn).text == "1×" and rate() == 1


def test_hold_for_double_speed(browser):
    b = browser
    open_loaded(b)
    post = open_video(b)
    media = b.q(f"{post} .xbg-post-media")
    rate = lambda: b.js(f"return document.querySelector('{post} video').playbackRate")
    ActionChains(b.d).move_to_element(media).click_and_hold().pause(0.8).perform()
    assert rate() == 2 and b.visible(f"{post} .xbg-ffwd")
    b.shot("V-hold")
    ActionChains(b.d).release().perform()
    time.sleep(0.4)
    assert rate() == 1 and not b.visible(f"{post} .xbg-ffwd")
    assert not b.js(f"return document.querySelector('{post} .xbg-post-media').classList.contains('xbg-ui-on')"), "letting go also counted as a tap"


def test_video_controls_fit_on_a_phone():
    b = Browser(width=500, height=1000)
    try:
        open_loaded(b)
        b.zoom(1.3)
        time.sleep(0.4)
        post = open_video(b)
        b.js(f"document.querySelector('{post} .xbg-post-media').classList.add('xbg-ui-on')")
        time.sleep(0.4)
        b.shot("V-phone-controls")
        assert b.js(f"""const row=document.querySelector('{post} .xbg-vrow'); const r=row.getBoundingClientRect();
          return [...row.children].every(c => {{ const x=c.getBoundingClientRect(); return x.left >= r.left - 1 && x.right <= r.right + 1; }})"""), "a video button is cut off"
    finally:
        b.quit()
