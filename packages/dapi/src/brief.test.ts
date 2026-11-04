/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRIEF_MARKER,
  beatKind,
  formatScriptLine,
  parseBrief,
  parseNotes,
  parseScript,
  parseTargetSeconds,
  replaceScript,
  splitSentences,
} from "./brief";

const canonical = `${BRIEF_MARKER}
# Rent in Lisbon

## Goal
- viewer: a remote designer paying €1,400 for a studio in Lisbon
- **Payoff:** teach
- format: how-to
- target: 25-35 s
- aspect: 9:16

## Viewer
Moved in 2024, signs every lease through an agency, never negotiates.

## Script
1. [opener · surprised] You're paying the agency price for a flat you found yourself.
   > delivery: quick, amused | screen: lease on the table, push in | sound: paper rustle
2. [doubt · doubtful] Landlords won't talk to you without an agency, right?
3. [point 1 · curious] Ask the building's porteira who owns the empty flats.
4. [proof · relieved] That's how Inês got €250 off on Rua da Graça.
   > screen: text "€1,400 → €1,150"
5. [close · confident] Knock on one door this week.

## Shot plan
| # | Line | Point | Shot | Job | Source | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | opener | close | feel | film | to film | |
| 2 | 4 | proof | insert, phone | inform | have:footage/ines.mov@8 | have | ask Inês |

## Edit plan
- pace: tight

## Notes
Check the rent figure with Inês.
`;

