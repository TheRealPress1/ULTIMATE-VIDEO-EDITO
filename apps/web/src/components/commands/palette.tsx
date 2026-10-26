/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { Dialog } from "@kobalte/core/dialog";
import { Command as CommandPrimitive, defaultFilter } from "cmdk-solid";
import { Icon } from "@/components/ui/icon";
import { cx } from "@/lib/cva";
import { SECTIONS, useCommands } from "@/context/commands";

import type { LayerSection, LayeredCommand, RegisteredCommand } from "@/context/commands";

const offered = (command: RegisteredCommand) => command.palette !== false && (command.available?.() ?? true);

/**
 * The least score a match needs to be listed. cmdk matches letters anywhere
 * in order, so "group" finds g…r…o…u…p across a command's keywords; such a
 * match scores well under this, a word or prefix or initials well over.
 */
const MIN_SCORE = 0.05;

/** How many of the commands last carried out the palette lists over the rest. */
const RECENTS_LISTED = 4;

/** The bump the palette gives when it goes into a layer or back: down, then up again. */
const LAYER_BUMP: Keyframe[] = [{ scale: "1" }, { scale: "0.98" }, { scale: "1" }];

/**
 * The command palette, on ⌘K: the commands on offer, by section, found by
 * typing; the arrows pick one, Enter carries it out. A command with options
 * lists them in a layer of its own, which Esc goes back from.
 */
export function CommandPalette() {
  const commands = useCommands();

  // Picking a command can hand the focus to what it opens (the prompt box),
  // which the dialog would otherwise take back on its way out.
  let picked = false;
  // What was highlighted when a layer came up, highlighted again on the way back.
  let returnTo: string | undefined;
  let content: HTMLDivElement | undefined;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    // Nothing on offer outside the editor yet: ⌘K is left alone there.
    if (!commands.paletteOpen() && !commands.commands().some(offered)) return;

    // Ahead of the editor, which would record the K as held.
    event.preventDefault();
    event.stopPropagation();
    commands.setPaletteOpen(!commands.paletteOpen());
  };

  onMount(() => window.addEventListener("keydown", onKeyDown, true));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));

  const pick = (command: RegisteredCommand, value: string) => {
    if (command.layer) returnTo = value;
    else picked = true;
    commands.execute(command);
  };

  const pickOption = (command: LayeredCommand, id: string) => {
    commands.setPaletteOpen(false);
    command.layer.pick(id);
  };

  // Not on the way out: closing takes the layer down too.
  createEffect(
    on(commands.layer,
      () => {
        if (commands.paletteOpen()) {
          content?.animate(LAYER_BUMP, { duration: 200, easing: "ease-out" });
        }
      },
      { defer: true },
    ),
  );

  return (
    <Dialog open={commands.paletteOpen()} onOpenChange={commands.setPaletteOpen}>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-50 bg-overlay-soft data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0" />
        <Dialog.Content
          ref={content}
          class="fixed top-[20vh] left-1/2 z-50 w-full max-w-[calc(100%-2rem)] sm:max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground outline-none shadow-[0px_12px_24px_0px_rgba(0,0,0,0.24)] data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-[0.98] data-[expanded]:zoom-in-[0.98] duration-100"
          onEscapeKeyDown={(event: KeyboardEvent) => {
            if (!commands.layer()) return;
            event.preventDefault();
            commands.back();
          }}
          onCloseAutoFocus={(event: Event) => {
            if (picked) event.preventDefault();
            picked = false;
            returnTo = undefined;
          }}
        >
          <Dialog.Title class="sr-only">Commands</Dialog.Title>
          <Show when={commands.layer()} keyed fallback={<PaletteContent initial={returnTo} onPick={pick} />}>
            {(command) => <LayerContent command={command} onPick={(id) => pickOption(command, id)} />}
          </Show>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}

type ListedSection = {
  name: string;
  commands: RegisteredCommand[];
  /** Tells its items from the same commands listed in another section. */
  key?: string;
};

