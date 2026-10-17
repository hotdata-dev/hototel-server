#!/usr/bin/env python3
"""The System page: platform views for the one account that is system admin.

What matters is the gate, not the table: /system and /api/system/state must
answer only a system admin, an org admin gets nothing platform-wide, and the
nav only draws the link for the account that can use it.

Run: python3 server/tests/test_system.py
"""
import json
import os
import sys
import threading
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))
import server  # noqa: E402
import test_auth_store as fakes  # noqa: E402
from test_http_read_token import FakeStores, call  # noqa: E402


def boot():
    db = fakes.StatefulSysDb()
    auth = server.AuthStore(db, fakes.FakePool())
    auth.create_account("ops@x.dev", "hunter2hunter2")
    auth.create_org_for("ops@x.dev", "Platform Co")
    auth.set_system_admin("ops@x.dev")
    auth.create_account("ada@x.dev", "hunter2hunter2")
    auth.create_org_for("ada@x.dev", "Acme Inc")  # ada is an org admin, nothing more
    fakes.approved_token(auth, "ops@x.dev")
    fakes.approved_token(auth, "ada@x.dev")
    read_token = fakes.approved_token(auth, "ops@x.dev", scope="read")

    server.Handler.auth = auth
    server.Handler.pool = fakes.FakePool()
    server.Handler.stores = FakeStores()
    server.Handler.token = "shared-ingest-token"
    server.Handler.insights = None

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    return httpd, base, auth, read_token


HTTPD, BASE, AUTH, READ = boot()
AS_OPS = {"Cookie": f"hotusage_session={AUTH.login('ops@x.dev', 'hunter2hunter2')}"}
AS_ADA = {"Cookie": f"hotusage_session={AUTH.login('ada@x.dev', 'hunter2hunter2')}"}


def test_the_system_admin_gets_the_page_and_every_org():
    status, raw = call(BASE, "/system", headers=AS_OPS)
    assert status == 200 and b'data-page="system"' in raw, (status, raw[:200])
    status, raw = call(BASE, "/api/system/state", headers=AS_OPS)
    d = json.loads(raw)
    assert status == 200, (status, d)
    slugs = sorted(o["slug"] for o in d["orgs"])
    assert slugs == ["acme-inc", "platform-co"], slugs
    assert d["totals"] == {"organizations": 2, "members": 2, "empty": 0}, d["totals"]
    assert d["viewer"]["orgSlug"] == "platform-co", d["viewer"]
    print(f"system admin: /system 200, state lists {slugs}, totals {d['totals']}")


def test_an_org_admin_is_turned_away():
    # urllib follows the redirect, so the page that comes back is the dashboard
    status, raw = call(BASE, "/system", headers=AS_ADA)
    assert status == 200 and b'data-page="system"' not in raw, (status, raw[:200])
    status, raw = call(BASE, "/api/system/state", headers=AS_ADA)
    assert status == 403, (status, raw[:200])
    status, raw = call(BASE, "/api/admin/state", headers=AS_ADA)
    d = json.loads(raw)
    assert status == 200 and "allOrgs" not in d, "the org page must not carry the platform list"
    print("org admin: bounced off /system, 403 on its state, nothing platform-wide on /api/admin/state")


def test_tokens_and_strangers_get_nothing():
    print("refused:")
    for who, hdr in (("anonymous", None), ("read token", {"Authorization": f"Bearer {READ}"})):
        status, raw = call(BASE, "/api/system/state", headers=hdr)
        assert status == 401, (who, status)
        print(f"    {who}: 401")


def test_the_nav_draws_system_only_for_the_system_admin():
    for hdr, expect in ((AS_OPS, True), (AS_ADA, False)):
        status, raw = call(BASE, "/api/orgs", headers=hdr)
        d = json.loads(raw)
        assert status == 200 and d["isSystemAdmin"] is expect, (status, d)
    status, raw = call(BASE, "/static/nav.js")
    assert b"'/system'" in raw and b"isSystemAdmin" in raw, "nav.js does not gate the System link"
    status, raw = call(BASE, "/static/admin.html", headers=AS_OPS)
    assert b"All organizations" not in raw, "the card still lives on the Organization page"
    print("/api/orgs says isSystemAdmin true for ops, false for ada; nav gates the link on it")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
    HTTPD.shutdown()
    print(f"\nall {len(tests)} tests passed")
