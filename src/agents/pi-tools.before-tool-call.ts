import type { AnyAgentTool } from "./tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isPlainObject } from "../utils.js";
import { normalizeToolName } from "./tool-policy.js";
import {
  type ToolApprovalRuntimeConfig,
  maybeRequireToolApproval,
} from "./tool-approval.js";

type HookContext = {
  agentId?: string;
  sessionKey?: string;
  toolApproval?: ToolApprovalRuntimeConfig;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  let nextParams = args.params;

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
      return await execute(toolCallId, outcome.params, signal, onUpdate);
    },
  };
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: false,
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

export const __testing = {
  BEFORE_TOOL_CALL_WRAPPED,
  adjustedParamsByToolCallId,
  runBeforeToolCallHook,
  isPlainObject,
};
