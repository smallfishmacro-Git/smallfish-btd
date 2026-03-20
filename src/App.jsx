import { useState, useEffect, useMemo, useCallback, useRef } from "react";

// ═══════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════
const API = "/api/data";
async function fetchData(force = false) {
  const url = force ? `${API}?force=true` : API;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// ═══════════════════════════════════════════════════════════════
// Theme — unified terminal design (matches Cross-Asset Regimes)
// ═══════════════════════════════════════════════════════════════
const T = {
  bg: "#0a0a0c",
  bgPanel: "#0e0e12",
  bgCard: "#111116",
  border: "#1c1c24",
  borderBright: "#2a2a35",
  text: "#8a8f9a",
  dim: "#4a4e58",
  bright: "#e8eaef",
  white: "#ffffff",
  cyan: "#00d4ff",
  orange: "#ff9f43",
  green: "#00ff88",
  red: "#ff4757",
  amber: "#ffbe0b",
  purple: "#a855f7",
  greenDim: "rgba(0,255,136,0.15)",
  amberDim: "rgba(255,190,11,0.12)",
  font: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
};

// ═══════════════════════════════════════════════════════════════
// Timeframe
// ═══════════════════════════════════════════════════════════════
const TF_LIST = ["1M", "3M", "6M", "YTD", "1Y", "2Y", "5Y", "ALL"];

function tfCutoff(tf) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  switch (tf) {
    case "1M": return new Date(y, m - 1, d);
    case "3M": return new Date(y, m - 3, d);
    case "6M": return new Date(y, m - 6, d);
    case "YTD": return new Date(y, 0, 1);
    case "1Y": return new Date(y - 1, m, d);
    case "2Y": return new Date(y - 2, m, d);
    case "5Y": return new Date(y - 5, m, d);
    default: return null;
  }
}

function sliceByTf(dates, arrays, tf) {
  const cutoff = tfCutoff(tf);
  if (!cutoff) return { dates, arrays };
  const cutStr = cutoff.toISOString().split("T")[0];
  const si = dates.findIndex((d) => d >= cutStr);
  if (si < 0) return { dates, arrays };
  return { dates: dates.slice(si), arrays: arrays.map((a) => a.slice(si)) };
}

