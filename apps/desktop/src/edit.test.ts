/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The canvas shows an edit before the file has it, and an export and the next
// open render the file: an edit the write left out would move back. So the
// user wins — a prop is written over whatever the source held for it.

import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyEdits } from "./edit";

import type { SourceEdit } from "./edit";

const FILE = "main.tsx";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "edit-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("applyEdits", () => {
  it("writes a prop over a literal and over an expression alike", async () => {
    await writeFile(
      join(dir, FILE),
      `const X = 100;\nexport default () => <video id="clip" x={X} y={20} rotation={ticker() * 2} />;\n`,
    );

    const result = await applyEdits({ dir }, [
      { kind: "set", source: `${FILE}:clip`, props: { x: 555, y: 42, rotation: 90 } },
    ]);

    expect(result.skipped).toEqual([]);
    const text = await readFile(join(dir, FILE), "utf8");
    expect(text).toContain(`<video id="clip" x={555} y={42} rotation={90} />`);
    // The constant is someone else's too, and stays.
    expect(text).toContain(`const X = 100;`);
  });

  it("keeps a text's paint when what it says changes", async () => {
    await writeFile(join(dir, FILE), `export default () => <scene id="s"></scene>;\n`);

    // The draw tool's insert: the text, then its paint under it.
    await applyEdits({ dir }, [
      { kind: "insert", source: "pending#1", parent: `${FILE}:s`, tag: "text", props: {}, text: "Text" },
      { kind: "insert", source: "pending#2", parent: "pending#1", tag: "solidPaint", props: { color: "#FFFFFF" } },
    ]);
    const inserted = await readFile(join(dir, FILE), "utf8");
    const id = /<text id="([^"]+)"/.exec(inserted)![1];

    // Then typing into it, once the insert has its name.
    const result = await applyEdits({ dir }, [{ kind: "set", source: `${FILE}:${id}`, props: {}, text: "Hello" }]);

    expect(result.skipped).toEqual([]);
    const text = await readFile(join(dir, FILE), "utf8");
    expect(text).toMatch(/<text id="[^"]+">Hello\s*<solidPaint id="[^"]+" color="#FFFFFF" \/>\s*<\/text>/);
  });

  it("replaces every part of what a text says, and only that", async () => {
    await writeFile(
      join(dir, FILE),
      `export default () => (\n  <text id="t">\n    Hello {name}!\n    <solidPaint color="#FFFFFF" />\n    {/* note */}\n  </text>\n);\n`,
    );

    const result = await applyEdits({ dir }, [{ kind: "set", source: `${FILE}:t`, props: {}, text: "Bye" }]);

    expect(result.skipped).toEqual([]);
    const text = await readFile(join(dir, FILE), "utf8");
    expect(text).toContain(`  <text id="t">\n    Bye\n    <solidPaint color="#FFFFFF" />\n    {/* note */}\n  </text>`);
  });
});

describe("a remove of what an earlier remove in the same write took along", () => {
  // A clip of a scene, cut in two, is wrapped in a sequence with the tail beside it. The undo of that cut, once the
  // cut has been written, takes the head back out and removes the sequence and the tail: the canvas has the tail out
  // of the sequence by then, and a write that is told only of the removals finds it in the sequence still.
  const BEFORE = `export default () => (
  <scene id="scene" active>
    <audio id="mus" name="Music bed" src="music.mp3" start={0} end={21.9} />
    <sequence id="v1">
      <video id="a" src="a.mp4" start={0} end={5} />
    </sequence>
  </scene>
);
`;
  const CUT = `export default () => (
  <scene id="scene" active>
    <sequence id="wrap" name="Sequence 1">
      <audio id="mus" name="Music bed" src="music.mp3" start={0} end={2.6} />
      <audio id="tail" name="Music bed" src="music.mp3" start={2.6} end={21.9} sourceIn={2.6} selected />
    </sequence>
    <sequence id="v1">
      <video id="a" src="a.mp4" start={0} end={5} />
    </sequence>
  </scene>
);
`;
  const undo = (...removes: string[]): SourceEdit[] => [
    { kind: "move", source: `${FILE}:mus`, parent: `${FILE}:scene`, before: `${FILE}:v1` },
    { kind: "set", source: `${FILE}:mus`, props: { end: 21.9 } },
    ...removes.map((id): SourceEdit => ({ kind: "remove", source: `${FILE}:${id}` })),
  ];

  beforeEach(async () => {
    await writeFile(join(dir, FILE), CUT);
  });

  it.each([
    ["the sequence and then the tail it holds", ["wrap", "tail"]],
    ["the tail and then the sequence", ["tail", "wrap"]],
  ])("takes out %s, and the file is as it was before the cut", async (_, removes) => {
    const result = await applyEdits({ dir, strict: true }, undo(...removes!));

    expect(result).toEqual({ skipped: [] });
    expect(await readFile(join(dir, FILE), "utf8")).toBe(BEFORE);
  });

  it("still reports a remove of what the file never had, and then writes nothing", async () => {
    const result = await applyEdits({ dir, strict: true }, undo("wrap", "tail", "ghost"));

    expect(result.skipped).toEqual([`${FILE}:ghost`]);
    expect(result.error).toBeDefined();
    expect(await readFile(join(dir, FILE), "utf8")).toBe(CUT);
  });

  it("only knows what this write took out: an element an earlier write removed is still missing", async () => {
    await applyEdits({ dir, strict: true }, [{ kind: "remove", source: `${FILE}:wrap` }]);

    const result = await applyEdits({ dir, strict: true }, [{ kind: "remove", source: `${FILE}:tail` }]);

    expect(result.skipped).toEqual([`${FILE}:tail`]);
    expect(result.error).toBeDefined();
  });
});
