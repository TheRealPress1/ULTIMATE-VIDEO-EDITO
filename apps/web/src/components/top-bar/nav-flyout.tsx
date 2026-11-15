/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createSignal, onCleanup, type JSX } from "solid-js";
import { Popover as PopoverPrimitive } from "@kobalte/core/popover";

import { PopoverContent, PopoverPortal } from "@/components/ui/popover";

/** How long the pointer rests on a label before its flyout opens. */
const OPEN_DELAY = 90;
/** The grace, in ms, to cross the gap between a label and its flyout before it closes. */
const CLOSE_DELAY = 240;

/**
 * Where a label was last pressed. Going to a page puts a new bar, and a new
 * label, under a pointer that has not moved, and the browser then reports the
 * pointer as having arrived: that arrival is not a wish to open the flyout.
 */
let lastPress: { x: number; y: number } | null = null;
const stationary = (event: PointerEvent) => lastPress !== null && Math.abs(event.clientX - lastPress.x) < 3 && Math.abs(event.clientY - lastPress.y) < 3;

type NavFlyoutProps = {
  label: string;
  /** The page this label is for, so it reads as the open one. */
  active?: boolean;
  /** Pressing the label itself. The flyout closes and this runs. */
  onSelect?: () => void;
  /** A list to work in rather than a link: pressing the label (or anything in the flyout) keeps it open. */
  pinned?: boolean;
  width?: number;
  /** The flyout's content; `close` shuts it, for a row that goes somewhere. */
  children: (close: () => void) => JSX.Element;
};

/**
 * A label in the top bar that opens a flyout under it. Resting the pointer on
 * the label opens it; it stays while the pointer is on the label or the
 * flyout, and closes shortly after it leaves. Working in a flyout (a press in
 * it, or on a `pinned` label) holds it open until Escape or a press outside,
 * so a menu or dialog opened from a row does not close what holds it.
 */
export function NavFlyout(props: NavFlyoutProps) {
  const [hovering, setHovering] = createSignal(false);
  const [held, setHeld] = createSignal(false);
  let timer: number | undefined;
  let label: HTMLButtonElement | undefined;

  const clear = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };
  const enter = () => {
    clear();
    timer = window.setTimeout(() => setHovering(true), OPEN_DELAY);
  };
  const leave = () => {
    clear();
    timer = window.setTimeout(() => setHovering(false), CLOSE_DELAY);
  };
  const close = () => {
    clear();
    setHovering(false);
    setHeld(false);
  };
  onCleanup(clear);

  const open = () => hovering() || held();
  let openAtPress = false;

  return (
    <PopoverPrimitive
      open={open()}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      placement="bottom-start"
      gutter={2}
      modal={false}
    >
      <PopoverPrimitive.Anchor class="inline-flex">
        <button
          ref={label}
          type="button"
          class="cutroom-topnav-item"
          classList={{ "is-active": props.active, "is-open": open() }}
          aria-haspopup="true"
          aria-expanded={open()}
          onPointerEnter={(event) => event.pointerType === "mouse" && !stationary(event) && enter()}
          onPointerMove={(event) => {
            if (event.pointerType !== "mouse" || lastPress === null || stationary(event)) return;
            lastPress = null;
            if (!open()) enter();
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== "mouse") return;
            lastPress = null;
            leave();
          }}
          onPointerDown={(event) => {
            openAtPress = open();
            lastPress = { x: event.clientX, y: event.clientY };
          }}
          onClick={() => {
            if (props.pinned) {
              if (openAtPress) close();
              else setHeld(true);
            } else {
              close();
              props.onSelect?.();
            }
          }}
        >
          {props.label}
        </button>
      </PopoverPrimitive.Anchor>
      <PopoverPortal>
        <PopoverContent
          class="cutroom-flyout"
          style={{ width: `${props.width ?? 300}px` }}
          onOpenAutoFocus={(event: Event) => event.preventDefault()}
          onCloseAutoFocus={(event: Event) => event.preventDefault()}
          // The label is not part of the flyout, but pressing it is not "outside": it has its own say.
          onInteractOutside={(event: Event) => {
            const target = (event as CustomEvent<{ originalEvent?: Event }>).detail?.originalEvent?.target ?? event.target;
            if (label && target instanceof Node && label.contains(target)) event.preventDefault();
          }}
          onPointerEnter={() => {
            clear();
            setHovering(true);
          }}
          onPointerLeave={() => {
            if (!held()) leave();
          }}
          onPointerDown={() => setHeld(true)}
        >
          {props.children(close)}
        </PopoverContent>
      </PopoverPortal>
    </PopoverPrimitive>
  );
}
