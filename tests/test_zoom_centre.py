"""The post viewer keeps the post in the middle, and pictures can be zoomed (reported from the phone)."""

import math
import time

from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.keys import Keys

from harness import Browser
from test_first_use import open_loaded


def open_post(b, index):
    """Open the index-th photo (zoom is for photos)."""
    tile = b.qa('.xbg-grid .xbg-tile[aria-label="Photo"]')[index]
    key = tile.get_attribute("data-key")
    tile.click()
    b.wait(lambda d: b.visible(".xbg-lightbox"), 5)
    time.sleep(0.6)
    return key


def off_centre(b):
    """How far (px) the post nearest the middle is from being centred in the feed."""
    return b.js("""const f=document.querySelector('.xbg-feed').getBoundingClientRect(); const mid=(f.top+f.bottom)/2;
      let best=1e9; for (const p of document.querySelectorAll('.xbg-post')) { const r=p.getBoundingClientRect(); const d=(r.top+r.bottom)/2-mid; if (Math.abs(d)<Math.abs(best)) best=d; } return best;""")


def flick(b, dy):
    """Scroll the feed with the mouse wheel, like a short swipe, then let it settle."""
    feed = b.q(".xbg-feed")
    ActionChains(b.d).scroll_from_origin(__import__("selenium.webdriver.common.actions.wheel_input", fromlist=["ScrollOrigin"]).ScrollOrigin.from_element(feed), 0, dy).perform()
    time.sleep(1.2)


def test_post_settles_in_the_middle_after_scrolling():
    b = Browser(width=500, height=1000)
    try:
        open_loaded(b)
        b.zoom(1.3)  # phone width
        time.sleep(0.4)
        open_post(b, 4)
        assert abs(off_centre(b)) < 3
        for dy in (120, -70, 260, 45):
            flick(b, dy)
            b.shot("Z-settled")
            assert abs(off_centre(b)) < 3, f"post left {off_centre(b):.0f}px off the middle after scrolling {dy}px"
    finally:
        b.quit()


def scale(b):
    return b.js("const i=document.querySelector('.xbg-zoom img'); return i ? new DOMMatrix(getComputedStyle(i).transform).a : null")


def shift(b):
    return b.js("const m=new DOMMatrix(getComputedStyle(document.querySelector('.xbg-zoom img')).transform); return [m.e, m.f]")


def test_zoom_button_wheel_drag_double_click_and_close(browser):
    b = browser
    open_loaded(b)
    key = open_post(b, 4)
    post = f'.xbg-post[data-key="{key}"]'
    b.js(f"document.querySelector('{post} .xbg-post-media').classList.add('xbg-ui-on')")
    time.sleep(0.3)
    b.q(f"{post} .xbg-zoom-btn").click()
    b.wait(lambda d: b.visible(".xbg-zoom"), 3, "zoom view didn't open")
    time.sleep(0.4)
    assert abs(scale(b) - 1) < 0.01
    # Fits the screen and sits in the middle.
    r = b.js("const r=document.querySelector('.xbg-zoom img').getBoundingClientRect(), z=document.querySelector('.xbg-zoom'); return [r.left, r.top, r.right, r.bottom, z.clientWidth, z.clientHeight]")
    assert abs((r[0] + r[2]) / 2 - r[4] / 2) < 2 and abs((r[1] + r[3]) / 2 - r[5] / 2) < 2, r
    img = b.q(".xbg-zoom img")
    ActionChains(b.d).scroll_to_element(img).perform()
    from selenium.webdriver.common.actions.wheel_input import ScrollOrigin
    for _ in range(4):
        ActionChains(b.d).scroll_from_origin(ScrollOrigin.from_element(img), 0, -200).perform()
        time.sleep(0.1)
    time.sleep(0.3)
    assert scale(b) > 1.8, f"wheel didn't zoom in ({scale(b)})"
    b.shot("Z-zoomed")
    # Drag to look around.
    before = shift(b)
    ActionChains(b.d).move_to_element(img).click_and_hold().move_by_offset(-80, -60).release().perform()
    time.sleep(0.3)
    after = shift(b)
    assert after[0] < before[0] - 30 and after[1] < before[1] - 20, (before, after)
    # Double-click: back to fit; again: zoomed in.
    ActionChains(b.d).double_click(img).perform()
    time.sleep(0.5)
    assert abs(scale(b) - 1) < 0.01 and shift(b) == [0, 0]
    ActionChains(b.d).double_click(img).perform()
    time.sleep(0.5)
    assert scale(b) > 2
    # Escape closes the zoom only; Back works too.
    ActionChains(b.d).send_keys(Keys.ESCAPE).perform()
    time.sleep(0.4)
    assert not b.visible(".xbg-zoom") and b.visible(".xbg-lightbox")
    b.q(f"{post} .xbg-zoom-btn").click()
    b.wait(lambda d: b.visible(".xbg-zoom"), 3)
    b.d.back()
    time.sleep(0.6)
    assert not b.visible(".xbg-zoom") and b.visible(".xbg-lightbox"), "Back should close just the zoom"
    b.d.back()
    time.sleep(0.6)
    assert not b.visible(".xbg-lightbox") and b.gallery_open()


