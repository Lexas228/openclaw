import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isPlainObject } from "../utils.js";
import { type ToolApprovalRuntimeConfig, maybeRequireToolApproval } from "./tool-approval.js";
import { normalizeToolName } from "./tool-policy.js";

export type HookContext = {
  agentId?: string;
  sessionKey?: string;
  loopDetection?: ToolLoopDetectionConfig;
  toolApproval?: ToolApprovalRuntimeConfig;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };
type ToolMutationBeforeFile = {
  path: string;
  backupPath: string;
  size?: number;
};

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const adjustedParamsByToolCallId = new Map<string, unknown>();
const mutationBeforeFileByToolCallId = new Map<string, ToolMutationBeforeFile>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const MAX_TRACKED_MUTATION_BEFORE_FILES = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;
const FILE_MUTATING_TOOLS = new Set(["write", "edit", "apply_patch"]);
const BACKUP_DIR = path.join(os.homedir(), ".openclaw", "backups");
const NEW_FILE_BASELINE_SUFFIX = ".missing.bak";
let backupDirEnsured = false;

function trimNonEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractPathFromParams(params: unknown): string {
  if (!params || typeof params !== "object") {
    return "";
  }
  const record = params as Record<string, unknown>;
  return trimNonEmpty(record.path ?? record.file_path ?? record.filePath);
}

async function createMutationBeforeFile(
  filePath: string,
  toolCallId: string,
): Promise<ToolMutationBeforeFile | null> {
  if (!backupDirEnsured) {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    backupDirEnsured = true;
  }
  const safeToolCallId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_");
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }
    const backupPath = path.join(BACKUP_DIR, `${safeToolCallId}.bak`);
    await fs.copyFile(filePath, backupPath);
    return { path: filePath, backupPath, size: stat.size };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      return null;
    }
    const backupPath = path.join(BACKUP_DIR, `${safeToolCallId}${NEW_FILE_BASELINE_SUFFIX}`);
    await fs.writeFile(backupPath, "", { encoding: "utf-8" });
    return { path: filePath, backupPath, size: 0 };
  }
}

function rememberMutationBeforeFile(toolCallId: string, beforeFile: ToolMutationBeforeFile): void {
  mutationBeforeFileByToolCallId.set(toolCallId, beforeFile);
  if (mutationBeforeFileByToolCallId.size <= MAX_TRACKED_MUTATION_BEFORE_FILES) {
    return;
  }
  const oldest = mutationBeforeFileByToolCallId.keys().next().value;
  if (typeof oldest === "string" && oldest.length > 0) {
    mutationBeforeFileByToolCallId.delete(oldest);
  }
}

