/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { isInputTarget } from "@/utils/browser";

import type { ProjectInfo } from "@/projects";

type ProjectSelectionOptions<T extends ProjectInfo> = {
  /** The projects the grid shows, in the order it shows them. */
  projects: () => T[];
  /** The grid itself: its columns, and the cards arrows move focus to. */
  grid: () => HTMLElement | undefined;
  /** Delete or Backspace with projects selected. */
  onDelete: (projects: T[]) => void;
};

/**
 * Finder's selection, over a grid of project cards: a click selects one card,
 * ⌘/Ctrl-click adds or removes one, Shift-click selects the run from the last
 * card clicked, ⌘/Ctrl-A selects them all, the arrows move the selection
 * (Shift extends it), Escape clears it, and Delete (or ⌘⌫) asks to delete it.
 *
 * The keys are heard on the window, while focus is on the page itself or in
 * the grid — not in a field, a menu, or a dialog. The grid's first cell is
 * the New project card, which is never selected.
 */
export function createProjectSelection<T extends ProjectInfo>(options: ProjectSelectionOptions<T>) {
  const [dirs, setDirs] = createSignal<ReadonlySet<string>>(new Set());
  // Where a Shift range starts, where Shift-arrows move from, and what was
  // selected before the range — the range is added to that.
  let anchor: string | null = null;
  let lead: string | null = null;
  let base: ReadonlySet<string> = new Set();

  /** What is selected and still on the grid, in grid order. */
  const selected = createMemo(() => options.projects().filter((project) => dirs().has(project.dir)));

  const isSelected = (project: T) => dirs().has(project.dir);

  const selectOnly = (dir: string) => {
    setDirs(new Set([dir]));
    anchor = lead = dir;
    base = new Set();
  };

  /** Selects anchor through `dir` on top of `base`, or just `dir` when the anchor is off the grid. */
  const selectRangeTo = (dir: string) => {
    const projects = options.projects();
    const from = projects.findIndex((project) => project.dir === anchor);
    const to = projects.findIndex((project) => project.dir === dir);
    if (from < 0 || to < 0) return selectOnly(dir);

    const next = new Set(base);
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(projects[i].dir);
    setDirs(next);
    lead = dir;
  };

  /** A click on a card; a Space press on one, with no event, is a plain click. */
  const click = (project: T, event?: MouseEvent) => {
    if (event?.shiftKey) return selectRangeTo(project.dir);

    if (event?.metaKey || event?.ctrlKey) {
      const next = new Set(dirs());
      if (!next.delete(project.dir)) next.add(project.dir);
      setDirs(next);
      anchor = lead = project.dir;
      base = new Set([...next].filter((dir) => dir !== project.dir));
      return;
    }

    selectOnly(project.dir);
  };

  /** A right-click keeps the selection it lands in, and replaces any other. */
  const contextMenu = (project: T) => {
    if (!isSelected(project)) selectOnly(project.dir);
  };

  /** What a card's menu acts on: the selection when the card is in it, else the card alone. */
  const targets = (project: T) => (isSelected(project) ? selected() : [project]);

  const clear = () => {
    setDirs(new Set<string>());
    anchor = lead = null;
    base = new Set();
  };

  const selectAll = () => {
    const projects = options.projects();
    setDirs(new Set(projects.map((project) => project.dir)));
    anchor = projects[0]?.dir ?? null;
    lead = projects.at(-1)?.dir ?? null;
    base = new Set();
  };

  /** Moves the lead a cell over, or a row up or down, as Finder's icon view does. */
  const move = (key: string, extend: boolean) => {
    const projects = options.projects();
    const grid = options.grid();
    if (projects.length === 0 || !grid) return;

    // Cells count the New project card at 0, so project i sits in cell i + 1.
    const columns = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").length);
    const count = projects.length;
    const from = projects.findIndex((project) => project.dir === lead);

    let cell: number;
    if (from < 0) {
      cell = 1;
    } else {
      const current = from + 1;
      if (key === "ArrowLeft") cell = current - 1;
      else if (key === "ArrowRight") cell = current + 1;
      else if (key === "ArrowUp") cell = current - columns;
      // Down from a row above a short last row lands on its last card.
      else if (current + columns <= count) cell = current + columns;
      else if (Math.floor(current / columns) < Math.floor(count / columns)) cell = count;
      else return;

      if (cell < 1 || cell > count) return;
    }

    const dir = projects[cell - 1].dir;
    if (extend && anchor !== null) selectRangeTo(dir);
    else selectOnly(dir);

    grid.querySelectorAll<HTMLElement>('[data-slot="card-button"]')[cell]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isInputTarget(event)) return;
    const target = event.target as Node;
    if (target !== document.body && !options.grid()?.contains(target)) return;

    const mod = event.metaKey || event.ctrlKey;

    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAll();
      return;
    }

    // ⌘⌫ is Finder's Move to Trash; the bare keys are kept from before.
    if ((event.key === "Backspace" || event.key === "Delete") && !event.shiftKey && !event.altKey) {
      const projects = selected();
      if (projects.length === 0) return;
      event.preventDefault();
      options.onDelete(projects);
      return;
    }

    if (mod || event.altKey) return;

    if (event.key === "Escape") {
      if (dirs().size === 0) return;
      event.preventDefault();
      clear();
      return;
    }

    if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      move(event.key, event.shiftKey);
    }
  };

  onMount(() => {
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  return { selected, isSelected, click, contextMenu, targets, clear };
}
