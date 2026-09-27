#!/usr/bin/env python3
"""End-to-end tests: run the Script Filter the way Alfred does, against a local mock server
that replays fixtures captured from the real APIs (tests/fixtures). No real network, except
LiveTests, which only run with STOCKS_LIVE=1."""
import glob, json, os, plistlib, re, shutil, subprocess, sys, tempfile, threading, time, unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
FIX = os.path.join(ROOT, "tests", "fixtures")

# Saturday 2026-09-26 ~09:40 New York: every equity market in the fixtures is closed
NOW = 1790430000
AAPL_PRE, AAPL_REGULAR, AAPL_POST = 1790330000, 1790350000, 1790370000
KEY = "testkey-1234567890"


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def safe(s):
    return urllib.parse.quote(s, safe="").replace("%", "_")


def fixture(name):
    """(status, body) for tests/fixtures/<name>.json or <name>.<status>.json, else None."""
    p = os.path.join(FIX, name + ".json")
    status = 200
    if not os.path.exists(p):
        found = glob.glob(os.path.join(FIX, glob.escape(name) + ".*.json"))
        if not found:
            return None
        p = found[0]
        status = int(p.rsplit(".", 2)[1])
    with open(p, "rb") as f:
        return status, f.read()


class Mock(BaseHTTPRequestHandler):
    fault = None  # (status, body) for every request, or "slow"
    overrides = {}  # fixture name -> (status, body)
    requests = []

    def log_message(self, *a):
        pass

    def send(self, status, body, ctype="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        Mock.requests.append((self.path, dict(self.headers)))
        if Mock.fault == "slow":
            time.sleep(3)
            return self.send(200, b"{}")
        if Mock.fault:
            return self.send(*Mock.fault)
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        path = urllib.parse.unquote(u.path)
        if path == "/v1/finance/search":
            name, default = "yahoo/search_" + safe(q["q"].lower()), (200, b'{"count":0,"quotes":[]}')
        elif path.startswith("/v8/finance/chart/"):
            name, default = "yahoo/chart_" + safe(path[len("/v8/finance/chart/"):]), fixture("yahoo/chart_TWTR")
        elif path.startswith("/api/v1/"):
            if self.headers.get("X-Finnhub-Token") != KEY:
                return self.send(*fixture("finnhub/badkey"))
            if path == "/api/v1/search":
                name, default = "finnhub/search_" + safe(q["q"].lower()), (200, b'{"count":0,"result":[]}')
            else:
                name, default = "finnhub/quote_" + safe(q["symbol"]), fixture("finnhub/quote_ZZZZ")
        elif path == "/query":
            if q.get("apikey") != KEY:
                return self.send(*fixture("alphavantage/demo_information"))
            if q["function"] == "SYMBOL_SEARCH":
                name, default = "alphavantage/search_" + safe(q["keywords"].lower()), (200, b'{"bestMatches":[]}')
            else:
                name, default = "alphavantage/quote_" + safe(q["symbol"]), fixture("alphavantage/quote_EMPTY")
        elif path in ("/quote", "/symbol_search"):
            if self.headers.get("Authorization") != f"apikey {KEY}":
                return self.send(*fixture("twelvedata/nokey"))
            if path == "/symbol_search":
                name, default = "twelvedata/search_" + safe(q["symbol"].lower()), (200, b'{"data":[],"status":"ok"}')
            else:
                name, default = "twelvedata/quote_" + safe(q["symbol"]), fixture("twelvedata/notfound")
        else:
            return self.send(404, b"not found", "text/plain")
        self.send(*(Mock.overrides.get(name) or fixture(name) or default))


ThreadingHTTPServer.request_queue_size = 64  # curl opens up to 8 connections at once
ThreadingHTTPServer.daemon_threads = True
SERVER = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
threading.Thread(target=SERVER.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{SERVER.server_port}"


class Env:
    """A fresh cache/data/keychain per test."""

    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="stocks-test-")
        self.cache = os.path.join(self.dir, "cache")
        self.data = os.path.join(self.dir, "data")
        self.keychain = os.path.join(self.dir, "keychain")
        os.makedirs(self.keychain)

    def vars(self, **extra):
        e = dict(os.environ, alfred_workflow_cache=self.cache, alfred_workflow_data=self.data,
                 alfred_workflow_bundleid="io.github.x-o-r-r-o.stocks",
                 STOCKS_YAHOO_URL=BASE, STOCKS_FINNHUB_URL=BASE + "/api/v1", STOCKS_ALPHAVANTAGE_URL=BASE,
                 STOCKS_TWELVEDATA_URL=BASE, STOCKS_TEST_NOW=str(NOW), STOCKS_SYNC="1", STOCKS_TIMEOUT="5",
                 STOCKS_TEST_KEYCHAIN=self.keychain, STOCKS_TEST_CLIPBOARD="", STOCKS_TEST_NOOPEN="1",
                 number_locale="en-US")
        e.update({k: str(v) for k, v in extra.items()})
        return e

    def sf(self, query="", **extra):
        out = subprocess.run(["osascript", "-l", "JavaScript", "./stocks.js", "filter", query], cwd=SRC,
                             env=self.vars(**extra), capture_output=True, text=True, timeout=60)
        assert out.returncode == 0, out.stderr
        data = json.loads(out.stdout)
        validate(data)
        return data

    def items(self, query="", **extra):
        return self.sf(query, **extra)["items"]

    def act(self, action, arg, **extra):
        out = subprocess.run(["osascript", "-l", "JavaScript", "./stocks.js", "act", arg], cwd=SRC,
                             env=self.vars(stocks_action=action, **extra), capture_output=True, text=True, timeout=30)
        assert out.returncode == 0, out.stderr
        return out.stdout.strip()

    def set_key(self, provider, key=KEY):
        with open(os.path.join(self.keychain, f"io.github.x-o-r-r-o.stocks.{provider}"), "w") as f:
            f.write(key)

    def watchlist(self, content=None):
        p = os.path.join(self.data, "watchlist.json")
        if content is not None:
            os.makedirs(self.data, exist_ok=True)
            with open(p, "wb" if isinstance(content, bytes) else "w") as f:
                f.write(content)
            return None
        return json.loads(read(p))["symbols"] if os.path.exists(p) else None

    def quotes(self):
        return json.loads(read(os.path.join(self.cache, "quotes.json")))


def validate(data):
    assert isinstance(data.get("items"), list)
    for it in data["items"]:
        assert isinstance(it.get("title"), str) and it["title"], it
        assert "\n" not in it["title"], it
        if "icon" in it:
            assert os.path.exists(os.path.join(SRC, it["icon"]["path"])), it["icon"]
        if it.get("valid", True) is not False:
            assert "arg" in it, it
        for m in (it.get("mods") or {}).values():
            assert "subtitle" in m and "arg" in m, m


def find(items, prefix):
    for i in items:
        if i["title"].startswith(prefix):
            return i
    raise AssertionError(f"no item starting with {prefix!r}: {[i['title'] for i in items]}")


class Base(unittest.TestCase):
    def setUp(self):
        Mock.fault = None
        Mock.overrides = {}
        Mock.requests = []
        self.env = Env()

    def tearDown(self):
        shutil.rmtree(self.env.dir, ignore_errors=True)


class SearchTests(Base):
    def test_company_search(self):
        it = self.env.items("apple")
        aapl = it[0]
        self.assertEqual(aapl["title"], "AAPL   341.07 USD   ▲ +5.15 (+1.53%)")
        self.assertEqual(aapl["subtitle"], "★ Apple Inc. · NasdaqGS · Day 334.53 – 341.67 · Closed")  # ★: in the watchlist
        self.assertEqual(aapl["arg"], "https://finance.yahoo.com/quote/AAPL/")
        self.assertTrue(aapl["icon"]["path"].startswith(os.path.join(self.env.cache, "spark", "AAPL-")), aapl["icon"])
        self.assertEqual(aapl["mods"]["cmd"]["arg"], "341.07")
        self.assertEqual(aapl["mods"]["alt"]["arg"], "AAPL")
        self.assertEqual(aapl["mods"]["alt"]["variables"]["stocks_action"], "toggle")
        self.assertIn("Remove AAPL", aapl["mods"]["alt"]["subtitle"])  # AAPL is in the default watchlist
        self.assertIn("Add APLE", find(it, "APLE")["mods"]["alt"]["subtitle"])
        self.assertEqual(aapl["text"]["copy"], "341.07")
        tsla = self.env.items("tesla")[0]
        self.assertTrue(tsla["title"].startswith("TSLA   372.11 USD   ▼ -5.83 (-1.54%)"), tsla["title"])
        self.assertEqual(self.env.items("tesla", sparklines="0")[0]["icon"]["path"], "icons/down.png")

    def test_unquoted_results_still_listed(self):
        it = self.env.items("apple")
        fut = find(it, "SAAPL=F")  # no chart fixture: 404 → no quote, but the search result stays
        self.assertEqual(fut["subtitle"], "No quote available")
        self.assertEqual(fut["arg"], "https://finance.yahoo.com/quote/SAAPL%3DF/")

    def test_exact_ticker_crypto_fx(self):
        btc = self.env.items("BTC-USD")[0]
        self.assertEqual(btc["title"], "BTC-USD   84,069.29 USD   ▼ -12.62 (-0.02%)")
        self.assertIn("Bitcoin USD", btc["subtitle"])
        fx = self.env.items("eurusd=x")[0]
        self.assertTrue(fx["title"].startswith("EURUSD=X   1.1400 USD   ▲ +0.0020"), fx["title"])
        self.assertEqual(fx["mods"]["cmd"]["arg"], "1.1400")
        idx = self.env.items("^gspc")[0]
        self.assertTrue(idx["title"].startswith("^GSPC   7,743.41 USD"), idx["title"])

    def test_penny_and_huge_prices(self):
        shib = self.env.items("SHIB-USD")[0]
        self.assertTrue(shib["title"].startswith("SHIB-USD   0.00000592 USD   ▼ -0.0000000353"), shib["title"])
        self.assertNotIn("e-", shib["title"])
        self.assertEqual(shib["mods"]["cmd"]["arg"], "0.00000592")
        brk = self.env.items("BRK-A")[0]
        self.assertTrue(brk["title"].startswith("BRK-A   758,506.00 USD   ▼ -694.00 (-0.09%)"), brk["title"])
        self.assertEqual(brk["mods"]["cmd"]["arg"], "758506.00")

    def test_unicode_names_and_retry_without_accents(self):
        it = self.env.items("nestlé")
        self.assertTrue(it[0]["title"].startswith("NESN.SW   77.17 CHF   ▼ -0.77 (-0.99%)"), it[0]["title"])
        self.assertTrue(it[0]["subtitle"].startswith("Nestlé S.A. · Swiss"))
        # Yahoo finds nothing for "société générale"; the accent-free retry does
        it = self.env.items("société générale")
        self.assertEqual(it[0]["title"].split()[0], "GLE.PA")
        paths = [urllib.parse.unquote(p) for p, _ in Mock.requests if "search" in p]
        self.assertTrue(any("societe generale" in p for p in paths), paths)

    def test_delisted_and_no_results(self):
        it = self.env.items("TWTR")
        self.assertEqual(len(it), 1)
        self.assertEqual(it[0]["title"], "No data for TWTR")
        self.assertIs(it[0]["valid"], False)
        it = self.env.items("zzzzqqqxx")
        self.assertEqual(it[0]["title"], "No data for ZZZZQQQXX")
        it = self.env.items("no such company here")
        self.assertEqual(it[0]["title"], "No results for “no such company here”")

    def test_weird_input(self):
        for q in ['a"b', "it's", "a\nb", "$(touch /tmp/pwned)", "`id`", "%", "🚀", "x" * 300, "   "]:
            data = self.env.sf(q)
            self.assertTrue(data["items"], q)
        self.assertFalse(os.path.exists("/tmp/pwned"))

    def test_search_cache(self):
        self.env.items("apple")
        n = len([p for p, _ in Mock.requests if "/search" in p])
        self.env.items("Apple")
        self.assertEqual(len([p for p, _ in Mock.requests if "/search" in p]), n)

    def test_market_states(self):
        for t, label in ((AAPL_PRE, "Pre-market"), (AAPL_REGULAR, "Market open"), (AAPL_POST, "After hours"), (NOW, "Closed")):
            env = Env()
            self.assertTrue(env.items("AAPL", STOCKS_TEST_NOW=t)[0]["subtitle"].endswith(label), label)
        btc = self.env.items("BTC-USD")[0]
        self.assertTrue(btc["subtitle"].endswith("Market open"), btc["subtitle"])

    def test_yahoo_user_agent(self):
        self.env.items("AAPL")
        self.assertTrue(all(h.get("User-Agent") == "Mozilla/5.0" for _, h in Mock.requests))


class FormatTests(Base):
    def fmt(self, *vals, locale="en-US"):
        out = subprocess.run(["osascript", "-l", "JavaScript", "./stocks.js", "fmt", *vals], cwd=SRC,
                             env=self.env.vars(number_locale=locale), capture_output=True, text=True)
        return json.loads(out.stdout)

    def test_prices(self):
        self.assertEqual(self.fmt("341.07,2", "1.14,4", "0.00000592,5", "0.00000000013,8", "0,8", "758506,2", "1234567890123.456,2"),
                         ["341.07", "1.1400", "0.00000592", "0.00000000013", "0.00000000", "758,506.00", "1,234,567,890,123.46"])

    def test_nan_null_and_extremes(self):
        self.assertEqual(self.fmt("NaN", "", "abc", "Infinity", "1e300,2", "-0.5", "-12.3456"),
                         ["—", "—", "—", "—", self.fmt("1e300,2")[0], "-0.50", "-12.35"])
        self.assertNotIn("e", self.fmt("1e300,2")[0])
        self.assertEqual(self.fmt("1e-30"), ["0.00"])

    def test_locales(self):
        self.assertEqual(self.fmt("7743.41,2", "0.00000592,5", locale="de-DE"), ["7.743,41", "0,00000592"])
        self.assertEqual(self.fmt("758506,2", locale="en-IN"), ["7,58,506.00"])
        self.assertEqual(self.fmt("1234.5,2", locale="fr-FR")[0].replace(" ", " ").replace(" ", " "), "1 234,50")
        self.assertEqual(self.fmt("1234.5,2", locale="not a locale!"), self.fmt("1234.5,2", locale="en-US"))

    def test_locale_in_rows(self):
        it = self.env.items("^GSPC", number_locale="de-DE")
        self.assertIn("7.743,41 USD", it[0]["title"])
        self.assertIn("+39,28", it[0]["title"])
        self.assertEqual(it[0]["mods"]["cmd"]["arg"], "7743,41")


class WatchlistTests(Base):
    def test_default_watchlist_with_sparklines(self):
        it = self.env.items()
        self.assertEqual([i["title"].split()[0] for i in it], ["^GSPC", "^IXIC", "AAPL"])
        for i in it:
            self.assertTrue(i["icon"]["path"].startswith(os.path.join(self.env.cache, "spark")), i["icon"])
            out = subprocess.run(["sips", "-g", "pixelWidth", i["icon"]["path"]], capture_output=True, text=True).stdout
            self.assertEqual(int(out.split()[-1]), 128)
            self.assertIn("Remove", i["mods"]["alt"]["subtitle"])
            self.assertEqual(i["mods"]["alt"]["variables"]["stocks_reopen"], "1")
            self.assertEqual(i["mods"]["ctrl"]["variables"]["stocks_action"], "top")

    def test_sparklines_off(self):
        it = self.env.items(sparklines="0")
        self.assertEqual(it[0]["icon"]["path"], "icons/up.png")

    def test_served_from_cache_fast(self):
        self.env.items()
        n = len(Mock.requests)
        t = time.time()
        data = self.env.sf(STOCKS_YAHOO_URL="http://127.0.0.1:9")  # dead endpoint: must not be needed
        elapsed = time.time() - t
        self.assertEqual(len(Mock.requests), n)
        self.assertNotIn("rerun", data)
        self.assertTrue(data["items"][0]["title"].startswith("^GSPC   7,743.41"))
        self.assertLess(elapsed, 0.3 if not os.environ.get("CI") else 1.0)

    def test_ttl_open_vs_closed(self):
        self.env.items("AAPL", STOCKS_TEST_NOW=AAPL_REGULAR)
        self.env.watchlist('{"symbols":["AAPL"]}')
        n = len(Mock.requests)
        self.env.items(STOCKS_TEST_NOW=AAPL_REGULAR + 30)  # < 60 s: cached
        self.assertEqual(len(Mock.requests), n)
        self.env.items(STOCKS_TEST_NOW=AAPL_REGULAR + 90)  # market open: stale after 60 s
        self.assertEqual(len(Mock.requests), n + 1)
        self.env.items("AAPL", STOCKS_TEST_NOW=NOW)
        n = len(Mock.requests)
        self.env.items(STOCKS_TEST_NOW=NOW + 600)  # closed: 15 min
        self.assertEqual(len(Mock.requests), n)
        self.env.items(STOCKS_TEST_NOW=NOW + 1000)
        self.assertEqual(len(Mock.requests), n + 1)

    def test_background_refresh(self):
        data = self.env.sf(STOCKS_SYNC="0")
        self.assertEqual(data["rerun"], 0.5)
        self.assertEqual([i["subtitle"] for i in data["items"]], ["Loading…"] * 3)
        # a second run while the refresh is going doesn't start another one
        self.env.sf(STOCKS_SYNC="0")
        lock = os.path.join(self.env.cache, "refresh.lock")
        for _ in range(100):
            if not os.path.exists(lock):
                break
            time.sleep(0.1)
        self.assertFalse(os.path.exists(lock))
        data = self.env.sf(STOCKS_SYNC="0")
        self.assertNotIn("rerun", data)
        self.assertTrue(data["items"][2]["title"].startswith("AAPL   341.07"))
        charts = [p for p, _ in Mock.requests if "/chart/" in p]
        self.assertEqual(len(charts), 3)

    def test_stale_lock_is_ignored(self):
        os.makedirs(self.env.cache, exist_ok=True)
        with open(os.path.join(self.env.cache, "refresh.lock"), "w") as f:
            json.dump({"started": NOW - 3600}, f)
        self.assertTrue(self.env.items()[0]["title"].startswith("^GSPC   7,743.41"))

    def test_empty_watchlist(self):
        self.env.watchlist('{"symbols":[]}')
        it = self.env.items()
        self.assertEqual(it[0]["title"], "Your watchlist is empty")

    def test_unknown_symbol_in_watchlist(self):
        self.env.watchlist('{"symbols":["AAPL","TWTR"]}')
        it = self.env.items()
        self.assertEqual(it[1]["title"], "TWTR")
        self.assertIn("delisted", it[1]["subtitle"])
        self.assertIn("Remove TWTR", it[1]["mods"]["alt"]["subtitle"])

    def test_edit_actions(self):
        self.assertEqual(self.env.act("toggle", "msft"), "Added MSFT to the watchlist")
        self.assertEqual(self.env.watchlist(), ["^GSPC", "^IXIC", "AAPL", "MSFT"])
        self.assertEqual(self.env.act("top", "MSFT"), "Moved MSFT to the top of the watchlist")
        self.assertEqual(self.env.watchlist()[0], "MSFT")
        self.assertEqual(self.env.act("toggle", "^IXIC"), "Removed ^IXIC from the watchlist")
        self.assertEqual(self.env.watchlist(), ["MSFT", "^GSPC", "AAPL"])
        self.assertEqual(self.env.act("toggle", "bad symbol!"), "Not a valid symbol")
        self.assertEqual(self.env.act("reset", "reset"), "Watchlist reset")
        self.assertEqual(self.env.watchlist(), ["^GSPC", "^IXIC", "AAPL"])
        self.assertTrue(glob.glob(os.path.join(self.env.data, "watchlist.json.backup-*")))

    def test_watchlist_cap(self):
        self.env.watchlist(json.dumps({"symbols": [f"S{i}" for i in range(50)]}))
        self.assertIn("full", self.env.act("toggle", "AAPL"))

    def test_search_row_knows_watchlist(self):
        it = self.env.items("AAPL")
        self.assertIn("Remove AAPL", it[0]["mods"]["alt"]["subtitle"])
        self.assertEqual(it[0]["mods"]["ctrl"]["subtitle"], "Move AAPL to the top of the watchlist")
        self.assertEqual(it[0]["mods"]["ctrl"]["variables"], {"stocks_action": "top", "stocks_reopen": "0"})


class CorruptionTests(Base):
    def test_truncated_file_is_salvaged_not_overwritten(self):
        self.env.watchlist('{"version":1,"symbols":["AAPL","TSLA","MS')
        it = self.env.items()
        self.assertEqual(it[0]["title"], "The watchlist file is damaged")
        self.assertEqual(it[0]["arg"], "AAPL TSLA")
        self.assertEqual([i["title"].split()[0] for i in it[1:]], ["AAPL", "TSLA"])
        with open(os.path.join(self.env.data, "watchlist.json")) as f:
            self.assertTrue(f.read().endswith('"MS'))  # untouched until the user acts
        self.assertEqual(self.env.act("restore", it[0]["arg"]), "Watchlist repaired")
        self.assertEqual(self.env.watchlist(), ["AAPL", "TSLA"])
        self.assertTrue(glob.glob(os.path.join(self.env.data, "watchlist.json.damaged-*")))

    def test_garbage_and_wrong_types(self):
        self.env.watchlist(b"\x00\xff\xfe garbage")
        it = self.env.items()
        self.assertEqual(it[0]["title"], "The watchlist file is damaged")
        self.assertEqual(it[0]["arg"], "-")
        self.assertEqual(it[1]["title"], "Your watchlist is empty")
        self.env.act("restore", "-")
        self.assertEqual(self.env.watchlist(), [])
        self.env.watchlist('{"symbols":"AAPL"}')
        self.assertEqual(self.env.items()[0]["title"], "The watchlist file is damaged")
        self.env.watchlist('["aapl", null, 5, "bad symbol!", "AAPL", {"x":1}, "tsla"]')
        self.assertEqual([i["title"].split()[0] for i in self.env.items()], ["AAPL", "TSLA"])

    def test_toggle_on_damaged_file_keeps_backup(self):
        self.env.watchlist('{"symbols":["AAPL",')
        self.assertEqual(self.env.act("toggle", "TSLA"), "Added TSLA to the watchlist")
        self.assertEqual(self.env.watchlist(), ["AAPL", "TSLA"])
        self.assertTrue(glob.glob(os.path.join(self.env.data, "watchlist.json.damaged-*")))

    def test_corrupt_caches(self):
        os.makedirs(self.env.cache, exist_ok=True)
        for f in ("quotes.json", "searches.json", "status.json", "refresh.lock"):
            with open(os.path.join(self.env.cache, f), "w") as fh:
                fh.write('{"AAPL": 5, "x": null, "^GSPC": {"provider": "yahoo", "fetched": "soon"}')
        self.assertTrue(self.env.items()[0]["title"].startswith("^GSPC   7,743.41"))
        with open(os.path.join(self.env.cache, "quotes.json"), "w") as fh:
            fh.write('{"AAPL": 5, "x": null, "^GSPC": {"provider": "yahoo", "fetched": "soon"}}')
        self.assertTrue(self.env.items("apple")[0]["title"].startswith("AAPL   341.07"))


class FailureTests(Base):
    def check(self, fault, title, **extra):
        Mock.fault = fault
        it = self.env.items("AAPL", **extra)
        self.assertEqual(it[0]["title"], title)
        return it[0]

    def test_http_errors(self):
        e = self.check((403, b"Forbidden"), "Couldn’t get data from Yahoo Finance: access denied (HTTP 403)")
        self.assertEqual(e["variables"]["stocks_action"], "config")
        self.assertIn("Workflow’s Configuration", e["subtitle"])
        self.check((500, b"oops"), "Couldn’t get data from Yahoo Finance: server error (HTTP 500)")
        self.check((429, b"Too Many Requests"), "Yahoo Finance is limiting requests")
        self.env = Env()  # a rate limit backs off for a minute
        self.check((502, b"<html>bad gateway</html>"), "Couldn’t get data from Yahoo Finance: server error (HTTP 502)")

    def test_malformed_and_empty(self):
        self.check((200, b'{"quotes": [{"symbol": "AAPL"'), "Couldn’t get data from Yahoo Finance: unexpected response (not JSON) (HTTP 200)")
        self.check((200, b""), "Couldn’t get data from Yahoo Finance: empty response (HTTP 200)")
        self.check((200, b"<html>consent</html>"), "Couldn’t get data from Yahoo Finance: unexpected response (not JSON) (HTTP 200)")
        self.check((200, b"[]"), "Couldn’t get data from Yahoo Finance: unexpected search response")
        self.check((200, b"null"), "Couldn’t get data from Yahoo Finance: unexpected response (HTTP 200)")

    def test_changed_quote_shape(self):
        Mock.overrides["yahoo/chart_AAPL"] = (200, b'{"chart": {"result": [{"meta": {"regularMarketPrice": null}}]}}')
        self.assertEqual(self.env.items("AAPL")[0]["title"], "No data for AAPL")
        env = Env()
        Mock.overrides["yahoo/chart_AAPL"] = (200, b'{"something": "else"}')
        it = env.items("AAPL")
        self.assertEqual(it[0]["title"], "Couldn’t get data from Yahoo Finance: unexpected quote response")

    def test_null_fields(self):
        Mock.overrides["yahoo/chart_AAPL"] = (200, json.dumps({"chart": {"result": [{"meta": {
            "symbol": "AAPL", "regularMarketPrice": 12.5, "previousClose": None, "chartPreviousClose": "NaN",
            "currency": None, "longName": None, "regularMarketDayLow": None, "currentTradingPeriod": "x"},
            "indicators": {"quote": [{"close": [None, "NaN", 1, None]}]}}], "error": None}}).encode())
        it = self.env.items("AAPL")
        self.assertEqual(it[0]["title"], "AAPL   12.50   — (—)")
        self.assertNotIn("NaN", json.dumps(it))
        self.assertNotIn("undefined", json.dumps(it))

    def test_network_down_and_timeout(self):
        e = self.check(None, "Can’t reach Yahoo Finance", STOCKS_YAHOO_URL="http://127.0.0.1:9")
        self.assertEqual((e["subtitle"], e["icon"]["path"]), ("Check your internet connection", "icons/offline.png"))
        self.check("slow", "Can’t reach Yahoo Finance", STOCKS_TIMEOUT=1)

    def test_offline_row_over_cached_quotes(self):
        self.env.items()
        it = self.env.items(STOCKS_TEST_NOW=NOW + 3600, STOCKS_YAHOO_URL="http://127.0.0.1:9")
        self.assertEqual(it[0]["title"], "Offline: showing results from 1 h ago")
        self.assertEqual(it[0]["subtitle"], "Check your internet connection")
        self.assertEqual(it[0]["icon"]["path"], "icons/offline.png")
        self.assertTrue(it[1]["title"].startswith("^GSPC   7,743.41"))

    def test_watchlist_keeps_stale_quotes_and_shows_error(self):
        self.env.items()
        Mock.fault = (429, b"Too Many Requests")
        it = self.env.items(STOCKS_TEST_NOW=NOW + 3600)
        self.assertEqual(it[0]["title"], "Yahoo Finance is limiting requests")
        self.assertTrue(it[1]["title"].startswith("^GSPC   7,743.41"))
        self.assertIn("as of", it[1]["subtitle"])
        Mock.fault = None
        it = self.env.items(STOCKS_TEST_NOW=NOW + 7200)
        self.assertTrue(it[0]["title"].startswith("^GSPC"))


class KeyedProviderTests(Base):
    def test_missing_key(self):
        for p, name in (("finnhub", "Finnhub"), ("twelvedata", "Twelve Data"), ("alphavantage", "Alpha Vantage")):
            it = self.env.items("", provider=p)
            self.assertEqual(it[0]["title"], f"Set your {name} API key")
            self.assertTrue(it[0]["subtitle"].startswith("Save it via “stock apikey”"))
            self.assertEqual(it[0]["autocomplete"], "apikey ")
            self.assertEqual(it[1]["title"], "Get an API key…")
            self.assertTrue(it[1]["arg"].startswith("https://"))
        it = self.env.items("", provider="finnhub", STOCKS_TEST_CLIPBOARD=KEY)
        self.assertEqual([i["title"] for i in it], ["Set your Finnhub API key", "Save API key from clipboard", "Get an API key…"])
        self.assertEqual(self.env.items("", provider="finnhub", keyword_stock="st")[0]["subtitle"].split(" · ")[0], "Save it via “st apikey”")
        self.assertEqual(Mock.requests, [])

    def test_set_and_remove_key(self):
        it = self.env.items("apikey short", provider="finnhub")
        self.assertEqual(it[0]["title"], "That doesn’t look like a Finnhub API key")
        it = self.env.items(f"apikey {KEY}", provider="finnhub")
        self.assertEqual(it[0]["title"], "Save typed API key")
        self.assertEqual(it[0]["subtitle"], "••••7890 · Typed keys are briefly visible to other processes: the clipboard is safer")
        self.assertEqual(it[0]["variables"]["stocks_action"], "savekey")
        self.assertNotIn(KEY, it[0]["arg"])  # the argument ends up on the action's command line
        self.assertEqual(self.env.act("savekey", it[0]["arg"], provider="finnhub", stocks_key=it[0]["variables"]["stocks_key"]), "API key saved")
        self.assertEqual(read(os.path.join(self.env.keychain, "io.github.x-o-r-r-o.stocks.finnhub")), KEY)
        self.assertEqual(self.env.act("savekey", "savekey", provider="finnhub", stocks_key="bad key"), "Couldn’t save the API key: it doesn’t look like a Finnhub API key")
        self.assertEqual(self.env.act("savekey", KEY, provider="finnhub"), "Couldn’t save the API key: it doesn’t look like a Finnhub API key")  # never from argv
        self.assertEqual(self.env.act("savekey", "savekey", stocks_key=KEY), "Couldn’t save the API key: Yahoo Finance doesn’t use one")
        self.assertTrue(self.env.items("AAPL", provider="finnhub")[0]["title"].startswith("AAPL   341.07 USD"))
        it = self.env.items("apikey", provider="finnhub")
        row = find(it, "Remove the saved API key")
        self.assertEqual(row["subtitle"], "Deletes it from your macOS Keychain")
        self.assertEqual(row["variables"]["stocks_action"], "delkey")
        self.assertEqual(self.env.act("delkey", row["arg"], provider="finnhub"), "API key removed")
        self.assertEqual(self.env.act("delkey", "finnhub", provider="finnhub"), "Couldn’t remove the API key: none is saved")
        self.assertEqual(self.env.items("", provider="finnhub")[0]["title"], "Set your Finnhub API key")
        self.assertNotIn("Remove the saved API key", [i["title"] for i in self.env.items("apikey", provider="finnhub")])

    def test_key_rows_and_order(self):
        self.env.set_key("finnhub")
        it = self.env.items("apikey other-key-99999999", provider="finnhub", STOCKS_TEST_CLIPBOARD=KEY)
        self.assertEqual([i["title"] for i in it], ["Save API key from clipboard", "Save typed API key", "Remove the saved API key", "Get an API key…"])
        self.assertEqual([i["icon"]["path"] for i in it], ["icons/key.png", "icons/key.png", "icons/key-remove.png", "icons/key-get.png"])
        self.assertEqual(it[0]["subtitle"], "••••7890 · Stored in your macOS Keychain")
        self.assertEqual(it[3]["subtitle"], "Opens Finnhub’s API key page · Copy the key, then type “stock apikey”")
        # the same key typed and in the clipboard: only the clipboard row (it is cleared afterwards)
        it = self.env.items(f"apikey {KEY}", provider="finnhub", STOCKS_TEST_CLIPBOARD=KEY)
        self.assertEqual([i["title"] for i in it][:2], ["Save API key from clipboard", "Remove the saved API key"])
        self.assertEqual(Mock.requests, [])

    def test_apikey_word_and_aliases(self):
        self.env.set_key("finnhub")
        for q in ("apikey", "APIKEY", "ApiKey", ":key", ":KEY"):
            self.assertEqual(self.env.items(q, provider="finnhub")[-1]["title"], "Get an API key…", q)
            self.assertEqual(self.env.items(f"{q} other-key-99999999", provider="finnhub")[0]["title"], "Save typed API key", q)
        self.assertEqual(Mock.requests, [])  # never a ticker search
        # only the exact first word: “apikeys” and a later “apikey” are ordinary searches
        self.assertNotEqual(self.env.items("apikeys", provider="finnhub")[-1]["title"], "Get an API key…")
        self.assertNotEqual(self.env.items("apple apikey", provider="finnhub")[-1]["title"], "Get an API key…")
        self.assertTrue(Mock.requests)
        # Yahoo Finance needs no key: say so instead of searching for “APIKEY”
        Mock.requests.clear()
        self.assertEqual(self.env.items("apikey")[0]["title"], "Yahoo Finance doesn’t use an API key")
        self.assertEqual(Mock.requests, [])
        # the settings list offers it too, and “:k” still finds it
        row = self.env.items(":k", provider="finnhub")[0]
        self.assertEqual((row["title"], row["autocomplete"]), ("apikey  API key", "apikey "))
        self.assertNotIn("match", row)

    def test_clipboard_is_cleared_after_saving(self):
        out = os.path.join(self.env.dir, "clipboard-out")
        it = self.env.items("apikey", provider="finnhub", STOCKS_TEST_CLIPBOARD=KEY)[0]
        v = it["variables"]
        self.assertEqual(v["stocks_key_source"], "clipboard")
        self.assertEqual(self.env.act("savekey", it["arg"], provider="finnhub", stocks_key=v["stocks_key"], stocks_key_source="clipboard",
                                      STOCKS_TEST_CLIPBOARD=KEY, STOCKS_TEST_CLIPBOARD_OUT=out), "API key saved")
        self.assertEqual(read(out), "cleared")
        os.remove(out)
        # the clipboard changed in the meantime, or the key was typed: left alone
        self.env.act("savekey", "savekey", provider="finnhub", stocks_key=KEY, stocks_key_source="clipboard", STOCKS_TEST_CLIPBOARD="something else", STOCKS_TEST_CLIPBOARD_OUT=out)
        self.env.act("savekey", "savekey", provider="finnhub", stocks_key=KEY, stocks_key_source="typed", STOCKS_TEST_CLIPBOARD=KEY, STOCKS_TEST_CLIPBOARD_OUT=out)
        self.assertFalse(os.path.exists(out))

    def test_finnhub(self):
        self.env.set_key("finnhub")
        it = self.env.items("apple", provider="finnhub")
        self.assertEqual(it[0]["title"], "AAPL   341.07 USD   ▲ +5.15 (+1.53%)")
        self.assertEqual(it[0]["subtitle"], "★ APPLE INC · Day 334.53 – 341.67 · Closed")
        self.assertEqual(it[0]["icon"]["path"], "icons/up.png")
        self.assertEqual(find(it, "APLE")["subtitle"], "No quote available")  # all-zero quote = unknown
        for path, headers in Mock.requests:
            self.assertNotIn(KEY, path)
            self.assertEqual(headers.get("X-Finnhub-Token"), KEY)
        self.assertEqual(self.env.items("ZZZZ", provider="finnhub")[0]["title"], "No data for ZZZZ")
        it = self.env.items("AAPL", provider="finnhub", STOCKS_TEST_NOW=AAPL_REGULAR)
        self.assertTrue(it[0]["subtitle"].endswith("Market open"))

    def test_finnhub_bad_key_and_rate_limit(self):
        self.env.set_key("finnhub", "wrong-key-123456")
        it = self.env.items("AAPL", provider="finnhub")
        self.assertEqual(it[0]["title"], "Finnhub rejected your API key")
        self.assertEqual(it[0]["subtitle"], "Save a new one via “stock apikey”")
        self.assertEqual(it[0]["autocomplete"], "apikey ")
        self.env.set_key("finnhub")
        Mock.fault = fixture("finnhub/ratelimit")
        env = Env()
        env.set_key("finnhub")
        self.assertEqual(env.items("AAPL", provider="finnhub")[0]["title"], "Finnhub is limiting requests")

    def test_twelvedata(self):
        self.env.set_key("twelvedata")
        it = self.env.items("AAPL", provider="twelvedata")
        self.assertEqual(it[0]["title"], "AAPL   341.07 USD   ▲ +5.15 (+1.53%)")
        self.assertEqual(it[0]["subtitle"], "★ Apple Inc. · NASDAQ · Day 334.53 – 341.67 · Closed")
        self.assertTrue(all(h.get("Authorization") == f"apikey {KEY}" for _, h in Mock.requests))
        self.assertTrue(all(KEY not in p for p, _ in Mock.requests))
        Mock.overrides["twelvedata/quote_AAPL"] = fixture("twelvedata/ratelimit")
        env = Env()
        env.set_key("twelvedata")
        it = env.items("AAPL", provider="twelvedata")
        self.assertEqual(it[0]["title"], "Twelve Data is limiting requests")
        self.assertIn("Rate limit reached (8 requests a minute on the free plan)", it[0]["subtitle"])

    def test_alphavantage(self):
        self.env.set_key("alphavantage")
        it = self.env.items("IBM", provider="alphavantage")
        self.assertEqual(it[0]["title"], "IBM   225.51 USD   ▼ -1.55 (-0.68%)")
        it = self.env.items("tesco", provider="alphavantage")
        self.assertEqual(it[0]["title"].split()[0], "TSCO.LON")
        self.assertEqual(len([p for p, _ in Mock.requests if "GLOBAL_QUOTE" in p]), 2)  # 1 quote per search (25/day)
        Mock.overrides["alphavantage/quote_MSFT"] = fixture("alphavantage/ratelimit_information")
        it = self.env.items("MSFT", provider="alphavantage")
        self.assertEqual(it[0]["title"], "Alpha Vantage is limiting requests")
        self.assertIn("Daily limit reached (25 requests a day on the free plan)", it[0]["subtitle"])
        self.assertNotIn(KEY, json.dumps(it))
        # the daily limit holds until 00:00 UTC: no more requests until then
        n = len(Mock.requests)
        self.assertTrue(self.env.items("NOPE", provider="alphavantage")[0]["title"].startswith("Alpha Vantage is limiting requests"))
        self.assertTrue(self.env.items("", provider="alphavantage", STOCKS_TEST_NOW=NOW + 3600)[0]["title"].startswith("Alpha Vantage is limiting requests"))
        self.assertEqual(len(Mock.requests), n)
        Mock.overrides["alphavantage/quote_NOPE"] = fixture("alphavantage/invalid_call")
        midnight = (NOW // 86400 + 1) * 86400
        self.assertEqual(self.env.items("NOPE", provider="alphavantage", STOCKS_TEST_NOW=midnight + 5)[0]["title"], "No data for NOPE")

    def test_key_never_written_to_disk(self):
        self.env.set_key("alphavantage")
        self.env.items("IBM", provider="alphavantage")
        Mock.fault = (500, KEY.encode())
        self.env.items("", provider="alphavantage", STOCKS_TEST_NOW=NOW + 99999)
        for base, _, files in os.walk(self.env.dir):
            if base.startswith(self.env.keychain):
                continue
            for f in files:
                with open(os.path.join(base, f), "rb") as fh:
                    self.assertNotIn(KEY.encode(), fh.read(), f)


class ActionTests(Base):
    def test_open_sites(self):
        self.env.items("AAPL")
        cases = {
            "yahoo": "https://finance.yahoo.com/quote/AAPL/",
            "google": "https://www.google.com/finance/quote/AAPL%3ANASDAQ",
            "tradingview": "https://www.tradingview.com/symbols/NASDAQ-AAPL/",
            "stocks": "stocks://?symbol=AAPL",
        }
        for site, url in cases.items():
            it = self.env.items("AAPL", open_in=site)
            self.assertEqual(it[0]["arg"], url, site)
            self.assertTrue(it[0]["quicklookurl"].startswith("https://"))
            self.assertEqual(self.env.act("open", url), f"open {url}")

    def test_site_symbol_mapping(self):
        g = lambda q: self.env.items(q, open_in="google")[0]["arg"]
        tv = lambda q: self.env.items(q, open_in="tradingview")[0]["arg"]
        self.assertEqual(g("^GSPC"), "https://www.google.com/finance/quote/.INX%3AINDEXSP")
        self.assertEqual(g("EURUSD=X"), "https://www.google.com/finance/quote/EUR-USD")
        self.assertEqual(g("7203.T"), "https://www.google.com/finance/quote/7203%3ATYO")
        self.assertEqual(g("BRK-A"), "https://www.google.com/finance/quote/BRK.A%3ANYSE")
        self.assertEqual(tv("BTC-USD"), "https://www.tradingview.com/symbols/BTCUSD/")
        self.assertEqual(tv("NESN.SW"), "https://www.tradingview.com/symbols/SIX-NESN/")
        self.assertEqual(tv("BRK-A"), "https://www.tradingview.com/symbols/NYSE-BRK.A/")

    def test_open_refuses_other_schemes(self):
        self.assertEqual(self.env.act("open", "file:///etc/passwd"), "")
        self.assertEqual(self.env.act("open", "javascript:alert(1)"), "")

    def test_settings_menu(self):
        it = self.env.items(":")
        self.assertEqual([i["title"].split()[0] for i in it], [":reset", ":cache", ":config"])
        self.assertEqual([i["title"].split()[0] for i in self.env.items(":ca")], [":cache"])
        self.assertIn("apikey", [i["title"].split()[0] for i in self.env.items(":", provider="twelvedata")])
        self.env.items("AAPL")
        self.assertEqual(self.env.act("clearcache", "clearcache"), "Cleared cached quotes")
        self.assertFalse(os.path.exists(os.path.join(self.env.cache, "quotes.json")))
        self.assertEqual(self.env.act("config", "config"), "config")


class Audit1RegressionTests(Base):
    """Bugs found in the first audit pass."""

    def test_stale_market_open_flag_is_not_trusted_next_session(self):
        # Twelve Data says is_market_open=false (fetched on Saturday); on Monday morning the stale
        # cached quote must not say "Closed" while the market is open
        self.env.set_key("twelvedata")
        self.env.watchlist('{"symbols":["AAPL"]}')
        self.env.items(provider="twelvedata")
        Mock.fault = (500, b"down")
        monday_open = NOW + 2 * 86400  # Monday 09:40 New York
        it = self.env.items(provider="twelvedata", STOCKS_TEST_NOW=monday_open)
        self.assertIn("Market open", it[1]["subtitle"])

    def test_holiday_flag_still_used_within_the_session(self):
        self.env.set_key("twelvedata")
        monday_open = NOW + 2 * 86400
        it = self.env.items("AAPL", provider="twelvedata", STOCKS_TEST_NOW=monday_open)
        self.assertIn("· Closed · as of ", it[0]["subtitle"])  # is_market_open=false during hours; Friday's price

    def test_quote_from_the_future_is_refetched(self):
        self.env.items("AAPL", STOCKS_TEST_NOW=NOW + 86400)
        n = len(Mock.requests)
        self.env.items("AAPL")
        self.assertGreater(len(Mock.requests), n)

    def test_lowercase_name_query_quotes_results_first(self):
        self.env.set_key("alphavantage")
        Mock.overrides["alphavantage/quote_TSCO.LON"] = fixture("alphavantage/quote_IBM")
        it = self.env.items("tesco", provider="alphavantage")
        self.assertTrue(it[0]["title"].startswith("TSCO.LON   225.51"), it[0]["title"])
        quoted = [urllib.parse.parse_qs(urllib.parse.urlparse(p).query)["symbol"][0] for p, _ in Mock.requests if "GLOBAL_QUOTE" in p]
        self.assertEqual(quoted, ["TSCO.LON"])
        # a ticker typed in capitals that the search doesn't list exactly is quoted first
        Mock.overrides["alphavantage/search_tsco"] = fixture("alphavantage/search_tesco")
        Mock.overrides["alphavantage/quote_TSCO"] = fixture("alphavantage/quote_IBM")
        it = self.env.items("TSCO", provider="alphavantage")
        self.assertTrue(it[0]["title"].startswith("TSCO   225.51"), it[0]["title"])

    def test_successful_search_clears_watchlist_error(self):
        self.env.items()
        Mock.fault = (429, b"Too Many Requests")
        self.assertTrue(self.env.items(STOCKS_TEST_NOW=NOW + 3600)[0]["title"].startswith("Yahoo Finance is limiting requests"))
        Mock.fault = None
        for sym in ("^GSPC", "^IXIC", "AAPL"):
            self.env.items(sym, STOCKS_TEST_NOW=NOW + 3700)
        it = self.env.items(STOCKS_TEST_NOW=NOW + 3710)
        self.assertTrue(it[0]["title"].startswith("^GSPC"), it[0]["title"])

    def test_as_of_shows_the_date_when_old(self):
        self.env.items()
        Mock.fault = (500, b"down")
        it = self.env.items(STOCKS_TEST_NOW=NOW + 3 * 86400)
        self.assertRegex(it[1]["subtitle"], r"as of Sep 26\b")

    def test_negative_previous_close(self):
        body = json.loads(fixture("yahoo/chart_AAPL")[1])
        body["chart"]["result"][0]["meta"].update(regularMarketPrice=10.0, previousClose=-37.63, chartPreviousClose=-37.63)
        Mock.overrides["yahoo/chart_" + safe("CL=F")] = (200, json.dumps(body).encode())
        it = self.env.items("CL=F")
        self.assertIn("▲ +47.63 (+126.57%)", it[0]["title"])

    def test_invalid_utf8_body(self):
        Mock.fault = (200, b"\xff\xfe\x00junk")
        self.assertEqual(self.env.items("AAPL")[0]["title"], "Couldn’t get data from Yahoo Finance: unexpected response (not JSON) (HTTP 200)")

    def test_empty_search_results_expire_sooner(self):
        self.env.items("zzzzqqqxx")
        count = lambda: len([p for p, _ in Mock.requests if "/search" in p])
        n = count()
        self.env.items("zzzzqqqxx", STOCKS_TEST_NOW=NOW + 300)
        self.assertEqual(count(), n)
        self.env.items("zzzzqqqxx", STOCKS_TEST_NOW=NOW + 700)
        self.assertEqual(count(), n + 1)

    def test_action_rows_disable_modifiers(self):
        for it in self.env.items(":"):
            for m in ("cmd", "alt", "ctrl"):
                self.assertIs(it["mods"][m]["valid"], False, it["title"])
        Mock.fault = (403, b"no")
        err = self.env.items("AAPL")[0]
        self.assertIs(err["mods"]["cmd"]["valid"], False)

    def test_http_400_quote_is_unknown_symbol(self):
        Mock.overrides["yahoo/chart_AAPL"] = (400, b'{"chart":{"result":null,"error":{"code":"Bad Request","description":"Invalid symbol"}}}')
        self.assertEqual(self.env.items("AAPL")[0]["title"], "No data for AAPL")

    def test_open_rejects_unparseable_url(self):
        self.assertEqual(self.env.act("open", "https://exa mple.com/<>"), "")


class Audit2RegressionTests(Base):
    """Bugs found in the second audit pass."""

    def test_failed_refresh_backs_off(self):
        Mock.fault = (429, b"Too Many Requests")
        it = self.env.items()
        self.assertTrue(it[0]["title"].startswith("Yahoo Finance is limiting requests"))
        n = len(Mock.requests)
        it = self.env.items(STOCKS_TEST_NOW=NOW + 30)
        self.assertEqual(len(Mock.requests), n)  # no new attempt (and no rerun loop) for a minute
        self.assertTrue(it[0]["title"].startswith("Yahoo Finance is limiting requests"))
        self.assertEqual(it[1]["subtitle"], "No quote yet")
        self.env.items(STOCKS_TEST_NOW=NOW + 61)
        self.assertGreater(len(Mock.requests), n)

    def test_background_refresh_does_not_loop_on_errors(self):
        Mock.fault = (500, b"down")
        self.env.sf(STOCKS_SYNC="0")
        lock = os.path.join(self.env.cache, "refresh.lock")
        for _ in range(100):
            if not os.path.exists(lock):
                break
            time.sleep(0.1)
        n = len(Mock.requests)
        data = self.env.sf(STOCKS_SYNC="0")
        self.assertNotIn("rerun", data)
        self.assertEqual(len(Mock.requests), n)
        self.assertEqual(data["items"][0]["title"], "Couldn’t get data from Yahoo Finance: server error (HTTP 500)")

    def test_leftover_temp_dirs_are_removed(self):
        old = os.path.join(self.env.cache, "tmp-dead")
        new = os.path.join(self.env.cache, "tmp-busy")
        os.makedirs(old)
        os.makedirs(new)
        os.utime(old, (time.time() - 600, time.time() - 600))
        self.env.items("AAPL")
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.exists(new))

    def test_long_unicode_name_not_cut_inside_an_emoji(self):
        body = json.loads(fixture("yahoo/chart_AAPL")[1])
        body["chart"]["result"][0]["meta"]["longName"] = "A" * 48 + "🚀🚀🚀 Ünïcødé"
        Mock.overrides["yahoo/chart_AAPL"] = (200, json.dumps(body).encode())
        sub = self.env.items("AAPL")[0]["subtitle"]
        sub.encode("utf-8")  # raises on a lone surrogate
        self.assertTrue(sub.startswith("★ " + "A" * 48 + "🚀…"), sub)

    def test_html_entities_in_names(self):
        Mock.overrides["yahoo/search_procter"] = (200, json.dumps({"quotes": [
            {"symbol": "GJR", "shortname": "Synthetic", "longname": "Strats Trust For Procter &amp; Gambel &#233;&#x1F600; &bogus;",
             "quoteType": "EQUITY", "exchDisp": "NYSE", "isYahooFinance": True}]}).encode())
        it = self.env.items("procter")
        self.assertEqual(it[0]["title"], "GJR   Strats Trust For Procter & Gambel é😀 &bogus;")

    def test_checkbox_false_string(self):
        self.assertEqual(self.env.items("AAPL", sparklines="false")[0]["icon"]["path"], "icons/up.png")

    def test_watchlist_write_failure_is_reported(self):
        self.env.watchlist('{"symbols":["AAPL"]}')
        os.chmod(self.env.data, 0o500)
        try:
            self.assertEqual(self.env.act("toggle", "TSLA"), "Couldn’t save the watchlist")
            self.assertEqual(self.env.act("reset", "reset"), "Couldn’t save the watchlist")
        finally:
            os.chmod(self.env.data, 0o700)
        self.assertEqual(self.env.watchlist(), ["AAPL"])


class Audit3RegressionTests(Base):
    """Bugs found in the third audit pass."""

    def test_sparkline_keeps_the_last_point(self):
        def chart(closes):
            body = json.loads(fixture("yahoo/chart_AAPL")[1])
            body["chart"]["result"][0]["indicators"]["quote"][0]["close"] = closes
            return (200, json.dumps(body).encode())
        Mock.overrides["yahoo/chart_FLAT"] = chart([340.0] * 200)
        Mock.overrides["yahoo/chart_SPIKE"] = chart([340.0] * 199 + [345.0])  # index 199 was dropped by the 1-in-2 sampling
        self.env.watchlist('{"symbols":["FLAT","SPIKE"]}')
        it = self.env.items()
        with open(it[0]["icon"]["path"], "rb") as a, open(it[1]["icon"]["path"], "rb") as b:
            self.assertNotEqual(a.read(), b.read())


class Audit4RegressionTests(Base):
    """Bugs found in the fourth audit pass."""

    def raw(self, query, **extra):
        return subprocess.run(["osascript", "-l", "JavaScript", "./stocks.js", "filter", query], cwd=SRC,
                              env=self.env.vars(**extra), capture_output=True, timeout=60).stdout

    # --- the API key never reaches a command line
    def test_api_key_stays_off_command_lines(self):
        js = read(os.path.join(SRC, "stocks.js"))
        self.assertNotIn("/usr/bin/security", js)  # `security … -w KEY` showed the key in `ps`
        it = self.env.items(f"apikey {KEY}", provider="finnhub")[0]
        self.assertNotIn(KEY, it["arg"])
        self.assertNotIn(KEY, json.dumps(it["text"]))
        self.assertNotIn(KEY, it["title"])
        self.assertEqual(it["variables"]["stocks_key"], KEY)
        out = subprocess.run(["osascript", "-l", "JavaScript", "./stocks.js", "act", it["arg"]], cwd=SRC, capture_output=True, text=True,
                             env=self.env.vars(provider="finnhub", **it["variables"])).stdout
        self.assertEqual(out.strip(), "API key saved")
        self.assertNotIn(KEY, out)
        raw = self.raw("apikey", provider="finnhub", STOCKS_TEST_CLIPBOARD=KEY).decode()
        self.assertEqual(raw.count(KEY), 1)  # only in the item's variables
        for i in json.loads(raw)["items"]:
            for m in i.get("mods", {}).values():
                self.assertNotIn(KEY, m["arg"])

    def test_key_from_the_clipboard(self):
        it = self.env.items("apikey", provider="twelvedata", STOCKS_TEST_CLIPBOARD=KEY)
        self.assertEqual(it[0]["title"], "Save API key from clipboard")
        self.assertEqual(it[0]["variables"], {"stocks_action": "savekey", "stocks_key": KEY, "stocks_key_source": "clipboard"})
        it = self.env.items("apikey", provider="twelvedata", STOCKS_TEST_CLIPBOARD="not a key at all")
        self.assertFalse(it[0]["title"].startswith("Save"))
        for word in ("watchlist", "password", "12345678901234567"):  # plain words aren't offered as keys
            self.assertFalse(self.env.items("apikey", provider="twelvedata", STOCKS_TEST_CLIPBOARD=word)[0]["title"].startswith("Save"), word)

    # --- refresh lock
    def lock(self, **fields):
        os.makedirs(self.env.cache, exist_ok=True)
        with open(os.path.join(self.env.cache, "refresh.lock"), "w") as f:
            json.dump(fields, f)

    def test_lock_of_a_dead_refresh_is_ignored(self):
        p = subprocess.Popen(["true"])
        p.wait()
        self.lock(started=NOW, pid=p.pid)  # Alfred killed the refresh: don't wait 30 s
        self.assertTrue(self.env.items()[0]["title"].startswith("^GSPC   7,743.41"))

    def test_lock_of_a_live_refresh_is_respected_beyond_30s(self):
        self.lock(started=NOW - 45, pid=os.getpid())  # 50 slow symbols take longer than 30 s
        data = self.env.sf()
        self.assertEqual(data["rerun"], 0.5)
        self.assertEqual(Mock.requests, [])

    def test_lock_from_the_future_is_ignored(self):
        self.lock(started=NOW + 86400)
        self.assertTrue(self.env.items()[0]["title"].startswith("^GSPC   7,743.41"))

    def test_requests_really_run_in_parallel(self):
        Mock.fault = "slow"  # 3 s per request
        self.env.watchlist(json.dumps({"symbols": [f"S{i}" for i in range(6)]}))
        t = time.time()
        self.env.items(STOCKS_TIMEOUT=5)
        self.assertLess(time.time() - t, 8)  # was 6 × 3 s: curl queued them on one HTTP/1.1 connection

    # --- keyed providers: per-symbol plan limits and budgets
    def test_symbol_outside_the_plan_is_not_a_key_error(self):
        self.env.set_key("finnhub")
        self.env.watchlist('{"symbols":["AAPL","AAPL.SW"]}')
        Mock.overrides["finnhub/quote_AAPL.SW"] = (403, b'{"error":"You don\'t have access to this resource."}')
        it = self.env.items(provider="finnhub")
        self.assertEqual([i["title"].split()[0] for i in it], ["AAPL", "AAPL.SW"])
        self.assertEqual(it[1]["subtitle"], "Not available on your Finnhub plan")
        n = len(Mock.requests)
        self.env.items(provider="finnhub", STOCKS_TEST_NOW=NOW + 1000)  # no back-off: AAPL refreshes
        self.assertGreater(len(Mock.requests), n)
        self.env.set_key("twelvedata")
        Mock.overrides["twelvedata/quote_VOD"] = (200, b'{"code":403,"message":"**symbol** VOD is available exclusively with pro or enterprise plans.","status":"error"}')
        self.assertEqual(self.env.items("VOD", provider="twelvedata")[0]["subtitle"], "Not available on your Twelve Data plan")

    def test_alpha_vantage_budget(self):
        self.env.set_key("alphavantage")
        for s in ("SPY", "QQQ", "AAPL"):
            Mock.overrides[f"alphavantage/quote_{s}"] = fixture("alphavantage/quote_IBM")
        for k in range(5):
            self.env.items("", provider="alphavantage", STOCKS_TEST_NOW=AAPL_REGULAR + 61 * k)
        self.assertEqual(len([p for p, _ in Mock.requests if "GLOBAL_QUOTE" in p]), 3)

    def test_twelve_data_batches_and_spaces_refreshes(self):
        self.env.set_key("twelvedata")
        self.env.watchlist(json.dumps({"symbols": [f"S{i}" for i in range(12)]}))
        count = lambda: len([p for p, _ in Mock.requests if p.startswith("/quote")])
        self.env.items(provider="twelvedata")
        self.assertEqual(count(), 8)  # 8 credits a minute
        data = self.env.sf(provider="twelvedata", STOCKS_TEST_NOW=NOW + 30)
        self.assertEqual(count(), 8)
        self.assertEqual(data["rerun"], 5)  # comes back for the rest when the minute is up
        self.assertEqual(data["items"][-1]["subtitle"], "Loading…")
        self.env.items(provider="twelvedata", STOCKS_TEST_NOW=NOW + 61)
        self.assertEqual(count(), 12)  # the 4 never fetched

    def test_cached_search_does_not_spend_a_daily_limit(self):
        self.env.set_key("alphavantage")
        self.env.items("tesco", provider="alphavantage")  # search cached
        Mock.overrides["alphavantage/quote_IBM"] = fixture("alphavantage/ratelimit_information")
        self.env.items("IBM", provider="alphavantage")
        os.remove(os.path.join(self.env.cache, "quotes.json"))  # the quote is needed again, the search is cached
        n = len(Mock.requests)
        it = self.env.items("tesco", provider="alphavantage", STOCKS_TEST_NOW=NOW + 60)
        self.assertEqual(len(Mock.requests), n)
        self.assertTrue(it[0]["title"].startswith("Alpha Vantage is limiting requests"))

    def test_search_failure_does_not_poison_the_watchlist(self):
        self.env.items()
        Mock.overrides["yahoo/chart_TSLA"] = (500, b"x")
        self.assertTrue(self.env.items("TSLA", STOCKS_TEST_NOW=NOW + 10)[0]["title"].startswith("Couldn’t get data from Yahoo Finance: server error"))
        self.assertTrue(self.env.items(STOCKS_TEST_NOW=NOW + 20)[0]["title"].startswith("^GSPC"))

    def test_rate_limited_search_backs_off(self):
        Mock.overrides["yahoo/search_apple"] = (429, b"Too Many Requests")
        self.env.items("apple")
        n = len(Mock.requests)
        it = self.env.items("tesla", STOCKS_TEST_NOW=NOW + 20)
        self.assertEqual(len(Mock.requests), n)
        self.assertTrue(it[0]["title"].startswith("Yahoo Finance is limiting requests"))
        self.assertTrue(self.env.items("tesla", STOCKS_TEST_NOW=NOW + 70)[0]["title"].startswith("TSLA"))

    def test_typed_ticker_quoted_when_search_fails(self):
        Mock.overrides["yahoo/search_aapl"] = (429, b"Too Many Requests")
        it = self.env.items("AAPL")
        self.assertTrue(it[0]["title"].startswith("AAPL   341.07"))
        self.assertTrue(it[-1]["title"].startswith("Yahoo Finance is limiting requests"))

    # --- symbols, formatting, market state
    def test_us_detection_excludes_exchange_suffixes(self):
        self.env.set_key("finnhub")
        Mock.overrides["finnhub/quote_VOD.L"] = fixture("finnhub/quote_AAPL")
        Mock.overrides["finnhub/quote_BRK.B"] = fixture("finnhub/quote_AAPL")
        self.assertNotIn("USD", self.env.items("VOD.L", provider="finnhub")[0]["title"])
        self.assertIn("USD", self.env.items("BRK.B", provider="finnhub")[0]["title"])

    def test_yahoo_share_class_alias(self):
        it = self.env.items("BRK.B")  # Yahoo: BRK.B is 404, BRK-B is the listing
        self.assertTrue(it[0]["title"].startswith("BRK-B   505.48 USD"), it[0]["title"])

    def test_fx_decimals_without_price_hint(self):
        self.env.set_key("twelvedata")
        body = {"symbol": "EUR/USD", "name": "Euro / US Dollar", "exchange": "Forex", "currency": "", "close": "1.17123",
                "previous_close": "1.17003", "change": "0.00120", "percent_change": "0.10256", "high": "1.17200",
                "low": "1.16950", "is_market_open": True}
        Mock.overrides["twelvedata/quote_" + safe("EUR/USD")] = (200, json.dumps(body).encode())
        it = self.env.items("EUR/USD", provider="twelvedata")
        self.assertEqual(it[0]["title"], "EUR/USD   1.1712   ▲ +0.0012 (+0.10%)")

    def test_small_change_never_rounds_to_zero(self):
        body = json.loads(fixture("yahoo/chart_AAPL")[1])
        body["chart"]["result"][0]["meta"].update(regularMarketPrice=100.003, previousClose=100.0, priceHint=2)
        Mock.overrides["yahoo/chart_AAPL"] = (200, json.dumps(body).encode())
        self.assertIn("▲ +0.003 (+0.00%)", self.env.items("AAPL")[0]["title"])

    def test_negative_zero(self):
        out = subprocess.run(["osascript", "-l", "JavaScript", "./stocks.js", "fmt", "-0,2"], cwd=SRC,
                             env=self.env.vars(), capture_output=True, text=True)
        self.assertEqual(json.loads(out.stdout), ["0.00"])

    def test_crypto_is_open_around_the_clock(self):
        self.env.items("BTC-USD")
        it = self.env.items("BTC-USD", STOCKS_TEST_NOW=NOW + 50)
        self.assertTrue(it[0]["subtitle"].endswith("Market open"))
        # past the fixture's "session" (midnight UTC): still open, and on the short TTL
        n = len(Mock.requests)
        it = self.env.items("BTC-USD", STOCKS_TEST_NOW=NOW + 12 * 3600)
        self.assertGreater(len(Mock.requests), n)
        self.assertIn("Market open", it[0]["subtitle"])

    def test_quote_fetched_before_the_close_is_refetched_soon(self):
        end = json.loads(fixture("yahoo/chart_AAPL")[1])["chart"]["result"][0]["meta"]["currentTradingPeriod"]["post"]["end"]
        self.env.items("AAPL", STOCKS_TEST_NOW=end - 30)
        n = len(Mock.requests)
        self.env.items("AAPL", STOCKS_TEST_NOW=end + 90)  # closed now, but was open at fetch time: 60 s TTL
        self.assertGreater(len(Mock.requests), n)

    def test_us_holidays_and_early_closes(self):
        self.env.set_key("finnhub")
        thanksgiving = 1795706400  # 2026-11-26 10:20 New York
        self.assertIn("· Closed", self.env.items("AAPL", provider="finnhub", STOCKS_TEST_NOW=thanksgiving)[0]["subtitle"])
        early = 1795804200  # 2026-11-27 13:30 New York: the 1 pm early close
        self.assertIn("After hours", Env().items("AAPL", provider="finnhub", STOCKS_TEST_NOW=early, STOCKS_TEST_KEYCHAIN=self.env.keychain)[0]["subtitle"])

    def test_old_price_shows_its_date(self):
        self.env.watchlist('{"symbols":["AAPL"]}')
        it = self.env.items(STOCKS_TEST_NOW=NOW + 86400)  # Sunday: Friday's close
        self.assertRegex(it[0]["subtitle"], r"Closed · as of Sep 2[56]")

    # --- caches and output
    def test_array_and_null_caches_are_replaced(self):
        os.makedirs(self.env.cache, exist_ok=True)
        with open(os.path.join(self.env.cache, "quotes.json"), "w") as f:
            f.write("[]")
        self.env.items()
        n = len(Mock.requests)
        self.env.items()
        self.assertEqual(len(Mock.requests), n)  # the array was replaced: no endless refresh
        with open(os.path.join(self.env.cache, "searches.json"), "w") as f:
            json.dump({"yahoo:apple": {"at": NOW, "results": [None]}}, f)
        self.assertTrue(self.env.items("apple")[0]["title"].startswith("AAPL   341.07"))

    def test_error_text_is_one_line(self):
        Mock.overrides["yahoo/chart_AAPL"] = (200, json.dumps({"chart": {"result": None, "error": {"code": "Internal", "description": "line one\nline two " + "x" * 300}}}).encode())
        title = self.env.items("AAPL")[0]["title"]
        self.assertTrue(title.startswith("Couldn’t get data from Yahoo Finance: line one line two"), title)
        self.assertLessEqual(len(title), 130)

    def test_lone_surrogates_are_replaced(self):
        Mock.overrides["yahoo/search_surr"] = (200, json.dumps({"quotes": [{"symbol": "GJR", "longname": "Bad \ud800 name &#xD800;", "quoteType": "EQUITY", "isYahooFinance": True}]}).encode("utf-8", "surrogatepass"))
        out = self.raw("surr")
        self.assertNotIn(b"\\ud800", out.lower())
        json.loads(out.decode("utf-8"))  # strict UTF-8

    def test_sparklines_are_pruned(self):
        self.env.watchlist('{"symbols":["AAPL","^GSPC"]}')
        spark = os.path.join(self.env.cache, "spark")
        for k in range(3):
            self.env.items(STOCKS_TEST_NOW=NOW + 1000 * k)
            for f in os.listdir(spark):
                os.utime(os.path.join(spark, f), (time.time() - 60, time.time() - 60))
        self.env.items(STOCKS_TEST_NOW=NOW + 5000)
        self.assertEqual(len(os.listdir(spark)), 2)

    def test_concurrent_watchlist_edits(self):
        self.env.watchlist('{"symbols":[]}')
        syms = [f"S{i}" for i in range(8)]
        procs = [subprocess.Popen(["osascript", "-l", "JavaScript", "./stocks.js", "act", s], cwd=SRC,
                                  env=self.env.vars(stocks_action="toggle"), stdout=subprocess.PIPE) for s in syms]
        for p in procs:
            p.communicate(timeout=30)
        self.assertEqual(sorted(self.env.watchlist()), syms)
        self.assertFalse(os.path.exists(os.path.join(self.env.data, "watchlist.lock")))


class FinalReviewRegressionTests(Base):
    def test_bidi_and_control_characters_removed_from_display(self):
        body = json.loads(fixture("yahoo/chart_AAPL")[1])
        body["chart"]["result"][0]["meta"]["longName"] = "Evil\u202eCorp\u0007 Inc\u2066."
        Mock.overrides["yahoo/chart_AAPL"] = (200, json.dumps(body).encode())
        it = self.env.items("AAPL")
        self.assertTrue(it[0]["subtitle"].startswith("★ EvilCorp  Inc."), it[0]["subtitle"])
        it = self.env.items("zz\u202ezz\u0001")
        raw = json.dumps(it, ensure_ascii=False)
        self.assertNotIn("\u202e", raw)
        self.assertNotIn("\u0001", raw)

    def test_query_from_environment(self):
        out = subprocess.run(["osascript", "-l", "JavaScript", "./stocks.js", "filter"], cwd=SRC,
                             env=self.env.vars(stocks_query=":cache"), capture_output=True, text=True, timeout=60)
        self.assertEqual(json.loads(out.stdout)["items"][0]["title"], ":cache  Clear cached quotes")
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            script = next(o for o in plistlib.load(f)["objects"] if o["type"] == "alfred.workflow.input.scriptfilter")["config"]["script"]
        self.assertNotIn("filter \"$1\"", script)  # the query (maybe an API key) never goes on osascript's argv

    def test_shared_budget_across_refresh_and_search(self):
        self.env.set_key("twelvedata")
        self.env.watchlist(json.dumps({"symbols": [f"S{i}" for i in range(8)]}))
        self.env.items(provider="twelvedata")  # the refresh spends the minute's 8 credits
        n = len(Mock.requests)
        it = self.env.items("MSFT", provider="twelvedata", STOCKS_TEST_NOW=NOW + 20)
        self.assertEqual(len(Mock.requests), n)  # nothing sent: the provider would answer 429
        self.assertEqual(it[0]["title"], "Twelve Data is limiting requests")
        self.assertTrue(it[0]["subtitle"].startswith("Try again in a minute · Request limit reached (8 a minute on the free plan)"), it[0]["subtitle"])
        Mock.overrides["twelvedata/quote_MSFT"] = fixture("twelvedata/quote_AAPL")
        it = self.env.items("MSFT", provider="twelvedata", STOCKS_TEST_NOW=NOW + 61)  # the minute is over
        self.assertTrue(it[0]["title"].startswith("MSFT"), it[0]["title"])

    def test_budget_caps_quotes_per_search(self):
        self.env.set_key("twelvedata")
        os.makedirs(self.env.cache)
        with open(os.path.join(self.env.cache, "requests.json"), "w") as f:
            f.write(json.dumps({"twelvedata": [NOW - 10] * 6, "bogus": 3, "__proto__": []}))
        self.env.items("aapl", provider="twelvedata")  # 1 search + 1 quote left of 8 (4 wanted)
        self.assertEqual(len([p for p, _ in Mock.requests if p.startswith("/quote")]), 1)
        log = json.loads(read(os.path.join(self.env.cache, "requests.json")))
        self.assertEqual(list(log), ["twelvedata"])

    def test_ctrl_adds_at_top_and_respects_cap(self):
        self.assertEqual(self.env.act("top", "TSLA"), "Added TSLA to the top of the watchlist")
        self.assertEqual(self.env.watchlist()[0], "TSLA")
        self.env.watchlist(json.dumps({"symbols": [f"S{i}" for i in range(50)]}))
        self.assertIn("full", self.env.act("top", "AAPL"))
        self.assertEqual(self.env.act("top", "S9"), "Moved S9 to the top of the watchlist")

    def test_reset_backups_are_pruned(self):
        os.makedirs(self.env.data, exist_ok=True)
        for i in range(8):
            open(os.path.join(self.env.data, f"watchlist.json.backup-{1000 + i}"), "w").close()
        self.env.watchlist(json.dumps({"symbols": ["AAPL"]}))
        self.env.act("reset", "reset")
        backups = [f for f in os.listdir(self.env.data) if ".backup-" in f]
        self.assertEqual(len(backups), 5)
        self.assertNotIn("watchlist.json.backup-1000", backups)

    def test_unknown_provider_value(self):
        self.assertTrue(self.env.items(provider="constructor")[0]["title"].startswith("^GSPC"))


class Round4Tests(Base):
    """Alfred's real runtime (no LANG, macOS region settings) and the v1.1 additions."""

    def fmt(self, *vals, locale="", tz="America/New_York"):
        out = subprocess.run(["osascript", "-l", "JavaScript", "./stocks.js", "fmt", *vals], cwd=SRC,
                             env=dict(self.env.vars(number_locale=locale), TZ=tz), capture_output=True, text=True)
        return json.loads(out.stdout)

    def test_macos_style_locale_identifiers(self):
        # the format macOS itself shows (de_DE, en_US@rg=dezzzz) used to be ignored silently
        self.assertEqual(self.fmt("7743.41,2", locale="de_DE"), ["7.743,41"])
        self.assertEqual(self.fmt("7743.41,2", locale="en_US@rg=dezzzz"), ["7.743,41"])
        self.assertEqual(self.fmt("7743.41,2", locale="de-DE"), ["7.743,41"])
        self.assertEqual(self.fmt("7743.41,2", locale="xx_YY"), self.fmt("7743.41,2", locale="en-US"))

    def test_system_region_and_custom_separators(self):
        # NSArgumentDomain stands in for the user's defaults (-AppleLocale, -AppleICUNumberSymbols)
        self.assertEqual(self.fmt("1234567.891,2", "-AppleLocale", "de_DE"), ["1.234.567,89"])
        self.assertEqual(self.fmt("1234567.891,2", "-AppleLocale", "en_US@rg=dezzzz"), ["1.234.567,89"])
        self.assertEqual(self.fmt("1234567.891,2", "-AppleLocale", "en_IN"), ["12,34,567.89"])
        # System Settings › Number format: English (US) region with 1.234,56
        self.assertEqual(self.fmt("1234567.891,2", "-AppleLocale", "en_US", "-AppleICUNumberSymbols", '{ 0 = ","; 1 = "."; }'), ["1.234.567,89"])
        # an explicit locale in the Workflow's Configuration wins over the system's symbols
        self.assertEqual(self.fmt("1234567.891,2", "-AppleICUNumberSymbols", '{ 0 = ","; 1 = "."; }', locale="en-US"), ["1,234,567.89"])
        # Arabic region with Western digits
        self.assertEqual(self.fmt("1234.5,2", "-AppleLocale", "ar_SA@numbers=latn")[0][-4:], "4.50")

    def test_system_time_format(self):
        self.assertEqual(self.fmt("t:%d" % AAPL_POST, "-AppleLocale", "de_DE"), ["17:00"])
        self.assertEqual(self.fmt("t:%d" % AAPL_POST, "-AppleLocale", "en_US")[0].replace("\u202f", " "), "5:00 PM")
        self.assertIn("21:33", self.fmt("t:1790300000", "-AppleLocale", "en_GB")[0])

    def test_alfred_runtime_fresh_install(self):
        """env -i (no LANG, no Homebrew), Alfred's variables, paths with spaces, no data/cache folders yet."""
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            plist = plistlib.load(f)
        script = [o["config"]["script"] for o in plist["objects"] if o["type"].endswith("scriptfilter")][0]
        home = os.path.join(self.env.dir, "home dir")
        bid = "io.github.x-o-r-r-o.stocks"
        data = os.path.join(home, "Library/Application Support/Alfred/Workflow Data", bid)
        cache = os.path.join(home, "Library/Caches/com.runningwithcrayons.Alfred/Workflow Data", bid)
        wf = os.path.join(home, "Alfred.alfredpreferences/workflows/user.workflow.A B")
        shutil.copytree(SRC, wf)
        env = dict(HOME=home, USER=os.environ.get("USER", ""), TMPDIR=os.environ.get("TMPDIR", "/tmp"), PATH="/usr/bin:/bin:/usr/sbin:/sbin",
                   alfred_workflow_data=data, alfred_workflow_cache=cache, alfred_preferences=os.path.dirname(os.path.dirname(wf)),
                   alfred_version="5.6", alfred_version_build="2300", alfred_theme_subtext="3", alfred_workflow_bundleid=bid,
                   alfred_workflow_name="Stocks", alfred_workflow_uid="user.workflow.A B", alfred_workflow_version="1.0.0", alfred_debug="1",
                   keyword_stock="stock", provider="yahoo", open_in="yahoo", number_locale="", sparklines="1",
                   STOCKS_YAHOO_URL=BASE, STOCKS_TEST_NOW=str(NOW), STOCKS_SYNC="1")
        for q in (None, "apple", "Société Générale", ":"):
            out = subprocess.run(["/bin/bash", "-c", script, "bash"] + ([q] if q else []), cwd=wf, env=env,
                                 capture_output=True, text=True, timeout=60)
            self.assertEqual(out.returncode, 0, out.stderr)
            data_ = json.loads(out.stdout)
            validate(data_)
            self.assertNotEqual(data_["items"][0]["title"], "Something went wrong", data_)
        self.assertTrue(os.path.exists(os.path.join(cache, "quotes.json")))
        self.assertTrue(any(f.startswith("AAPL-") for f in os.listdir(os.path.join(cache, "spark"))))

    def post_market_chart(self, pre=False):
        body = json.loads(fixture("yahoo/chart_AAPL")[1])
        r = body["chart"]["result"][0]
        q = r["indicators"]["quote"][0]
        if pre:  # before the open: only pre-market trades so far
            r["timestamp"] = [1790324000, 1790326000, 1790329000]
            for k in q:
                q[k] = [341.5, 341.8, 342.0]
        else:  # after the close: the series goes on into the post-market session
            r["timestamp"] = r["timestamp"][:-1] + [1790366700, 1790370000, 1790380500]
            for k in q:
                q[k] = q[k][:-1] + [341.2, 341.3, 341.46]
        Mock.overrides["yahoo/chart_AAPL"] = (200, json.dumps(body).encode())

    def test_extended_hours_price(self):
        self.env.items("AAPL")
        self.assertTrue(any("includePrePost=true" in p for p, _ in Mock.requests if "/chart/" in p))
        self.assertNotIn("after hours", self.env.items("AAPL")[0]["subtitle"].lower())  # plain fixture: no extended trades
        self.post_market_chart()
        env = Env()
        it = env.items("AAPL")[0]  # Saturday: closed, Friday's after-hours price still the latest
        self.assertEqual(it["title"], "AAPL   341.07 USD   ▲ +5.15 (+1.53%)")
        self.assertTrue(it["subtitle"].endswith("Closed · after hours 341.46 (+0.11%)"), it["subtitle"])
        self.assertIn("After hours 341.46 (+0.11%)", it["text"]["largetype"])
        self.assertEqual(it["mods"]["shift"]["arg"], "AAPL 341.07 USD ▲ +5.15 (+1.53%) · after hours 341.46 (+0.11%)")
        env = Env()
        it = env.items("AAPL", STOCKS_TEST_NOW=AAPL_POST)[0]
        self.assertTrue(it["subtitle"].endswith("After hours 341.46 (+0.11%)"), it["subtitle"])
        env = Env()
        self.assertTrue(env.items("AAPL", STOCKS_TEST_NOW=AAPL_REGULAR)[0]["subtitle"].endswith("Market open"))
        # the day range and sparkline stay on regular hours
        self.assertIn("Day 334.53 – 341.67", it["subtitle"])
        self.post_market_chart(pre=True)
        env = Env()
        it = env.items("AAPL", STOCKS_TEST_NOW=AAPL_PRE)[0]
        self.assertTrue(it["subtitle"].endswith("Pre-market 342.00 (+0.27%)"), it["subtitle"])

    def test_cached_quote_from_v1_0_0(self):
        # v1.0.0 cache entries have no extended-hours field
        self.env.items("AAPL")
        qs = self.env.quotes()
        self.assertNotIn("ext", {k for v in qs.values() for k in v if v.get("ext")})
        qs["AAPL"].pop("ext", None)
        with open(os.path.join(self.env.cache, "quotes.json"), "w") as f:
            json.dump(qs, f)
        self.assertTrue(self.env.items("AAPL")[0]["title"].startswith("AAPL   341.07"))
        qs["AAPL"]["ext"] = "garbage"
        with open(os.path.join(self.env.cache, "quotes.json"), "w") as f:
            json.dump(qs, f)
        self.assertTrue(self.env.items("AAPL")[0]["subtitle"].endswith("Closed"))

    def test_crypto_has_no_extended_hours(self):
        self.assertNotIn("after hours", self.env.items("BTC-USD")[0]["subtitle"].lower())

    def test_shift_copies_a_summary(self):
        it = self.env.items("tesla")[0]
        self.assertEqual(it["mods"]["shift"]["arg"], "TSLA 372.11 USD ▼ -5.83 (-1.54%)")
        self.assertIs(it["mods"]["shift"]["valid"], True)
        fut = find(self.env.items("apple"), "SAAPL=F")
        self.assertEqual(fut["mods"]["shift"]["arg"], "SAAPL=F")
        for row in self.env.items(":"):
            if "mods" in row:
                self.assertIs(row["mods"]["shift"]["valid"], False)
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            plist = plistlib.load(f)
        uid = {o["uid"]: o["type"] for o in plist["objects"]}
        sf = [o["uid"] for o in plist["objects"] if o["type"].endswith("scriptfilter")][0]
        mods = {c["modifiers"] for c in plist["connections"][sf] if uid[c["destinationuid"]].endswith("clipboard")}
        self.assertEqual(mods, {1048576, 131072})  # ⌘ and ⇧

    def test_silent_actions_print_nothing(self):
        # the Notification object ("only show if populated") would pop up empty after ↩ on a quote
        for action, arg in (("open", "https://finance.yahoo.com/quote/AAPL/"), ("config", "config"), ("nosuchaction", "x"), ("open", "javascript:alert(1)")):
            out = subprocess.run(["osascript", "-l", "JavaScript", "./stocks.js", "act", arg], cwd=SRC,
                                 env=self.env.vars(stocks_action=action, STOCKS_TEST_NOOPEN="silent"), capture_output=True, text=True, timeout=30)
            self.assertEqual(out.stdout, "", (action, out.stdout))
        self.assertEqual(self.env.act("toggle", "MSFT"), "Added MSFT to the watchlist")

    def test_killed_runs_leave_no_damage(self):
        # queuemode 2: Alfred terminates the previous run on every keystroke, at any point
        import signal
        self.env.set_key("finnhub")
        cmd = ["osascript", "-l", "JavaScript", "./stocks.js", "filter"]
        for i, delay in enumerate((0.05, 0.15, 0.3, 0.5, 0.8, 1.2, 2.0)):
            Mock.fault = "slow" if i % 2 else None
            prov = "finnhub" if i % 3 == 0 else "yahoo"
            proc = subprocess.Popen(cmd + [["apple", "", "tesla", "AAPL"][i % 4]], cwd=SRC, env=self.env.vars(provider=prov),
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(delay)
            proc.send_signal(signal.SIGKILL)
            proc.wait()
        Mock.fault = None
        for d in (self.env.cache, self.env.data):
            for root, _, files in os.walk(d):
                for f in files:
                    if f.endswith(".json"):
                        json.loads(read(os.path.join(root, f)))  # never partial
        # a lock left by a killed process doesn't hold up the next run
        dead = subprocess.Popen(["/usr/bin/true"])
        dead.wait()
        lock = os.path.join(self.env.cache, "requests.lock")
        os.makedirs(lock, exist_ok=True)
        with open(os.path.join(lock, "pid"), "w") as f:
            f.write(str(dead.pid))
        t = time.time()
        it = self.env.items("AAPL", provider="finnhub")
        self.assertLess(time.time() - t, 2.5)
        self.assertTrue(it[0]["title"].startswith("AAPL"), it[0])
        self.assertFalse(os.path.exists(lock))
        self.assertTrue(self.env.items("tesla")[0]["title"].startswith("TSLA"))

    def test_star_marks_watchlist_items_in_search_only(self):
        self.assertTrue(self.env.items("apple")[0]["subtitle"].startswith("★ "))
        self.assertFalse(find(self.env.items("apple"), "APLE")["subtitle"].startswith("★"))
        self.assertFalse(any(i["subtitle"].startswith("★") for i in self.env.items("")))


@unittest.skipUnless(os.environ.get("STOCKS_KEYCHAIN") == "1", "set STOCKS_KEYCHAIN=1 to test the real Keychain (a throwaway item)")
class KeychainTests(unittest.TestCase):
    def test_real_keychain_round_trip(self):
        env = Env()
        svc = f"io.github.x-o-r-r-o.stocks.test-{os.getpid()}"
        v = env.vars(provider="finnhub", alfred_workflow_bundleid=svc, STOCKS_FINNHUB_URL="http://127.0.0.1:9")
        v.pop("STOCKS_TEST_KEYCHAIN")
        act = lambda action, key="": subprocess.run(["osascript", "-l", "JavaScript", "./stocks.js", "act", action], cwd=SRC,
                                                   env=dict(v, stocks_action=action, stocks_key=key), capture_output=True, text=True).stdout.strip()
        try:
            self.assertEqual(act("savekey", "throwaway-key-111111"), "API key saved")
            self.assertEqual(act("savekey", "throwaway-key-222222"), "API key saved")  # update in place
            out = subprocess.run(["osascript", "-l", "JavaScript", "./stocks.js", "filter", "apikey"], cwd=SRC, env=v, capture_output=True, text=True).stdout
            self.assertIn("Remove the saved API key", out)
            self.assertEqual(act("delkey"), "API key removed")
            self.assertEqual(act("delkey"), "Couldn’t remove the API key: none is saved")
        finally:
            subprocess.run(["security", "delete-generic-password", "-s", svc, "-a", "finnhub"], capture_output=True)
            shutil.rmtree(env.dir, ignore_errors=True)


class PlistTests(unittest.TestCase):
    def test_build_and_plist(self):
        subprocess.run([sys.executable, "tools/build.py"], cwd=ROOT, check=True, capture_output=True)
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            p = plistlib.load(f)
        uids = [o["uid"] for o in p["objects"]]
        self.assertEqual(len(uids), len(set(uids)))
        for src, conns in p["connections"].items():
            self.assertIn(src, uids)
            for c in conns:
                self.assertIn(c["destinationuid"], uids)
        for o in p["objects"]:
            kw = o["config"].get("keyword")
            if kw:
                self.assertRegex(kw, r"^\{var:keyword_\w+\}$")
        self.assertTrue(p["readme"].startswith("## Usage"))
        self.assertIn("not financial advice", p["readme"])
        self.assertEqual(p["bundleid"], "io.github.x-o-r-r-o.stocks")
        out = subprocess.run(["sips", "-g", "pixelWidth", os.path.join(SRC, "icon.png")], capture_output=True, text=True).stdout
        self.assertGreaterEqual(int(out.split()[-1]), 256)

    def test_no_runtime_dependencies(self):
        for f in os.listdir(SRC):
            self.assertFalse(f.endswith((".py", ".rb", ".node")), f)
        js = read(os.path.join(SRC, "stocks.js"))
        for tool in re.findall(r'"(/usr/bin/[\w-]+|/bin/\w+)"', js):
            self.assertTrue(os.path.exists(tool), tool)


@unittest.skipUnless(os.environ.get("STOCKS_LIVE") == "1", "set STOCKS_LIVE=1 to hit the real Yahoo Finance API")
class LiveTests(unittest.TestCase):
    def test_live_yahoo(self):
        env = Env()
        v = env.vars()
        for k in ("STOCKS_YAHOO_URL", "STOCKS_TEST_NOW"):
            v.pop(k)
        out = subprocess.run(["osascript", "-l", "JavaScript", "./stocks.js", "filter", "AAPL"], cwd=SRC, env=v,
                             capture_output=True, text=True, timeout=60)
        items = json.loads(out.stdout)["items"]
        self.assertTrue(items[0]["title"].startswith("AAPL   "), items[0])
        self.assertRegex(items[0]["title"], r"[▲▼•] [+-]?[\d.,]+ \([+-]?[\d.,]+%\)")
        out = subprocess.run(["osascript", "-l", "JavaScript", "./stocks.js", "filter", "bitcoin"], cwd=SRC, env=v,
                             capture_output=True, text=True, timeout=60)
        self.assertIn("BTC-USD", out.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=1)