async function maybeCaptureMutationBeforeFile(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<void> {
  const toolCallId = trimNonEmpty(args.toolCallId);
  if (!toolCallId || !args.ctx?.sessionKey) {
    return;
  }
  if (!FILE_MUTATING_TOOLS.has(args.toolName)) {
    return;
  }
  const filePath = extractPathFromParams(args.params);
  if (!filePath) {
    return;
  }
  try {
    const beforeFile = await createMutationBeforeFile(filePath, toolCallId);
    if (!beforeFile) {
      return;
    }
    rememberMutationBeforeFile(toolCallId, beforeFile);
    log.debug(
      `mutation beforeFile prepared: tool=${args.toolName} toolCallId=${toolCallId} path=${beforeFile.path} backup=${beforeFile.backupPath}`,
    );
  } catch (error) {
    log.warn(
      `mutation beforeFile capture failed: tool=${args.toolName} toolCallId=${toolCallId} path=${filePath} error=${String(error)}`,
    );
  }
}

function shouldEmitLoopWarning(state: SessionState, warningKey: string, count: number): boolean {
  if (!state.toolLoopWarningBuckets) {
    state.toolLoopWarningBuckets = new Map();
  }
  const bucket = Math.floor(count / LOOP_WARNING_BUCKET_SIZE);
  const lastBucket = state.toolLoopWarningBuckets.get(warningKey) ?? 0;
  if (bucket <= lastBucket) {
    return false;
  }
  state.toolLoopWarningBuckets.set(warningKey, bucket);
  if (state.toolLoopWarningBuckets.size > MAX_LOOP_WARNING_KEYS) {
    const oldest = state.toolLoopWarningBuckets.keys().next().value;
    if (oldest) {
      state.toolLoopWarningBuckets.delete(oldest);
    }
  }
  return true;
}

async function recordLoopOutcome(args: {
  ctx?: HookContext;
  toolName: string;
  toolParams: unknown;
  toolCallId?: string;
  result?: unknown;
  error?: unknown;
}): Promise<void> {
  if (!args.ctx?.sessionKey) {
    return;
  }
  try {
    const { getDiagnosticSessionState } = await import("../logging/diagnostic-session-state.js");
    const { recordToolCallOutcome } = await import("./tool-loop-detection.js");
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });
    recordToolCallOutcome(sessionState, {
      toolName: args.toolName,
      toolParams: args.toolParams,
      toolCallId: args.toolCallId,
      result: args.result,
      error: args.error,
      config: args.ctx.loopDetection,
    });
  } catch (err) {
    log.warn(`tool loop outcome tracking failed: tool=${args.toolName} error=${String(err)}`);
  }
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  let nextParams = args.params;

  if (args.ctx?.sessionKey) {
    const { getDiagnosticSessionState } = await import("../logging/diagnostic-session-state.js");
    const { logToolLoopAction } = await import("../logging/diagnostic.js");
    const { detectToolCallLoop, recordToolCall } = await import("./tool-loop-detection.js");

    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });

    const loopResult = detectToolCallLoop(
      sessionState,
      toolName,
      nextParams,
      args.ctx.loopDetection,
    );

    if (loopResult.stuck) {
      if (loopResult.level === "critical") {
        log.error(`Blocking ${toolName} due to critical loop: ${loopResult.message}`);
        logToolLoopAction({
          sessionKey: args.ctx.sessionKey,
          sessionId: args.ctx?.agentId,
          toolName,
          level: "critical",
          action: "block",
          detector: loopResult.detector,
          count: loopResult.count,
          message: loopResult.message,
          pairedToolName: loopResult.pairedToolName,
        });
        return {
          blocked: true,
          reason: loopResult.message,
        };
      } else {
        const warningKey = loopResult.warningKey ?? `${loopResult.detector}:${toolName}`;
        if (shouldEmitLoopWarning(sessionState, warningKey, loopResult.count)) {
          log.warn(`Loop warning for ${toolName}: ${loopResult.message}`);
          logToolLoopAction({
            sessionKey: args.ctx.sessionKey,
            sessionId: args.ctx?.agentId,
            toolName,
            level: "warning",
            action: "warn",
            detector: loopResult.detector,
            count: loopResult.count,
            message: loopResult.message,
            pairedToolName: loopResult.pairedToolName,
          });
        }
      }
    }

    recordToolCall(sessionState, toolName, nextParams, args.toolCallId, args.ctx.loopDetection);
  }

  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_tool_call")) {
    try {
      const normalizedParams = isPlainObject(nextParams) ? nextParams : {};
      const hookResult = await hookRunner.runBeforeToolCall(
        {
          toolName,
          params: normalizedParams,
        },
        {
          toolName,
          agentId: args.ctx?.agentId,
          sessionKey: args.ctx?.sessionKey,
        },
      );

      if (hookResult?.block) {
        return {
          blocked: true,
          reason: hookResult.blockReason || "Tool call blocked by plugin hook",
        };
      }

      if (hookResult?.params && isPlainObject(hookResult.params)) {
        if (isPlainObject(nextParams)) {
          nextParams = { ...nextParams, ...hookResult.params };
        } else {
          nextParams = hookResult.params;
        }
      }
    } catch (err) {
      const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
      log.warn(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(err)}`);
    }
  }

  const approval = await maybeRequireToolApproval({
    toolName,
    args: nextParams,
    cfg: args.ctx?.toolApproval,
    agentId: args.ctx?.agentId,
    sessionKey: args.ctx?.sessionKey,
  });
  if (!approval.allowed) {
    return { blocked: true, reason: approval.reason };
  }

  await maybeCaptureMutationBeforeFile({
    toolName,
    params: nextParams,
    toolCallId: args.toolCallId,
    ctx: args.ctx,
  });

  return { blocked: false, params: nextParams };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      if (toolCallId) {
        adjustedParamsByToolCallId.set(toolCallId, outcome.params);
        if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
          const oldest = adjustedParamsByToolCallId.keys().next().value;
          if (oldest) {
            adjustedParamsByToolCallId.delete(oldest);
          }
        }
      }
      const normalizedToolName = normalizeToolName(toolName || "tool");
      try {
        const result = await execute(toolCallId, outcome.params, signal, onUpdate);
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          result,
        });
        return result;
      } catch (err) {
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          error: err,
        });
        throw err;
      }
    },
  };
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: true,
  });
  return wrappedTool;
}

export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

export function consumeAdjustedParamsForToolCall(toolCallId: string): unknown {
  const params = adjustedParamsByToolCallId.get(toolCallId);
  adjustedParamsByToolCallId.delete(toolCallId);
  return params;
}

export function consumeMutationBeforeFileForToolCall(
  toolCallId: string,
): ToolMutationBeforeFile | null {
  const normalizedToolCallId = trimNonEmpty(toolCallId);
  if (!normalizedToolCallId) {
    return null;
  }
  const beforeFile = mutationBeforeFileByToolCallId.get(normalizedToolCallId) ?? null;
  mutationBeforeFileByToolCallId.delete(normalizedToolCallId);
  return beforeFile;
}

export const __testing = {
  BEFORE_TOOL_CALL_WRAPPED,
  adjustedParamsByToolCallId,
  mutationBeforeFileByToolCallId,
  runBeforeToolCallHook,
  isPlainObject,
};