// ═══════════════════════════════════════════════════════════════
// TimeframeBar — compact button strip (matches Cross-Asset)
// ═══════════════════════════════════════════════════════════════
function TimeframeBar({ value, onChange, count, style: outerStyle }) {
  return (
    <div style={{ display: "flex", gap: 0, alignItems: "center", ...outerStyle }}>
      {count != null && (
        <span style={{ color: T.dim, fontSize: 9, marginRight: 8, fontFamily: T.font, letterSpacing: 0.5 }}>
          {count.toLocaleString()}D
        </span>
      )}
      <span style={{ color: T.dim, fontSize: 9, fontFamily: T.font, letterSpacing: 0.5, marginRight: 6 }}>RANGE:</span>
      {TF_LIST.map((t) => {
        const isActive = value === t;
        return (
          <button key={t} onClick={() => onChange(t)} style={{
            padding: "3px 8px", fontSize: 9, fontWeight: isActive ? 700 : 400,
            fontFamily: T.font, cursor: "pointer", letterSpacing: 0.3, borderRadius: 0,
            background: isActive ? T.orange : "transparent",
            color: isActive ? "#000" : T.dim,
            border: `1px solid ${isActive ? T.orange : T.border}`,
            marginLeft: -1,
          }}>{t}</button>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TerminalChart — dual-panel SVG (SPX top, indicator bottom)
// ═══════════════════════════════════════════════════════════════
function TerminalChart({
  dates, topValues, bottomValues, topLabel, bottomLabel,
  signals = [], threshold,
  topColor = T.bright, bottomColor = T.cyan, height = 340,
}) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const [W, setW] = useState(700);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => { const w = e[0].contentRect.width; if (w > 0) setW(w); });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const n = dates.length;
  if (n < 2) return <div style={{ color: T.dim, padding: 16, fontSize: 10 }}>NO DATA</div>;

  const pad = { l: 48, r: 8, t: 4, mid: 16, b: 16 };
  const topH = Math.floor((height - pad.t - pad.mid - pad.b) * 0.55);
  const botH = Math.floor((height - pad.t - pad.mid - pad.b) * 0.45);
  const xScale = (i) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r);

  const minMax = (arr) => {
    const v = arr.filter((x) => x != null && isFinite(x));
    if (!v.length) return [0, 1];
    const mn = Math.min(...v), mx = Math.max(...v);
    const m = (mx - mn) * 0.04 || 1;
    return [mn - m, mx + m];
  };
  const [tMin, tMax] = minMax(topValues);
  const [bMin, bMax] = minMax(bottomValues);
  const yTop = (v) => v == null ? null : pad.t + topH - ((v - tMin) / (tMax - tMin)) * topH;
  const yBot = (v) => v == null ? null : pad.t + topH + pad.mid + botH - ((v - bMin) / (bMax - bMin)) * botH;

  const buildPath = (vals, yFn) => {
    let p = "";
    for (let i = 0; i < n; i++) { const y = yFn(vals[i]); if (y == null) continue; p += (p ? "L" : "M") + `${xScale(i).toFixed(1)},${y.toFixed(1)}`; }
    return p;
  };

  const topPath = buildPath(topValues, yTop);
  const botPath = buildPath(bottomValues, yBot);
  const threshY = threshold != null ? yBot(threshold) : null;

  const sigSet = new Set(signals);
  const sigPts = [];
  for (let i = 0; i < n; i++) if (sigSet.has(dates[i])) { const y = yTop(topValues[i]); if (y != null) sigPts.push({ x: xScale(i), y }); }

  const fmtV = (v) => Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  const topTicks = [tMin, (tMin + tMax) / 2, tMax].map((v) => ({ y: yTop(v), label: fmtV(v) }));
  const botTicks = [bMin, (bMin + bMax) / 2, bMax].map((v) => ({ y: yBot(v), label: fmtV(v) }));

  const dateLbls = [];
  const step = Math.max(1, Math.floor(n / 7));
  for (let i = 0; i < n; i += step) {
    dateLbls.push({ x: xScale(i), label: new Date(dates[i]).toLocaleDateString("en-US", { year: "2-digit", month: "short" }) });
  }

  const handleMouse = (e) => {
    const r = ref.current?.getBoundingClientRect(); if (!r) return;
    const idx = Math.round(((e.clientX - r.left - pad.l) / (W - pad.l - pad.r)) * (n - 1));
    if (idx >= 0 && idx < n) setHover(idx);
  };
  const hx = hover != null ? xScale(hover) : null;

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}
      onMouseMove={handleMouse} onMouseLeave={() => setHover(null)}>
      <svg width={W} height={height} style={{ display: "block" }}>
        {topTicks.map((l, i) => <line key={`tg${i}`} x1={pad.l} x2={W - pad.r} y1={l.y} y2={l.y} stroke="rgba(255,255,255,0.035)" />)}
        {botTicks.map((l, i) => <line key={`bg${i}`} x1={pad.l} x2={W - pad.r} y1={l.y} y2={l.y} stroke="rgba(255,255,255,0.035)" />)}
        <line x1={pad.l} x2={W - pad.r} y1={pad.t + topH + pad.mid / 2} y2={pad.t + topH + pad.mid / 2} stroke={T.border} strokeWidth={0.5} />
        <path d={topPath} fill="none" stroke={topColor} strokeWidth={1} />
        <path d={botPath} fill="none" stroke={bottomColor} strokeWidth={1} />
        {threshY != null && <line x1={pad.l} x2={W - pad.r} y1={threshY} y2={threshY} stroke={T.red} strokeWidth={0.6} strokeDasharray="3,3" opacity={0.5} />}
        {sigPts.map((p, i) => <polygon key={i} points={`${p.x},${p.y - 5} ${p.x - 3.5},${p.y + 1.5} ${p.x + 3.5},${p.y + 1.5}`} fill={T.green} opacity={0.85} />)}
        {topTicks.map((l, i) => <text key={`tl${i}`} x={pad.l - 4} y={l.y + 3} fill={T.dim} fontSize={8} textAnchor="end" fontFamily={T.font}>{l.label}</text>)}
        {botTicks.map((l, i) => <text key={`bl${i}`} x={pad.l - 4} y={l.y + 3} fill={T.dim} fontSize={8} textAnchor="end" fontFamily={T.font}>{l.label}</text>)}
        <text x={pad.l + 4} y={pad.t + 12} fill={T.dim} fontSize={8} fontFamily={T.font} letterSpacing={0.5}>{topLabel}</text>
        <text x={pad.l + 4} y={pad.t + topH + pad.mid + 12} fill={bottomColor} fontSize={8} fontFamily={T.font} letterSpacing={0.5}>{bottomLabel}</text>
        {dateLbls.map((l, i) => <text key={i} x={l.x} y={height - 2} fill={T.dim} fontSize={8} textAnchor="middle" fontFamily={T.font}>{l.label}</text>)}
        {hover != null && <>
          <line x1={hx} x2={hx} y1={pad.t} y2={height - pad.b} stroke="rgba(255,255,255,0.15)" strokeWidth={0.5} />
          {yTop(topValues[hover]) != null && <circle cx={hx} cy={yTop(topValues[hover])} r={2.5} fill={topColor} stroke={T.bg} strokeWidth={1} />}
          {yBot(bottomValues[hover]) != null && <circle cx={hx} cy={yBot(bottomValues[hover])} r={2.5} fill={bottomColor} stroke={T.bg} strokeWidth={1} />}
        </>}
      </svg>
      {hover != null && (
        <div style={{
          position: "absolute", left: Math.min(hx + 10, W - 170), top: pad.t,
          background: "rgba(10,10,12,0.94)", border: `1px solid ${T.borderBright}`,
          padding: "5px 8px", pointerEvents: "none", zIndex: 10,
          fontFamily: T.font, fontSize: 9, lineHeight: 1.5,
        }}>
          <div style={{ color: T.dim }}>{dates[hover]}</div>
          <div style={{ color: topColor }}>{topLabel}: {topValues[hover]?.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
          <div style={{ color: bottomColor }}>{bottomLabel}: {bottomValues[hover]?.toFixed(3)}</div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// CompositeChart
// ═══════════════════════════════════════════════════════════════
function CompositeChart({ dates, spx, scores, triggers, height = 420 }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const [W, setW] = useState(600);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => { const w = e[0].contentRect.width; if (w > 0) setW(w); });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const n = dates.length;
  if (n < 2) return null;

  const pad = { l: 44, r: 32, t: 4, b: 16 };
  const H = height - pad.t - pad.b;
  const xS = (i) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r);

  const spxV = spx.filter((v) => v != null && v > 0);
  const logMin = Math.log(Math.min(...spxV)) - 0.04;
  const logMax = Math.log(Math.max(...spxV)) + 0.04;
  const ySpx = (v) => (!v || v <= 0) ? null : pad.t + H - ((Math.log(v) - logMin) / (logMax - logMin)) * H;
  const barH = (s) => (s / 9) * H;

  let path = "";
  for (let i = 0; i < n; i++) { const y = ySpx(spx[i]); if (y == null) continue; path += (path ? "L" : "M") + `${xS(i).toFixed(1)},${y.toFixed(1)}`; }

  const trigSet = new Set(triggers);
  const trigPts = [];
  for (let i = 0; i < n; i++) if (trigSet.has(dates[i])) { const y = ySpx(spx[i]); if (y != null) trigPts.push({ x: xS(i), y }); }

  const bw = Math.max(1, (W - pad.l - pad.r) / n * 0.8);
  const spxLbls = [logMin, (logMin + logMax) / 2, logMax].map((lv) => ({
    y: pad.t + H - ((lv - logMin) / (logMax - logMin)) * H, label: Math.exp(lv).toFixed(0),
  }));
  const scLbls = [0, 3, 6, 9].map((s) => ({ y: pad.t + H - barH(s), label: s.toString() }));

  const handleMouse = (e) => {
    const r = ref.current?.getBoundingClientRect(); if (!r) return;
    const idx = Math.round(((e.clientX - r.left - pad.l) / (W - pad.l - pad.r)) * (n - 1));
    if (idx >= 0 && idx < n) setHover(idx);
  };
  const hx = hover != null ? xS(hover) : null;

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}
      onMouseMove={handleMouse} onMouseLeave={() => setHover(null)}>
      <svg width={W} height={height} style={{ display: "block" }}>
        {spxLbls.map((l, i) => <line key={i} x1={pad.l} x2={W - pad.r} y1={l.y} y2={l.y} stroke="rgba(255,255,255,0.03)" />)}
        {[3, 6].map((s) => <line key={s} x1={pad.l} x2={W - pad.r} y1={pad.t + H - barH(s)} y2={pad.t + H - barH(s)} stroke="rgba(0,255,136,0.1)" strokeDasharray="2,4" />)}
        {scores.map((s, i) => s > 0 && <rect key={i} x={xS(i) - bw / 2} y={pad.t + H - barH(s)} width={bw} height={barH(s)} fill={`rgba(0,255,136,${0.05 + s * 0.02})`} />)}
        <path d={path} fill="none" stroke={T.bright} strokeWidth={1} />
        {trigPts.map((p, i) => <polygon key={i} points={`${p.x},${p.y - 5} ${p.x - 3.5},${p.y + 1.5} ${p.x + 3.5},${p.y + 1.5}`} fill={T.green} opacity={0.85} />)}
        {spxLbls.map((l, i) => <text key={i} x={pad.l - 4} y={l.y + 3} fill={T.dim} fontSize={8} textAnchor="end" fontFamily={T.font}>{l.label}</text>)}
        {scLbls.map((l, i) => <text key={i} x={W - pad.r + 4} y={l.y + 3} fill={T.green} fontSize={8} textAnchor="start" fontFamily={T.font} opacity={0.5}>{l.label}</text>)}
        {(() => { const ls = []; const st = Math.max(1, Math.floor(n / 6)); for (let i = 0; i < n; i += st) ls.push(<text key={i} x={xS(i)} y={height - 2} fill={T.dim} fontSize={8} textAnchor="middle" fontFamily={T.font}>{new Date(dates[i]).toLocaleDateString("en-US", { year: "2-digit", month: "short" })}</text>); return ls; })()}
        {hover != null && <>
          <line x1={hx} x2={hx} y1={pad.t} y2={pad.t + H} stroke="rgba(255,255,255,0.15)" strokeWidth={0.5} />
          {ySpx(spx[hover]) != null && <circle cx={hx} cy={ySpx(spx[hover])} r={2.5} fill={T.bright} stroke={T.bg} strokeWidth={1} />}
        </>}
      </svg>
      {hover != null && (
        <div style={{
          position: "absolute", left: Math.min(hx + 10, W - 170), top: pad.t,
          background: "rgba(10,10,12,0.94)", border: `1px solid ${T.borderBright}`,
          padding: "5px 8px", pointerEvents: "none", zIndex: 10,
          fontFamily: T.font, fontSize: 9, lineHeight: 1.5,
        }}>
          <div style={{ color: T.dim }}>{dates[hover]}</div>
          <div style={{ color: T.bright }}>SPX: {spx[hover]?.toLocaleString(undefined, { maximumFractionDigits: 1 })}</div>
          <div style={{ color: T.green }}>SIGNALS: {scores[hover]} / 9</div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Signal Badge
// ═══════════════════════════════════════════════════════════════
function SignalBadge({ active }) {
  const color = active ? T.green : T.dim;
  const label = active ? "BUY" : "IDLE";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 44, padding: "2px 0", fontSize: 9, fontWeight: 700,
      fontFamily: T.font, letterSpacing: 0.5,
      background: active ? `${T.green}18` : "transparent",
      color: color,
      border: `1px solid ${active ? T.green + "55" : T.border}`,
    }}>{label}</span>
  );
}

// ═══════════════════════════════════════════════════════════════
// Indicator configs
// ═══════════════════════════════════════════════════════════════
const IND_ORDER = [
  "r3fd", "acwi", "mcclellan", "putcall", "feargreed",
  "lowry", "zweig", "volcurve", "highs52w",
];
const IND_NUMS = {
  r3fd: "1", acwi: "2", mcclellan: "3", putcall: "4", feargreed: "5",
  lowry: "6", zweig: "7", volcurve: "8", highs52w: "9",
};
const IND_COLORS = {
  r3fd: T.orange, acwi: T.cyan, mcclellan: T.orange,
  putcall: T.purple, feargreed: T.amber, lowry: T.red,
  zweig: T.cyan, volcurve: T.orange, highs52w: T.cyan,
};

// ═══════════════════════════════════════════════════════════════
// IndicatorRow — expandable with chart
// ═══════════════════════════════════════════════════════════════
function IndicatorRow({ id, indicator, isActive }) {
  const [expanded, setExpanded] = useState(false);
  const [tf, setTf] = useState("2Y");
  const color = IND_COLORS[id] || T.cyan;

  const { dates: slD, arrays: [slSpx, slVal] } = useMemo(
    () => sliceByTf(indicator.dates, [indicator.spx, indicator.values], tf),
    [indicator, tf]
  );

  return (
    <div style={{
      background: expanded ? T.bgCard : "transparent",
      borderBottom: `1px solid ${T.border}`,
      transition: "background 0.15s",
    }}>
      {/* Header row */}
      <div onClick={() => setExpanded(!expanded)} style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "7px 8px 7px 0", cursor: "pointer",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            width: 16, height: 16, borderRadius: 2,
            background: T.border, color: T.text,
            fontSize: 9, fontWeight: 700, fontFamily: T.font,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
          }}>{IND_NUMS[id]}</span>
          <span style={{
            fontSize: 10, color: expanded ? T.bright : T.text, fontWeight: 500,
            letterSpacing: 0.2,
          }}>{indicator.name}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SignalBadge active={isActive} />
          <span style={{ color: T.dim, fontSize: 10 }}>{expanded ? "▾" : "▸"}</span>
        </div>
      </div>

      {/* Expanded chart */}
      {expanded && (
        <div style={{ padding: "4px 8px 10px" }}>
          <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 4 }}>
            <TimeframeBar value={tf} onChange={setTf} count={slD.length} />
          </div>
          <TerminalChart
            dates={slD}
            topValues={slSpx}
            bottomValues={slVal}
            topLabel="S&P 500"
            bottomLabel={indicator.name}
            signals={indicator.signals}
            threshold={indicator.threshold}
            bottomColor={color}
            height={340}
          />
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TitleBar — unified terminal header
// ═══════════════════════════════════════════════════════════════
function TitleBar({ fetchedAt, onRefresh, refreshing }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "8px 16px", background: T.bg,
      borderBottom: `1px solid ${T.border}`,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: T.orange, fontFamily: T.font, letterSpacing: 2 }}>
          SMALLFISHMACRO
        </span>
        <span style={{ fontSize: 12, fontWeight: 400, color: T.dim, fontFamily: T.font, letterSpacing: 1 }}>
          TERMINAL
        </span>
        <span style={{ fontSize: 10, color: T.dim, fontFamily: T.font }}>v1.0</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 9, fontFamily: T.font, color: T.dim }}>
        <span>{fetchedAt ? new Date(fetchedAt).toLocaleString() : ""}</span>
        <button onClick={onRefresh} disabled={refreshing} style={{
          padding: "3px 10px", fontSize: 9, fontFamily: T.font,
          border: `1px solid ${T.border}`, background: "transparent",
          color: T.dim, cursor: "pointer", letterSpacing: 0.5,
        }}>{refreshing ? "..." : "REFRESH"}</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// NavBar — top-level tab navigation (unified across terminal)
