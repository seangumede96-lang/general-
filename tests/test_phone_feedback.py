"""Problems reported from a real phone (Firefox for Android), Oct 27 2026."""

import io
import json
import time

from PIL import Image

from harness import Browser
from test_collections import card_names, go_collections, new_collection
from test_first_use import open_loaded

PHONE = dict(width=500, height=1000)


def phone():
    return Browser(**PHONE)


def on_screen(b, css):
    """True when the element is wholly inside the window (not cut off)."""
    return b.js(
        "const e=document.querySelector(arguments[0]); if(!e) return false; const r=e.getBoundingClientRect();"
        "return r.width>0 && r.left>=-1 && r.right<=innerWidth+1 && e.scrollWidth<=e.clientWidth+1",
        css,
    )


def test_long_status_line_wraps_and_keeps_buttons_on_phone():
    b = phone()
    try:
        # An unfinished long load in the saved copy gives the longest status line.
        b.go("https://x.com/home")
        item = {"key": "media/P0m0x", "type": "photo", "thumb": "https://pbs.twimg.com/media/P0m0x?format=jpg&name=360x360", "tweet": "https://x.com/alice/status/1"}
        b.set_storage({"xbg_cache_partial": {"posts": 10019, "at": int(time.time() * 1000), "chunks": 1}, "xbg_cache_partial_0": [item]})
        b.go("https://x.com/home")
        b.zoom(1.3)  # ~385 CSS px wide, a phone
        b.open_gallery_with_ball()
        time.sleep(0.5)
        status = b.status_text()
        assert status.startswith("Partly loaded (10,019 bookmarks)") and status.endswith("open your bookmarks to finish"), status
        b.shot("PF-status-phone")
        assert on_screen(b, ".xbg-bar .xbg-status"), "status line is cut off"
        lines = b.js("const s=document.querySelector('.xbg-bar .xbg-status > span:not(.xbg-progress)'); return s.getClientRects().length")
        assert lines <= 2, f"status takes {lines} lines"
        assert on_screen(b, ".xbg-bar .xbg-text-btn") and b.visible(".xbg-bar .xbg-text-btn"), "Select button pushed off screen"
        assert on_screen(b, '.xbg-bar .xbg-close[aria-label="Options"]'), "⋯ button pushed off screen"
        # The grid starts below the taller header, not under it.
        assert b.js("return document.querySelector('.xbg-grid').getBoundingClientRect().top >= document.querySelector('.xbg-bar').getBoundingClientRect().bottom - 1")
    finally:
        b.quit()


def import_file(b, tmp_path, payload):
    f = tmp_path / "import.json"
    f.write_text(payload if isinstance(payload, str) else json.dumps(payload))
    b.fake_file_picker(str(f))
    go_collections(b)
    b.click_text("Restore from backup", ".xbg-empty button")


def test_import_result_shows_in_a_popup(browser, tmp_path):
    b = browser
    open_loaded(b)
    new_collection(b, "Already here")
    stored = b.storage()["xbg_collections"]
    key = b.storage()["xbg_cache_0"][0]["key"]
    import_file(b, tmp_path, {"app": "x-bookmarks-gallery", "collections": [
        {"id": stored[0]["id"], "name": "Already here", "keys": [key]},
        {"id": "new1", "name": "Brand new", "keys": [key]},
    ], "items": {}})
    b.wait(lambda d: b.visible(".xbg-alert"), 10, "no popup after importing")
    time.sleep(0.4)
    text = b.q(".xbg-alert").text
    b.shot("PF-import-popup")
    assert "Import finished" in text
    assert "Added 1 folder" in text and "updated 1 folder you already had" in text, text
    assert on_screen(b, ".xbg-alert-message")
    assert not b.visible(".xbg-toast"), "the result should be in the popup, not a strip at the bottom"
    b.click_text("OK", ".xbg-alert button")
    time.sleep(0.4)
    assert not b.qa("#xbg-overlay .xbg-alert-backdrop")
    assert "Brand new" in card_names(b)


def test_import_wrong_file_shows_in_a_popup(browser, tmp_path):
    b = browser
    open_loaded(b)
    import_file(b, tmp_path, "this is not json")
    b.wait(lambda d: b.visible(".xbg-alert"), 10)
    assert "isn’t a collections backup" in b.q(".xbg-alert").text
    b.click_text("OK", ".xbg-alert button")


def test_long_notice_fits_on_phone():
    b = phone()
    try:
        open_loaded(b)
        b.zoom(1.3)
        time.sleep(0.4)
        b.click('.xbg-bar .xbg-close[aria-label="Options"]')
        b.click_text("Export all bookmarks for sorting", ".xbg-sheet button")
        b.wait(lambda d: "Exported" in (b.q(".xbg-toast").text or ""), 10)
        b.shot("PF-toast-phone")
        assert on_screen(b, ".xbg-toast"), "the notice runs off the sides of the screen"
    finally:
        b.quit()