describe("parseBrief", () => {
  it("reads a canonical brief without warnings", () => {
    const brief = parseBrief(canonical);
    expect(brief.warnings).toEqual([]);
    expect(brief.version).toBe(1);
    expect(brief.hasScript).toBe(true);
    expect(brief.goal).toMatchObject({ viewer: "a remote designer paying €1,400 for a studio in Lisbon", payoff: "teach", format: "how-to", target: "25-35 s", targetSeconds: { min: 25, max: 35 }, aspect: "9:16" });
    expect(brief.viewer).toBe("Moved in 2024, signs every lease through an agency, never negotiates.");
    expect(brief.script.map((line) => line.n)).toEqual([1, 2, 3, 4, 5]);
    expect(brief.script[0]).toEqual({
      n: 1, beat: "opener", emotion: "surprised", text: "You're paying the agency price for a flat you found yourself.",
      notes: { delivery: "quick, amused", screen: "lease on the table, push in", sound: "paper rustle" },
    });
    expect(brief.script[2]).toEqual({ n: 3, beat: "point 1", emotion: "curious", text: "Ask the building's porteira who owns the empty flats." });
    expect(brief.script[3]!.notes).toEqual({ screen: 'text "€1,400 → €1,150"' });
    expect(brief.shotPlan).toEqual([
      { "#": "1", line: "1", point: "opener", shot: "close", job: "feel", source: "film", status: "to film", notes: "" },
      { "#": "2", line: "4", point: "proof", shot: "insert, phone", job: "inform", source: "have:footage/ines.mov@8", status: "have", notes: "ask Inês" },
    ]);
    expect(brief.editPlan).toBe("- pace: tight");
    expect(brief.notes).toBe("Check the rent figure with Inês.");
    expect(Object.keys(brief.sections)).toEqual(["Goal", "Viewer", "Script", "Shot plan", "Edit plan", "Notes"]);
  });

  it("accepts a freeform paragraph script, one sentence per line, with a warning", () => {
    const brief = parseBrief("## Script\nYou think you need an hour. You don't.\nEight minutes is plenty, Dr. Okafor says.\n\nStart tonight.\n");
    expect(brief.script.map((line) => [line.n, line.text])).toEqual([
      [1, "You think you need an hour."],
      [2, "You don't."],
      [3, "Eight minutes is plenty, Dr. Okafor says."],
      [4, "Start tonight."],
    ]);
    expect(brief.warnings).toHaveLength(1);
    expect(brief.warnings[0]).toMatch(/4 script sentences were not numbered/);
  });

  it("numbers bullets after the numbered lines and keeps their labels", () => {
    const brief = parseBrief("## Script\n1. [opener · curious] First line here.\n- [close · warm] Last line. Really.\n");
    expect(brief.script).toEqual([
      { n: 1, beat: "opener", emotion: "curious", text: "First line here." },
      { n: 2, beat: "close", emotion: "warm", text: "Last line." },
      { n: 3, text: "Really." },
    ]);
  });

  it("keeps written numbers when unnumbered sentences sit between them", () => {
    const brief = parseBrief("## Script\n1. One line here.\nA loose sentence. Another one.\n2. Two line here.\n3. Three line here.\n");
    expect(brief.script.map((line) => [line.n, line.text])).toEqual([
      [1, "One line here."],
      [4, "A loose sentence."],
      [5, "Another one."],
      [2, "Two line here."],
      [3, "Three line here."],
    ]);
    expect(brief.warnings).toHaveLength(1);
    expect(brief.warnings[0]).toMatch(/2 script sentences were not numbered/);
    const repeated = parseBrief("## Script\n1. First.\n1. Again.\n2. Second.\n- Loose.\n");
    expect(repeated.script.map((line) => line.n)).toEqual([1, 3, 2, 4]);
    expect(repeated.warnings[0]).toBe("Script line number 1 appears twice; the second one was renumbered 3.");
    expect(repeated.warnings.join(" ")).not.toMatch(/comes after/);
  });

  it("has no script when there is no Script section, and warns about near misses", () => {
    const none = parseBrief("## Goal\n- viewer: someone\n\n## Notes\nnothing yet\n");
    expect(none.hasScript).toBe(false);
    expect(none.script).toEqual([]);
    expect(none.warnings).toEqual([]);
    const nearMiss = parseBrief("## Goal\n- format: list\n\n### Script\n1. A line.\n");
    expect(nearMiss.hasScript).toBe(false);
    expect(nearMiss.warnings.join(" ")).toMatch(/exact "## Script" heading/);
    expect(parseBrief("## Script draft\n1. A line.\n").hasScript).toBe(false);
    expect(parseBrief("## script\n1. A line.\n").script).toHaveLength(1);
  });

  it("keeps pipes inside note fields", () => {
    const brief = parseBrief('## Script\n1. [point · tense] Rent, food, fun.\n   > screen: split text "rent | food | fun" | sound: register ding | delivery: fast\n');
    expect(brief.script[0]!.notes).toEqual({ screen: 'split text "rent | food | fun"', sound: "register ding", delivery: "fast" });
    expect(parseNotes("whisper it | on-screen: big 41")).toEqual({ other: "whisper it", screen: "big 41" });
  });

  it("fills missing shot-plan cells with empty strings and says so", () => {
    const brief = parseBrief("## Shot plan\n| # | Line | Shot | Source |\n|---|---|---|---|\n| 1 | 2 | close |\n| 2 | 3 | wide | film | extra |\n| 3 | 4 | a \\| b | web:kettle |\n");
    expect(brief.shotPlan).toEqual([
      { "#": "1", line: "2", shot: "close", source: "" },
      { "#": "2", line: "3", shot: "wide", source: "film" },
      { "#": "3", line: "4", shot: "a | b", source: "web:kettle" },
    ]);
    expect(brief.warnings).toEqual([
      "Shot plan row 1 has 3 of 4 cells; the missing ones are empty.",
      "Shot plan row 2 has 1 more cells than the header; they were ignored.",
    ]);
    expect(parseBrief("## Shot plan\nto do\n").warnings[0]).toMatch(/has no table/);
  });

  it("reads a CRLF file with a byte-order mark the same as LF", () => {
    const crlf = "﻿" + canonical.replace(/\n/g, "\r\n");
    const a = parseBrief(crlf);
    const b = parseBrief(canonical);
    expect(a).toEqual(b);
  });

  it("reads a 200-line script", () => {
    const text = "## Script\n" + Array.from({ length: 200 }, (_, i) => `${i + 1}. [point ${i + 1} · calm] Line number ${i + 1} says one thing.`).join("\n");
    const brief = parseBrief(text);
    expect(brief.script).toHaveLength(200);
    expect(brief.script[199]).toMatchObject({ n: 200, beat: "point 200", text: "Line number 200 says one thing." });
    expect(brief.warnings).toEqual([]);
  });

  it("renumbers a repeated number, joins indented continuations and skips fences and comments", () => {
    const brief = parseBrief([
      "## Script",
      "<!-- draft two -->",
      "1. [opener] A sentence that wraps",
      "   onto the next line.",
      "1. Second line.",
      "```",
      "2. not a line",
      "```",
      "> stray note",
    ].join("\n"));
    expect(brief.script).toEqual([
      { n: 1, beat: "opener", text: "A sentence that wraps onto the next line." },
      { n: 2, text: "Second line.", notes: { other: "stray note" } },
    ]);
    expect(brief.warnings[0]).toMatch(/appears twice/);
  });

  it("reads only the first of duplicate sections, and never throws", () => {
    const brief = parseBrief("## Script\n1. First.\n\n## Script\n1. Second.\n");
    expect(brief.script.map((line) => line.text)).toEqual(["First."]);
    expect(brief.warnings[0]).toMatch(/more than once/);
    for (const junk of ["", "\0\0\0", "## \n##\n#", "|||\n|-|", "1.", "> >", "[]", 42 as unknown as string, null as unknown as string]) {
      expect(() => parseBrief(junk)).not.toThrow();
    }
    expect(parseBrief("<!-- cutroom:brief v3 -->").warnings[0]).toMatch(/v3/);
  });

  it("parses the worked example in docs/reference/brief.md without warnings", () => {
    const doc = join(__dirname, "..", "..", "..", "docs", "reference", "brief.md");
    if (!existsSync(doc)) return;
    const example = /```markdown\n([\s\S]*?)\n```/.exec(readFileSync(doc, "utf8"))?.[1];
    expect(example).toBeDefined();
    const brief = parseBrief(example!);
    expect(brief.warnings).toEqual([]);
    expect(brief.version).toBe(1);
    expect(brief.script).toHaveLength(8);
    expect(brief.goal?.targetSeconds).toEqual({ min: 30, max: 40 });
    expect(brief.shotPlan?.every((row) => Object.keys(row).length === 8)).toBe(true);
  });
});

