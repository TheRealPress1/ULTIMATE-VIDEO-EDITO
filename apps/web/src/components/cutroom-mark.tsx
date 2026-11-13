/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createUniqueId } from "solid-js";

/**
 * The logo, small: a total eclipse. A black disc, the thin rim of light along
 * its edge (brightest toward the flare), the warm corona around it, and the
 * diamond-ring flare with its two fine streaks on the upper right. It is
 * apps/desktop/assets/icon.svg without the square, at the same proportions
 * (that file is the artwork; its numbers are scaled by 0.046 here), so it
 * reads as the app icon wherever it appears. The colors are the logo's, not
 * the surrounding text color; the corona and the flare are a little stronger,
 * since the sidebar behind it is lighter than the icon's black square.
 */
export function CutroomMark(props: { class?: string }) {
  const id = createUniqueId();
  const ref = (name: string) => `url(#${id}-${name})`;

  return (
    <svg class={props.class} width="36" height="36" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <defs>
        <radialGradient id={`${id}-corona`} gradientUnits="userSpaceOnUse" cx="24" cy="24" r="22.9">
          <stop offset=".5723" stop-color="#ffae3a" stop-opacity="0" />
          <stop offset=".5959" stop-color="#fff1d6" />
          <stop offset=".6313" stop-color="#ffc66e" stop-opacity=".68" />
          <stop offset=".7198" stop-color="#ffae3a" stop-opacity=".32" />
          <stop offset=".885" stop-color="#ffae3a" stop-opacity=".1" />
          <stop offset="1" stop-color="#ffae3a" stop-opacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-lit`} gradientUnits="userSpaceOnUse" cx="34.34" cy="15.32" r="43.5">
          <stop offset="0" stop-color="#fff" />
          <stop offset=".5" stop-color="#8d8d8d" />
          <stop offset="1" stop-color="#303030" />
        </radialGradient>
        <mask id={`${id}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
          <rect width="48" height="48" fill={ref("lit")} />
        </mask>
        <linearGradient id={`${id}-rim`} gradientUnits="userSpaceOnUse" x1="34.34" y1="15.32" x2="13.66" y2="32.68">
          <stop offset="0" stop-color="#fff" />
          <stop offset=".5" stop-color="#ffe9c4" stop-opacity=".4" />
          <stop offset="1" stop-color="#ffe9c4" stop-opacity=".12" />
        </linearGradient>
        <radialGradient id={`${id}-spark`} gradientUnits="userSpaceOnUse" cx="34.34" cy="15.32" r="5.6">
          <stop offset="0" stop-color="#fff" />
          <stop offset=".1" stop-color="#fff4de" stop-opacity=".9" />
          <stop offset=".22" stop-color="#ffe0a8" stop-opacity=".5" />
          <stop offset=".4" stop-color="#ffc060" stop-opacity=".2" />
          <stop offset=".62" stop-color="#ffae3a" stop-opacity=".07" />
          <stop offset="1" stop-color="#ffae3a" stop-opacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-streak-x`} gradientUnits="userSpaceOnUse" x1="25.76" y1="0" x2="42.92" y2="0">
          <stop offset="0" stop-color="#fff" stop-opacity="0" />
          <stop offset=".5" stop-color="#fff" stop-opacity=".85" />
          <stop offset="1" stop-color="#fff" stop-opacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-streak-y`} gradientUnits="userSpaceOnUse" x1="0" y1="8.46" x2="0" y2="22.19">
          <stop offset="0" stop-color="#fff" stop-opacity="0" />
          <stop offset=".5" stop-color="#fff" stop-opacity=".8" />
          <stop offset="1" stop-color="#fff" stop-opacity="0" />
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" r="22.9" fill={ref("corona")} mask={ref("mask")} />
      <circle cx="24" cy="24" r="13.5" fill="#000" />
      <circle cx="24" cy="24" r="13.5" stroke={ref("rim")} stroke-width="1" />
      <circle cx="34.34" cy="15.32" r="5.6" fill={ref("spark")} />
      <rect x="25.76" y="14.92" width="17.16" height=".8" fill={ref("streak-x")} />
      <rect x="33.94" y="8.46" width=".8" height="13.73" fill={ref("streak-y")} />
    </svg>
  );
}
