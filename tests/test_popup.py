"""B. The toolbar popup (opened as a tab, since WebDriver can't click toolbar buttons)."""

import time

from harness import Browser, api_log


def x_tabs(b):
    out = []
    for h in b.d.window_handles:
        b.d.switch_to.window(h)
        if b.d.current_url.startswith("https://x.com"):
            out.append(h)
    return out


def test_open_gallery_without_x_tab_opens_bookmarks(browser):
    b = browser
    b.go("about:blank", False)
    blank = b.d.current_window_handle
    b.open_ext_page("popup.html")
    b.click("#open")
    b.wait(lambda d: any(h != blank for h in d.window_handles) and len(x_tabs(b)) == 1, 10, "no bookmarks tab was opened")
    tabs = x_tabs(b)
    assert len(tabs) == 1
    b.d.switch_to.window(tabs[0])
    b.wait(lambda d: d.current_url == "https://x.com/i/bookmarks", 10)
    # You asked for the gallery: it should open once the bookmarks are there.
    b.wait(lambda d: b.gallery_open(), 10, "gallery didn't open in the new bookmarks tab")


def test_open_gallery_with_x_tab(browser):
    b = browser
    b.go("https://x.com/i/bookmarks")
    x = b.d.current_window_handle
    b.wait(lambda d: b.visible("#xbg-ball"), 10)
    b.open_ext_page("popup.html")
    b.click("#open")
    b.d.switch_to.window(x)
    b.wait(lambda d: b.gallery_open(), 10)


def test_go_to_bookmarks_from_home_moves_without_reload(browser):
    b = browser
    b.go("https://x.com/home")
    x = b.d.current_window_handle
    b.js("window.__sameDocument = true")
    b.open_ext_page("popup.html")
    b.click("#goto")
    b.d.switch_to.window(x)
    b.wait(lambda d: d.current_url == "https://x.com/i/bookmarks", 10)
    assert b.js("return window.__sameDocument === true"), "page was reloaded"
    b.wait(lambda d: len(b.qa("article")) >= 20, 10, "X didn't show the bookmarks after the move")
    b.wait(lambda d: b.gallery_open(), 10)
    assert b.js("return window.__lastPop && window.__lastPop.path") == "/i/bookmarks"


def test_floating_button_switch(browser):
    b = browser
    b.go("https://x.com/home")
    x = b.d.current_window_handle
    b.wait(lambda d: b.visible("#xbg-ball"), 10)
    popup = b.open_ext_page("popup.html")
    b.wait(lambda d: b.q("#fab").get_attribute("data-ready") == "1", 5)
    assert b.q("#fab").is_selected()
    b.click("#fab")
    time.sleep(0.5)
    b.d.switch_to.window(x)
    b.wait(lambda d: not b.visible("#xbg-ball"), 5, "ball still showing after switching it off")
    b.go("https://x.com/home")
    time.sleep(1)
    assert not b.visible("#xbg-ball")
    b.d.switch_to.window(popup)
    b.d.refresh()
    b.wait(lambda d: b.q("#fab").get_attribute("data-ready") == "1", 5)
    assert not b.q("#fab").is_selected(), "popup forgot the switch was off"
    b.click("#fab")
    b.d.switch_to.window(x)
    b.wait(lambda d: b.visible("#xbg-ball"), 5)


def test_x_tab_opened_before_install():
    b = Browser(install=False)
    try:
        b.go("https://x.com/i/bookmarks")
        x = b.d.current_window_handle
        b.wait(lambda d: len(b.qa("article")) >= 20, 10)
        b.install()
        time.sleep(1)
        b.open_ext_page("popup.html")
        popup = b.d.current_window_handle
        b.click("#open")
        time.sleep(1.5)
        # The popup closes itself when it handed over to the X tab.
        status = ""
        if popup in b.d.window_handles:
            b.d.switch_to.window(popup)
            status = b.q("#status").text
        b.d.switch_to.window(x)
        if b.gallery_open():
            # Firefox puts the content scripts into tabs that were already open.
            # The page's first request was missed, so it must still fill up.
            b.wait(lambda d: b.tile_count() > 0, 15, "gallery stayed empty in a tab opened before install")
        else:
            assert "Reload" in status, f"no gallery and no advice; status was {status!r}"
        assert not b.console_errors()
    finally:
        b.quit()
