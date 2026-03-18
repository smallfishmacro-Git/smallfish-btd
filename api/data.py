"""
Vercel serverless function: Buy The Dip indicator engine.
Fetches CSV data from the market-dashboard GitHub repo,
computes all 9 indicators + composite, returns JSON.
Caches at CDN for 24 hours.
"""
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json
import os
import traceback
import io
import csv
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.request
import ssl
import math

# ── GitHub raw URLs ──────────────────────────────────────────────────────────
GITHUB_BASE = "https://raw.githubusercontent.com/smallfishmacro-Git/market-dashboard/main"
BARCHART = f"{GITHUB_BASE}/data/barchart"
DATASETS = f"{GITHUB_BASE}/data/datasets"

CSV_FILES = {
    "spx":    f"{BARCHART}/S%26P_500_Index_%24SPX.csv",
    "r3fd":   f"{BARCHART}/Russell_3000_Stocks_Above_5-Day_Average_%24R3FD.csv",
    "nshu":   f"{BARCHART}/NYSE_Advancing_Stocks_%24NSHU.csv",
    "nshd":   f"{BARCHART}/NYSE_Declining_Stocks_%24NSHD.csv",
    "nvlu":   f"{BARCHART}/NYSE_Advancing_Volume_%24NVLU.csv",
    "dvcn":   f"{BARCHART}/NYSE_Declining_Volume_%24DVCN.csv",
    "cpcs":   f"{BARCHART}/Equity_PutCall_Ratio_%24CPCS.csv",
    "vix":    f"{BARCHART}/CBOE_Volatility_Index_%24VIX.csv",
    "vxv":    f"{BARCHART}/CBOE_3-Month_VIX_%24VXV.csv",
    "mahp":   f"{BARCHART}/S%26P_500_52-Week_Highs_%24MAHP.csv",
    "fg":     f"{DATASETS}/cnn_fear_greed.csv",
    "acwi":   f"{DATASETS}/acwi_oscillator.csv",
}


# ── CSV fetch + parse ────────────────────────────────────────────────────────
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def fetch_csv(key):
    """Fetch and parse a CSV from GitHub. Returns (key, {dates:[], values:[]})."""
    url = CSV_FILES[key]
    req = urllib.request.Request(url, headers={"User-Agent": "SmallFish/1.0"})
    with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
        text = resp.read().decode("utf-8")

    reader = csv.DictReader(io.StringIO(text))
    dates, values = [], []
    for row in reader:
        date_str = row.get("Time") or row.get("Date") or ""
        date_str = date_str.strip()[:10]
        if not date_str or date_str < "1990-01-01":
            continue
        val_str = (row.get("Last") or row.get("Fear_Greed") or
                   row.get("Percentage") or "")
        val_str = str(val_str).replace(",", "").strip()
        try:
            val = float(val_str)
        except (ValueError, TypeError):
            continue
        dates.append(date_str)
        values.append(val)
    return key, dates, values


def fetch_all_csvs():
    """Fetch all CSVs in parallel from GitHub."""
    data = {}
    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = {executor.submit(fetch_csv, k): k for k in CSV_FILES}
        for future in as_completed(futures):
            try:
                key, dates, values = future.result()
                data[key] = {"dates": dates, "values": values}
            except Exception as e:
                data[futures[future]] = {"dates": [], "values": [], "error": str(e)}
    return data


# ── Math helpers ─────────────────────────────────────────────────────────────
def ewma(values, span):
    """Exponential weighted moving average."""
    alpha = 2.0 / (span + 1)
    result = [values[0]] if values else []
    for i in range(1, len(values)):
        result.append(alpha * values[i] + (1 - alpha) * result[i - 1])
    return result


def rolling_mean(values, window):
    result = [None] * len(values)
    for i in range(window - 1, len(values)):
        result[i] = sum(values[i - window + 1:i + 1]) / window
    return result


