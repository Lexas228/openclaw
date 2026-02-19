import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { resolveSessionStoreKey } from "./session-utils.js";

export type FileChangeApprovalDecision = "accept" | "rollback";

export type FileChangeApprovalRecord = {
  id: string;
  sessionKey: string;
  path: string;
  backupPath: string;
  firstToolCallId: string;
  lastToolCallId: string;
  runId: string;
  toolName: string;
  changesCount: number;
  createdAtMs: number;
  updatedAtMs: number;
};

type InFlightFileChange = {
  sessionKey: string;
  path: string;
  backupPath: string;
  runId: string;
  toolName: string;
  pendingId?: string;
};

type RegisterToolStartParams = {
  sessionKey: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  path: string;
  backupPath: string;
};

type RegisterToolStartResult = {
  baselinePath: string;
  baselineBackupPath: string;
  existingPending: boolean;
};

type RegisterToolResultParams = {
  runId: string;
  toolCallId: string;
  isError: boolean;
};

type RegisterToolResultResult = {
  approvalId: string;
};

type ResolvePendingChangeParams = {
  sessionKey: string;
  decision: FileChangeApprovalDecision;
  id?: string;
  toolCallId?: string;
};

type ResolvePendingChangeResult =
  | { ok: true; record: FileChangeApprovalRecord }
  | { ok: false; error: string };

type SqliteDatabase = import("node:sqlite").DatabaseSync;

type FileChangeApprovalManagerOptions = {
  /**
   * Enables persistence of pending file approvals in SQLite.
   * When omitted, manager behaves as in-memory only.
   */
  dbPath?: string | null;
};

type PersistedApprovalRow = {
  id: string;
  session_key: string;
  path: string;
  backup_path: string;
  first_tool_call_id: string;
  last_tool_call_id: string;
  run_id: string;
  tool_name: string;
  changes_count: number;
  created_at_ms: number;
  updated_at_ms: number;
  tool_call_ids_json: string | null;
};

const NEW_FILE_BASELINE_SUFFIX = ".missing.bak";

function trimNonEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function addNonEmpty(set: Set<string>, value: unknown): void {
  const normalized = trimNonEmpty(value);
  if (normalized) {
    set.add(normalized);
  }
}

export function resolveDefaultFileChangeApprovalsDbPath(): string {
  return path.join(resolveStateDir(), "gateway", "file-change-approvals.sqlite");
}

export class FileChangeApprovalManager {
  private readonly pendingById = new Map<string, FileChangeApprovalRecord>();
  private readonly pendingBySessionPath = new Map<string, string>();
  private readonly pendingIdByToolCallId = new Map<string, string>();
  private readonly pendingToolCallIdsByPendingId = new Map<string, Set<string>>();
  private readonly inFlightByToolCallId = new Map<string, InFlightFileChange>();
  private db: SqliteDatabase | null = null;

  constructor(options: FileChangeApprovalManagerOptions = {}) {
    const dbPath = trimNonEmpty(options.dbPath);
    if (!dbPath) {
      return;
    }
    this.openPersistence(dbPath);
    this.loadPersistedPending();
  }

  close(): void {
    const db = this.db;
    this.db = null;
    if (!db) {
      return;
    }
    try {
      db.close();
    } catch {
      // ignore close failures
    }
  }

  registerToolStart(params: RegisterToolStartParams): RegisterToolStartResult | null {
    const toolCallId = trimNonEmpty(params.toolCallId);
    const path = trimNonEmpty(params.path);
    const backupPath = trimNonEmpty(params.backupPath);
    if (!toolCallId || !path || !backupPath) {
      return null;
    }
    const sessionKey = this.normalizeSessionKey(params.sessionKey);
    const key = this.sessionPathKey(sessionKey, path);
    const existingId = this.pendingBySessionPath.get(key);
    if (existingId) {
      const existing = this.pendingById.get(existingId);
      if (existing) {
        this.inFlightByToolCallId.set(toolCallId, {
          sessionKey,
          path,
          backupPath: existing.backupPath,
          runId: params.runId,
          toolName: params.toolName,
          pendingId: existingId,
        });
        this.linkToolCallToPending(toolCallId, existingId);
        this.persistRecord(existing);
        if (backupPath !== existing.backupPath) {
          this.deleteFileQuietly(backupPath);
        }
        return {
          baselinePath: existing.path,
          baselineBackupPath: existing.backupPath,
          existingPending: true,
        };
      }
      this.pendingBySessionPath.delete(key);
    }
    this.inFlightByToolCallId.set(toolCallId, {
      sessionKey,
      path,
      backupPath,
      runId: params.runId,
      toolName: params.toolName,
    });
    return {
      baselinePath: path,
      baselineBackupPath: backupPath,
      existingPending: false,
    };
  }

