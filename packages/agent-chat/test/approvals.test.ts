/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";

import { requestApproval } from "../src/host/approval";
import { QuestionBox } from "../src/host/harness";
import { emptyTranscript, reduce } from "../src/reduce";

import type { ChatEvent, PendingRequest, RequestResponse } from "../src/protocol";

function fixture() {
  const events: ChatEvent[] = [];
  let transcript = emptyTranscript();
  const box = new QuestionBox((event) => {
    events.push(event);
    transcript = reduce(transcript, event);
  });
  return { box, events, pending: () => transcript.pending! };
}

const answer = (request: PendingRequest, values = ["Allow once"]): RequestResponse => ({
  answers: { [request.questions[0]!.id]: values },
});

describe("permission cards", () => {
  it("waits for explicit consent and keeps the complete action details", async () => {
    const { box, pending } = fixture();
    const command = `echo ${"review ".repeat(60)} && rm /outside/original.mp4`;
    const result = requestApproval(box, "Allow command?", { command });
    expect(pending().questions[0]?.question).toContain(command);
    expect(pending().questions[0]).toMatchObject({ header: "Permission", allowOther: false, multiSelect: false });
    box.settle(pending().id, answer(pending()));
    await expect(result).resolves.toBe("accept");
    expect(box.size).toBe(0);
  });

  it.each(["skip", "cancel", "Deny", "unexpected", "both", "empty"])("never grants access for %s", async (value) => {
    const { box, pending } = fixture();
    const result = requestApproval(box, "Allow action?", { path: "/outside" });
    const response = value === "skip" || value === "cancel" ? value :
      answer(pending(), value === "both" ? ["Allow once", "Deny"] : value === "empty" ? [] : [value]);
    box.settle(pending().id, response);
    await expect(result).resolves.toBe(value === "cancel" ? "cancel" : "decline");
  });

  it("does not grant when it cannot display a complete request", async () => {
    const { box, events } = fixture();
    await expect(requestApproval(box, "Allow action?", "x".repeat(24_001))).resolves.toBe("decline");
    await expect(requestApproval(null, "Allow action?", {})).resolves.toBe("cancel");
    expect(events).toEqual([]);
  });

  it("does not send a late approval after the provider withdraws the action", async () => {
    const { box, pending } = fixture();
    const controller = new AbortController();
    const result = requestApproval(box, "Allow action?", { path: "/outside" }, controller.signal);
    box.settle(pending().id, answer(pending()));
    controller.abort();
    await expect(result).resolves.toBe("cancel");
  });
});

describe("queued permission requests", () => {
  it("shows concurrent requests one at a time and does not reuse approval", async () => {
    const { box, pending, events } = fixture();
    const first = requestApproval(box, "First action?", { path: "/one" });
    const firstRequest = pending();
    const second = requestApproval(box, "Second action?", { path: "/two" });
    expect(pending()).toBe(firstRequest);
    expect(events.filter((event) => event.type === "request.opened")).toHaveLength(1);
    box.settle(firstRequest.id, answer(firstRequest));
    await expect(first).resolves.toBe("accept");
    expect(pending().questions[0]?.question).toContain("Second action?");
    expect(box.settle(firstRequest.id, answer(firstRequest))).toBe(false);
    box.settle(pending().id, answer(pending(), ["Deny"]));
    await expect(second).resolves.toBe("decline");
  });

  it("cancels the visible and queued requests without flashing queued cards", async () => {
    const { box, pending, events } = fixture();
    const first = requestApproval(box, "First?", {});
    const second = requestApproval(box, "Second?", {});
    box.cancelAll();
    await expect(Promise.all([first, second])).resolves.toEqual(["cancel", "cancel"]);
    expect(pending()).toBeNull();
    expect(box.size).toBe(0);
    expect(events.filter((event) => event.type === "request.opened")).toHaveLength(1);
  });

  it("handles aborts before and while waiting, including a queued request", async () => {
    const { box, pending, events } = fixture();
    const aborted = new AbortController();
    aborted.abort();
    await expect(requestApproval(box, "Never shown", {}, aborted.signal)).resolves.toBe("cancel");
    expect(events).toEqual([]);
    const active = new AbortController();
    const queued = new AbortController();
    const first = requestApproval(box, "First?", {}, active.signal);
    const second = requestApproval(box, "Second?", {}, queued.signal);
    queued.abort();
    await expect(second).resolves.toBe("cancel");
    expect(pending().questions[0]?.question).toContain("First?");
    active.abort();
    await expect(first).resolves.toBe("cancel");
    expect(pending()).toBeNull();
  });
});
