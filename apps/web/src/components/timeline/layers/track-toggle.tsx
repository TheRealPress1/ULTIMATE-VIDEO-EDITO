/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from '@/components/ui/tooltip';
import { cx } from '@/lib/cva';

import type { JSX } from 'solid-js';

/** Where a switch a row does not have would be, so the ones it has stay in line with those of the rows around it. */
export function TrackSlot() {
  return <span class="size-[22px] shrink-0" aria-hidden="true" />;
}

/**
 * One of the compact switches of a track header: the eye, the mute, the solo,
 * the padlock. The same square whichever a row has, so a column of headers
 * lines up. The mute and the solo are letters, as an editor's are; the others
 * bring their icon.
 */
export function TrackToggle(props: {
  label: string;
  on: boolean;
  /** How the switch looks when it is on: the solo is the one that quietens everything else, so it stands out. */
  tone?: 'solo';
  /** Hidden until the row is hovered, unless it is on: for the rows below the tracks. */
  reveal?: boolean;
  onClick: (event: MouseEvent) => void;
  children: JSX.Element;
}) {
  return (
    <Tooltip placement="bottom">
      <TooltipTrigger
        type="button"
        aria-label={props.label}
        aria-pressed={props.on}
        class={cx(
          'size-[22px] shrink-0 rounded-[4px] flex items-center justify-center transition-colors focus-ring',
          props.on
            ? props.tone === 'solo' ? 'bg-amber-400 text-black' : 'bg-tertiary text-tertiary-foreground'
            : 'text-muted-foreground/70 hover:text-foreground hover:bg-accent',
          props.reveal && !props.on && 'invisible group-hover:visible',
        )}
        onClick={props.onClick}
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent>{props.label}</TooltipContent>
      </TooltipPortal>
    </Tooltip>
  );
}
