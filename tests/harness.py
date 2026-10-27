"""Shared helpers: the mock X server and a Firefox Nightly driven by Selenium
with the extension installed as a temporary add-on."""

import json
import os
import re
import shutil
import ssl
import tempfile
import threading
import time
import urllib.request

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

from mock_x.server import make_server

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT_DIR = os.path.join(ROOT, "extension")
NIGHTLY = os.environ.get("FIREFOX_NIGHTLY", "/opt/ffn/firefox/firefox")
ARTIFACTS = os.path.join(ROOT, "tests", "artifacts")
ADDON_ID = "x-bookmarks-gallery@local"
UUID = "0b5e1c2a-7d3f-4e8a-9c61-5a2b3c4d5e6f"

_server = None


def start_server():
    global _server
    if _server is None:
        _server = make_server(443)
        threading.Thread(target=_server.serve_forever, daemon=True).start()
    return _server


def _ctx():
    c = ssl.create_default_context()
    c.check_hostname = False
    c.verify_mode = ssl.CERT_NONE
    return c


def ctl(**kw):
    """Change how the fake X behaves (see DEFAULTS in mock_x/server.py)."""
    q = "&".join(f"{k}={v}" for k, v in kw.items())
    req = urllib.request.Request(f"https://127.0.0.1/__ctl?{q}", headers={"Host": "x.com"})
    return json.loads(urllib.request.urlopen(req, context=_ctx()).read())


def api_log():
    req = urllib.request.Request("https://127.0.0.1/__log", headers={"Host": "x.com"})
    return json.loads(urllib.request.urlopen(req, context=_ctx()).read())