def rolling_std(values, window):
    result = [None] * len(values)
    for i in range(window - 1, len(values)):
        subset = values[i - window + 1:i + 1]
        m = sum(subset) / window
        var = sum((x - m) ** 2 for x in subset) / window
        result[i] = math.sqrt(var) if var > 0 else 0.0001
    return result


def rolling_sum(values, window):
    result = [None] * len(values)
    for i in range(window - 1, len(values)):
        result[i] = sum(v for v in values[i - window + 1:i + 1] if v is not None)
    return result


def align_series(dates_a, values_a, dates_b, values_b):
    """Align two series to common dates using forward-fill."""
    map_a = dict(zip(dates_a, values_a))
    map_b = dict(zip(dates_b, values_b))
    all_dates = sorted(set(dates_a) | set(dates_b))
    d, va, vb = [], [], []
    last_a, last_b = None, None
    for dt in all_dates:
        a = map_a.get(dt, last_a)
        b = map_b.get(dt, last_b)
        if a is not None:
            last_a = a
        if b is not None:
            last_b = b
        if last_a is not None and last_b is not None:
            d.append(dt)
            va.append(last_a)
            vb.append(last_b)
    return d, va, vb


def find_signals(dates, values, condition_fn):
    """Find dates where condition is met with 5-day cooldown."""
    signals = []
    last_signal = None
    for i in range(1, len(values)):
        if values[i] is None:
            continue
        if condition_fn(values, i):
            if last_signal is None or (i - last_signal) > 5:
                signals.append(dates[i])
                last_signal = i
    return signals


