"""web-ext lint must stay at 0 errors and 0 warnings."""

import json
import os
import subprocess

from harness import EXT_DIR


# Firefox 128-139 ignore data_collection_permissions (it arrived in 140, and
# 142 on Android). The extension keeps supporting 128+, so that one note stays.
ALLOWED = {"KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION", "KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION"}


def test_web_ext_lint_clean():
    out = subprocess.run(["web-ext", "lint", "--output=json", "--source-dir", EXT_DIR], capture_output=True, text=True, timeout=180)
    report = json.loads(out.stdout[out.stdout.index("{"):])
    problems = [f"{m['code']}: {m.get('file','')} {m['message']}" for m in report["errors"] + report["warnings"]
                if not (m["code"] in ALLOWED and "data_collection_permissions" in json.dumps(m))]
    assert not problems, "\n".join(problems)