/**
 * The commands on offer that match `search`, in sections. Without a search,
 * sections in `SECTIONS` order and commands by `order`, then in the order
 * they registered;
 * with one, the best match first, and the section it is in. cmdk scores,
 * but leaves the order alone under Solid.
 */
function rank(commands: RegisteredCommand[], search: string): ListedSection[] {
  const query = search.trim();
  const matches = commands
    .filter(offered)
    .map((command) => ({
      command,
      score: query ? defaultFilter(command.title, query, [command.group, ...(command.keywords ?? [])]) : 1,
    }))
    .filter((match) => match.score >= MIN_SCORE)
    .sort(
      (a, b) =>
        b.score - a.score ||
        SECTIONS.indexOf(a.command.group) - SECTIONS.indexOf(b.command.group) ||
        (a.command.order ?? 0) - (b.command.order ?? 0),
    );

  const byName = new Map<string, RegisteredCommand[]>();
  for (const { command } of matches) {
    const section = byName.get(command.group);
    if (section) section.push(command);
    else byName.set(command.group, [command]);
  }
  return [...byName].map(([name, list]) => ({ name, commands: list }));
}

const LIST_CLASS =
  "max-h-[min(400px,60vh)] scroll-pt-1 scroll-pb-2.5 overflow-y-auto overflow-x-hidden px-3 pt-1 pb-2.5 [&_[cmdk-list-sizer]]:flex [&_[cmdk-list-sizer]]:flex-col [&_[cmdk-list-sizer]]:gap-2";

const GROUP_CLASS =
  "[&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:h-8 [&_[cmdk-group-heading]]:items-center [&_[cmdk-group-heading]]:px-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:select-none";

const ITEM_CLASS = "group flex h-9 cursor-default items-center text-xs text-foreground outline-hidden select-none";

/** The highlight is a row inset in the item, 2px short of it top and bottom. */
const ROW_CLASS = "flex h-8 min-w-0 flex-1 items-center gap-1 rounded-md pr-1 group-data-[selected=true]:bg-accent";

type SearchRowProps = {
  value: string;
  onValueChange(value: string): void;
  placeholder: string;
  onKeyDown?(event: KeyboardEvent): void;
};

/** The search box over a layer's list, focused as the layer comes up. */
function SearchRow(props: SearchRowProps) {
  let input: HTMLInputElement | undefined;
  onMount(() => input?.focus());

  return (
    <div class="flex h-11 shrink-0 px-2">
      <div class="flex min-w-0 flex-1 items-center border-b border-border">
        <span class="flex size-7 shrink-0 items-center justify-center">
          <Icon name="search" class="text-muted-foreground" />
        </span>
        <CommandPrimitive.Input
          ref={input}
          value={props.value}
          onValueChange={props.onValueChange}
          onKeyDown={props.onKeyDown}
          placeholder={props.placeholder}
          class="h-full min-w-0 flex-1 bg-transparent text-xs text-foreground outline-hidden placeholder:text-muted-foreground"
        />
      </div>
    </div>
  );
}

type PaletteContentProps = {
  /** The item highlighted at first; the first one when left out. */
  initial?: string;
  onPick(command: RegisteredCommand, value: string): void;
};