# ── Indicator computations ───────────────────────────────────────────────────
def compute_indicators(raw):
    """Compute all 9 BTD indicators from raw CSV data."""
    indicators = {}

    # SPX (used as backdrop for all charts)
    spx_d, spx_v = raw["spx"]["dates"], raw["spx"]["values"]

    # 1. % Russell 3000 Above 5-Day MA
    r3fd = raw["r3fd"]
    d, spx_a, r3fd_v = align_series(spx_d, spx_v, r3fd["dates"], r3fd["values"])
    signals = [d[i] for i in range(len(r3fd_v)) if r3fd_v[i] < 10]
    indicators["r3fd"] = {
        "name": "% Russell 3000 Above 5-Day MA",
        "dates": d, "spx": spx_a, "values": r3fd_v,
        "signals": signals, "threshold": 10, "thresholdDir": "below",
    }

    # 2. ACWI Oscillator
    acwi = raw["acwi"]
    d, spx_a, acwi_v = align_series(spx_d, spx_v, acwi["dates"], acwi["values"])
    signals = [d[i] for i in range(len(acwi_v)) if acwi_v[i] == 0]
    indicators["acwi"] = {
        "name": "ACWI ETF Oscillator (% Above 10DMA)",
        "dates": d, "spx": spx_a, "values": acwi_v,
        "signals": signals, "threshold": 0, "thresholdDir": "at",
    }

    # 3. McClellan Oscillator
    nshu = raw["nshu"]
    nshd = raw["nshd"]
    d_raw, adv_v, dec_v = align_series(nshu["dates"], nshu["values"],
                                        nshd["dates"], nshd["values"])
    rana = [(adv_v[i] - dec_v[i]) / max(adv_v[i] + dec_v[i], 1) * 1000
            for i in range(len(adv_v))]
    rana = [max(-1000, min(1000, v)) for v in rana]
    ema19 = ewma(rana, 19)
    ema39 = ewma(rana, 39)
    mco = [ema19[i] - ema39[i] for i in range(len(rana))]
    mco = [max(-500, min(500, v)) for v in mco]
    d, spx_a, mco_a = align_series(spx_d, spx_v, d_raw, mco)
    signals = [d[i] for i in range(1, len(mco_a))
               if mco_a[i] < -80 and mco_a[i - 1] >= -80]
    indicators["mcclellan"] = {
        "name": "McClellan Oscillator",
        "dates": d, "spx": spx_a, "values": mco_a,
        "signals": signals, "threshold": -80, "thresholdDir": "crossBelow",
    }

    # 4. Equity Put/Call Ratio Z-Score
    cpcs = raw["cpcs"]
    pc_d, pc_v = cpcs["dates"], cpcs["values"]
    sma5 = rolling_mean(pc_v, 5)
    rm52 = rolling_mean([x for x in sma5 if x is not None], 52)
    rs52 = rolling_std([x for x in sma5 if x is not None], 52)
    # Compute z-score only where we have enough data
    offset = sum(1 for x in sma5 if x is None)
    zscore_raw = [None] * len(pc_v)
    for i in range(len(pc_v)):
        s5 = sma5[i]
        idx = i - offset
        if s5 is not None and 0 <= idx < len(rm52) and rm52[idx] is not None and rs52[idx] is not None and rs52[idx] > 0:
            zscore_raw[i] = (rm52[idx] - s5) / rs52[idx]
    pc_dates_clean = [pc_d[i] for i in range(len(pc_d)) if zscore_raw[i] is not None]
    zscore_clean = [zscore_raw[i] for i in range(len(pc_d)) if zscore_raw[i] is not None]
    d, spx_a, zs_a = align_series(spx_d, spx_v, pc_dates_clean, zscore_clean)
    signals = [d[i] for i in range(len(zs_a)) if zs_a[i] is not None and zs_a[i] < -2.5]
    indicators["putcall"] = {
        "name": "Equity Put/Call Z-Score",
        "dates": d, "spx": spx_a, "values": zs_a,
        "signals": signals, "threshold": -2.5, "thresholdDir": "below",
    }

    # 5. CNN Fear & Greed
    fg = raw["fg"]
    d, spx_a, fg_v = align_series(spx_d, spx_v, fg["dates"], fg["values"])
    signals = [d[i] for i in range(len(fg_v)) if fg_v[i] < 25]
    indicators["feargreed"] = {
        "name": "CNN Fear & Greed Index",
        "dates": d, "spx": spx_a, "values": fg_v,
        "signals": signals, "threshold": 25, "thresholdDir": "below",
    }

    # 6. Lowry Panic Indicator
    nvlu = raw["nvlu"]
    dvcn = raw["dvcn"]
    d_adv_s, adv_s_v, dec_s_v = align_series(nshu["dates"], nshu["values"],
                                               nshd["dates"], nshd["values"])
    d_adv_v, adv_v_v, dec_v_v = align_series(nvlu["dates"], nvlu["values"],
                                               dvcn["dates"], dvcn["values"])
    d_all, ts_v, tv_v = align_series(d_adv_s, adv_s_v, d_adv_v, adv_v_v)
    # Re-align dec values
    dec_s_map = dict(zip(d_adv_s, dec_s_v))
    dec_v_map = dict(zip(d_adv_v, dec_v_v))
    scores = []
    for i, dt in enumerate(d_all):
        total_s = ts_v[i] + (dec_s_map.get(dt, 0) or 0)
        total_v = tv_v[i] + (dec_v_map.get(dt, 0) or 0)
        ds = dec_s_map.get(dt, 0) or 0
        dv = dec_v_map.get(dt, 0) or 0
        dec_pct_s = (ds / total_s * 100) if total_s > 0 else 0
        dec_pct_v = (dv / total_v * 100) if total_v > 0 else 0
        score = (int(dec_pct_s >= 90) + int(80 <= dec_pct_s < 90) +
                 int(dec_pct_v >= 90) + int(80 <= dec_pct_v < 90))
        scores.append(score)
    roll6 = rolling_sum(scores, 6)
    lowry_d = [d_all[i] for i in range(len(roll6)) if roll6[i] is not None]
    lowry_v = [roll6[i] for i in range(len(roll6)) if roll6[i] is not None]
    d, spx_a, lowry_a = align_series(spx_d, spx_v, lowry_d, lowry_v)
    signals = [d[i] for i in range(1, len(lowry_a))
               if lowry_a[i] >= 4 and lowry_a[i - 1] < 4]
    indicators["lowry"] = {
        "name": "Lowry Panic Indicator",
        "dates": d, "spx": spx_a, "values": lowry_a,
        "signals": signals, "threshold": 4, "thresholdDir": "crossAbove",
    }

    # 7. Zweig Breadth
    d_zw, adv_zw, dec_zw = align_series(nshu["dates"], nshu["values"],
                                          nshd["dates"], nshd["values"])
    ratio = [adv_zw[i] / max(adv_zw[i] + dec_zw[i], 1) for i in range(len(adv_zw))]
    ratio = [max(0, min(1, v)) for v in ratio]
    zweig = ewma(ratio, 10)
    zweig = [max(0, min(1, v)) for v in zweig]
    d, spx_a, zw_a = align_series(spx_d, spx_v, d_zw, zweig)
    signals = [d[i] for i in range(1, len(zw_a))
               if zw_a[i] <= 0.35 and zw_a[i - 1] > 0.35]
    indicators["zweig"] = {
        "name": "Zweig Breadth Indicator",
        "dates": d, "spx": spx_a, "values": zw_a,
        "signals": signals, "threshold": 0.35, "thresholdDir": "crossBelow",
    }

    # 8. Volatility Curve (VXV/VIX - 1)
    d_vc, vxv_v, vix_v = align_series(raw["vxv"]["dates"], raw["vxv"]["values"],
                                        raw["vix"]["dates"], raw["vix"]["values"])
    vc = [(vxv_v[i] / vix_v[i] - 1) if vix_v[i] > 0 else 0 for i in range(len(vxv_v))]
    d, spx_a, vc_a = align_series(spx_d, spx_v, d_vc, vc)
    signals = [d[i] for i in range(1, len(vc_a))
               if vc_a[i] >= 0 and vc_a[i - 1] < 0]
    indicators["volcurve"] = {
        "name": "Volatility Curve (VXV/VIX)",
        "dates": d, "spx": spx_a, "values": vc_a,
        "signals": signals, "threshold": 0, "thresholdDir": "crossAbove",
    }

    # 9. S&P 500 52-Week New Highs
    mahp = raw["mahp"]
    d, spx_a, highs_v = align_series(spx_d, spx_v, mahp["dates"], mahp["values"])
    signals = [d[i] for i in range(len(highs_v)) if highs_v[i] < 1]
    indicators["highs52w"] = {
        "name": "S&P 500 52-Week New Highs",
        "dates": d, "spx": spx_a, "values": highs_v,
        "signals": signals, "threshold": 1, "thresholdDir": "below",
    }

    return indicators


