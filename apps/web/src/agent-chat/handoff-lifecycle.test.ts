import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  flush: vi.fn(),
  request: vi.fn(),
  state: "open",
  listeners: new Set<(state: string) => void>(),
}));
vi.mock("@/projects/edits", () => ({ flushProjectEdits: mocks.flush }));
vi.mock("@/init", () => ({
  store: { define: (_key: string, value: unknown) => ({ value }) },
}));
vi.mock("@/lib/store", async () => {
  const { createSignal } = await import("solid-js");
  return {
    createStoredSignal: (entry: { value: unknown }) =>
      createSignal(entry.value),
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/hooks/use-project-route", () => ({
  projectRoute: (id: string) => `/project/${id}`,
}));
vi.mock("./attachments", () => ({
  attachmentFromPath: (path: string) => ({ path }),
  attachmentPaths: (items: unknown[]) => items,
  mergeAttachments: (a: unknown[], b: unknown[]) => [...a, ...b],
}));
vi.mock("./connection", () => ({
  hasHost: () => true,
  client: {
    get state() {
      return mocks.state;
    },
    request: mocks.request,
    onState: (fn: (state: string) => void) => {
      mocks.listeners.add(fn);
      return () => mocks.listeners.delete(fn);
    },
    onHarnesses: () => () => {},
    open: () => () => {},
    connect() {},
  },
}));
const options = {
  projectId: "reference-project",
  cwd: "/projects/reference",
  chatId: null,
  text: "Edit the saved scene from this reference",
  attachments: [],
  model: { harness: "claude" as const, model: "fixture" },
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetModules();
  mocks.flush.mockReset().mockResolvedValue(undefined);
  mocks.request.mockReset().mockResolvedValue({ chatId: "new-reference-chat" });
  mocks.listeners.clear();
  mocks.state = "open";
});
describe("agent handoff lifecycle", () => {
  it("checks cancellation after a delayed connection opens and never dispatches the canceled turn", async () => {
    mocks.state = "connecting";
    const controller = new AbortController(),
      guard = vi.fn(() => controller.signal.throwIfAborted());
    const { send, chatState } = await import("./store");
    const work = send({ ...options, beforeDispatch: guard });
    const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
    controller.abort();
    mocks.state = "open";
    for (const listener of [...mocks.listeners]) listener("open");
    await rejected;
    expect(guard).toHaveBeenCalledOnce();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(chatState.sending["new:reference-project"]).toBeNull();
  });
  it("checks cancellation after a pending save completes, and clears the optimistic user message", async () => {
    const saving = deferred();
    mocks.flush.mockReturnValueOnce(saving.promise);
    const controller = new AbortController(),
      guard = vi.fn(() => controller.signal.throwIfAborted());
    const { send, chatState } = await import("./store");
    const work = send({ ...options, beforeDispatch: guard });
    const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() =>
      expect(mocks.flush).toHaveBeenCalledWith(options.cwd),
    );
    expect(chatState.sending["new:reference-project"]).toMatchObject({
      kind: "user",
    });
    controller.abort();
    expect(guard).not.toHaveBeenCalled();
    saving.resolve();
    await rejected;
    expect(mocks.request).not.toHaveBeenCalled();
    expect(chatState.sending["new:reference-project"]).toBeNull();
  });
  it("rejects an identifier changed by the final save and permits a clean retry", async () => {
    let source = "project.tsx:scene";
    mocks.flush.mockImplementationOnce(async () => {
      source = "project.tsx:renamed";
    });
    const { send } = await import("./store");
    await expect(
      send({
        ...options,
        beforeDispatch: () => {
          if (source !== "project.tsx:scene")
            throw new Error("Scene identifier changed");
        },
      }),
    ).rejects.toThrow("identifier changed");
    expect(mocks.request).not.toHaveBeenCalled();
    await expect(
      send({
        ...options,
        text: "Use project.tsx:renamed",
        beforeDispatch: () => {
          if (source !== "project.tsx:renamed")
            throw new Error("Scene identifier changed");
        },
      }),
    ).resolves.toBe("new-reference-chat");
    expect(mocks.request).toHaveBeenCalledOnce();
  });
  it("runs the guard immediately after saving and before dispatch, without serializing it into the host request", async () => {
    const order: string[] = [];
    mocks.flush.mockImplementation(async () => {
      order.push("save");
    });
    mocks.request.mockImplementation(async () => {
      order.push("dispatch");
      return { chatId: "new-reference-chat" };
    });
    const { send } = await import("./store");
    await send({
      ...options,
      beforeDispatch: () => {
        order.push("guard");
      },
    });
    expect(order).toEqual(["save", "guard", "dispatch"]);
    expect(mocks.request.mock.calls[0]![1]).not.toHaveProperty(
      "beforeDispatch",
    );
  });
  it("does not invoke a handoff guard or dispatch after saving fails", async () => {
    mocks.flush.mockRejectedValueOnce(new Error("Disk full"));
    const guard = vi.fn();
    const { send } = await import("./store");
    await expect(send({ ...options, beforeDispatch: guard })).rejects.toThrow(
      "Disk full",
    );
    expect(guard).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
