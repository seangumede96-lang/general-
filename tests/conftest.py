import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from harness import Browser, ctl, start_server  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def server():
    return start_server()


@pytest.fixture(autouse=True)
def reset_mock():
    ctl(reset=1)
    yield


@pytest.fixture
def browser(request):
    b = Browser()
    yield b
    name = request.node.name.replace("/", "_")
    try:
        b.shot("last-" + name)
    except Exception:
        pass
    errors = b.console_errors() + b.page_errors()
    b.quit()
    # Every test also fails if the extension logged an error along the way.
    allowed = getattr(request.node.function, "allowed_errors", ())
    errors = [e for e in errors if not any(a in e for a in allowed)]
    assert not errors, "Extension errors in the console:\n" + "\n".join(errors[:20])


def allow_errors(*patterns):
    def deco(fn):
        fn.allowed_errors = patterns
        return fn
    return deco