describe("replaceScript", () => {
  const outside = (text: string) => {
    const lines = text.split(/(?<=\n)/);
    const start = lines.findIndex((line) => /^## Script\r?\n$/.test(line));
    const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
    return { before: lines.slice(0, start + 1).join(""), after: end < 0 ? "" : lines.slice(end).join("") };
  };

  it("round-trips the script and leaves every other section byte-identical", () => {
    const brief = parseBrief(canonical);
    const rewritten = replaceScript(canonical, brief.script);
    expect(outside(rewritten)).toEqual(outside(canonical));
    expect(parseBrief(rewritten).script).toEqual(brief.script);
    expect(rewritten).toBe(canonical);
  });

  it("round-trips notes with a part that has no key", () => {
    const text = "## Script\n1. [proof · calm] It worked in May.\n   > whisper it | delivery: slow | screen: €250 on screen\n";
    const brief = parseBrief(text);
    expect(brief.script[0]!.notes).toEqual({ other: "whisper it", delivery: "slow", screen: "€250 on screen" });
    const rewritten = replaceScript(text, brief.script);
    expect(rewritten).toBe(text);
    expect(parseBrief(rewritten).script).toEqual(brief.script);
    expect(parseBrief(replaceScript(rewritten, parseBrief(rewritten).script)).script).toEqual(brief.script);
  });

  it("keeps CRLF line endings and rewrites only the script", () => {
    const crlf = canonical.replace(/\n/g, "\r\n");
    const lines = parseBrief(crlf).script.map((line) => (line.n === 5 ? { ...line, text: "Knock on one door before Friday." } : line));
    const rewritten = replaceScript(crlf, lines);
    expect(outside(rewritten)).toEqual(outside(crlf));
    expect(rewritten).toContain("5. [close · confident] Knock on one door before Friday.\r\n");
    expect(rewritten.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("appends a Script section when there is none, and handles a script at the end of the file", () => {
    expect(replaceScript("## Goal\n- format: list", [{ n: 1, text: "Hi." }])).toBe("## Goal\n- format: list\n\n## Script\n\n1. Hi.\n");
    expect(replaceScript("", [{ n: 1, text: "Hi." }])).toBe("## Script\n\n1. Hi.\n");
    expect(replaceScript("## Script\n1. Old.", [{ n: 1, beat: "close", text: "New." }])).toBe("## Script\n1. [close] New.\n");
    expect(replaceScript("## Script\n\n1. Old.\n\n## Notes\nx\n", [{ n: 1, text: "New." }])).toBe("## Script\n\n1. New.\n\n## Notes\nx\n");
    expect(replaceScript("## Script\n## Notes\n", [{ n: 1, text: "New." }])).toBe("## Script\n\n1. New.\n\n## Notes\n");
  });
});

describe("helpers", () => {
  it("formats a line with its notes", () => {
    expect(formatScriptLine({ n: 3, beat: "proof", emotion: "relieved", text: "It worked.", notes: { sound: "hit", delivery: "slow" } }))
      .toBe("3. [proof · relieved] It worked.\n   > delivery: slow | sound: hit");
    expect(formatScriptLine({ n: 1, emotion: "calm", text: " Plain. " })).toBe("1. [calm] Plain.");
    expect(formatScriptLine({ n: 2, text: "Go.", notes: { delivery: "slow", other: "whisper it" } })).toBe("2. Go.\n   > whisper it | delivery: slow");
  });

  it("reads target lengths", () => {
    expect(parseTargetSeconds("30-45 s")).toEqual({ min: 30, max: 45 });
    expect(parseTargetSeconds("0:30–0:45")).toEqual({ min: 30, max: 45 });
    expect(parseTargetSeconds("1-2 min")).toEqual({ min: 60, max: 120 });
    expect(parseTargetSeconds("under 60s")).toEqual({ min: 0, max: 60 });
    expect(parseTargetSeconds("40 seconds")).toEqual({ min: 34, max: 46 });
    expect(parseTargetSeconds("short")).toBeUndefined();
  });

  it("names beats through their aliases", () => {
    expect(beatKind("hook")).toBe("opener");
    expect(beatKind("Point 2")).toBe("point");
    expect(beatKind("point: rent")).toBe("point");
    expect(beatKind("CTA")).toBe("close");
    expect(beatKind("story")).toBeNull();
    expect(beatKind(undefined)).toBeNull();
  });

  it("splits sentences without breaking decimals, initials or abbreviations", () => {
    expect(splitSentences("It cost $1.50 a day. J. R. said so. Ask Dr. Reyes! Then go.")).toEqual(["It cost $1.50 a day.", "J. R. said so.", "Ask Dr. Reyes!", "Then go."]);
    expect(splitSentences("wait... what? yes")).toEqual(["wait... what? yes"]);
  });

  it("reads bare script text the way the Script section is read", () => {
    expect(parseScript("1. [opener · curious] One.\n2. Two.")).toEqual([{ n: 1, beat: "opener", emotion: "curious", text: "One." }, { n: 2, text: "Two." }]);
  });
});
