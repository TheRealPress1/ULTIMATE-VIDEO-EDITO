/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo } from "solid-js";
import { useTrait, useWorld } from "@diffusionstudio/koota-solid";
import { Computed, FrameRate, Playback, setPlayhead, stopPlayback, togglePlayback } from "@diffusionstudio/runtime";
import { useActiveScene, useDerived } from "@/engine/hooks";
import { seekBy } from "@/engine/input/shortcuts";
import { formatFrames } from "@/components/timeline/time-format";
import { Icon } from "@/components/ui/icon";

/**
 * The transport under the program monitor: the playhead's timecode and the
 * scene's length, a scrub bar, and the buttons for what Space and the arrow
 * keys already do. It moves the same playhead the timeline's ruler does.
 */
export function MonitorBar() {
  const world = useWorld();
  const scene = useActiveScene();
  const frameRate = useTrait(world, FrameRate);
  const playback = useTrait(scene, Playback);
  const now = useDerived(() => scene()?.get(Computed)?.localTime ?? 0);
  const duration = useDerived(() => scene()?.get(Computed)?.duration ?? 0);

  const fps = () => frameRate()?.value ?? 30;
  const last = () => Math.max(0, duration() - 1);
  const progress = createMemo(() => (last() > 0 ? Math.min(1, Math.max(0, now() / last())) : 0));
  const playing = () => playback()?.playing ?? false;

  const seek = (frame: number) => {
    const entity = scene();
    if (entity) setPlayhead(world, entity, Math.max(0, Math.min(last(), Math.round(frame))));
  };
  const toggle = () => {
    const entity = scene();
    if (entity) togglePlayback(world, entity);
  };

  let track!: HTMLDivElement;
  const scrubTo = (event: PointerEvent) => {
    const rect = track.getBoundingClientRect();
    if (rect.width > 0) seek(((event.clientX - rect.left) / rect.width) * last());
  };
  const startScrub = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const entity = scene();
    if (entity && playing()) stopPlayback(world, entity);
    track.setPointerCapture(event.pointerId);
    scrubTo(event);
  };
  const moveScrub = (event: PointerEvent) => {
    if (track.hasPointerCapture(event.pointerId)) scrubTo(event);
  };

  return (
    <div class="cutroom-monitor-bar" data-monitor-bar>
      <div class="cutroom-monitor-time">
        <span class="cutroom-timecode">{formatFrames(now(), fps(), "timecode")}</span>
        <span class="cutroom-monitor-fit">Fit</span>
        <span class="cutroom-monitor-total">{formatFrames(duration(), fps(), "timecode")}</span>
      </div>
      <div
        ref={track}
        class="cutroom-scrub"
        role="slider"
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={last()}
        aria-valuenow={Math.round(now())}
        onPointerDown={startScrub}
        onPointerMove={moveScrub}
      >
        <div class="cutroom-scrub-fill" style={{ width: `${progress() * 100}%` }} />
        <div class="cutroom-scrub-head" style={{ left: `${progress() * 100}%` }} />
      </div>
      <div class="cutroom-transport">
        <button type="button" aria-label="Go to start" title="Go to start" onClick={() => seek(0)}>
          <Icon name="timeline.go-to-start" />
        </button>
        <button type="button" aria-label="Previous frame" title="Previous frame (←)" onClick={() => seekBy(world, -1)}>
          <Icon name="timeline.previous-frame" />
        </button>
        <button type="button" class="is-play" aria-label={playing() ? "Pause" : "Play"} title={playing() ? "Pause (Space)" : "Play (Space)"} onClick={toggle}>
          <Icon name={playing() ? "pause" : "play"} />
        </button>
        <button type="button" aria-label="Next frame" title="Next frame (→)" onClick={() => seekBy(world, 1)}>
          <Icon name="timeline.next-frame" />
        </button>
        <button type="button" aria-label="Go to end" title="Go to end" onClick={() => seek(last())}>
          <Icon name="timeline.go-to-end" />
        </button>
      </div>
    </div>
  );
}