def compute_composite(indicators):
    """Compute the composite signal from all 9 indicators."""
    # Collect all signal dates from all indicators into a unified set
    all_signal_sets = {}
    for key, ind in indicators.items():
        all_signal_sets[key] = set(ind["signals"])

    # Use SPX dates as the master timeline
    spx_dates = indicators["r3fd"]["dates"]  # Any indicator has aligned SPX dates
    spx_values = indicators["r3fd"]["spx"]

    # For each date, count how many indicators are in "signal" state
    # We use a simplified approach: signal is active for 10 days after trigger
    composite_dates = []
    composite_scores = []
    for i, dt in enumerate(spx_dates):
        if dt < "2000-01-01":
            continue
        score = 0
        for key in all_signal_sets:
            # Check if any signal fired within the last 10 calendar days
            for sig_dt in all_signal_sets[key]:
                if sig_dt <= dt and sig_dt >= _sub_days(dt, 10):
                    score += 1
                    break
        composite_dates.append(dt)
        composite_scores.append(score)

    # 2-day moving average
    ma2 = rolling_mean(composite_scores, 2)

    # Trigger: score > 2 and score > ma2
    triggers = []
    for i in range(len(composite_scores)):
        if (composite_scores[i] > 2 and ma2[i] is not None
                and composite_scores[i] > ma2[i]):
            triggers.append(composite_dates[i])

    # SPX values for composite dates
    spx_map = dict(zip(spx_dates, spx_values))
    comp_spx = [spx_map.get(d, None) for d in composite_dates]

    return {
        "dates": composite_dates,
        "scores": composite_scores,
        "ma2": [x if x is not None else 0 for x in ma2],
        "triggers": triggers,
        "spx": comp_spx,
    }


