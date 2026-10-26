/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { QuestionBox } from "../src/host/harness";
import { emptyTranscript, reduce } from "../src/reduce";

import type { ChatEvent, PendingRequest, Question, RequestResponse } from "../src/protocol";

function fixture() {
  const events: ChatEvent[] = [];
  let transcript = emptyTranscript();
  const box = new QuestionBox((event) => {
    events.push(event);
    transcript = reduce(transcript, event);
  });
  return { box, events, pending: () => transcript.pending!, items: () => transcript.items };
}

const question = (text: string): Question[] => [{
  id: text, header: "Format", question: text,
  options: [{ label: "9:16", description: "Portrait" }, { label: "16:9", description: "Landscape" }],
  multiSelect: false, allowOther: true, secret: false,
}];

const answer = (request: PendingRequest, values = ["9:16"]): RequestResponse => ({
  answers: { [request.questions[0]!.id]: values },
});

describe("agent questions", () => {
  it("has no permission-card helper left to call", () => {
    expect(existsSync(new URL("../src/host/approval.ts", import.meta.url))).toBe(false);
  });

  it("shows the question, records the answer and clears the card", async () => {
    const { box, pending, items } = fixture();
    const result = box.ask(question("Which format?"));
    expect(pending().questions[0]).toMatchObject({ header: "Format", question: "Which format?" });
    box.settle(pending().id, answer(pending()));
    await expect(result).resolves.toEqual({ answers: { "Which format?": ["9:16"] } });
    expect(pending()).toBeNull();
    expect(items()).toContainEqual(expect.objectContaining({ kind: "question", answers: { "Which format?": ["9:16"] } }));
    expect(box.size).toBe(0);
  });

  it("passes skip through and records a skipped question without answers", async () => {
    const { box, pending, items } = fixture();
    const result = box.ask(question("Which format?"));
    box.settle(pending().id, "skip");
    await expect(result).resolves.toBe("skip");
    expect(items()).toContainEqual(expect.objectContaining({ kind: "question", answers: null }));
  });

  it("does not send a late answer after the provider withdraws the question", async () => {
    const { box, pending } = fixture();
    const controller = new AbortController();
    const result = box.ask(question("Which format?"), controller.signal);
    controller.abort();
    await expect(result).resolves.toBe("cancel");
    expect(pending()).toBeNull();
  });
});

describe("queued questions", () => {
  it("shows concurrent questions one at a time and never reuses an answer", async () => {
    const { box, pending, events } = fixture();
    const first = box.ask(question("First?"));
    const firstRequest = pending();
    const second = box.ask(question("Second?"));
    expect(pending()).toBe(firstRequest);
    expect(events.filter((event) => event.type === "request.opened")).toHaveLength(1);
    box.settle(firstRequest.id, answer(firstRequest));
    await expect(first).resolves.toEqual({ answers: { "First?": ["9:16"] } });
    expect(pending().questions[0]?.question).toBe("Second?");
    expect(box.settle(firstRequest.id, answer(firstRequest))).toBe(false);
    box.settle(pending().id, answer(pending(), ["16:9"]));
    await expect(second).resolves.toEqual({ answers: { "Second?": ["16:9"] } });
  });

  it("cancels the visible and queued questions without flashing queued cards", async () => {
    const { box, pending, events } = fixture();
    const first = box.ask(question("First?"));
    const second = box.ask(question("Second?"));
    box.cancelAll();
    await expect(Promise.all([first, second])).resolves.toEqual(["cancel", "cancel"]);
    expect(pending()).toBeNull();
    expect(box.size).toBe(0);
    expect(events.filter((event) => event.type === "request.opened")).toHaveLength(1);
  });

  it("handles aborts before and while waiting, including a queued question", async () => {
    const { box, pending, events } = fixture();
    const aborted = new AbortController();
    aborted.abort();
    await expect(box.ask(question("Never shown"), aborted.signal)).resolves.toBe("cancel");
    expect(events).toEqual([]);
    const active = new AbortController();
    const queued = new AbortController();
    const first = box.ask(question("First?"), active.signal);
    const second = box.ask(question("Second?"), queued.signal);
    queued.abort();
    await expect(second).resolves.toBe("cancel");
    expect(pending().questions[0]?.question).toBe("First?");
    active.abort();
    await expect(first).resolves.toBe("cancel");
    expect(pending()).toBeNull();
  });
});
