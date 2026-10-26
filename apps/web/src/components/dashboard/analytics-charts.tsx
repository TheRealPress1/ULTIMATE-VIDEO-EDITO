import { For, Show, createMemo, createSignal, createUniqueId } from "solid-js";
import { metricValue, trendChange, trendPoints, type AnalyticsPoint } from "./analytics-data";
import "./analytics-charts.css";

const exactCount = new Intl.NumberFormat(undefined, { maximumFractionDigits: 20 });
const shortCount = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const percentCount = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const axisDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const preciseDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

type ChartPoint = AnalyticsPoint & { x: number; y: number };

/** Plots only recorded values; a first observation gets a marker, not an invented trend. */
export function AnalyticsSparkline(props: {
  points: AnalyticsPoint[];
  label: string;
  compact?: boolean;
  empty?: string;
  byPost?: boolean;
}) {
  const id = createUniqueId();
  const [hovered, setHovered] = createSignal<number | null>(null);
  const [focused, setFocused] = createSignal<number | null>(null);
  const points = createMemo(() => props.byPost
    ? props.points.filter((point) => Number.isFinite(Date.parse(point.date)) && metricValue(point.value) !== null)
      .sort((left, right) => Date.parse(left.date) - Date.parse(right.date))
    : trendPoints(props.points));
  const height = () => props.compact ? 60 : 116;
  const bounds = createMemo(() => {
    const entries = points();
    if (!entries.length) return { min: 0, max: 0 };
    return {
      min: Math.min(...entries.map((point) => point.value)),
      max: Math.max(...entries.map((point) => point.value)),
    };
  });
  const coordinates = createMemo<ChartPoint[]>(() => {
    const entries = points();
    const first = Date.parse(entries[0]?.date ?? "");
    const span = Date.parse(entries.at(-1)?.date ?? "") - first;
    const { min, max } = bounds();
    return entries.map((point, index) => ({
      ...point,
      x: entries.length === 1 ? 250 : 10 + (span === 0 ? index / (entries.length - 1) : (Date.parse(point.date) - first) / span) * 480,
      y: min === max ? height() / 2 : height() - 12 - ((point.value - min) / (max - min)) * (height() - 24),
    }));
  });
  const line = createMemo(() => coordinates().map((point) => `${point.x},${point.y}`).join(" "));
  const fill = createMemo(() => {
    const entries = coordinates();
    if (entries.length < 2) return "";
    return `M${entries[0].x},${height()} L${line()} L${entries.at(-1)!.x},${height()} Z`;
  });
  const active = createMemo(() => {
    const index = hovered() ?? focused();
    return index === null ? null : coordinates()[index] ?? null;
  });
  const description = () => {
    const entries = points();
    if (!entries.length) return `${props.label}: no available measurements`;
    if (entries.length === 1) return `${props.label}: ${exactCount.format(entries[0].value)}, ${props.byPost ? "post published" : "first observation"} on ${preciseDate.format(new Date(entries[0].date))}`;
    return `${props.label}: ${exactCount.format(entries[0].value)} to ${exactCount.format(entries.at(-1)!.value)} across ${entries.length} ${props.byPost ? "posts" : "observations"}`;
  };
  const pointLabel = (point: AnalyticsPoint) => `${props.label}: ${exactCount.format(point.value)} on ${preciseDate.format(new Date(point.date))}`;

  return (
    <div class="cutroom-sparkline" classList={{ "is-compact": props.compact }} role="group" aria-label={description()}>
      <Show when={points().length} fallback={
        <div class="cutroom-sparkline-empty" style={{ height: `${height()}px` }}>{props.empty ?? "No measurements yet"}</div>
      }>
        <Show when={!props.compact}>
          <div class="cutroom-sparkline-scale" classList={{ "is-flat": bounds().min === bounds().max }} aria-hidden="true">
            <span>{shortCount.format(bounds().max)}</span>
            <Show when={bounds().min !== bounds().max}><span>{shortCount.format(bounds().min)}</span></Show>
          </div>
        </Show>
        <div class="cutroom-sparkline-body">
          <div class="cutroom-sparkline-plot" style={{ height: `${height()}px` }}>
            <svg viewBox={`0 0 500 ${height()}`} preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#43c98b" stop-opacity={props.compact ? ".18" : ".2"} />
                  <stop offset="100%" stop-color="#43c98b" stop-opacity="0" />
                </linearGradient>
              </defs>
              <Show when={!props.compact}>
                <path class="cutroom-sparkline-guide" d={`M10 12H490M10 ${height() / 2}H490M10 ${height() - 12}H490`} />
              </Show>
              <Show when={props.compact && points().length === 1}>
                <path class="cutroom-sparkline-guide" d={`M10 ${height() / 2}H490`} />
              </Show>
              <Show when={points().length > 1}>
                <path d={fill()} fill={`url(#${id}-fill)`} />
                <polyline class="cutroom-sparkline-line" points={line()} />
              </Show>
              <Show when={active()}>{(point) =>
                <path class="cutroom-sparkline-crosshair" d={`M${point().x} 0V${height()}`} />
              }</Show>
            </svg>
            <For each={coordinates()}>{(point, index) => (
              <button
                type="button"
                class="cutroom-sparkline-point"
                classList={{
                  "is-endpoint": index() === coordinates().length - 1,
                  "is-active": hovered() === index() || focused() === index(),
                }}
                style={{ left: `${point.x / 5}%`, top: `${point.y}px` }}
                aria-label={pointLabel(point)}
                aria-describedby={hovered() === index() || focused() === index() ? `${id}-tooltip` : undefined}
                onMouseEnter={() => setHovered(index())}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setFocused(index())}
                onBlur={() => setFocused(null)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setHovered(null);
                    setFocused(null);
                    event.currentTarget.blur();
                  }
                }}
              ><span /></button>
            )}</For>
            <Show when={points().length === 1 && !props.compact}>
              <span class="cutroom-sparkline-first" aria-hidden="true">{props.byPost ? "One post" : "First observation"}</span>
            </Show>
            <Show when={active()}>{(point) => (
              <div
                id={`${id}-tooltip`}
                class="cutroom-sparkline-tooltip"
                role="tooltip"
                style={{ left: `clamp(0px, calc(${point().x / 5}% - 80px), calc(100% - 160px))`, top: `${point().y - 12}px` }}
              >
                <span>{preciseDate.format(new Date(point().date))}</span>
                <strong>{exactCount.format(point().value)}</strong>
              </div>
            )}</Show>
          </div>
          <Show when={!props.compact}>
            <div class="cutroom-sparkline-dates" classList={{ "is-single": points().length === 1 }} aria-hidden="true">
              <span>{axisDate.format(new Date(points()[0].date))}</span>
              <Show when={points().length > 1}><span>{axisDate.format(new Date(points().at(-1)!.date))}</span></Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** A change requires at least two actual, comparable observations. */
export function AnalyticsChange(props: { points: AnalyticsPoint[]; context?: string }) {
  const change = createMemo(() => {
    const change = trendChange(props.points);
    if (!change) return null;
    const { delta, percent } = change;
    return {
      delta,
      count: `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${exactCount.format(Math.abs(delta))}`,
      percent: percent !== null && Number.isFinite(percent) ? `${percentCount.format(Math.abs(percent))}%` : null,
    };
  });
  return (
    <Show when={change()}>{(value) => (
      <span class="cutroom-analytics-change" classList={{ "is-up": value().delta > 0, "is-down": value().delta < 0 }}>
        <span class="cutroom-analytics-change-value">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d={value().delta > 0 ? "M3 12L12 3M5 3h7v7" : value().delta < 0 ? "M3 4l9 9M5 13h7V6" : "M3 8h10"} stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          {value().count}<Show when={value().percent !== null}><span>({value().percent})</span></Show>
        </span>
        <span class="cutroom-analytics-change-context">{props.context ?? "since first sync"}</span>
      </span>
    )}</Show>
  );
}