  registerToolResult(params: RegisterToolResultParams): RegisterToolResultResult | null {
    const toolCallId = trimNonEmpty(params.toolCallId);
    if (!toolCallId) {
      return null;
    }
    const started = this.inFlightByToolCallId.get(toolCallId);
    if (!started) {
      return null;
    }
    this.inFlightByToolCallId.delete(toolCallId);

    if (params.isError) {
      if (started.pendingId) {
        this.unlinkToolCallFromPending(toolCallId, started.pendingId);
        const existing = this.pendingById.get(started.pendingId);
        if (existing) {
          this.persistRecord(existing);
        }
      }
      if (!started.pendingId) {
        this.deleteFileQuietly(started.backupPath);
      }
      return null;
    }

    const now = Date.now();
    const sessionPath = this.sessionPathKey(started.sessionKey, started.path);
    let pendingId = started.pendingId;
    if (!pendingId) {
      const fromPath = this.pendingBySessionPath.get(sessionPath);
      if (fromPath && this.pendingById.has(fromPath)) {
        pendingId = fromPath;
      } else if (fromPath) {
        this.pendingBySessionPath.delete(sessionPath);
      }
    }

    if (pendingId) {
      const existing = this.pendingById.get(pendingId);
      if (existing) {
        existing.lastToolCallId = toolCallId;
        existing.runId = trimNonEmpty(params.runId) || started.runId;
        existing.toolName = trimNonEmpty(started.toolName) || existing.toolName;
        existing.updatedAtMs = now;
        existing.changesCount += 1;
        this.linkToolCallToPending(toolCallId, existing.id);
        this.persistRecord(existing);
        if (started.backupPath !== existing.backupPath) {
          this.deleteFileQuietly(started.backupPath);
        }
        return { approvalId: existing.id };
      }
    }

    let id = toolCallId;
    if (this.pendingById.has(id)) {
      id = `${id}-${now}`;
    }
    const record: FileChangeApprovalRecord = {
      id,
      sessionKey: started.sessionKey,
      path: started.path,
      backupPath: started.backupPath,
      firstToolCallId: toolCallId,
      lastToolCallId: toolCallId,
      runId: trimNonEmpty(params.runId) || started.runId,
      toolName: trimNonEmpty(started.toolName) || "tool",
      changesCount: 1,
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.pendingById.set(record.id, record);
    this.pendingBySessionPath.set(sessionPath, record.id);
    this.linkToolCallToPending(toolCallId, record.id);
    this.persistRecord(record);
    return { approvalId: record.id };
  }

  listPending(sessionKey: string): FileChangeApprovalRecord[] {
    const normalizedSessionKey = this.normalizeSessionKey(sessionKey);
    return Array.from(this.pendingById.values())
      .filter((entry) => entry.sessionKey === normalizedSessionKey)
      .toSorted((a, b) => a.updatedAtMs - b.updatedAtMs)
      .map((entry) => ({ ...entry }));
  }

  resolvePendingChange(params: ResolvePendingChangeParams): ResolvePendingChangeResult {
    const normalizedSessionKey = this.normalizeSessionKey(params.sessionKey);
    const id = this.resolvePendingId(params.id, params.toolCallId);
    if (!id) {
      return { ok: false, error: "id or toolCallId is required" };
    }
    const record = this.pendingById.get(id);
    if (!record) {
      return { ok: false, error: "pending file change not found" };
    }
    if (record.sessionKey !== normalizedSessionKey) {
      return { ok: false, error: "pending file change not found in this session" };
    }
    if (params.decision === "rollback") {
      try {
        if (record.backupPath.endsWith(NEW_FILE_BASELINE_SUFFIX)) {
          this.deleteFileQuietly(record.path);
        } else {
          fs.copyFileSync(record.backupPath, record.path);
        }
      } catch (err) {
        return { ok: false, error: `rollback failed: ${String(err)}` };
      }
    }
    this.deleteFileQuietly(record.backupPath);
    this.removePendingRecord(record);
    return { ok: true, record: { ...record } };
  }

  private resolvePendingId(id?: string, toolCallId?: string): string | null {
    const normalizedId = trimNonEmpty(id);
    if (normalizedId) {
      return normalizedId;
    }
    const normalizedToolCallId = trimNonEmpty(toolCallId);
    if (!normalizedToolCallId) {
      return null;
    }
    const pendingId = this.pendingIdByToolCallId.get(normalizedToolCallId);
    return pendingId && pendingId.trim().length > 0 ? pendingId : null;
  }

  private removePendingRecord(record: FileChangeApprovalRecord): void {
    this.pendingById.delete(record.id);
    this.pendingBySessionPath.delete(this.sessionPathKey(record.sessionKey, record.path));
    const linkedToolCallIds = this.pendingToolCallIdsByPendingId.get(record.id);
    if (linkedToolCallIds) {
      for (const toolCallId of linkedToolCallIds) {
        this.pendingIdByToolCallId.delete(toolCallId);
      }
      this.pendingToolCallIdsByPendingId.delete(record.id);
    }
    for (const [toolCallId, started] of this.inFlightByToolCallId) {
      if (started.pendingId === record.id) {
        if (started.backupPath !== record.backupPath) {
          this.deleteFileQuietly(started.backupPath);
        }
        this.pendingIdByToolCallId.delete(toolCallId);
        this.inFlightByToolCallId.delete(toolCallId);
      }
    }
    this.deletePersistedRecord(record.id);
  }

  private normalizeSessionKey(sessionKey: string): string {
    const normalized = trimNonEmpty(sessionKey);
    if (!normalized) {
      return normalized;
    }
    try {
      return resolveSessionStoreKey({
        cfg: loadConfig(),
        sessionKey: normalized,
      });
    } catch {
      return normalized;
    }
  }

  private sessionPathKey(sessionKey: string, filePath: string): string {
    return `${sessionKey}\n${trimNonEmpty(filePath)}`;
  }

  private deleteFileQuietly(filePath: string): void {
    const target = trimNonEmpty(filePath);
    if (!target) {
      return;
    }
    try {
      fs.unlinkSync(target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        // ignore cleanup errors
      }
    }
  }

  private openPersistence(dbPath: string): void {
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_change_approvals (
          id TEXT PRIMARY KEY,
          session_key TEXT NOT NULL,
          path TEXT NOT NULL,
          backup_path TEXT NOT NULL,
          first_tool_call_id TEXT NOT NULL,
          last_tool_call_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          changes_count INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          tool_call_ids_json TEXT NOT NULL DEFAULT '[]'
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_file_change_approvals_session_path
          ON file_change_approvals(session_key, path)
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_file_change_approvals_updated
          ON file_change_approvals(updated_at_ms)
      `);
      this.db = db;
    } catch {
      this.db = null;
    }
  }

  private loadPersistedPending(): void {
    const db = this.db;
    if (!db) {
      return;
    }
    let rows: PersistedApprovalRow[] = [];
    try {
      rows = db
        .prepare(
          `
            SELECT
              id,
              session_key,
              path,
              backup_path,
              first_tool_call_id,
              last_tool_call_id,
              run_id,
              tool_name,
              changes_count,
              created_at_ms,
              updated_at_ms,
              tool_call_ids_json
            FROM file_change_approvals
          `,
        )
        .all() as PersistedApprovalRow[];
    } catch {
      return;
    }

    for (const row of rows) {
      const id = trimNonEmpty(row.id);
      const sessionKey = trimNonEmpty(row.session_key);
      const filePath = trimNonEmpty(row.path);
      const backupPath = trimNonEmpty(row.backup_path);
      const firstToolCallId = trimNonEmpty(row.first_tool_call_id);
      const lastToolCallId = trimNonEmpty(row.last_tool_call_id);
      const runId = trimNonEmpty(row.run_id);
      const toolName = trimNonEmpty(row.tool_name) || "tool";
      const changesCount =
        typeof row.changes_count === "number" && Number.isFinite(row.changes_count)
          ? Math.max(1, Math.floor(row.changes_count))
          : 1;
      const createdAtMs =
        typeof row.created_at_ms === "number" && Number.isFinite(row.created_at_ms)
          ? Math.max(0, Math.floor(row.created_at_ms))
          : Date.now();
      const updatedAtMs =
        typeof row.updated_at_ms === "number" && Number.isFinite(row.updated_at_ms)
          ? Math.max(createdAtMs, Math.floor(row.updated_at_ms))
          : createdAtMs;
      if (
        !id ||
        !sessionKey ||
        !filePath ||
        !backupPath ||
        !firstToolCallId ||
        !lastToolCallId ||
        !runId
      ) {
        continue;
      }

      const record: FileChangeApprovalRecord = {
        id,
        sessionKey,
        path: filePath,
        backupPath,
        firstToolCallId,
        lastToolCallId,
        runId,
        toolName,
        changesCount,
        createdAtMs,
        updatedAtMs,
      };

      const existing = this.pendingById.get(record.id);
      if (existing && existing.updatedAtMs > record.updatedAtMs) {
        continue;
      }

      this.pendingById.set(record.id, record);
      this.pendingBySessionPath.set(this.sessionPathKey(record.sessionKey, record.path), record.id);
      const parsedToolCallIds = this.parsePersistedToolCallIds(row.tool_call_ids_json, record);
      this.pendingToolCallIdsByPendingId.set(record.id, parsedToolCallIds);
      for (const toolCallId of parsedToolCallIds) {
        this.pendingIdByToolCallId.set(toolCallId, record.id);
      }
    }
  }

  private parsePersistedToolCallIds(
    raw: string | null,
    record: FileChangeApprovalRecord,
  ): Set<string> {
    const ids = new Set<string>();
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            addNonEmpty(ids, entry);
          }
        }
      } catch {
        // ignore malformed stored data
      }
    }
    addNonEmpty(ids, record.firstToolCallId);
    addNonEmpty(ids, record.lastToolCallId);
    return ids;
  }

  private collectToolCallIdsForRecord(record: FileChangeApprovalRecord): string[] {
    const ids = new Set<string>();
    addNonEmpty(ids, record.firstToolCallId);
    addNonEmpty(ids, record.lastToolCallId);
    const existing = this.pendingToolCallIdsByPendingId.get(record.id);
    if (existing) {
      for (const toolCallId of existing) {
        addNonEmpty(ids, toolCallId);
      }
    }
    this.pendingToolCallIdsByPendingId.set(record.id, ids);
    for (const toolCallId of ids) {
      this.pendingIdByToolCallId.set(toolCallId, record.id);
    }
    return Array.from(ids);
  }

  private persistRecord(record: FileChangeApprovalRecord): void {
    const db = this.db;
    if (!db) {
      return;
    }
    try {
      const toolCallIdsJson = JSON.stringify(this.collectToolCallIdsForRecord(record));
      db.prepare(
        `
          INSERT INTO file_change_approvals (
            id,
            session_key,
            path,
            backup_path,
            first_tool_call_id,
            last_tool_call_id,
            run_id,
            tool_name,
            changes_count,
            created_at_ms,
            updated_at_ms,
            tool_call_ids_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            session_key = excluded.session_key,
            path = excluded.path,
            backup_path = excluded.backup_path,
            first_tool_call_id = excluded.first_tool_call_id,
            last_tool_call_id = excluded.last_tool_call_id,
            run_id = excluded.run_id,
            tool_name = excluded.tool_name,
            changes_count = excluded.changes_count,
            created_at_ms = excluded.created_at_ms,
            updated_at_ms = excluded.updated_at_ms,
            tool_call_ids_json = excluded.tool_call_ids_json
        `,
      ).run(
        record.id,
        record.sessionKey,
        record.path,
        record.backupPath,
        record.firstToolCallId,
        record.lastToolCallId,
        record.runId,
        record.toolName,
        record.changesCount,
        record.createdAtMs,
        record.updatedAtMs,
        toolCallIdsJson,
      );
    } catch {
      // ignore persistence failures to keep runtime path available
    }
  }

  private deletePersistedRecord(recordId: string): void {
    const db = this.db;
    if (!db) {
      return;
    }
    try {
      db.prepare(`DELETE FROM file_change_approvals WHERE id = ?`).run(recordId);
    } catch {
      // ignore persistence failures to keep runtime path available
    }
  }

  private linkToolCallToPending(toolCallId: string, pendingId: string): void {
    const normalizedToolCallId = trimNonEmpty(toolCallId);
    const normalizedPendingId = trimNonEmpty(pendingId);
    if (!normalizedToolCallId || !normalizedPendingId) {
      return;
    }
    this.pendingIdByToolCallId.set(normalizedToolCallId, normalizedPendingId);
    const set = this.pendingToolCallIdsByPendingId.get(normalizedPendingId) ?? new Set<string>();
    set.add(normalizedToolCallId);
    this.pendingToolCallIdsByPendingId.set(normalizedPendingId, set);
  }

  private unlinkToolCallFromPending(toolCallId: string, pendingId: string): void {
    const normalizedToolCallId = trimNonEmpty(toolCallId);
    const normalizedPendingId = trimNonEmpty(pendingId);
    if (!normalizedToolCallId || !normalizedPendingId) {
      return;
    }
    this.pendingIdByToolCallId.delete(normalizedToolCallId);
    const set = this.pendingToolCallIdsByPendingId.get(normalizedPendingId);
    if (!set) {
      return;
    }
    set.delete(normalizedToolCallId);
    if (set.size === 0) {
      this.pendingToolCallIdsByPendingId.delete(normalizedPendingId);
      return;
    }
    this.pendingToolCallIdsByPendingId.set(normalizedPendingId, set);
  }
}
