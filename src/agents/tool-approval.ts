import { callGatewayTool } from "./tools/gateway.js";
import { isMutatingToolCall } from "./tool-mutation.js";

export type ToolApprovalMode = "all" | "mutating";

export type ToolApprovalRuntimeConfig = {
  enabled?: boolean;
  mode?: ToolApprovalMode;
  include?: string[];
  exclude?: string[];
  timeoutMs?: number;
};

type ToolApprovalDecision = "allow-once" | "allow-always" | "deny";

type MaybeRequireToolApprovalParams = {
  toolName: string;
  args: unknown;
  cfg?: ToolApprovalRuntimeConfig;
  agentId?: string;
  sessionKey?: string;
};

type ToolApprovalOutcome = { allowed: true } | { allowed: false; reason: string };

const DEFAULT_TOOL_APPROVAL_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_PADDING_MS = 10_000;
const MAX_TOOL_APPROVAL_TIMEOUT_MS = 600_000;
const MAX_TOOL_APPROVAL_COMMAND_LEN = 500;
const TOOLS_WITH_NATIVE_APPROVAL = new Set(["exec", "bash"]);
const FILE_POST_REVIEW_TOOLS = new Set(["write", "edit", "apply_patch"]);

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function normalizeNameList(values?: string[]): Set<string> {
  if (!Array.isArray(values) || values.length === 0) {
    return new Set<string>();
  }
  return new Set(
    values
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

function normalizeTimeoutMs(timeoutMs: unknown): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TOOL_APPROVAL_TIMEOUT_MS;
  }
  const rounded = Math.floor(timeoutMs);
  if (rounded <= 0) {
    return DEFAULT_TOOL_APPROVAL_TIMEOUT_MS;
  }
  return Math.min(MAX_TOOL_APPROVAL_TIMEOUT_MS, rounded);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeTextSnippet(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}…` : normalized;
}

function buildToolApprovalCommand(toolName: string, args: unknown): string {
  const record = asRecord(args);
  const parts = [`tool=${toolName}`];
  if (record) {
    const action = normalizeTextSnippet(record.action, 64);
    if (action) {
      parts.push(`action=${action}`);
    }
    for (const key of [
      "path",
      "filePath",
      "file_path",
      "oldPath",
      "newPath",
      "target",
      "to",
      "id",
      "sessionKey",
      "command",
      "message",
    ]) {
      const value = normalizeTextSnippet(record[key], 120);
      if (value) {
        parts.push(`${key}=${value}`);
      }
    }
  }
  const line = parts.join(" ").trim();
  if (line.length <= MAX_TOOL_APPROVAL_COMMAND_LEN) {
    return line;
  }
  return `${line.slice(0, MAX_TOOL_APPROVAL_COMMAND_LEN)}…`;
}

function resolveToolCallCwd(args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }
  const workdir = normalizeTextSnippet(record.workdir, 240);
  if (workdir) {
    return workdir;
  }
  const cwd = normalizeTextSnippet(record.cwd, 240);
  if (cwd) {
    return cwd;
  }
  return undefined;
}

function parseApprovalDecision(
  value: unknown,
): ToolApprovalDecision | null {
  if (value === "allow-once" || value === "allow-always" || value === "deny") {
    return value;
  }
  return null;
}

function shouldRequireApproval(params: {
  toolName: string;
  args: unknown;
  cfg?: ToolApprovalRuntimeConfig;
}): boolean {
  if (!params.cfg?.enabled) {
    return false;
  }
  const toolName = normalizeToolName(params.toolName);
  if (!toolName || TOOLS_WITH_NATIVE_APPROVAL.has(toolName)) {
    return false;
  }
  const exclude = normalizeNameList(params.cfg.exclude);
  if (exclude.has(toolName)) {
    return false;
  }
  const include = normalizeNameList(params.cfg.include);
  if (include.size > 0) {
    return include.has(toolName);
  }
  const mode = params.cfg.mode ?? "mutating";
  if (mode === "all") {
    return true;
  }
  // File changes are reversible via before-backups and should go through
  // post-change review (accept/reject), not preflight blocking.
  if (FILE_POST_REVIEW_TOOLS.has(toolName)) {
    return false;
  }
  return isMutatingToolCall(toolName, params.args);
}

export async function maybeRequireToolApproval(
  params: MaybeRequireToolApprovalParams,
): Promise<ToolApprovalOutcome> {
  if (!shouldRequireApproval({ toolName: params.toolName, args: params.args, cfg: params.cfg })) {
    return { allowed: true };
  }

  const normalizedToolName = normalizeToolName(params.toolName);
  const timeoutMs = normalizeTimeoutMs(params.cfg?.timeoutMs);
  const requestTimeoutMs = timeoutMs + REQUEST_TIMEOUT_PADDING_MS;
  const requestPayload = {
    command: buildToolApprovalCommand(normalizedToolName, params.args),
    cwd: resolveToolCallCwd(params.args) ?? null,
    host: "tool",
    security: "full",
    ask: "always",
    agentId: params.agentId ?? null,
    sessionKey: params.sessionKey ?? null,
    timeoutMs,
  };

  let decision: ToolApprovalDecision | null = null;
  try {
    const result = await callGatewayTool<{ decision?: unknown }>(
      "exec.approval.request",
      { timeoutMs: requestTimeoutMs },
      requestPayload,
    );
    const decisionValue =
      result && typeof result === "object" ? (result as { decision?: unknown }).decision : undefined;
    decision = parseApprovalDecision(decisionValue);
  } catch (err) {
    return {
      allowed: false,
      reason: `Tool "${normalizedToolName}" approval request failed: ${String(err)}`,
    };
  }

  if (decision === "allow-once" || decision === "allow-always") {
    return { allowed: true };
  }

  if (decision === "deny") {
    return {
      allowed: false,
      reason: `Tool "${normalizedToolName}" was denied by approval policy`,
    };
  }

  return {
    allowed: false,
    reason: `Tool "${normalizedToolName}" approval timed out`,
  };
}
