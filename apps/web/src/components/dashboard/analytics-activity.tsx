import { For, createMemo, createSignal } from "solid-js";
import type { InstagramPost } from "@desktop/instagram-types";
import { postingActivity } from "./analytics-data";

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function PublishingActivity(props: { posts: InstagramPost[]; hasMore: boolean; now?: number }) {
  const calendar = createMemo(() => postingActivity(props.posts, props.now));
  const months = createMemo(() => calendar().months.filter((month, index, all) => !all[index + 1] || all[index + 1].column - month.column >= 3));
  const [focused, setFocused] = createSignal(-1);
  const [hovered, setHovered] = createSignal<number | null>(null);
  const buttons: HTMLButtonElement[] = [];
  const todayIndex = () => calendar().cells.findLastIndex((cell) => !cell.future);
  const tabStop = () => focused() < 0 ? todayIndex() : Math.min(focused(), todayIndex());
  const describe = (index: number) => {
    const day = calendar().cells[index];
    return `${dayFormat.format(new Date(`${day.date}T00:00:00Z`))} · ${day.count} loaded ${day.count === 1 ? "post" : "posts"}`;
  };
  const keyboard = (event: KeyboardEvent, index: number) => {
    const moves: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
    let next = index;
    if (event.key in moves) next += moves[event.key];
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = todayIndex();
    else return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(next, todayIndex()))]?.focus();
  };

  return (
    <section class="cutroom-activity" aria-label="Publishing activity">
      <header class="cutroom-activity-header">
        <div><h2>Publishing activity</h2><p><strong>{calendar().total}</strong> {calendar().total === 1 ? "post" : "posts"} in the past year <span>· {calendar().activeDays} active {calendar().activeDays === 1 ? "day" : "days"}</span></p></div>
        <span class="cutroom-activity-period"><span />Past year</span>
      </header>
      <div class="cutroom-activity-calendar" role="group" aria-label="Posts by day, in UTC. Use arrow keys to explore dates.">
        <div class="cutroom-activity-weekdays" aria-hidden="true"><span>Mon</span><span>Wed</span><span>Fri</span></div>
        <div class="cutroom-activity-body">
          <div class="cutroom-activity-months" aria-hidden="true"><For each={months()}>{(month) => <span style={{ "grid-column": `${month.column + 1} / span ${Math.min(3, 53 - month.column)}` }}>{month.label}</span>}</For></div>
          <div class="cutroom-activity-dots" onMouseLeave={() => setHovered(null)}>
            <For each={calendar().cells}>{(day, index) => (
              <button
                ref={(element) => { buttons[index()] = element; }}
                type="button"
                class="cutroom-activity-dot"
                classList={{ "is-future": day.future, "is-today": index() === todayIndex() }}
                data-level={day.level}
                disabled={day.future}
                tabIndex={index() === tabStop() ? 0 : -1}
                aria-label={day.future ? `${day.date}, future date` : describe(index())}
                title={day.future ? undefined : describe(index())}
                onMouseEnter={() => setHovered(index())}
                onFocus={() => { setFocused(index()); setHovered(index()); }}
                onBlur={() => setHovered(null)}
                onClick={() => { setFocused(index()); setHovered(index()); }}
                onKeyDown={(event) => keyboard(event, index())}
              />
            )}</For>
          </div>
        </div>
      </div>
      <footer class="cutroom-activity-footer">
        <span aria-live="polite">{hovered() !== null ? describe(hovered()!) : props.hasMore ? "Loaded posts only · older posts may be missing · UTC" : "Publishing dates from your loaded posts · UTC"}</span>
        <div class="cutroom-activity-legend" aria-label="Dot brightness indicates posts per day, from zero to four or more"><span>Less</span><For each={[0, 1, 2, 3, 4]}>{(level) => <i data-level={level} />}</For><span>More</span></div>
      </footer>
    </section>
  );
}
