import { describe, expect, it, vi } from "vitest";

const sessionState = vi.hoisted(() => ({
  canonicalKey: "agent:main:main",
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...original,
    loadSessionEntry: () => ({
      cfg: {},
      storePath: undefined,
      store: {},
      entry: undefined,
      canonicalKey: sessionState.canonicalKey,
      legacyKey: undefined,
    }),
  };
});

const { chatHandlers } = await import("./chat.js");

describe("chat file approvals rpc", () => {
  it("returns pending approvals for canonicalized session key", async () => {
    const respond = vi.fn();
    const manager = {
      listPending: vi.fn().mockReturnValue([
        {
          id: "tool-1",
          sessionKey: "agent:main:main",
          path: "/tmp/a.txt",
          backupPath: "/tmp/a.txt.bak",
          firstToolCallId: "tool-1",
          lastToolCallId: "tool-2",
          runId: "run-1",
          toolName: "write",
          changesCount: 2,
          createdAtMs: 1,
          updatedAtMs: 2,
        },
      ]),
    };

    await chatHandlers["chat.files.pending"]({
      params: { sessionKey: "main" },
      respond,
      context: { fileChangeApprovalManager: manager } as never,
    });

    expect(manager.listPending).toHaveBeenCalledWith("agent:main:main");
    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      sessionKey: "agent:main:main",
      pending: [{ id: "tool-1", lastToolCallId: "tool-2", changesCount: 2 }],
    });
  });

  it("resolves rollback using toolCallId and returns updated pending list", async () => {
    const respond = vi.fn();
    const manager = {
      listPending: vi.fn().mockReturnValue([]),
      resolvePendingChange: vi.fn().mockReturnValue({
        ok: true,
        record: {
          id: "tool-1",
          sessionKey: "agent:main:main",
          path: "/tmp/a.txt",
          backupPath: "/tmp/a.txt.bak",
          firstToolCallId: "tool-1",
          lastToolCallId: "tool-3",
          runId: "run-2",
          toolName: "edit",
          changesCount: 3,
          createdAtMs: 1,
          updatedAtMs: 3,
        },
      }),
    };

    await chatHandlers["chat.files.resolve"]({
      params: {
        sessionKey: "main",
        toolCallId: "tool-3",
        decision: "rollback",
      },
      respond,
      context: { fileChangeApprovalManager: manager } as never,
      client: { connect: { client: { id: "ui-1", displayName: "UI" } } } as never,
    });

    expect(manager.resolvePendingChange).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      decision: "rollback",
      id: undefined,
      toolCallId: "tool-3",
    });
    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      ok: true,
      sessionKey: "agent:main:main",
      resolved: {
        id: "tool-1",
        decision: "rollback",
        resolvedBy: "UI",
      },
      pending: [],
    });
  });
});