def _sub_days(date_str, days):
    """Subtract days from a YYYY-MM-DD string."""
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    return (dt - timedelta(days=days)).strftime("%Y-%m-%d")


def compute_metrics(composite, indicators):
    """Compute summary metrics."""
    latest_score = composite["scores"][-1] if composite["scores"] else 0

    # Last signal date (any indicator active)
    last_signal = None
    for ind in indicators.values():
        if ind["signals"]:
            s = ind["signals"][-1]
            if last_signal is None or s > last_signal:
                last_signal = s

    last_trigger = composite["triggers"][-1] if composite["triggers"] else None

    return {
        "btdScore": latest_score,
        "lastSignalDate": last_signal,
        "lastTriggerDate": last_trigger,
    }


# ── Downsample for JSON size ─────────────────────────────────────────────────
def downsample(dates, values_dict, max_points=8000):
    """Downsample aligned series to keep JSON response manageable."""
    n = len(dates)
    if n <= max_points:
        return dates, values_dict
    step = max(1, n // max_points)
    idx = list(range(0, n, step))
    if idx[-1] != n - 1:
        idx.append(n - 1)
    new_dates = [dates[i] for i in idx]
    new_vals = {}
    for k, v in values_dict.items():
        new_vals[k] = [v[i] if i < len(v) else None for i in idx]
    return new_dates, new_vals


# ── Handler ──────────────────────────────────────────────────────────────────
class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            force = params.get("force", ["false"])[0].lower() == "true"

            # Fetch all CSVs
            raw = fetch_all_csvs()

            # Check for errors
            errors = {k: v.get("error") for k, v in raw.items() if v.get("error")}
            if len(errors) > 3:
                raise ValueError(f"Too many CSV fetch errors: {errors}")

            # Compute indicators
            indicators = compute_indicators(raw)

            # Downsample each indicator for JSON size
            for key in indicators:
                ind = indicators[key]
                ind["dates"], sampled = downsample(
                    ind["dates"],
                    {"spx": ind["spx"], "values": ind["values"]},
                    max_points=8000
                )
                ind["spx"] = sampled["spx"]
                ind["values"] = sampled["values"]

            # Composite
            composite = compute_composite(indicators)

            # Metrics
            metrics = compute_metrics(composite, indicators)

            # Downsample composite
            composite["dates"], comp_sampled = downsample(
                composite["dates"],
                {"scores": composite["scores"], "ma2": composite["ma2"],
                 "spx": composite["spx"]},
                max_points=8000
            )
            composite["scores"] = comp_sampled["scores"]
            composite["ma2"] = comp_sampled["ma2"]
            composite["spx"] = comp_sampled["spx"]

            response = {
                "indicators": indicators,
                "composite": composite,
                "metrics": metrics,
                "errors": errors if errors else None,
                "fetchedAt": datetime.utcnow().isoformat() + "Z",
            }

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            if force:
                self.send_header("Cache-Control", "no-cache")
            else:
                self.send_header("Cache-Control", "s-maxage=86400, stale-while-revalidate=3600")
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({
                "error": str(e), "trace": traceback.format_exc()
            }).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
