/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";

import { claudeModelLabel, claudeModels } from "../src/host/claude";

// What `claude` 2.1.236 reports on a signed-in machine.
const ROWS = [
  { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)" },
  { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)" },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku" },
];

describe("claudeModelLabel", () => {
  it("reads family and version off the wire id", () => {
    expect(ROWS.map(claudeModelLabel)).toEqual(["Opus 5", "Opus 5", "Fable 5.1", "Sonnet 5", "Haiku 4.5"]);
  });

  it("keeps the CLI's label when the id has no version", () => {
    expect(claudeModelLabel({ value: "custom", displayName: "Custom (gateway)" })).toBe("Custom (gateway)");
    expect(claudeModelLabel({ value: "opus", resolvedModel: "gpt-9", displayName: "Opus" })).toBe("Opus");
  });
});

describe("claudeModels", () => {
  it("collapses aliases onto one row and points the default at it", () => {
    const { models, defaultModel } = claudeModels(ROWS);
    expect(models).toEqual([
      { id: "opus[1m]", label: "Opus 5" },
      { id: "claude-fable-5-1[1m]", label: "Fable 5.1" },
      { id: "sonnet", label: "Sonnet 5" },
      { id: "haiku", label: "Haiku 4.5" },
    ]);
    expect(defaultModel).toBe("opus[1m]");
  });

  it("keeps a default that resolves to nothing else", () => {
    const { models, defaultModel } = claudeModels([
      { value: "default", resolvedModel: "claude-opus-5", displayName: "Default" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" },
    ]);
    expect(models).toEqual([
      { id: "default", label: "Opus 5" },
      { id: "sonnet", label: "Sonnet 5" },
    ]);
    expect(defaultModel).toBe("default");
  });

  it("survives rows without resolvedModel", () => {
    const { models, defaultModel } = claudeModels([{ value: "sonnet", displayName: "Sonnet" }]);
    expect(models).toEqual([{ id: "sonnet", label: "Sonnet" }]);
    expect(defaultModel).toBe("sonnet");
  });
});