def test_saved_post_shows_bookmark_icon_not_white_circle(browser):
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
    post = f'.xbg-post[data-key="{key}"]'
    b.js(f"document.querySelector('{post} .xbg-save-btn').click()")
    b.click_text("Faves\n0 posts", ".xbg-pick")
    b.click_text("Done", ".xbg-sheet button")
    time.sleep(0.4)
    b.js(f"document.querySelector('{post} .xbg-post-media').classList.add('xbg-ui-on')")
    time.sleep(0.5)
    save_bg, open_bg, fill = b.js(
        f"const s=document.querySelector('{post} .xbg-save-btn'), o=document.querySelector('{post} a.xbg-fab-btn');"
        "return [getComputedStyle(s).backgroundColor, getComputedStyle(o).backgroundColor, s.querySelector('path').getAttribute('fill')]"
    )
    assert "xbg-on" in b.q(f"{post} .xbg-save-btn").get_attribute("class")
    assert save_bg == open_bg, f"saved button background {save_bg} differs from the other round button {open_bg}"
    assert fill == "#fff", "bookmark icon should be filled white when saved"
    # On screen: dark ring around a white bookmark, not a solid white circle.
    r = b.js(f"const r=document.querySelector('{post} .xbg-save-btn').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]")
    b.js(f"document.querySelector('{post}').scrollIntoView({{block:'center'}})")
    time.sleep(0.3)
    r = b.js(f"const r=document.querySelector('{post} .xbg-save-btn').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]")
    im = Image.open(io.BytesIO(b.d.get_screenshot_as_png())).convert("RGB")
    edge = im.getpixel((int(r[0] + 4), int(r[1] + r[3] / 2)))
    centre = im.getpixel((int(r[0] + r[2] / 2), int(r[1] + r[3] / 2)))
    im.crop((int(r[0]) - 70, int(r[1]) - 30, int(r[0] + r[2]) + 30, int(r[1] + r[3]) + 30)).resize((int(r[2]) * 5 + 500, int(r[3]) * 5 + 300)).save(b.shot("PF-saved-button"))
    assert sum(edge) < 450, f"the button's background is light {edge}: still a white circle"
    assert sum(centre) > 600, f"no white bookmark in the middle {centre}"


def open_first_post(b):
    tile = b.qa(".xbg-grid .xbg-tile")[4]
    key = tile.get_attribute("data-key")
    tile.click()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    time.sleep(0.5)
    return key


def tap_open_link(b, key):
    post = f'.xbg-post[data-key="{key}"]'
    b.js(f"document.querySelector('{post} .xbg-post-media').classList.add('xbg-ui-on')")
    time.sleep(0.3)
    href = b.q(f"{post} a.xbg-fab-btn").get_attribute("href")
    b.q(f"{post} a.xbg-fab-btn").click()
    return href


def test_open_link_shows_the_post_in_this_tab_and_back_returns(browser):
    b = browser
    open_loaded(b)
    key = open_first_post(b)
    href = tap_open_link(b, key)
    b.wait(lambda d: d.current_url == href, 5, f"didn't go to the post; at {b.d.current_url}")
    time.sleep(0.5)
    assert len(b.d.window_handles) == 1, "should open in the same tab"
    assert not b.gallery_open(), "the gallery is still covering the post"
    assert b.js("return document.querySelector('#timeline h2').textContent") == "Post", "X isn't showing the post"
    b.shot("PF-post-on-x")
    # Back: the gallery comes back with the same post open.
    b.d.back()
    b.wait(lambda d: b.gallery_open(), 5, "Back didn't bring the gallery back")
    assert b.d.current_url == "https://x.com/i/bookmarks"
    assert b.visible(".xbg-lightbox")
    time.sleep(0.4)
    centre = b.js("const m=innerHeight/2; for (const p of document.querySelectorAll('.xbg-post')) {const r=p.getBoundingClientRect(); if (r.top<=m && r.bottom>=m) return p.dataset.key;} return null")
    assert centre == key
    # And Back still steps out one level at a time from there.
    b.d.back()
    time.sleep(0.6)
    assert b.gallery_open() and not b.visible(".xbg-lightbox")
    b.d.back()
    time.sleep(0.6)
    assert not b.gallery_open() and b.d.current_url == "https://x.com/i/bookmarks"


def test_open_link_from_full_screen_video(browser):
    b = browser
    open_loaded(b)
    b.click('.xbg-chip[data-filter="video"]')
    time.sleep(0.3)
    key = open_first_post(b)
    b.js(f"document.querySelector('.xbg-post[data-key=\"{key}\"] .xbg-vbtn[aria-label=\"Full screen\"]').click()")
    b.wait(lambda d: b.qa(".xbg-reels"), 5)
    time.sleep(0.6)
    reel = f'.xbg-reels .xbg-reel[data-key="{key}"]'
    b.js(f"document.querySelector('{reel} .xbg-post-media').classList.add('xbg-ui-on')")
    href = b.q(f"{reel} a.xbg-fab-btn").get_attribute("href")
    b.js(f"document.querySelector('{reel} a.xbg-fab-btn').click()")
    b.wait(lambda d: d.current_url == href, 5)
    time.sleep(0.5)
    assert not b.gallery_open()
    assert b.js("return [...document.querySelectorAll('#xbg-overlay video')].every(v => v.paused)"), "a video kept playing behind X"
    b.d.back()
    b.wait(lambda d: b.gallery_open(), 5)


def test_ball_while_looking_at_the_post_brings_gallery_back(browser):
    b = browser
    open_loaded(b)
    key = open_first_post(b)
    href = tap_open_link(b, key)
    b.wait(lambda d: d.current_url == href, 5)
    b.open_gallery_with_ball()
    assert b.visible(".xbg-lightbox")
    assert not b.page_errors()
