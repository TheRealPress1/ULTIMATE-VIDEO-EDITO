import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scrollableParent } from "./stick-to-bottom";

/** Just what `scrollableParent` reads off an element; the web tests run without a DOM. */
class FakeElement {
  constructor(
    readonly overflowY: string,
    readonly scrollHeight: number,
    readonly clientHeight: number,
    readonly parentElement: FakeElement | null = null,
  ) {}
}

const plain = (parent: FakeElement | null) => new FakeElement("visible", 20, 20, parent);
/** The transcript: taller than its window. */
const scroller = () => new FakeElement("auto", 5000, 800);
const find = (target: FakeElement) => scrollableParent(target as unknown as EventTarget);

beforeEach(() => {
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("getComputedStyle", (target: FakeElement) => ({ overflowY: target.overflowY }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scrollableParent", () => {
  it("finds the transcript from text inside it", () => {
    const root = scroller();
    expect(find(plain(plain(root)))).toBe(root);
  });

  it("looks past a code block whose only scroll bar is horizontal", () => {
    // `overflow-x: auto` computes overflow-y to auto as well, with nothing to scroll.
    const root = scroller();
    const pre = new FakeElement("auto", 60, 60, plain(root));
    expect(find(plain(pre))).toBe(root);
  });

  it("stops at a block that does scroll vertically", () => {
    const root = scroller();
    const output = new FakeElement("auto", 600, 240, plain(root));
    expect(find(plain(output))).toBe(output);
  });

  it("does not count overflow that cannot be scrolled to", () => {
    const root = scroller();
    const clipped = new FakeElement("hidden", 600, 240, root);
    expect(find(plain(clipped))).toBe(root);
  });

  it("finds nothing when no ancestor has anything to scroll", () => {
    const short = new FakeElement("auto", 800, 800);
    expect(find(plain(short))).toBeNull();
  });
});
