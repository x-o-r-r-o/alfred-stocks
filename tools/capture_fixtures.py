#!/usr/bin/env python3
"""Capture test fixtures from the real endpoints (developer machine only, run once).

  python3 tools/capture_fixtures.py

Writes tests/fixtures/<provider>/<name>[.<status>].json. The keyed providers are
captured with their public "demo" keys where one exists (Alpha Vantage: IBM and
"tesco"; Twelve Data: AAPL); anything else is hand-written from the provider docs.
"""
import os, subprocess, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, "tests", "fixtures")
UA = "Mozilla/5.0"  # Yahoo answers 429 to full browser user agents without cookies


def safe(s):
    return urllib.parse.quote(s, safe="").replace("%", "_")


def get(url):
    # curl uses the system trust store (python.org builds may lack certificates)
    out = subprocess.run(["curl", "-sS", "-m", "15", "-A", UA, "-w", "\n%{http_code}", url],
                         capture_output=True, check=True).stdout
    body, _, status = out.rpartition(b"\n")
    return int(status), body


def save(provider, name, url):
    status, body = get(url)
    d = os.path.join(FIX, provider)
    os.makedirs(d, exist_ok=True)
    fn = f"{name}.json" if status == 200 else f"{name}.{status}.json"
    with open(os.path.join(d, fn), "wb") as f:
        f.write(body)
    print(status, provider, fn, len(body))


Y = "https://query1.finance.yahoo.com"
for q in ["apple", "btc", "eurusd", "nestlé", "société générale", "societe generale", "zzzzqqqxx", "tesla"]:
    save("yahoo", "search_" + safe(q.lower()),
         f"{Y}/v1/finance/search?q={urllib.parse.quote(q)}&quotesCount=8&newsCount=0&listsCount=0")
for s in ["AAPL", "^GSPC", "^IXIC", "BTC-USD", "EURUSD=X", "SHIB-USD", "BRK-A", "7203.T", "NESN.SW",
          "TSLA", "APLE", "AAPL.TO", "TWTR"]:
    save("yahoo", "chart_" + safe(s), f"{Y}/v8/finance/chart/{urllib.parse.quote(s, safe='')}?range=1d&interval=5m")

AV = "https://www.alphavantage.co/query"
save("alphavantage", "quote_IBM", f"{AV}?function=GLOBAL_QUOTE&symbol=IBM&apikey=demo")
save("alphavantage", "search_tesco", f"{AV}?function=SYMBOL_SEARCH&keywords=tesco&apikey=demo")
save("alphavantage", "demo_information", f"{AV}?function=GLOBAL_QUOTE&symbol=AAPL&apikey=demo")

TD = "https://api.twelvedata.com"
save("twelvedata", "quote_AAPL", f"{TD}/quote?symbol=AAPL&apikey=demo")
save("twelvedata", "search_aapl", f"{TD}/symbol_search?symbol=AAPL&outputsize=8")
save("twelvedata", "nokey", f"{TD}/quote?symbol=AAPL")

FH = "https://finnhub.io/api/v1"
save("finnhub", "nokey", f"{FH}/quote?symbol=AAPL")
save("finnhub", "badkey", f"{FH}/quote?symbol=AAPL&token=bogus")
