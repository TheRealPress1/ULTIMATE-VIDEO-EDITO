/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The commands the palette (⌘K) offers. A command is registered by the
// component that knows how to carry it out (see `useCommand`), mounted where
// the context it needs is: it is on offer for as long as that component is
// up, and its handlers and its bar see that component's context.

import { createContext, createSignal, getOwner, onCleanup, useContext } from "solid-js";
import { store } from "@/init";
import { createStoredSignal } from "@/lib/store";

import type { Accessor, Component, JSX, Owner } from "solid-js";

/**
 * The palette's sections, in the order it lists them. Fixed here rather than
 * taken from the order commands register in, which depends on what mounted
 * first and changes as parts of the UI come and go.
 */
export const SECTIONS = ["Media", "Generate", "Assets", "Export", "Timeline", "Object", "Tools", "File", "Edit", "View"] as const;

export type Section = (typeof SECTIONS)[number];

/**
 * How many of the commands last carried out are remembered, most recent
 * first. More than the palette lists, so the ones not on offer right now
 * leave room for older ones.
 */
const RECENTS_KEPT = 6;

/** One of the options a command's layer lists. */
export type LayerOption = {
  /** Unique within the layer. */
  id: string;
  title: string;
  /** At the row's end: "1920×1080". */
  detail?: string;
  /** More words it is found by. */
  keywords?: string[];
};

export type LayerSection = { name: string; options: LayerOption[] };

/**
 * A second layer of the palette: the options a command is carried out
 * with, listed in place of the commands until one is picked.
 */
export type CommandLayer = {
  /** The search box's placeholder while the layer is up. */
  placeholder: string;
  sections(): LayerSection[];
  /** The option highlighted when the layer comes up, as the last one picked; the first when left out. */
  current?(): string | undefined;
  /** Carries the command out with the option `id`; the palette is closed by then. */
  pick(id: string): void;
};

type CommandAction =
  | {
    /** What picking it does. */
    run(): void;
    bar?: never;
    ready?: never;
    layer?: never;
  }
  | {
    /**
     * The action bar picking it puts up, over the canvas until the bar
     * closes it (see `useCommands().close`) or Esc does. For commands
     * that need a target picked, or a go-ahead, before they run.
     */
    bar: Component;
    run?: never;
    ready?: never;
    layer?: never;
  }
  | {
    /** The options picking it lists in the palette, one of which carries it out. */
    layer: CommandLayer;
    run?: never;
    bar?: never;
    ready?: never;
  }
  | {
    /** What picking it does while `ready`: what the bar would ask for is settled already. */
    run(): void;
    /** The bar picking it puts up otherwise. */
    bar: Component;
    /** Whether it can run without the bar (what it runs over is selected). */
    ready(): boolean;
    layer?: never;
  };

export type Command = CommandAction & {
  /** Unique among the commands registered at once. */
  id: string;
  title: string;
  /** The palette section it is listed under. */
  group: Section;
  /** Shown beside it in the palette. */
  icon: string;
  /** More words the palette finds it by. */
  keywords?: string[];
  /** The keys it is bound to, one cap each (["⌘", "K"]); shown, not bound. */
  shortcut?: string[];
  /**
   * Where it is listed in its section, lowest first; 0 when left out.
   * Commands with the same index keep the order they registered in.
   */
  order?: number;
  /** Whether it is offered right now; always, when left out. */
  available?(): boolean;
  /**
   * What carrying it out over the selection costs, in credits: shown beside
   * it in menus. Undefined while that isn't known, and for a command that is free.
   */
  credits?(): number | undefined;
  /**
   * False keeps it out of the palette and its recents, for a command only a
   * menu or shortcut reaches, like the one that opens the palette itself.
   */
  palette?: false;
};

/** A command as registered: with the owner of the component that registered it. */
export type RegisteredCommand = Command & { owner: Owner | null };

/** A command whose options the palette lists in a layer of their own. */
export type LayeredCommand = RegisteredCommand & { layer: CommandLayer };

type CommandsContextValue = {
  /** Every command registered right now, in the order they were registered. */
  commands: Accessor<RegisteredCommand[]>;
  paletteOpen: Accessor<boolean>;
  /** Closing it takes its layer down too. */
  setPaletteOpen(open: boolean): void;
  /** The command whose options the palette lists in place of the commands. */
  layer: Accessor<LayeredCommand | null>;
  /** Back from a layer to the commands. */
  back(): void;
  /** The ids of the commands last carried out, most recent first; kept across sessions. */
  recents: Accessor<string[]>;
  /** The command whose bar is up. */
  active: Accessor<RegisteredCommand | null>;
  /** Carries `command` out: runs it, puts its bar up, or lists its options in the palette. */
  execute(command: RegisteredCommand): void;
  /** Takes the bar down. */
  close(): void;
  register(command: RegisteredCommand): () => void;
};

const CommandsContext = createContext<CommandsContextValue>();

export function CommandsProvider(props: { children: JSX.Element }) {
  const [commands, setCommands] = createSignal<RegisteredCommand[]>([]);
  const [paletteOpen, setOpen] = createSignal(false);
  const [layer, setLayer] = createSignal<LayeredCommand | null>(null);
  const [active, setActive] = createSignal<RegisteredCommand | null>(null);
  const [recents, setRecents] = createStoredSignal(store.define<string[]>("commands.recents", []));

  const setPaletteOpen = (open: boolean) => {
    setOpen(open);
    if (!open) setLayer(null);
  };

  const execute = (command: RegisteredCommand) => {
    if (command.palette !== false) {
      setRecents([command.id, ...recents().filter((id) => id !== command.id)].slice(0, RECENTS_KEPT));
    }
    if (command.layer) {
      setLayer({ ...command, layer: command.layer });
      return;
    }
    setPaletteOpen(false);
    if (!command.bar || command.ready?.()) {
      command.run?.();
    } else {
      setActive(command);
    }
  };

  const register = (command: RegisteredCommand) => {
    setCommands((list) => [...list, command]);

    return () => {
      setCommands((list) => list.filter((entry) => entry !== command));
      // Its component is gone, and with it what the bar or the layer was working with.
      if (active() === command) setActive(null);
      if (layer()?.id === command.id) setLayer(null);
    };
  };

  return (
    <CommandsContext.Provider
      value={{ commands, paletteOpen, setPaletteOpen, layer, back: () => setLayer(null), recents, active, execute, close: () => setActive(null), register }}
    >
      {props.children}
    </CommandsContext.Provider>
  );
}

export function useCommands() {
  const context = useContext(CommandsContext);
  if (!context) throw new Error("useCommands must be used within a CommandsProvider");
  return context;
}

/** Offers `command` in the palette for as long as the calling component is mounted. */
export function useCommand(command: Command): void {
  const { register } = useCommands();
  onCleanup(register({ ...command, owner: getOwner() }));
}
