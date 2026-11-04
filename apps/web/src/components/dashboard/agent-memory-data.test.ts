/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { MEMORY_LIMITS, MEMORY_TARGETS } from "@diffusionstudio/dapi";
import { MEMORY_LISTS, historyLabel, originLabel, usageLine, usageRatio, usageTone, withheldLabel } from "./agent-memory-data";

describe("agent memory settings", () => {
  it("labels both lists the tool knows", () => {
    expect(MEMORY_LISTS.map((list) => list.target)).toEqual([...MEMORY_TARGETS]);
  });

  it("meters each list by whichever budget is closer to full", () => {
    const usage = { chars: 1500, limit: MEMORY_LIMITS.profile.chars, entries: 3, maxEntries: MEMORY_LIMITS.profile.entries };
    expect(usageLine(usage)).toBe("1,500 / 2,000 characters · 3 of 20 entries");
    expect(usageRatio(usage)).toBe(0.75);
    expect(usageTone(usage)).toBe("ok");
    expect(usageTone({ ...usage, entries: 18 })).toBe("near");
    expect(usageTone({ ...usage, chars: 2400 })).toBe("full");
    expect(usageRatio({ ...usage, chars: 2400 })).toBe(1);
  });

  it("says why an entry is withheld from chats, and who wrote it", () => {
    expect(withheldLabel({ withheld: "secret" })).toBe("Not shown to chats: it looks like a credential. Edit or delete it.");
    expect(withheldLabel({})).toBeNull();
    expect(originLabel({ origin: "agent" })).toBe("Saved by an agent");
    expect(originLabel({ origin: "settings" })).toBe("Added by you");
  });

  it("describes an earlier version", () => {
    expect(historyLabel({ id: "000004-2026-11-03T12-00-00-000Z", revision: 4, savedAt: "2026-11-03T12:00:00.000Z", entries: 1 }, "en-US", "UTC"))
      .toBe("Revision 4 · 1 entry · replaced Nov 3, 2026, 12:00 PM");
  });
});
