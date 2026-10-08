"""Work around Windows file-handle timing in genlayer-test direct mode."""

import os

_original_unlink = os.unlink
_deferred = []


def _tolerant_unlink(path, *args, **kwargs):
    try:
        return _original_unlink(path, *args, **kwargs)
    except PermissionError:
        _deferred.append(path)
        return None


if os.name == "nt":
    os.unlink = _tolerant_unlink


def pytest_sessionfinish(session, exitstatus):
    del session, exitstatus
    if os.name != "nt":
        return
    os.unlink = _original_unlink
    for path in _deferred:
        try:
            _original_unlink(path)
        except (FileNotFoundError, PermissionError):
            pass
