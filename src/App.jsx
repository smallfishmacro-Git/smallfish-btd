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
// Theme
// ═══════════════════════════════════════════════════════════════
const T = {
  bg: "#08080a",
  bgCard: "#0d0d10",
  bgHover: "#14141a",
  border: "#1a1a22",
  text: "#c8ccd4",
  dim: "#5a5e6a",
  bright: "#eef0f4",
  cyan: "#00d4ff",
  orange: "#ff9f43",
  green: "#00ff88",
  red: "#ff4757",
  amber: "#ffbe0b",
  purple: "#a855f7",
  font: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
};

// ═══════════════════════════════════════════════════════════════
// Timeframe logic
// ═══════════════════════════════════════════════════════════════
const TF = ["1M", "3M", "6M", "YTD", "1Y", "2Y", "5Y", "ALL"];

function tfCutoff(tf) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
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
  const startIdx = dates.findIndex((d) => d >= cutStr);
  if (startIdx < 0) return { dates, arrays };
  return {
    dates: dates.slice(startIdx),
    arrays: arrays.map((a) => a.slice(startIdx)),
  };
}

// ═══════════════════════════════════════════════════════════════
// TimeframeBar component
// ═══════════════════════════════════════════════════════════════
function TimeframeBar({ value, onChange, count }) {
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
      {count != null && (
        <span style={{ color: T.dim, fontSize: 10, marginRight: 8, fontFamily: T.font }}>
          {count.toLocaleString()}D
        </span>
      )}
      {TF.map((t) => (
        <button key={t} onClick={() => onChange(t)} style={{
          padding: "3px 8px", fontSize: 10, fontWeight: value === t ? 700 : 400,
          fontFamily: T.font, border: "none", borderRadius: 2, cursor: "pointer",
          background: value === t ? T.amber : "transparent",
          color: value === t ? "#000" : T.dim,
        }}>{t}</button>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TerminalChart — the main chart component
// ═══════════════════════════════════════════════════════════════
function TerminalChart({
  dates, topValues, bottomValues, topLabel, bottomLabel,
  signals = [], threshold, thresholdDir,
  topColor = T.bright, bottomColor = T.cyan,
  topLog = false, height = 420, showSignals = true,
}) {
  const containerRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [dims, setDims] = useState({ w: 800, h: height });

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      if (width > 0) setDims({ w: width, h: height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [height]);

  const n = dates.length;
  if (n < 2) return <div style={{ color: T.dim, padding: 20, fontSize: 11 }}>Insufficient data</div>;

  const pad = { l: 55, r: 12, t: 8, mid: 24, b: 20 };
  const W = dims.w;
  const topH = Math.floor((height - pad.t - pad.mid - pad.b) * 0.55);
  const botH = Math.floor((height - pad.t - pad.mid - pad.b) * 0.45);

  // Scales
  const xScale = (i) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r);

  const minMax = (arr, log) => {
    const valid = arr.filter((v) => v != null && isFinite(v) && (!log || v > 0));
    if (!valid.length) return [0, 1];
    let mn = Math.min(...valid), mx = Math.max(...valid);
    if (log) { mn = Math.log(mn); mx = Math.log(mx); }
    const margin = (mx - mn) * 0.05 || 1;
    return [mn - margin, mx + margin];
  };

  const [topMin, topMax] = minMax(topValues, topLog);
  const [botMin, botMax] = minMax(bottomValues, false);

  const yTop = (v) => {
    if (v == null) return null;
    const val = topLog ? Math.log(v) : v;
    return pad.t + topH - ((val - topMin) / (topMax - topMin)) * topH;
  };
  const yBot = (v) => {
    if (v == null) return null;
    return pad.t + topH + pad.mid + botH - ((v - botMin) / (botMax - botMin)) * botH;
  };

  // Build paths
  const buildPath = (values, yFn) => {
    let path = "";
    for (let i = 0; i < n; i++) {
      const y = yFn(values[i]);
      if (y == null) continue;
      const x = xScale(i);
      path += (path ? "L" : "M") + `${x.toFixed(1)},${y.toFixed(1)}`;
    }
    return path;
  };

  const topPath = buildPath(topValues, yTop);
  const botPath = buildPath(bottomValues, yBot);

  // Threshold line
  const threshY = threshold != null ? yBot(threshold) : null;

  // Signal markers on top chart
  const signalSet = new Set(signals);
  const signalPoints = [];
  if (showSignals) {
    for (let i = 0; i < n; i++) {
      if (signalSet.has(dates[i])) {
        const y = yTop(topValues[i]);
        if (y != null) signalPoints.push({ x: xScale(i), y });
      }
    }
  }

  // Y-axis labels
  const topLabels = [topMin, (topMin + topMax) / 2, topMax].map((v) => ({
    y: yTop(topLog ? Math.exp(v) : v),
    label: topLog ? Math.exp(v).toFixed(0) : v >= 1000 ? v.toFixed(0) : v.toFixed(1),
  }));
  const botLabels = [botMin, (botMin + botMax) / 2, botMax].map((v) => ({
    y: yBot(v),
    label: Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2),
  }));

  // Date labels
  const dateLabels = [];
  const step = Math.max(1, Math.floor(n / 6));
  for (let i = 0; i < n; i += step) {
    const dt = new Date(dates[i]);
    dateLabels.push({
      x: xScale(i),
      label: dt.toLocaleDateString("en-US", { year: "2-digit", month: "short" }),
    });
  }

  // Hover handling
  const handleMouse = (e) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const idx = Math.round(((mx - pad.l) / (W - pad.l - pad.r)) * (n - 1));
    if (idx >= 0 && idx < n) setHover(idx);
  };

  const hx = hover != null ? xScale(hover) : null;

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%" }}
      onMouseMove={handleMouse} onMouseLeave={() => setHover(null)}>
      <svg width={W} height={height} style={{ display: "block" }}>
        {/* Top panel background */}
        <rect x={pad.l} y={pad.t} width={W - pad.l - pad.r} height={topH}
          fill="rgba(255,255,255,0.015)" rx={2} />
        {/* Bottom panel background */}
        <rect x={pad.l} y={pad.t + topH + pad.mid} width={W - pad.l - pad.r} height={botH}
          fill="rgba(255,255,255,0.015)" rx={2} />

        {/* Grid lines */}
        {topLabels.map((l, i) => (
          <line key={`tg${i}`} x1={pad.l} x2={W - pad.r} y1={l.y} y2={l.y}
            stroke="rgba(255,255,255,0.04)" strokeDasharray="2,4" />
        ))}
        {botLabels.map((l, i) => (
          <line key={`bg${i}`} x1={pad.l} x2={W - pad.r} y1={l.y} y2={l.y}
            stroke="rgba(255,255,255,0.04)" strokeDasharray="2,4" />
        ))}

        {/* Top chart: SPX */}
        <path d={topPath} fill="none" stroke={topColor} strokeWidth={1.2} />

        {/* Bottom chart: Indicator */}
        <path d={botPath} fill="none" stroke={bottomColor} strokeWidth={1.2} />

        {/* Threshold line */}
        {threshY != null && (
          <line x1={pad.l} x2={W - pad.r} y1={threshY} y2={threshY}
            stroke={T.red} strokeWidth={0.8} strokeDasharray="4,3" opacity={0.6} />
        )}

        {/* Buy signal markers */}
        {signalPoints.map((p, i) => (
          <polygon key={i} points={`${p.x},${p.y - 6} ${p.x - 4},${p.y + 2} ${p.x + 4},${p.y + 2}`}
            fill={T.green} opacity={0.9} />
        ))}

        {/* Y labels */}
        {topLabels.map((l, i) => (
          <text key={`tl${i}`} x={pad.l - 6} y={l.y + 3} fill={T.dim} fontSize={9}
            textAnchor="end" fontFamily={T.font}>{l.label}</text>
        ))}
        {botLabels.map((l, i) => (
          <text key={`bl${i}`} x={pad.l - 6} y={l.y + 3} fill={T.dim} fontSize={9}
            textAnchor="end" fontFamily={T.font}>{l.label}</text>
        ))}

        {/* Date labels */}
        {dateLabels.map((l, i) => (
          <text key={i} x={l.x} y={height - 4} fill={T.dim} fontSize={9}
            textAnchor="middle" fontFamily={T.font}>{l.label}</text>
        ))}

        {/* Panel labels */}
        <text x={pad.l + 6} y={pad.t + 14} fill={T.dim} fontSize={9}
          fontFamily={T.font}>{topLabel}</text>
        <text x={pad.l + 6} y={pad.t + topH + pad.mid + 14} fill={bottomColor} fontSize={9}
          fontFamily={T.font}>{bottomLabel}</text>

        {/* Crosshair */}
        {hover != null && (
          <>
            <line x1={hx} x2={hx} y1={pad.t} y2={height - pad.b}
              stroke="rgba(255,255,255,0.2)" strokeWidth={0.5} />
            {/* Top dot */}
            {yTop(topValues[hover]) != null && (
              <circle cx={hx} cy={yTop(topValues[hover])} r={3}
                fill={topColor} stroke={T.bg} strokeWidth={1} />
            )}
            {/* Bottom dot */}
            {yBot(bottomValues[hover]) != null && (
              <circle cx={hx} cy={yBot(bottomValues[hover])} r={3}
                fill={bottomColor} stroke={T.bg} strokeWidth={1} />
            )}
          </>
        )}
      </svg>

      {/* Tooltip */}
      {hover != null && (
        <div style={{
          position: "absolute",
          left: Math.min(hx + 12, W - 160),
          top: pad.t + 4,
          background: "rgba(13,13,16,0.92)",
          border: `1px solid ${T.border}`,
          borderRadius: 3,
          padding: "6px 10px",
          pointerEvents: "none",
          zIndex: 10,
          fontFamily: T.font,
          fontSize: 10,
        }}>
          <div style={{ color: T.dim, marginBottom: 3 }}>{dates[hover]}</div>
          <div style={{ color: topColor }}>
            {topLabel}: {topValues[hover]?.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
          <div style={{ color: bottomColor }}>
            {bottomLabel}: {bottomValues[hover]?.toFixed(3)}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// CompositeChart — the main hero chart
// ═══════════════════════════════════════════════════════════════
function CompositeChart({ dates, spx, scores, triggers, height = 460 }) {
  const containerRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [dims, setDims] = useState({ w: 900, h: height });

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      if (width > 0) setDims({ w: width, h: height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [height]);

  const n = dates.length;
  if (n < 2) return null;

  const pad = { l: 55, r: 40, t: 8, b: 20 };
  const W = dims.w;
  const H = height - pad.t - pad.b;

  const xScale = (i) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r);

  // SPX on log scale
  const spxValid = spx.filter((v) => v != null && v > 0);
  const spxLogMin = Math.log(Math.min(...spxValid)) - 0.05;
  const spxLogMax = Math.log(Math.max(...spxValid)) + 0.05;
  const ySpx = (v) => {
    if (!v || v <= 0) return null;
    return pad.t + H - ((Math.log(v) - spxLogMin) / (spxLogMax - spxLogMin)) * H;
  };

  // Score bars
  const maxScore = 9;
  const barH = (s) => (s / maxScore) * H;

  // SPX path
  let spxPath = "";
  for (let i = 0; i < n; i++) {
    const y = ySpx(spx[i]);
    if (y == null) continue;
    spxPath += (spxPath ? "L" : "M") + `${xScale(i).toFixed(1)},${y.toFixed(1)}`;
  }

  // Trigger set
  const triggerSet = new Set(triggers);
  const triggerPoints = [];
  for (let i = 0; i < n; i++) {
    if (triggerSet.has(dates[i])) {
      const y = ySpx(spx[i]);
      if (y != null) triggerPoints.push({ x: xScale(i), y });
    }
  }

  // Score bars (thin vertical lines)
  const barWidth = Math.max(1, (W - pad.l - pad.r) / n * 0.7);

  const handleMouse = (e) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const idx = Math.round(((mx - pad.l) / (W - pad.l - pad.r)) * (n - 1));
    if (idx >= 0 && idx < n) setHover(idx);
  };

  const hx = hover != null ? xScale(hover) : null;

  // Y labels for SPX
  const spxLabels = [spxLogMin, (spxLogMin + spxLogMax) / 2, spxLogMax].map((lv) => ({
    y: pad.t + H - ((lv - spxLogMin) / (spxLogMax - spxLogMin)) * H,
    label: Math.exp(lv).toFixed(0),
  }));
  // Y labels for score (right side)
  const scoreLabels = [0, 3, 6, 9].map((s) => ({
    y: pad.t + H - barH(s),
    label: s.toString(),
  }));

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%" }}
      onMouseMove={handleMouse} onMouseLeave={() => setHover(null)}>
      <svg width={W} height={height} style={{ display: "block" }}>
        <rect x={pad.l} y={pad.t} width={W - pad.l - pad.r} height={H}
          fill="rgba(255,255,255,0.01)" rx={2} />

        {/* Grid */}
        {spxLabels.map((l, i) => (
          <line key={i} x1={pad.l} x2={W - pad.r} y1={l.y} y2={l.y}
            stroke="rgba(255,255,255,0.03)" strokeDasharray="2,4" />
        ))}
        {/* Threshold lines at 3 and 6 */}
        {[3, 6].map((s) => (
          <line key={s} x1={pad.l} x2={W - pad.r}
            y1={pad.t + H - barH(s)} y2={pad.t + H - barH(s)}
            stroke="rgba(0,255,136,0.15)" strokeDasharray="3,4" />
        ))}

        {/* Score bars */}
        {scores.map((s, i) => s > 0 && (
          <rect key={i} x={xScale(i) - barWidth / 2}
            y={pad.t + H - barH(s)}
            width={barWidth} height={barH(s)}
            fill={`rgba(0,255,136,${0.06 + s * 0.025})`} />
        ))}

        {/* SPX line */}
        <path d={spxPath} fill="none" stroke={T.bright} strokeWidth={1.3} />

        {/* Trigger markers */}
        {triggerPoints.map((p, i) => (
          <polygon key={i} points={`${p.x},${p.y - 7} ${p.x - 5},${p.y + 2} ${p.x + 5},${p.y + 2}`}
            fill={T.green} opacity={0.9} />
        ))}

        {/* Y labels left (SPX) */}
        {spxLabels.map((l, i) => (
          <text key={i} x={pad.l - 6} y={l.y + 3} fill={T.dim} fontSize={9}
            textAnchor="end" fontFamily={T.font}>{l.label}</text>
        ))}
        {/* Y labels right (Score) */}
        {scoreLabels.map((l, i) => (
          <text key={i} x={W - pad.r + 6} y={l.y + 3} fill={T.green} fontSize={9}
            textAnchor="start" fontFamily={T.font} opacity={0.6}>{l.label}</text>
        ))}

        {/* Date labels */}
        {(() => {
          const labels = [];
          const step = Math.max(1, Math.floor(n / 7));
          for (let i = 0; i < n; i += step) {
            const dt = new Date(dates[i]);
            labels.push(
              <text key={i} x={xScale(i)} y={height - 4} fill={T.dim} fontSize={9}
                textAnchor="middle" fontFamily={T.font}>
                {dt.toLocaleDateString("en-US", { year: "2-digit", month: "short" })}
              </text>
            );
          }
          return labels;
        })()}

        {/* Crosshair */}
        {hover != null && (
          <>
            <line x1={hx} x2={hx} y1={pad.t} y2={pad.t + H}
              stroke="rgba(255,255,255,0.2)" strokeWidth={0.5} />
            {ySpx(spx[hover]) != null && (
              <circle cx={hx} cy={ySpx(spx[hover])} r={3}
                fill={T.bright} stroke={T.bg} strokeWidth={1} />
            )}
          </>
        )}
      </svg>

      {hover != null && (
        <div style={{
          position: "absolute",
          left: Math.min(hx + 12, W - 180),
          top: pad.t + 4,
          background: "rgba(13,13,16,0.92)",
          border: `1px solid ${T.border}`,
          borderRadius: 3,
          padding: "6px 10px",
          pointerEvents: "none",
          zIndex: 10,
          fontFamily: T.font,
          fontSize: 10,
        }}>
          <div style={{ color: T.dim, marginBottom: 3 }}>{dates[hover]}</div>
          <div style={{ color: T.bright }}>
            S&P 500: {spx[hover]?.toLocaleString(undefined, { maximumFractionDigits: 1 })}
          </div>
          <div style={{ color: T.green }}>
            Signals: {scores[hover]} / 9
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Indicator Card (expandable)
// ═══════════════════════════════════════════════════════════════
const INDICATOR_COLORS = {
  r3fd: T.orange, acwi: T.cyan, mcclellan: T.orange,
  putcall: T.purple, feargreed: T.amber, lowry: T.red,
  zweig: T.cyan, volcurve: T.orange, highs52w: T.cyan,
};

const INDICATOR_ORDER = [
  "r3fd", "acwi", "mcclellan", "putcall", "feargreed",
  "lowry", "zweig", "volcurve", "highs52w",
];

const INDICATOR_LABELS = {
  r3fd: "1", acwi: "2", mcclellan: "3", putcall: "4", feargreed: "5",
  lowry: "6", zweig: "7", volcurve: "8", highs52w: "9",
};

function IndicatorSection({ id, indicator, defaultTf = "2Y" }) {
  const [expanded, setExpanded] = useState(false);
  const [tf, setTf] = useState(defaultTf);
  const color = INDICATOR_COLORS[id] || T.cyan;

  const { dates: slicedDates, arrays: [slicedSpx, slicedValues] } = useMemo(
    () => sliceByTf(indicator.dates, [indicator.spx, indicator.values], tf),
    [indicator, tf]
  );

  const lastVal = indicator.values[indicator.values.length - 1];
  const lastSignal = indicator.signals[indicator.signals.length - 1];

  return (
    <div style={{
      background: T.bgCard,
      border: `1px solid ${T.border}`,
      borderRadius: 4,
      marginBottom: 6,
      overflow: "hidden",
    }}>
      {/* Header */}
      <div onClick={() => setExpanded(!expanded)} style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 14px", cursor: "pointer",
        borderBottom: expanded ? `1px solid ${T.border}` : "none",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 20, height: 20, borderRadius: 3,
            background: color, color: "#000",
            fontSize: 10, fontWeight: 700, fontFamily: T.font,
          }}>{INDICATOR_LABELS[id]}</span>
          <span style={{ color: T.bright, fontSize: 12, fontWeight: 600, fontFamily: T.font }}>
            {indicator.name}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: color, fontSize: 11, fontFamily: T.font }}>
            {lastVal?.toFixed(2)}
          </span>
          {lastSignal && (
            <span style={{
              fontSize: 9, padding: "2px 6px", borderRadius: 2,
              background: "rgba(0,255,136,0.15)", color: T.green,
              fontFamily: T.font,
            }}>LAST: {lastSignal}</span>
          )}
          <span style={{ color: T.dim, fontSize: 12 }}>{expanded ? "▾" : "▸"}</span>
        </div>
      </div>

      {/* Chart (expanded) */}
      {expanded && (
        <div style={{ padding: "8px 10px 12px" }}>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
            <TimeframeBar value={tf} onChange={setTf} count={slicedDates.length} />
          </div>
          <TerminalChart
            dates={slicedDates}
            topValues={slicedSpx}
            bottomValues={slicedValues}
            topLabel="S&P 500"
            bottomLabel={indicator.name}
            signals={indicator.signals}
            threshold={indicator.threshold}
            thresholdDir={indicator.thresholdDir}
            bottomColor={color}
            height={380}
          />
        </div>
      )}
    </div>
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
  const [compTf, setCompTf] = useState("ALL");

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

  // Sliced composite data for selected timeframe
  const compSliced = useMemo(() => {
    if (!data?.composite) return null;
    const { dates, arrays: [spx, scores, ma2] } = sliceByTf(
      data.composite.dates,
      [data.composite.spx, data.composite.scores, data.composite.ma2],
      compTf
    );
    // Filter triggers within the visible range
    const dateSet = new Set(dates);
    const triggers = (data.composite.triggers || []).filter((t) => dateSet.has(t));
    return { dates, spx, scores, ma2, triggers };
  }, [data, compTf]);

  // ── Loading ──
  if (loading) {
    return (
      <div style={styles.page}>
        <div style={{ textAlign: "center", paddingTop: 120 }}>
          <div style={{ fontSize: 14, color: T.amber, fontFamily: T.font, marginBottom: 8 }}>
            LOADING BUY THE DIP ENGINE
          </div>
          <div style={{ fontSize: 11, color: T.dim, fontFamily: T.font }}>
            Fetching 12 data series from market-dashboard...
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.page}>
        <div style={{ textAlign: "center", paddingTop: 120 }}>
          <div style={{ fontSize: 14, color: T.red, fontFamily: T.font, marginBottom: 8 }}>
            ERROR: {error}
          </div>
          <button style={styles.refreshBtn} onClick={() => loadData(true)}>RETRY</button>
        </div>
      </div>
    );
  }

  const m = data?.metrics || {};

  return (
    <div style={styles.page}>
      {/* ── Top Bar ── */}
      <div style={styles.topBar}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: T.amber, fontSize: 14, fontWeight: 700, fontFamily: T.font, letterSpacing: 1 }}>
            SMALLFISH
          </span>
          <span style={{ color: T.dim, fontSize: 11, fontFamily: T.font }}>
            BUY THE DIP
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ color: T.dim, fontSize: 9, fontFamily: T.font }}>
            {data?.fetchedAt && new Date(data.fetchedAt).toLocaleString()}
          </span>
          <button style={styles.refreshBtn}
            onClick={() => loadData(true)} disabled={refreshing}>
            {refreshing ? "..." : "⟳ REFRESH"}
          </button>
        </div>
      </div>

      {/* ── Metrics Strip ── */}
      <div style={styles.metricStrip}>
        <div style={styles.metric}>
          <div style={styles.metricLabel}>BTD SCORE</div>
          <div style={{
            ...styles.metricValue,
            color: m.btdScore >= 3 ? T.green : m.btdScore >= 1 ? T.amber : T.dim,
          }}>
            {m.btdScore} <span style={{ color: T.dim, fontSize: 11 }}>/ 9</span>
          </div>
          <div style={{
            fontSize: 9, fontFamily: T.font, marginTop: 2,
            color: m.btdScore >= 3 ? T.green : m.btdScore >= 1 ? T.amber : T.dim,
          }}>
            {m.btdScore >= 3 ? "▲ ELEVATED" : m.btdScore >= 1 ? "● MODERATE" : "○ NORMAL"}
          </div>
        </div>
        <div style={styles.metricDivider} />
        <div style={styles.metric}>
          <div style={styles.metricLabel}>LAST SIGNAL</div>
          <div style={styles.metricValue}>{m.lastSignalDate || "—"}</div>
        </div>
        <div style={styles.metricDivider} />
        <div style={styles.metric}>
          <div style={styles.metricLabel}>LAST TRIGGER</div>
          <div style={styles.metricValue}>{m.lastTriggerDate || "—"}</div>
        </div>
        <div style={styles.metricDivider} />
        <div style={styles.metric}>
          <div style={styles.metricLabel}>DATA ERRORS</div>
          <div style={{
            ...styles.metricValue,
            color: data?.errors ? T.red : T.green,
          }}>
            {data?.errors ? Object.keys(data.errors).length : 0}
          </div>
        </div>
      </div>

      {/* ── Composite Chart ── */}
      <div style={styles.section}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div>
            <span style={{ color: T.amber, fontSize: 13, fontWeight: 700, fontFamily: T.font }}>
              COMPOSITE SIGNAL
            </span>
            <span style={{ color: T.dim, fontSize: 10, fontFamily: T.font, marginLeft: 10 }}>
              9 oversold indicators vs S&P 500
            </span>
          </div>
          <TimeframeBar value={compTf} onChange={setCompTf}
            count={compSliced?.dates.length} />
        </div>
        <div style={{ color: T.dim, fontSize: 9, fontFamily: T.font, marginBottom: 8 }}>
          <span style={{ color: T.green }}>▲</span> = Buy trigger (score &gt; 2 & rising) &nbsp;
          <span style={{ color: "rgba(0,255,136,0.3)" }}>█</span> = Signals active (0–9)
        </div>
        {compSliced && (
          <CompositeChart
            dates={compSliced.dates}
            spx={compSliced.spx}
            scores={compSliced.scores}
            triggers={compSliced.triggers}
            height={440}
          />
        )}
      </div>

      {/* ── Individual Indicators ── */}
      <div style={styles.section}>
        <div style={{ marginBottom: 10 }}>
          <span style={{ color: T.amber, fontSize: 13, fontWeight: 700, fontFamily: T.font }}>
            INDIVIDUAL INDICATORS
          </span>
          <span style={{ color: T.dim, fontSize: 10, fontFamily: T.font, marginLeft: 10 }}>
            Click to expand charts
          </span>
        </div>
        {data?.indicators && INDICATOR_ORDER.map((id) => {
          const ind = data.indicators[id];
          if (!ind) return null;
          return <IndicatorSection key={id} id={id} indicator={ind} />;
        })}
      </div>

      {/* ── Footer ── */}
      <div style={{ textAlign: "center", padding: "20px 0", borderTop: `1px solid ${T.border}` }}>
        <span style={{ color: T.dim, fontSize: 9, fontFamily: T.font }}>
          SMALLFISH MACRO · Data via Barchart · Updated daily via GitHub Actions
        </span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Styles
// ═══════════════════════════════════════════════════════════════
const styles = {
  page: {
    background: T.bg,
    minHeight: "100vh",
    color: T.text,
    fontFamily: T.font,
    maxWidth: 1100,
    margin: "0 auto",
    padding: "0 16px",
  },
  topBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 0",
    borderBottom: `1px solid ${T.border}`,
  },
  refreshBtn: {
    padding: "4px 12px",
    fontSize: 10,
    fontWeight: 600,
    fontFamily: T.font,
    border: `1px solid ${T.border}`,
    borderRadius: 3,
    cursor: "pointer",
    background: "transparent",
    color: T.dim,
    letterSpacing: 0.5,
  },
  metricStrip: {
    display: "flex",
    alignItems: "center",
    padding: "14px 0",
    borderBottom: `1px solid ${T.border}`,
    gap: 0,
    overflowX: "auto",
  },
  metric: {
    flex: 1,
    textAlign: "center",
    minWidth: 120,
  },
  metricLabel: {
    fontSize: 9,
    color: T.dim,
    letterSpacing: 1,
    marginBottom: 4,
  },
  metricValue: {
    fontSize: 16,
    fontWeight: 700,
    color: T.bright,
  },
  metricDivider: {
    width: 1,
    height: 36,
    background: T.border,
    flexShrink: 0,
  },
  section: {
    padding: "20px 0",
    borderBottom: `1px solid ${T.border}`,
  },
};
