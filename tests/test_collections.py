"""C. Collections: make them, fill them, rename, remove, delete, back up, restore."""

import json
import os
import time

from selenium.webdriver.common.keys import Keys

from test_first_use import open_loaded


def go_collections(b):
    b.click('.xbg-tab[data-view="collections"]')
    b.wait(lambda d: b.visible(".xbg-cards:not(.xbg-hidden)"), 5)
    time.sleep(0.3)


def new_collection(b, name):
    go_collections(b)
    b.click_text("New collection", ".xbg-card .xbg-card-name")
    b.wait(lambda d: b.visible(".xbg-sheet .xbg-input"), 5)
    box = b.q(".xbg-sheet .xbg-input")
    box.send_keys(name)
    b.click_text("Save", ".xbg-sheet button")
    time.sleep(0.4)


def card_names(b):
    return b.js("return [...document.querySelectorAll('#xbg-overlay > .xbg-scroll .xbg-cards:not(.xbg-hidden) .xbg-card .xbg-card-name')].map(e=>e.textContent)")


def select_tiles(b, n):
    b.click_text("Select", ".xbg-text-btn")
    tiles = b.qa(".xbg-grid .xbg-tile")[:n]
    keys = [t.get_attribute("data-key") for t in tiles]
    for t in tiles:
        t.click()
    return keys


def open_collection(b, name):
    go_collections(b)
    for card in b.qa(".xbg-cards:not(.xbg-hidden) .xbg-card"):
        if card.find_element("css selector", ".xbg-card-name").text == name:
            card.click()
            time.sleep(0.5)
            return
    raise AssertionError(f"no collection {name}")


def test_create_and_add_with_select(browser):
    b = browser
    open_loaded(b)
    new_collection(b, "Trips ✈️")
    assert "Trips ✈️" in card_names(b)
    b.click('.xbg-tab[data-view="all"]')
    time.sleep(0.4)
    keys = select_tiles(b, 3)
    assert b.q(".xbg-select-info").text == "3 selected"
    b.click_text("Add to collection", ".xbg-select-bar button")
    b.click_text("Trips ✈️\n0 posts", ".xbg-pick")
    time.sleep(0.2)
    b.click_text("Done", ".xbg-sheet button")
    time.sleep(0.5)
    assert not b.visible(".xbg-select-bar"), "selection should end after adding"
    b.shot("C1-added")
    open_collection(b, "Trips ✈️")
    assert b.count_text() == "3"
    got = b.js("return [...document.querySelectorAll('.xbg-grid .xbg-tile')].map(t=>t.dataset.key)")
    assert sorted(got) == sorted(keys)
    time.sleep(0.6)
    stored = b.storage()["xbg_collections"]
    assert stored[0]["name"] == "Trips ✈️" and sorted(stored[0]["keys"]) == sorted(keys)


def test_save_button_in_feed(browser):
    b = browser
    open_loaded(b)
    new_collection(b, "Faves")
    b.click('.xbg-tab[data-view="all"]')
    time.sleep(0.4)
    tile = b.qa(".xbg-grid .xbg-tile")[2]
    key = tile.get_attribute("data-key")
    tile.click()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    time.sleep(0.4)
    post = b.q(f'.xbg-post[data-key="{key}"]')
    b.js("arguments[0].click()", post.find_element("css selector", ".xbg-save-btn"))
    b.click_text("Faves\n0 posts", ".xbg-pick")
    b.click_text("Done", ".xbg-sheet button")
    time.sleep(0.3)
    assert "xbg-on" in post.find_element("css selector", ".xbg-save-btn").get_attribute("class")
    b.click(".xbg-feed-bar .xbg-close")
    time.sleep(0.4)
    open_collection(b, "Faves")
    assert b.count_text() == "1"


def test_rename_remove_and_delete(browser):
    b = browser
    open_loaded(b)
    new_collection(b, "Old name")
    b.click('.xbg-tab[data-view="all"]')
    time.sleep(0.4)
    select_tiles(b, 2)
    b.click_text("Add to collection", ".xbg-select-bar button")
    b.click_text("Old name\n0 posts", ".xbg-pick")
    b.click_text("Done", ".xbg-sheet button")
    time.sleep(0.4)
    open_collection(b, "Old name")
    # Rename
    b.click('.xbg-bar .xbg-close[aria-label="Options"]')
    b.click_text("Rename", ".xbg-sheet button")
    box = b.q(".xbg-sheet .xbg-input")
    box.clear()
    box.send_keys("New name")
    b.click_text("Save", ".xbg-sheet button")
    time.sleep(0.3)
    assert b.js("return document.querySelector('.xbg-title span').textContent") == "New name"
    # Remove one post
    b.click_text("Select", ".xbg-text-btn")
    b.qa(".xbg-grid .xbg-tile")[0].click()
    b.click_text("Remove", ".xbg-select-bar button")
    time.sleep(0.4)
    assert b.count_text() == "1"
    # Delete the collection
    b.click('.xbg-bar .xbg-close[aria-label="Options"]')
    b.click_text("Delete collection", ".xbg-sheet button")
    b.wait(lambda d: b.visible(".xbg-alert"), 5)
    b.shot("C3-confirm-delete")
    b.click_text("Delete", ".xbg-alert button")
    time.sleep(0.6)
    b.shot("C3-after-delete")
    assert "New name" not in card_names(b)
    assert not b.qa("#xbg-overlay .xbg-backdrop"), "the collection's menu was left open after deleting it"
    assert not b.qa("#xbg-overlay .xbg-alert-backdrop")
    time.sleep(0.6)
    assert b.storage().get("xbg_collections") == []


