import type { FileChangeApprovalManager } from "./file-change-approval-manager.js";
import { normalizeVerboseLevel } from "../auto-reply/thinking.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { loadConfig } from "../config/config.js";
import { type AgentEventPayload, getAgentRunContext } from "../infra/agent-events.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import { loadSessionEntry } from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

/**
 * Check if webchat broadcasts should be suppressed for heartbeat runs.
 * Returns true if the run is a heartbeat and showOk is false.
 */
function shouldSuppressHeartbeatBroadcast(runId: string): boolean {
  const runContext = getAgentRunContext(runId);
  if (!runContext?.isHeartbeat) {
    return false;
  }

  try {
    const cfg = loadConfig();
    const visibility = resolveHeartbeatVisibility({ cfg, channel: "webchat" });
    return !visibility.showOk;
  } catch {
    // Default to suppressing if we can't load config
    return true;
  }
}

export type ChatRunEntry = {
  sessionKey: string;
  clientRunId: string;
};

export type ChatRunRegistry = {
  add: (sessionId: string, entry: ChatRunEntry) => void;
  peek: (sessionId: string) => ChatRunEntry | undefined;
  shift: (sessionId: string) => ChatRunEntry | undefined;
  remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
  clear: () => void;
};

export function createChatRunRegistry(): ChatRunRegistry {
  const chatRunSessions = new Map<string, ChatRunEntry[]>();

  const add = (sessionId: string, entry: ChatRunEntry) => {
    const queue = chatRunSessions.get(sessionId);
    if (queue) {
      queue.push(entry);
    } else {
      chatRunSessions.set(sessionId, [entry]);
    }
  };

  const peek = (sessionId: string) => chatRunSessions.get(sessionId)?.[0];

  const shift = (sessionId: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const entry = queue.shift();
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const remove = (sessionId: string, clientRunId: string, sessionKey?: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const idx = queue.findIndex(
      (entry) =>
        entry.clientRunId === clientRunId && (sessionKey ? entry.sessionKey === sessionKey : true),
    );
    if (idx < 0) {
      return undefined;
    }
    const [entry] = queue.splice(idx, 1);
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const clear = () => {
    chatRunSessions.clear();
  };

  return { add, peek, shift, remove, clear };
}

export type ChatRunState = {
  registry: ChatRunRegistry;
  buffers: Map<string, string>;
  deltaSentAt: Map<string, number>;
  abortedRuns: Map<string, number>;
  clear: () => void;
};

export function createChatRunState(): ChatRunState {
  const registry = createChatRunRegistry();
  const buffers = new Map<string, string>();
  const deltaSentAt = new Map<string, number>();
  const abortedRuns = new Map<string, number>();

  const clear = () => {
    registry.clear();
    buffers.clear();
    deltaSentAt.clear();
    abortedRuns.clear();
  };

  return {
    registry,
    buffers,
    deltaSentAt,
    abortedRuns,
    clear,
  };
}

export type ToolEventRecipientRegistry = {
  add: (runId: string, connId: string) => void;
  get: (runId: string) => ReadonlySet<string> | undefined;
  markFinal: (runId: string) => void;
};

type ToolRecipientEntry = {
  connIds: Set<string>;
  updatedAt: number;
  finalizedAt?: number;
};

const TOOL_EVENT_RECIPIENT_TTL_MS = 10 * 60 * 1000;
const TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS = 30 * 1000;

export function createToolEventRecipientRegistry(): ToolEventRecipientRegistry {
  const recipients = new Map<string, ToolRecipientEntry>();

  const prune = () => {
    if (recipients.size === 0) {
      return;
    }
    const now = Date.now();
    for (const [runId, entry] of recipients) {
      const cutoff = entry.finalizedAt
        ? entry.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS
        : entry.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS;
      if (now >= cutoff) {
        recipients.delete(runId);
      }
    }
  };

  const add = (runId: string, connId: string) => {
    if (!runId || !connId) {
      return;
    }
    const now = Date.now();
    const existing = recipients.get(runId);
    if (existing) {
      existing.connIds.add(connId);
      existing.updatedAt = now;
    } else {
      recipients.set(runId, {
        connIds: new Set([connId]),
        updatedAt: now,
      });
    }
    prune();
  };

  const get = (runId: string) => {
    const entry = recipients.get(runId);
    if (!entry) {
      return undefined;
    }
    entry.updatedAt = Date.now();
    prune();
    return entry.connIds;
  };

  const markFinal = (runId: string) => {
    const entry = recipients.get(runId);
    if (!entry) {
      return;
    }
    entry.finalizedAt = Date.now();
    prune();
  };

  return { add, get, markFinal };
}

export type ChatEventBroadcast = (
  event: string,
  payload: unknown,
  opts?: { dropIfSlow?: boolean },
) => void;

export type NodeSendToSession = (sessionKey: string, event: string, payload: unknown) => void;

export type AgentEventHandlerOptions = {
  broadcast: ChatEventBroadcast;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  nodeSendToSession: NodeSendToSession;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string) => string | undefined;
  clearAgentRunContext: (runId: string) => void;
  toolEventRecipients: ToolEventRecipientRegistry;
  fileChangeApprovalManager?: FileChangeApprovalManager;
  debugLog?: (message: string) => void;
};

export function createAgentEventHandler({
  broadcast,
  broadcastToConnIds,
  nodeSendToSession,
  agentRunSeq,
  chatRunState,
  resolveSessionKeyForRun,
  clearAgentRunContext,
  toolEventRecipients,
  fileChangeApprovalManager,
  debugLog,
}: AgentEventHandlerOptions) {
  const debugFileApproval = (message: string) => {
    try {
      debugLog?.(`[file-approval] ${message}`);
    } catch {
      // ignore logging failures
    }
  };

  const emitChatDelta = (sessionKey: string, clientRunId: string, seq: number, text: string) => {
    if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
      return;
    }
    chatRunState.buffers.set(clientRunId, text);
    const now = Date.now();
    const last = chatRunState.deltaSentAt.get(clientRunId) ?? 0;
    if (now - last < 150) {
      return;
    }
    chatRunState.deltaSentAt.set(clientRunId, now);
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "delta" as const,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: now,
      },
    };
    // Suppress webchat broadcast for heartbeat runs when showOk is false
    if (!shouldSuppressHeartbeatBroadcast(clientRunId)) {
      broadcast("chat", payload, { dropIfSlow: true });
    }
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const emitChatFinal = (
    sessionKey: string,
    clientRunId: string,
    seq: number,
    jobState: "done" | "error",
    error?: unknown,
  ) => {
    const text = chatRunState.buffers.get(clientRunId)?.trim() ?? "";
    const shouldSuppressSilent = isSilentReplyText(text, SILENT_REPLY_TOKEN);
    chatRunState.buffers.delete(clientRunId);
    chatRunState.deltaSentAt.delete(clientRunId);
    if (jobState === "done") {
      const payload = {
        runId: clientRunId,
        sessionKey,
        seq,
        state: "final" as const,
        message:
          text && !shouldSuppressSilent
            ? {
                role: "assistant",
                content: [{ type: "text", text }],
                timestamp: Date.now(),
              }
            : undefined,
      };
      // Suppress webchat broadcast for heartbeat runs when showOk is false
      if (!shouldSuppressHeartbeatBroadcast(clientRunId)) {
        broadcast("chat", payload);
      }
      nodeSendToSession(sessionKey, "chat", payload);
      return;
    }
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "error" as const,
      errorMessage: error ? formatForLog(error) : undefined,
    };
    broadcast("chat", payload);
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const resolveToolVerboseLevel = (runId: string, sessionKey?: string) => {
    const runContext = getAgentRunContext(runId);
    const runVerbose = normalizeVerboseLevel(runContext?.verboseLevel);
    if (runVerbose) {
      return runVerbose;
    }
    if (!sessionKey) {
      return "off";
    }
    try {
      const { cfg, entry } = loadSessionEntry(sessionKey);
      const sessionVerbose = normalizeVerboseLevel(entry?.verboseLevel);
      if (sessionVerbose) {
        return sessionVerbose;
      }
      const defaultVerbose = normalizeVerboseLevel(cfg.agents?.defaults?.verboseDefault);
      return defaultVerbose ?? "off";
    } catch {
      return "off";
    }
  };

  const parseToolStartFile = (data: unknown) => {
    if (!data || typeof data !== "object") {
      return null;
    }
    const payload = data as Record<string, unknown>;
    if (payload.phase !== "start") {
      return null;
    }
    const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId.trim() : "";
    const toolName = typeof payload.name === "string" ? payload.name.trim() : "";
    const beforeFile =
      payload.beforeFile && typeof payload.beforeFile === "object"
        ? (payload.beforeFile as Record<string, unknown>)
        : null;
    const filePath =
      beforeFile && typeof beforeFile.path === "string" ? beforeFile.path.trim() : "";
    const backupPath =
      beforeFile && typeof beforeFile.backupPath === "string" ? beforeFile.backupPath.trim() : "";
    if (!toolCallId || !toolName || !filePath || !backupPath) {
      return null;
    }
    return { toolCallId, toolName, filePath, backupPath };
  };

  const parseToolResult = (data: unknown) => {
    if (!data || typeof data !== "object") {
      return null;
    }
    const payload = data as Record<string, unknown>;
    if (payload.phase !== "result") {
      return null;
    }
    const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId.trim() : "";
    const isError = payload.isError === true;
    if (!toolCallId) {
      return null;
    }
    return { toolCallId, isError };
  };

  return (evt: AgentEventPayload) => {
    let normalizedToolData: Record<string, unknown> | null = null;
    const chatLink = chatRunState.registry.peek(evt.runId);
    const sessionKey = chatLink?.sessionKey ?? resolveSessionKeyForRun(evt.runId);
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const isAborted =
      chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
    const last = agentRunSeq.get(evt.runId) ?? 0;
    const isToolEvent = evt.stream === "tool";
    const eventData = evt.data && typeof evt.data === "object" ? evt.data : {};
    const phase = typeof eventData.phase === "string" ? eventData.phase : "";
    const toolCallId = typeof eventData.toolCallId === "string" ? eventData.toolCallId.trim() : "";
    const toolName = typeof eventData.name === "string" ? eventData.name.trim() : "";

    if (isToolEvent && fileChangeApprovalManager && !sessionKey) {
      debugFileApproval(
        `skip run=${evt.runId} reason=missing_session phase=${phase || "-"} tool=${toolName || "-"} toolCallId=${toolCallId || "-"}`,
      );
    }

    if (isToolEvent && sessionKey && fileChangeApprovalManager) {
      const toolStart = parseToolStartFile(eventData);
      if (toolStart) {
        const baseline = fileChangeApprovalManager.registerToolStart({
          sessionKey,
          runId: evt.runId,
          toolCallId: toolStart.toolCallId,
          toolName: toolStart.toolName,
          path: toolStart.filePath,
          backupPath: toolStart.backupPath,
        });
        if (baseline) {
          const eventData = evt.data && typeof evt.data === "object" ? evt.data : {};
          const beforeFileRaw =
            eventData.beforeFile && typeof eventData.beforeFile === "object"
              ? (eventData.beforeFile as Record<string, unknown>)
              : {};
          const beforeFile = {
            ...beforeFileRaw,
            path: baseline.baselinePath,
            backupPath: baseline.baselineBackupPath,
          };
          normalizedToolData = {
            ...eventData,
            beforeFile,
          };
          debugFileApproval(
            `start run=${evt.runId} session=${sessionKey} tool=${toolStart.toolName} toolCallId=${toolStart.toolCallId} path=${baseline.baselinePath} backup=${baseline.baselineBackupPath} existing=${baseline.existingPending}`,
          );
        } else {
          debugFileApproval(
            `start ignored run=${evt.runId} session=${sessionKey} tool=${toolStart.toolName} toolCallId=${toolStart.toolCallId} reason=register_start_rejected`,
          );
        }
      } else {
        if (phase === "start") {
          const beforeFilePresent =
            "beforeFile" in eventData &&
            Boolean(eventData.beforeFile) &&
            typeof eventData.beforeFile === "object";
          debugFileApproval(
            `start ignored run=${evt.runId} session=${sessionKey} tool=${toolName || "-"} toolCallId=${toolCallId || "-"} beforeFile=${beforeFilePresent}`,
          );
        }

        const toolResult = parseToolResult(eventData);
        if (toolResult) {
          debugFileApproval(
            `result run=${evt.runId} session=${sessionKey} toolCallId=${toolResult.toolCallId} isError=${toolResult.isError}`,
          );
          fileChangeApprovalManager.registerToolResult({
            runId: evt.runId,
            toolCallId: toolResult.toolCallId,
            isError: toolResult.isError,
          });
        }
      }
    }
    // Include sessionKey so Control UI can filter tool streams per session.
    const eventForOutput = normalizedToolData == null ? evt : { ...evt, data: normalizedToolData };
    const agentPayload = sessionKey ? { ...eventForOutput, sessionKey } : eventForOutput;
    const toolVerbose = isToolEvent ? resolveToolVerboseLevel(evt.runId, sessionKey) : "off";
    // Build tool payload for messaging surfaces: strip result/partialResult
    // unless verbose=full. WS clients with tool-events cap get the full
    // agentPayload (including result) unconditionally.
    const toolPayload =
      isToolEvent && toolVerbose !== "full"
        ? (() => {
            const data =
              eventForOutput.data && typeof eventForOutput.data === "object"
                ? { ...eventForOutput.data }
                : {};
            delete data.result;
            delete data.partialResult;
            return sessionKey
              ? { ...eventForOutput, sessionKey, data }
              : { ...eventForOutput, data };
          })()
        : agentPayload;
    if (evt.seq !== last + 1) {
      broadcast("agent", {
        runId: evt.runId,
        stream: "error",
        ts: Date.now(),
        sessionKey,
        data: {
          reason: "seq gap",
          expected: last + 1,
          received: evt.seq,
        },
      });
    }
    agentRunSeq.set(evt.runId, evt.seq);
    if (isToolEvent) {
      // Always broadcast tool events to registered WS recipients with
      // tool-events capability, regardless of verboseLevel. The verbose
      // setting only controls whether tool details are sent as channel
      // messages to messaging surfaces (Telegram, Discord, etc.).
      const recipients = toolEventRecipients.get(evt.runId);
      if (recipients && recipients.size > 0) {
        broadcastToConnIds("agent", agentPayload, recipients);
      }
    } else {
      broadcast("agent", agentPayload);
    }

    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;

    if (sessionKey) {
      // Send tool events to node/channel subscribers only when verbose is enabled;
      // WS clients already received the event above via broadcastToConnIds.
      if (!isToolEvent || toolVerbose !== "off") {
        nodeSendToSession(sessionKey, "agent", isToolEvent ? toolPayload : agentPayload);
      }
      if (!isAborted && evt.stream === "assistant" && typeof evt.data?.text === "string") {
        emitChatDelta(sessionKey, clientRunId, evt.seq, evt.data.text);
      } else if (!isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        if (chatLink) {
          const finished = chatRunState.registry.shift(evt.runId);
          if (!finished) {
            clearAgentRunContext(evt.runId);
            return;
          }
          emitChatFinal(
            finished.sessionKey,
            finished.clientRunId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
          );
        } else {
          emitChatFinal(
            sessionKey,
            evt.runId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
          );
        }
      } else if (isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        chatRunState.abortedRuns.delete(clientRunId);
        chatRunState.abortedRuns.delete(evt.runId);
        chatRunState.buffers.delete(clientRunId);
        chatRunState.deltaSentAt.delete(clientRunId);
        if (chatLink) {
          chatRunState.registry.remove(evt.runId, clientRunId, sessionKey);
        }
      }
    }

    if (lifecyclePhase === "end" || lifecyclePhase === "error") {
      toolEventRecipients.markFinal(evt.runId);
      clearAgentRunContext(evt.runId);
      agentRunSeq.delete(evt.runId);
      agentRunSeq.delete(clientRunId);
    }
  };
}