def pinch(b, el, start_gap, end_gap, ms=300, steps=10):
    """Two fingers on `el`, moving apart (zoom in) or together (zoom out)."""
    if isinstance(el, str):
        el = b.q(el)
    return b.d.execute_async_script(
        """const [el, g0, g1, ms, steps, done] = arguments;
        const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const fire = (type, gap, ended) => {
          const a = new Touch({ identifier: 1, target: el, clientX: cx - gap / 2, clientY: cy });
          const c = new Touch({ identifier: 2, target: el, clientX: cx + gap / 2, clientY: cy });
          const live = ended ? [] : [a, c];
          el.dispatchEvent(new TouchEvent(type, { touches: live, targetTouches: live, changedTouches: [a, c], bubbles: true, cancelable: true }));
        };
        fire("touchstart", g0);
        let i = 0;
        const step = () => { i++; fire("touchmove", g0 + (g1 - g0) * i / steps);
          if (i < steps) setTimeout(step, ms / steps); else setTimeout(() => { fire("touchend", g1, true); done(true); }, 16); };
        setTimeout(step, ms / steps);""",
        el, start_gap, end_gap, ms, steps,
    )


def test_pinch_a_picture_to_zoom_and_pinch_back_to_close(browser):
    b = browser
    open_loaded(b)
    key = open_post(b, 4)
    pinch(b, f'.xbg-post[data-key="{key}"] .xbg-post-media img', 80, 240)
    time.sleep(0.4)
    assert b.visible(".xbg-zoom"), "pinching the picture didn't zoom"
    assert scale(b) > 2, scale(b)
    # One finger drags around while zoomed.
    before = shift(b)
    b.swipe(".xbg-zoom img", -100, 0)
    time.sleep(0.3)
    assert shift(b)[0] < before[0] - 40
    # Pinch in: zooms out, and below the fitted size it closes.
    pinch(b, ".xbg-zoom img", 300, 60)
    time.sleep(0.6)
    assert not b.visible(".xbg-zoom") and b.visible(".xbg-lightbox")


def test_zoom_on_phone_fits_and_centres():
    b = Browser(width=500, height=1000)
    try:
        open_loaded(b)
        b.zoom(1.3)
        time.sleep(0.4)
        key = open_post(b, 4)
        pinch(b, f'.xbg-post[data-key="{key}"] .xbg-post-media img', 60, 200)
        time.sleep(0.5)
        b.shot("Z-phone-zoom")
        # Double-tap goes back to fitted: whole picture, centred.
        img = b.q(".xbg-zoom img")
        ActionChains(b.d).double_click(img).perform()
        time.sleep(0.5)
        r = b.js("const r=document.querySelector('.xbg-zoom img').getBoundingClientRect(), z=document.querySelector('.xbg-zoom'); return [r.left, r.top, r.right, r.bottom, z.clientWidth, z.clientHeight]")
        assert r[0] >= -1 and r[2] <= r[4] + 1, "picture wider than the screen when fitted"
        assert abs((r[1] + r[3]) / 2 - r[5] / 2) < 2, "not centred"
        b.shot("Z-phone-fit")
    finally:
        b.quit()
