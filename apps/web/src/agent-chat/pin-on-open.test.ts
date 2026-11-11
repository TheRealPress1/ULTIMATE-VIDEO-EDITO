import { afterEach, describe, expect, it, vi } from "vitest";

// Under node "solid-js" resolves to its server build, which never re-runs an
// effect. These tests are about re-runs, so they take the browser build the app ships.
vi.mock("solid-js", () => import("solid-js/dist/solid.js" as string));

import { createRoot, createSignal } from "solid-js";

import { createPinOnOpen } from "./pin-on-open";

type Item = { id: number };

const disposers: Array<() => void> = [];

/** The transcript's wiring: a chat key, and an items array that every streamed event replaces. */
function mount(initial: Item[]) {
  const [chatKey, setChatKey] = createSignal("chat-a", { equals: false });
  const [items, setItems] = createSignal<Item[]>(initial);
  const pin = vi.fn();
  createRoot((dispose) => {
    disposers.push(dispose);
    createPinOnOpen(chatKey, () => items().length > 0, pin);
  });
  const stream = (count: number) => {
    for (let i = 0; i < count; i++) setItems((current) => [...current, { id: current.length }]);
  };
  return { pin, setChatKey, setItems, stream };
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe("createPinOnOpen", () => {
  it("pins once as a chat opens", () => {
    const { pin } = mount([{ id: 0 }]);
    expect(pin).toHaveBeenCalledTimes(1);
  });

  it("does not pin again while a turn streams more items into the chat", () => {
    const { pin, stream } = mount([{ id: 0 }]);
    stream(5);
    expect(pin).toHaveBeenCalledTimes(1);
  });

  it("pins when another chat opens", () => {
    const { pin, setChatKey } = mount([{ id: 0 }]);
    setChatKey("chat-b");
    expect(pin).toHaveBeenCalledTimes(2);
  });

  it("does not pin when the chat key is announced again unchanged", () => {
    const { pin, setChatKey } = mount([{ id: 0 }]);
    setChatKey("chat-a");
    expect(pin).toHaveBeenCalledTimes(1);
  });

  it("pins when an empty chat first has something to show, and not for what streams in after", () => {
    const { pin, setItems, stream } = mount([]);
    expect(pin).toHaveBeenCalledTimes(1);
    setItems([{ id: 0 }]);
    expect(pin).toHaveBeenCalledTimes(2);
    stream(5);
    expect(pin).toHaveBeenCalledTimes(2);
  });
});
