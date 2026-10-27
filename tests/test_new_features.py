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
