import { describe, expect, it, vi } from "vitest";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat.js";

describe("agent event handler", () => {
  function createHarness(params?: {
    now?: number;
    resolveSessionKeyForRun?: (runId: string) => string | undefined;
    fileChangeApprovalManager?: {
      registerToolStart: ReturnType<typeof vi.fn>;
      registerToolResult: ReturnType<typeof vi.fn>;
    };
  }) {
    const nowSpy =
      params?.now === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(params.now);
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = createToolEventRecipientRegistry();

    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: params?.resolveSessionKeyForRun ?? (() => undefined),
      clearAgentRunContext: vi.fn(),
      toolEventRecipients,
      fileChangeApprovalManager: params?.fileChangeApprovalManager as never,
    });

    return {
      nowSpy,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      toolEventRecipients,
      handler,
    };
  }

  it("emits chat delta for assistant text-only events", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 1_000,
    });
    chatRunState.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });

    handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello world" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    const sessionChatCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
    expect(sessionChatCalls).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("does not emit chat delta for NO_REPLY streaming text", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 1_000,
    });
    chatRunState.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });

    handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: " NO_REPLY  " },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(0);
    const sessionChatCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
    expect(sessionChatCalls).toHaveLength(0);
    nowSpy?.mockRestore();
  });

  it("does not include NO_REPLY text in chat final message", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_000,
    });
    chatRunState.registry.add("run-2", { sessionKey: "session-2", clientRunId: "client-2" });

    handler({
      runId: "run-2",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "NO_REPLY" },
    });
    handler({
      runId: "run-2",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as { state?: string; message?: unknown };
    expect(payload.state).toBe("final");
    expect(payload.message).toBeUndefined();
    const sessionChatCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
    expect(sessionChatCalls).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("cleans up agent run sequence tracking when lifecycle completes", () => {
    const { agentRunSeq, chatRunState, handler, nowSpy } = createHarness({ now: 2_500 });
    chatRunState.registry.add("run-cleanup", {
      sessionKey: "session-cleanup",
      clientRunId: "client-cleanup",
    });

    handler({
      runId: "run-cleanup",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "done" },
    });
    expect(agentRunSeq.get("run-cleanup")).toBe(1);

    handler({
      runId: "run-cleanup",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    expect(agentRunSeq.has("run-cleanup")).toBe(false);
    expect(agentRunSeq.has("client-cleanup")).toBe(false);
    nowSpy?.mockRestore();
  });

  it("routes tool events only to registered recipients when verbose is enabled", () => {
    const { broadcast, broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool", "conn-1");

    handler({
      runId: "run-tool",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t1" },
    });

    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    resetAgentRunContextForTest();
  });

  it("broadcasts tool events to WS recipients even when verbose is off, but skips node send", () => {
    const { broadcastToConnIds, nodeSendToSession, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-off", { sessionKey: "session-1", verboseLevel: "off" });
    toolEventRecipients.add("run-tool-off", "conn-1");

    handler({
      runId: "run-tool-off",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t2" },
    });

    // Tool events always broadcast to registered WS recipients
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    // But node/channel subscribers should NOT receive when verbose is off
    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(0);
    resetAgentRunContextForTest();
  });

  it("strips tool output when verbose is on", () => {
    const { broadcastToConnIds, nodeSendToSession, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-on", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool-on", "conn-1");

    handler({
      runId: "run-tool-on",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t3",
        result: { content: [{ type: "text", text: "secret" }] },
        partialResult: { content: [{ type: "text", text: "partial" }] },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const nodePayload = nodeSendToSession.mock.calls[0]?.[2] as { data?: Record<string, unknown> };
    expect(nodePayload.data?.result).toBeUndefined();
    expect(nodePayload.data?.partialResult).toBeUndefined();
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toEqual({ content: [{ type: "text", text: "secret" }] });
    expect(payload.data?.partialResult).toEqual({ content: [{ type: "text", text: "partial" }] });
    resetAgentRunContextForTest();
  });

  it("keeps tool output when verbose is full", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-full", { sessionKey: "session-1", verboseLevel: "full" });
    toolEventRecipients.add("run-tool-full", "conn-1");

    const result = { content: [{ type: "text", text: "secret" }] };
    handler({
      runId: "run-tool-full",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t4",
        result,
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toEqual(result);
    resetAgentRunContextForTest();
  });

  it("tracks file approval candidates from tool start/result events", () => {
    const fileChangeApprovalManager = {
      registerToolStart: vi.fn(),
      registerToolResult: vi.fn(),
    };
    const { handler } = createHarness({
      resolveSessionKeyForRun: () => "main",
      fileChangeApprovalManager,
    });

    handler({
      runId: "run-file-1",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "start",
        name: "write",
        toolCallId: "tool-1",
        beforeFile: {
          path: "/tmp/test.txt",
          backupPath: "/tmp/test.txt.bak",
          size: 10,
        },
      },
    });
    handler({
      runId: "run-file-1",
      seq: 2,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "write",
        toolCallId: "tool-1",
        isError: false,
      },
    });

    expect(fileChangeApprovalManager.registerToolStart).toHaveBeenCalledWith({
      sessionKey: "main",
      runId: "run-file-1",
      toolCallId: "tool-1",
      toolName: "write",
      path: "/tmp/test.txt",
      backupPath: "/tmp/test.txt.bak",
    });
    expect(fileChangeApprovalManager.registerToolResult).toHaveBeenCalledWith({
      runId: "run-file-1",
      toolCallId: "tool-1",
      isError: false,
    });
  });

  it("tracks file approval candidates from tool result beforeFile payload", () => {
    const fileChangeApprovalManager = {
      registerToolStart: vi.fn(),
      registerToolResult: vi.fn(),
    };
    const { handler } = createHarness({
      resolveSessionKeyForRun: () => "main",
      fileChangeApprovalManager,
    });

    handler({
      runId: "run-file-result",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "edit",
        toolCallId: "tool-r1",
        isError: false,
        beforeFile: {
          path: "/tmp/result.txt",
          backupPath: "/tmp/result.txt.bak",
        },
      },
    });

    expect(fileChangeApprovalManager.registerToolStart).toHaveBeenCalledWith({
      sessionKey: "main",
      runId: "run-file-result",
      toolCallId: "tool-r1",
      toolName: "edit",
      path: "/tmp/result.txt",
      backupPath: "/tmp/result.txt.bak",
    });
    expect(fileChangeApprovalManager.registerToolResult).toHaveBeenCalledWith({
      runId: "run-file-result",
      toolCallId: "tool-r1",
      isError: false,
    });
  });

  it("uses backend baseline backup path in emitted tool start payload", () => {
    const fileChangeApprovalManager = {
      registerToolStart: vi.fn().mockReturnValue({
        baselinePath: "/tmp/test.txt",
        baselineBackupPath: "/tmp/test.txt.baseline.bak",
        existingPending: true,
      }),
      registerToolResult: vi.fn(),
    };
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "main",
      fileChangeApprovalManager,
    });
    toolEventRecipients.add("run-file-2", "conn-1");

    handler({
      runId: "run-file-2",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "start",
        name: "write",
        toolCallId: "tool-2",
        beforeFile: {
          path: "/tmp/test.txt",
          backupPath: "/tmp/test.txt.latest.bak",
          size: 100,
        },
      },
    });

    const payload = broadcastToConnIds.mock.calls[0]?.[1] as {
      data?: { beforeFile?: { backupPath?: string } };
    };
    expect(payload.data?.beforeFile?.backupPath).toBe("/tmp/test.txt.baseline.bak");
  });

  it("emits approvalId in tool result payload when file approval is registered", () => {
    const fileChangeApprovalManager = {
      registerToolStart: vi.fn(),
      registerToolResult: vi.fn().mockReturnValue({ approvalId: "approval-1" }),
    };
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "main",
      fileChangeApprovalManager,
    });
    toolEventRecipients.add("run-approval", "conn-1");

    handler({
      runId: "run-approval",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "edit",
        toolCallId: "tool-a1",
        isError: false,
      },
    });

    expect(fileChangeApprovalManager.registerToolResult).toHaveBeenCalledWith({
      runId: "run-approval",
      toolCallId: "tool-a1",
      isError: false,
    });
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as {
      data?: { approvalId?: string };
    };
    expect(payload.data?.approvalId).toBe("approval-1");
  });
});