class Browser:
    """One Firefox Nightly with the extension loaded."""

    def __init__(self, profile_dir=None, private=False, width=1280, height=900, install=True):
        self.own_profile = profile_dir is None
        self.profile_dir = profile_dir or tempfile.mkdtemp(prefix="xbg-prof-")
        os.makedirs(ARTIFACTS, exist_ok=True)
        self.log_path = os.path.join(ARTIFACTS, f"firefox-{int(time.time()*1000)}.log")
        o = Options()
        o.binary_location = NIGHTLY
        o.add_argument("-headless")
        o.add_argument("-profile")
        o.add_argument(self.profile_dir)
        o.accept_insecure_certs = True
        prefs = {
            "network.dns.localDomains": "x.com,twitter.com,pbs.twimg.com,video.twimg.com,abs.twimg.com",
            "network.proxy.type": 0,
            "network.trr.mode": 5,
            "browser.shell.checkDefaultBrowser": False,
            "datareporting.policy.dataSubmissionEnabled": False,
            "toolkit.telemetry.reportingpolicy.firstRun": False,
            "extensions.webextensions.uuids": json.dumps({ADDON_ID: UUID}),
            # A temporary add-on is removed when Firefox closes; keep its data
            # like a normally installed one would, for the restart tests.
            "extensions.webextensions.keepStorageOnUninstall": True,
            "extensions.webextensions.keepUuidOnUninstall": True,
            # Send console messages (page, content scripts, browser) to the log.
            "devtools.console.stdout.content": True,
            "devtools.console.stdout.chrome": True,
            "browser.dom.window.dump.enabled": True,
            "media.autoplay.default": 0,
            "media.autoplay.blocking_policy": 0,
            "browser.download.folderList": 2,
            "browser.download.dir": os.path.join(self.profile_dir, "downloads"),
            "browser.download.useDownloadDir": True,
            "browser.download.always_ask_before_handling_new_types": False,
        }
        if private:
            prefs["browser.privatebrowsing.autostart"] = True
        for k, v in prefs.items():
            o.set_preference(k, v)
        # Lets the harness reach Firefox's own chrome code (to open extension pages).
        self.service = Service(executable_path=shutil.which("geckodriver"), log_output=self.log_path, service_args=["--log", "info"], env={**os.environ, "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"})
        self.driver = webdriver.Firefox(options=o, service=self.service)
        self.driver.set_window_size(width, height)
        self.driver.set_script_timeout(30)
        self.log_start = 0
        if install:
            self.install()

    def install(self):
        self.addon_id = self.driver.install_addon(EXT_DIR, temporary=True)
        time.sleep(0.5)

    @property
    def d(self):
        return self.driver

    def quit(self, keep_profile=False):
        try:
            self.driver.quit()
        except Exception:
            pass
        if self.own_profile and not keep_profile:
            shutil.rmtree(self.profile_dir, ignore_errors=True)

    # --- pages ----------------------------------------------------------------

    def go(self, url, wait_overlay_ready=True):
        self.d.get(url)
        if wait_overlay_ready:
            self.wait(lambda d: d.execute_script("return document.readyState") == "complete", 15)
            time.sleep(0.4)

    def wait(self, cond, timeout=10, msg=""):
        return WebDriverWait(self.d, timeout, poll_frequency=0.1).until(cond, msg)

    def js(self, script, *args):
        return self.d.execute_script(script, *args)

    def q(self, css):
        return self.d.find_element(By.CSS_SELECTOR, css)

    def qa(self, css):
        return self.d.find_elements(By.CSS_SELECTOR, css)

    def visible(self, css):
        return self.js(
            "const e=document.querySelector(arguments[0]); if(!e) return false;"
            "const s=getComputedStyle(e); const r=e.getBoundingClientRect();"
            "return s.display!=='none' && s.visibility!=='hidden' && +s.opacity>0.01 && r.width>0 && r.height>0 && !e.closest('.xbg-hidden');",
            css,
        )

    def click(self, css):
        el = self.q(css)
        self.js("arguments[0].scrollIntoView({block:'center'})", el)
        el.click()

    def click_text(self, text, css="button"):
        for el in self.qa(css):
            if el.text.strip() == text and el.is_displayed():
                el.click()
                return el
        raise AssertionError(f"no visible {css} with text {text!r}; have {[e.text for e in self.qa(css)]}")

    def shot(self, name):
        os.makedirs(ARTIFACTS, exist_ok=True)
        path = os.path.join(ARTIFACTS, name + ".png")
        self.d.save_screenshot(path)
        return path

    def gallery_open(self):
        return bool(self.js("const o=document.getElementById('xbg-overlay'); return !!o && !o.classList.contains('xbg-hidden')"))

    def tile_count(self):
        return int(self.js("return document.querySelectorAll('#xbg-overlay .xbg-grid .xbg-tile').length"))

    def count_text(self):
        return self.js("const c=document.querySelector('#xbg-overlay .xbg-count'); return c ? c.textContent : null")

    def status_text(self):
        return self.js("const c=document.querySelector('#xbg-overlay .xbg-status > span:not(.xbg-progress)'); return c ? c.textContent : null")

    def open_gallery_with_ball(self):
        self.wait(lambda d: self.visible("#xbg-ball"), 10, "floating ball never showed")
        self.click("#xbg-ball")
        self.wait(lambda d: self.gallery_open(), 10, "gallery didn't open")

    # --- the extension's own pages ------------------------------------------

    def ext_url(self, path):
        return f"moz-extension://{UUID}/{path}"

    def open_ext_page(self, path="popup.html", background=False):
        """Open one of the extension's pages in a new tab and switch to it.
        (Marionette refuses to navigate to moz-extension: URLs itself, so the
        tab is opened from Firefox's own chrome code.)"""
        before = set(self.d.window_handles)
        with self.d.context(self.d.CONTEXT_CHROME):
            self.d.execute_script(
                "const t = gBrowser.addTab(arguments[0], {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});"
                "if (!arguments[1]) gBrowser.selectedTab = t;",
                self.ext_url(path), background,
            )
        self.wait(lambda d: len(set(d.window_handles) - before) == 1, 10)
        handle = (set(self.d.window_handles) - before).pop()
        self.d.switch_to.window(handle)
        self.wait(lambda d: d.execute_script("return document.readyState") == "complete" and d.current_url.startswith("moz-extension"), 10)
        return handle

    def _in_ext_page(self, script, *args):
        main = self.d.current_window_handle
        self.open_ext_page(background=True)
        try:
            return self.d.execute_async_script(script, *args)
        finally:
            self.d.close()
            self.d.switch_to.window(main)

    def storage(self):
        """Everything in the extension's storage.local (read from an extension page)."""
        return self._in_ext_page("const done=arguments[0]; browser.storage.local.get(null).then(done, e=>done({__error:String(e)}))")

    def set_storage(self, data):
        return self._in_ext_page("const done=arguments[1]; browser.storage.local.set(arguments[0]).then(()=>done(1), e=>done(String(e)))", data)

    def clear_storage(self):
        return self._in_ext_page("const done=arguments[0]; browser.storage.local.clear().then(()=>done(1), e=>done(String(e)))")

    def fake_file_picker(self, path):
        """Make Firefox's next "Open file" dialogs pick `path` (like Firefox's
        own MockFilePicker), since WebDriver can't drive the native dialog."""
        with self.d.context(self.d.CONTEXT_CHROME):
            self.d.execute_script(
                """
                const path = arguments[0];
                const CID = Components.ID("{8f1b4c3e-6d1e-4c6b-9a40-2f6b9f0a1c11}");
                const reg = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
                function Picker() {}
                Picker.prototype = {
                  QueryInterface: ChromeUtils.generateQI(["nsIFilePicker"]),
                  init() {}, appendFilters() {}, appendFilter() {},
                  get file() { return new FileUtils.File(Services.prefs.getStringPref("xbg.test.pickerPath")); },
                  get domFileOrDirectory() { return File.createFromNsIFile(this.file); },
                  get domFileOrDirectoryEnumerator() { const p = this; let done = false; return { hasMoreElements: () => !done, getNext: () => { done = true; return p.domFileOrDirectory; }, [Symbol.iterator]: function* () { yield p.domFileOrDirectory; } }; },
                  open(cb) { Promise.resolve().then(() => cb.done(Ci.nsIFilePicker.returnOK)); },
                  defaultExtension: "", defaultString: "", displayDirectory: null, filterIndex: 0, addToRecentDocs: false, mode: 0, okButtonLabel: "",
                };
                const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
                const factory = { createInstance(iid) { return new Picker().QueryInterface(iid); } };
                Services.prefs.setStringPref("xbg.test.pickerPath", path);
                if (!reg.isCIDRegistered(CID)) reg.registerFactory(CID, "xbg mock file picker", "@mozilla.org/filepicker;1", factory);
                """,
                path,
            )

    def downloads(self):
        d = os.path.join(self.profile_dir, "downloads")
        return sorted(os.listdir(d)) if os.path.isdir(d) else []

    # --- errors ------------------------------------------------------------

    def page_errors(self):
        try:
            return self.js("return window.__pageErrors || []") or []
        except Exception:
            return []

    def console_errors(self):
        """Errors Firefox printed that come from the extension (content scripts, popup, inject.js)."""
        try:
            with open(self.log_path, errors="replace") as f:
                text = f.read()
        except FileNotFoundError:
            return []
        out = []
        for line in text.splitlines():
            if re.search(r"(JavaScript error|console\.error|Error:|TypeError|ReferenceError|SyntaxError)", line) and re.search(
                r"(moz-extension|content\.js|inject\.js|popup\.js|xbg)", line
            ):
                out.append(line.strip())
        return out
