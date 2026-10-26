/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo, createSignal, splitProps, type ComponentProps } from "solid-js";
import { createElementSize } from "@solid-primitives/resize-observer";
import { cx } from "@/lib/cva";

const ELLIPSIS = "…";

let context: CanvasRenderingContext2D | null | undefined;

/**
 * Bumped whenever the document finishes loading fonts: text measured before
 * the web font arrived was measured in the fallback font.
 */
const [fontVersion, setFontVersion] = createSignal(0);
const bumpFontVersion = () => setFontVersion((version) => version + 1);
document.fonts.ready.then(bumpFontVersion);
document.fonts.addEventListener("loadingdone", bumpFontVersion);

/**
 * `text` shortened in the middle, keeping its start and end, so that it fits
 * `width` CSS pixels in `font` (a CSS font shorthand).
 */
function middleEllipsis(text: string, width: number, font: string): string {
  context ??= document.createElement("canvas").getContext("2d");
  if (!context) return text;

  context.font = font;
  const fits = (candidate: string) => context!.measureText(candidate).width <= width;
  if (fits(text)) return text;

  // Code points, so a surrogate pair is never split
  const chars = Array.from(text);
  const shorten = (kept: number) =>
    chars.slice(0, Math.ceil(kept / 2)).join("") + ELLIPSIS + chars.slice(chars.length - Math.floor(kept / 2)).join("");

  // The most characters that still fit beside the ellipsis
  let low = 0;
  let high = chars.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(shorten(mid))) low = mid;
    else high = mid - 1;
  }

  return shorten(low);
}

export type MiddleEllipsisProps = ComponentProps<"div"> & {
  text: string;
};

/**
 * Single-line text that is shortened in the middle rather than at the end
 * when it does not fit its width, so both the start and the end of a name
 * (such as its extension) stay visible.
 */
export function MiddleEllipsis(props: MiddleEllipsisProps) {
  const [local, rest] = splitProps(props, ["text", "class"]);
  const [element, setElement] = createSignal<HTMLDivElement>();
  const size = createElementSize(element);

  const shown = createMemo(() => {
    const el = element();
    const width = size.width;
    fontVersion();
    if (!el || !width) return local.text;
    return middleEllipsis(local.text, width, getComputedStyle(el).font);
  });

  return (
    <div ref={setElement} class={cx("overflow-hidden whitespace-nowrap", local.class)} {...rest}>
      {shown()}
    </div>
  );
}