// ═══════════════════════════════════════════════════════════════
const NAV_TABS = ["DASHBOARD", "BUY THE DIP", "MARKET RISK", "OVERVIEW", "STRATEGY MAP"];

function NavBar({ active }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 0,
      borderBottom: `1px solid ${T.border}`, background: T.bg, padding: "0 16px",
    }}>
      {NAV_TABS.map((tab) => {
        const isActive = tab === active;
        return (
          <div key={tab} style={{
            padding: "8px 16px", fontSize: 11, fontWeight: isActive ? 700 : 400,
            fontFamily: T.font, color: isActive ? T.orange : T.dim,
            borderBottom: isActive ? `2px solid ${T.orange}` : "2px solid transparent",
            cursor: "pointer", letterSpacing: 0.8,
          }}>{tab}</div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SubTabs — secondary navigation below page title
// ═══════════════════════════════════════════════════════════════
function SubTabs({ tabs, active, onChange }) {
  return (
    <div style={{
      display: "flex", gap: 0, borderBottom: `1px solid ${T.border}`,
    }}>
      {tabs.map((tab) => {
        const isActive = tab === active;
        return (
          <div key={tab} onClick={() => onChange(tab)} style={{
            padding: "8px 18px", fontSize: 11, fontWeight: isActive ? 600 : 400,
            fontFamily: T.font, letterSpacing: 0.8, cursor: "pointer",
            color: isActive ? T.white : T.dim,
            borderBottom: isActive ? `2px solid ${T.white}` : "2px solid transparent",
            marginBottom: -1,
          }}>{tab}</div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Helper
// ═══════════════════════════════════════════════════════════════
function isSignalActive(ind) {
  if (!ind.signals || ind.signals.length === 0) return false;
  const last = ind.signals[ind.signals.length - 1];
  const lastDate = new Date(last);
  const now = new Date();
  const diffDays = (now - lastDate) / (1000 * 60 * 60 * 24);
  return diffDays <= 10;
}

// ═══════════════════════════════════════════════════════════════
// BacktestPlaceholder
// ═══════════════════════════════════════════════════════════════
function BacktestPlaceholder() {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      minHeight: 400, color: T.dim, fontSize: 11, letterSpacing: 1,
      border: `1px solid ${T.border}`, background: T.bgPanel,
    }}>
      BACKTEST MODULE — COMING SOON
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// LiveSignalView — the main BTD content
// ═══════════════════════════════════════════════════════════════
function LiveSignalView({ data }) {
  const [compTf, setCompTf] = useState("ALL");

  const compSliced = useMemo(() => {
    if (!data?.composite) return null;
    const { dates, arrays: [spx, scores, ma2] } = sliceByTf(
      data.composite.dates,
      [data.composite.spx, data.composite.scores, data.composite.ma2],
      compTf
    );
    const dateSet = new Set(dates);
    const triggers = (data.composite.triggers || []).filter((t) => dateSet.has(t));
    return { dates, spx, scores, ma2, triggers };
  }, [data, compTf]);

  const m = data?.metrics || {};
  const activeCount = data?.indicators
    ? IND_ORDER.filter((id) => data.indicators[id] && isSignalActive(data.indicators[id])).length
    : 0;

  return (
    <>
      {/* Control bar — matches Cross-Asset style */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "6px 0", borderBottom: `1px solid ${T.border}`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 9, color: T.dim }}>
          <span>
            <span style={{ color: T.green }}>▲</span> Buy trigger
            &nbsp;&nbsp;
            <span style={{ color: "rgba(0,255,136,0.3)" }}>█</span> Active zone
          </span>
          <span>
            ACTIVE: <span style={{ color: T.green, fontWeight: 700 }}>{activeCount}</span>
            <span style={{ color: T.dim }}> / 9</span>
          </span>
        </div>
        <TimeframeBar value={compTf} onChange={setCompTf} count={compSliced?.dates.length} />
      </div>

      {/* Main 2-column layout */}
      <div style={{ display: "flex", gap: 0, flex: 1, minHeight: 0 }}>

        {/* LEFT: Composite chart */}
        <div style={{ flex: "1 1 55%", minWidth: 0, borderRight: `1px solid ${T.border}` }}>
          <div style={{
            fontSize: 10, fontWeight: 600, color: T.text, letterSpacing: 0.8,
            padding: "8px 8px 4px",
          }}>
            COMPOSITE SIGNAL
          </div>
          <div style={{ background: T.bgPanel }}>
            {compSliced && (
              <CompositeChart
                dates={compSliced.dates} spx={compSliced.spx}
                scores={compSliced.scores} triggers={compSliced.triggers}
                height={480}
              />
            )}
          </div>
        </div>

        {/* RIGHT: Indicators list */}
        <div style={{ flex: "1 1 45%", minWidth: 0, overflow: "auto" }}>
          <div style={{
            fontSize: 10, fontWeight: 600, color: T.text, letterSpacing: 0.8,
            padding: "8px 8px 4px",
            display: "flex", justifyContent: "space-between",
          }}>
            <span>INDICATORS</span>
            <span style={{ fontWeight: 400, color: T.dim, fontSize: 9, letterSpacing: 0.3 }}>
              Click to expand
            </span>
          </div>
          <div>
            {data?.indicators && IND_ORDER.map((id) => {
              const ind = data.indicators[id];
              if (!ind) return null;
              return (
                <IndicatorRow key={id} id={id} indicator={ind} isActive={isSignalActive(ind)} />
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// Main App
// ═══════════════════════════════════════════════════════════════
export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [subTab, setSubTab] = useState("LIVE SIGNAL");

  const loadData = useCallback(async (force = false) => {
    try {
      if (force) setRefreshing(true);
      else setLoading(true);
      setError(null);
      const d = await fetchData(force);
      setData(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const fetchedAt = data?.computedAt || data?.fetchedAt;
  const m = data?.metrics || {};
  const scoreColor = m.btdScore >= 3 ? T.green : m.btdScore >= 1 ? T.amber : T.dim;
  const scoreLabel = m.btdScore >= 3 ? "ELEVATED" : m.btdScore >= 1 ? "MODERATE" : "NORMAL";

  // Shell (loading + error share the same chrome)
  const shell = (content) => (
    <div style={{
      background: T.bg, minHeight: "100vh", color: T.text, fontFamily: T.font,
      display: "flex", flexDirection: "column",
    }}>
      <TitleBar fetchedAt={fetchedAt} onRefresh={() => loadData(true)} refreshing={refreshing} />
      <NavBar active="BUY THE DIP" />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "0 16px" }}>
        {/* Page header row — title left, status right */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 0 0",
        }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: T.white, letterSpacing: 1 }}>
              BUY THE DIP
            </span>
          </div>

          {/* Status badges — right side like Cross-Asset has SPX/10Y/DXY */}
          {data && (
            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <div style={{
                padding: "3px 10px", fontSize: 10, fontFamily: T.font,
                background: `${scoreColor}18`, border: `1px solid ${scoreColor}44`,
                color: scoreColor, fontWeight: 700, letterSpacing: 0.5,
              }}>
                {scoreLabel} ({m.btdScore}/9)
              </div>
              <div style={{
                padding: "3px 10px", fontSize: 9, fontFamily: T.font,
                color: T.dim, background: T.bgPanel, border: `1px solid ${T.border}`,
              }}>
                SIGNAL <span style={{ color: T.bright }}>{m.lastSignalDate || "—"}</span>
              </div>
              <div style={{
                padding: "3px 10px", fontSize: 9, fontFamily: T.font,
                color: T.dim, background: T.bgPanel, border: `1px solid ${T.border}`,
              }}>
                TRIGGER <span style={{ color: T.bright }}>{m.lastTriggerDate || "—"}</span>
              </div>
            </div>
          )}
        </div>

        {/* Sub-tabs */}
        <SubTabs tabs={["LIVE SIGNAL", "BACKTEST"]} active={subTab} onChange={setSubTab} />

        {/* Content */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          {content}
        </div>
      </div>

      {/* Footer */}
      <div style={{
        textAlign: "center", padding: "10px 0",
        borderTop: `1px solid ${T.border}`,
      }}>
        <span style={{ color: T.dim, fontSize: 8, letterSpacing: 1, fontFamily: T.font }}>
          SMALLFISHMACRO · BARCHART DATA · GITHUB ACTIONS · VERCEL EDGE
        </span>
      </div>
    </div>
  );

  if (loading) {
    return shell(
      <div style={{ textAlign: "center", paddingTop: 100 }}>
        <div style={{ fontSize: 12, color: T.orange, letterSpacing: 2, marginBottom: 6 }}>LOADING</div>
        <div style={{ fontSize: 10, color: T.dim }}>Fetching indicator data...</div>
      </div>
    );
  }

  if (error) {
    return shell(
      <div style={{ textAlign: "center", paddingTop: 100 }}>
        <div style={{ fontSize: 12, color: T.red, marginBottom: 8 }}>ERROR: {error}</div>
        <button onClick={() => loadData(true)} style={{
          padding: "4px 14px", fontSize: 10, fontFamily: T.font,
          border: `1px solid ${T.border}`, background: "transparent",
          color: T.dim, cursor: "pointer",
        }}>RETRY</button>
      </div>
    );
  }

  return shell(
    subTab === "LIVE SIGNAL"
      ? <LiveSignalView data={data} />
      : <BacktestPlaceholder />
  );
}