def test_cancel_delete_keeps_collection(browser):
    b = browser
    open_loaded(b)
    new_collection(b, "Keep me")
    open_collection(b, "Keep me")
    b.click('.xbg-bar .xbg-close[aria-label="Options"]')
    b.click_text("Delete collection", ".xbg-sheet button")
    time.sleep(0.4)
    # The question replaces the menu instead of sitting see-through on top of it.
    assert not b.qa("#xbg-overlay .xbg-backdrop"), "the menu stayed open under the confirmation"
    b.click_text("Cancel", ".xbg-alert button")
    time.sleep(0.3)
    assert b.js("return document.querySelector('.xbg-title span').textContent") == "Keep me"
    assert not b.qa("#xbg-overlay .xbg-alert-backdrop") and not b.qa("#xbg-overlay .xbg-backdrop")


def test_bad_names(browser):
    b = browser
    open_loaded(b)
    go_collections(b)
    # Empty and spaces only: nothing is created, the box stays open.
    b.click_text("New collection", ".xbg-card .xbg-card-name")
    b.click_text("Save", ".xbg-sheet button")
    assert b.visible(".xbg-sheet .xbg-input")
    b.q(".xbg-sheet .xbg-input").send_keys("     ")
    b.click_text("Save", ".xbg-sheet button")
    assert b.visible(".xbg-sheet .xbg-input")
    b.js("document.querySelector('.xbg-sheet .xbg-input').value=''")
    # HTML is shown as text, never run.
    b.q(".xbg-sheet .xbg-input").send_keys('<img src=x onerror="window.__pwned=1">')
    b.q(".xbg-sheet .xbg-input").send_keys(Keys.ENTER)  # Enter saves too
    time.sleep(0.4)
    assert '<img src=x onerror="window.__pwned=1">' in card_names(b)
    assert not b.js("return window.__pwned")
    # Very long names are cut to 60 characters.
    new_collection(b, "L" * 200)
    assert "L" * 60 in card_names(b)
    b.shot("C4-names")


def test_backup_downloads_a_file(browser):
    b = browser
    open_loaded(b)
    new_collection(b, "Backup me")
    b.click_text("Back up collections", ".xbg-empty button")
    b.wait(lambda d: any(f.endswith(".json") for f in b.downloads()), 10, f"no backup file was saved; toast: {b.js('return document.querySelector(`.xbg-toast`).textContent')}")
    path = os.path.join(b.profile_dir, "downloads", [f for f in b.downloads() if f.endswith(".json")][0])
    data = json.load(open(path))
    assert data["app"] == "x-bookmarks-gallery" and data["collections"][0]["name"] == "Backup me"


def test_restore_from_backup(browser, tmp_path):
    b = browser
    open_loaded(b)
    key = b.js("return document.querySelector('.xbg-grid .xbg-tile').dataset.key")
    backup = tmp_path / "bookmark-collections.json"
    backup.write_text(json.dumps({"app": "x-bookmarks-gallery", "version": 1, "collections": [{"id": "abc", "name": "Restored", "keys": [key]}], "items": {}}))
    b.fake_file_picker(str(backup))
    go_collections(b)
    b.click_text("Restore from backup", ".xbg-empty button")
    b.wait(lambda d: "Restored" in card_names(b), 10, "restored collection didn't appear")
    b.wait(lambda d: b.visible(".xbg-alert"), 5)
    assert "Added 1 folder" in b.q(".xbg-alert").text


def test_restore_wrong_file(browser, tmp_path):
    b = browser
    open_loaded(b)
    bad = tmp_path / "notes.json"
    bad.write_text("this is not json")
    b.fake_file_picker(str(bad))
    go_collections(b)
    b.click_text("Restore from backup", ".xbg-empty button")
    b.wait(lambda d: b.visible(".xbg-alert") and "isn’t a collections backup" in b.q(".xbg-alert").text, 10)
