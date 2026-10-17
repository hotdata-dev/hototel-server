#!/usr/bin/env python3
"""HotdataClient / ClientPool tests.

The hotdata SDK is imported inside the methods that use it, never at module
level, so a fake module in sys.modules is enough to exercise the client
lifecycle without an account or a network.

Run: python3 server/tests/test_client_pool.py
"""
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))

os.environ["HOTDATA_API_KEY"] = "test-key"


class FakeHotdata:
    """Just enough of the SDK for HotdataClient.client()."""

    def __init__(self):
        self.built = []
        self.lock = threading.Lock()
        fake = self

        class Configuration:
            def __init__(self, **kw):
                self.kw = kw

        class ApiClient:
            def __init__(self, configuration):
                # widen the window: a real ApiClient opens a urllib3 pool here,
                # which is exactly the work two threads must not both do
                time.sleep(0.01)
                with fake.lock:
                    fake.built.append(self)

        self.Configuration = Configuration
        self.ApiClient = ApiClient


fake_hotdata = FakeHotdata()
sys.modules["hotdata"] = fake_hotdata
import server  # noqa: E402


def test_only_a_400_reads_as_an_empty_table():
    """hotdata says "not found" both for a table with no rows (HTTP 400) and
    for a database that is not there (HTTP 404). Only the first is an empty
    result; the second must propagate, or every "is this org empty?" check
    fails open on a backend hiccup."""
    print("rows() and the two kinds of not-found:")
    client = server.HotdataClient("dbid-test")

    def raising(status, text):
        class Err(Exception):
            pass
        e = Err(f"({status}) Reason: {text}")
        e.status = status
        def sql(query, timeout=None):
            raise e
        return sql

    client.sql = raising(400, "Bad Request | table not found")
    assert client.rows("SELECT 1") == [], "a 400 not-found is an empty table"
    print("    400 'not found' -> []")
    client.sql = raising(400, "relation has no data")
    assert client.rows("SELECT 1") == []
    print("    400 'has no data' -> []")
    for status, text in ((404, "Not Found"), (500, "not found upstream"),
                         (None, "not found")):
        client.sql = raising(status, text)
        try:
            client.rows("SELECT 1")
        except Exception as e:
            assert getattr(e, "status", None) == status
            print(f"    {status} {text!r} -> raised")
        else:
            raise AssertionError(f"{status} {text!r} must propagate")


def test_concurrent_first_use_builds_one_client():
    """gather() is the first thing to reach a cold client, on several threads
    at once. Unlocked, each sees None and builds its own ApiClient; all but the
    last are dropped still holding their sockets."""
    print("a cold client under concurrent first use:")
    before = len(fake_hotdata.built)
    hd = server.HotdataClient("dbidtest0000000000000000")
    got, errors = [], []

    def race():
        try:
            got.append(hd.client())
        except Exception as e:                      # pragma: no cover
            errors.append(e)

    threads = [threading.Thread(target=race) for _ in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, errors
    built = len(fake_hotdata.built) - before
    assert built == 1, f"{built} ApiClients built for one HotdataClient"
    assert len(set(map(id, got))) == 1, "every caller must get the same client"
    assert got[0] is hd.client(), "and the warm path must return it too"
    print(f"    12 threads, {built} ApiClient, all callers share it")


def test_pool_returns_one_client_per_database():
    print("the pool keys clients by database:")
    pool = server.ClientPool()
    a1, a2 = pool.get("dbidaaa00000000000000000"), pool.get("dbidaaa00000000000000000")
    b = pool.get("dbidbbb00000000000000000")
    assert a1 is a2, "same database must reuse the client"
    assert a1 is not b, "different databases must not share one"
    assert a1.db == "dbidaaa00000000000000000" and b.db == "dbidbbb00000000000000000"
    print("    same id reuses, different ids do not")


def test_missing_api_key_is_a_clear_error():
    print("a missing API key says so:")
    hd = server.HotdataClient("dbidtest0000000000000001")
    saved = os.environ.pop("HOTDATA_API_KEY")
    real = server.core.hotdata_api_key
    server.core.hotdata_api_key = lambda: None      # ignore any ~/.hotdata file
    try:
        hd.client()
        raise AssertionError("expected a RuntimeError")
    except RuntimeError as e:
        assert "api key" in str(e).lower(), e
        print(f"    {e}")
    finally:
        server.core.hotdata_api_key = real
        os.environ["HOTDATA_API_KEY"] = saved


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
    print(f"\n{len(tests)} tests passed")