function PaletteContent(props: PaletteContentProps) {
  const commands = useCommands();
  const [search, setSearch] = createSignal("");

  const sections = createMemo((): ListedSection[] => {
    const listed = rank(commands.commands(), search());
    if (search().trim()) return listed;

    const recent = commands
      .recents()
      .map((id) => commands.commands().find((command) => command.id === id && offered(command)))
      .filter((command) => command !== undefined)
      .slice(0, RECENTS_LISTED);
    return recent.length ? [{ name: "Recents", commands: recent, key: "recent" }, ...listed] : listed;
  });

  return (
    <CommandPrimitive label="Commands" loop shouldFilter={false} defaultValue={props.initial} class="flex flex-col">
      <SearchRow value={search()} onValueChange={setSearch} placeholder="Search or type a command" />
      <CommandPrimitive.List class={LIST_CLASS}>
        <CommandPrimitive.Empty class="py-6 text-center text-xs text-muted-foreground">
          No commands found
        </CommandPrimitive.Empty>
        <For each={sections()}>
          {(section) => (
            <CommandPrimitive.Group heading={section.name} class={GROUP_CLASS}>
              <For each={section.commands}>
                {(command) => {
                  const value = section.key ? `${section.key}:${command.id}` : command.id;
                  return (
                    <CommandPrimitive.Item value={value} onSelect={() => props.onPick(command, value)} class={ITEM_CLASS}>
                      <span class={cx(ROW_CLASS, "[&_svg]:text-muted-foreground group-data-[selected=true]:[&_svg]:text-foreground")}>
                        <span class="flex size-7 shrink-0 items-center justify-center">
                          <Show when={command.icon}>{(icon) => <Icon name={icon()} />}</Show>
                        </span>
                        <span class="flex-1 truncate">{command.title}</span>
                        <Show when={command.shortcut}>
                          {(keys) => <span class="shrink-0 px-2 text-xxs text-muted-foreground">{keys().join("")}</span>}
                        </Show>
                      </span>
                    </CommandPrimitive.Item>
                  );
                }}
              </For>
            </CommandPrimitive.Group>
          )}
        </For>
      </CommandPrimitive.List>
    </CommandPrimitive>
  );
}

/** A layer's options that match `search`, in its sections and its order. */
function filterLayer(sections: LayerSection[], search: string): LayerSection[] {
  const query = search.trim();
  if (!query) return sections;

  return sections
    .map((section) => ({
      name: section.name,
      options: section.options.filter((option) => {
        const keywords = [section.name, option.detail, ...(option.keywords ?? [])];
        return defaultFilter(option.title, query, keywords.filter((word) => word !== undefined)) >= MIN_SCORE;
      }),
    }))
    .filter((section) => section.options.length > 0);
}

type LayerContentProps = {
  command: LayeredCommand;
  onPick(id: string): void;
};

/** A command's options, in place of the commands; Backspace in an empty search goes back. */
function LayerContent(props: LayerContentProps) {
  const commands = useCommands();
  const [search, setSearch] = createSignal("");

  const sections = createMemo(() => filterLayer(props.command.layer.sections(), search()));

  // The option highlighted at first, when it is listed.
  const current = props.command.layer.current?.();
  const initial = sections().some((section) => section.options.some((option) => option.id === current))
    ? current
    : undefined;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Backspace" || search()) return;
    event.preventDefault();
    commands.back();
  };

  return (
    <CommandPrimitive label={props.command.title} loop shouldFilter={false} defaultValue={initial} class="flex flex-col">
      <SearchRow
        value={search()}
        onValueChange={setSearch}
        placeholder={props.command.layer.placeholder}
        onKeyDown={onKeyDown}
      />
      <CommandPrimitive.List class={LIST_CLASS}>
        <CommandPrimitive.Empty class="py-6 text-center text-xs text-muted-foreground">
          No options found
        </CommandPrimitive.Empty>
        <For each={sections()}>
          {(section) => (
            <CommandPrimitive.Group heading={section.name} class={GROUP_CLASS}>
              <For each={section.options}>
                {(option) => (
                  <CommandPrimitive.Item value={option.id} onSelect={() => props.onPick(option.id)} class={ITEM_CLASS}>
                    <span class={cx(ROW_CLASS, "pl-2")}>
                      <span class="flex-1 truncate">{option.title}</span>
                      <Show when={option.detail}>
                        <span class="shrink-0 px-2 text-xxs text-muted-foreground">{option.detail}</span>
                      </Show>
                    </span>
                  </CommandPrimitive.Item>
                )}
              </For>
            </CommandPrimitive.Group>
          )}
        </For>
      </CommandPrimitive.List>
    </CommandPrimitive>
  );
}
