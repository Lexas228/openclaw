import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { FileChangeApprovalManager } from "./file-change-approval-manager.js";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("FileChangeApprovalManager", () => {
  const tempDirs: string[] = [];
  const sqliteAvailable = (() => {
    try {
      requireNodeSqlite();
      return true;
    } catch {
      return false;
    }
  })();

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) {
        continue;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-file-approval-"));
    tempDirs.push(dir);
    return dir;
  }

  it("keeps the first backup as baseline across repeated unapproved changes", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "target.txt");
    const backup1 = path.join(dir, "b1.bak");
    const backup2 = path.join(dir, "b2.bak");
    await fs.writeFile(filePath, "v2", "utf-8");
    await fs.writeFile(backup1, "v0", "utf-8");
    await fs.writeFile(backup2, "v1", "utf-8");

    const manager = new FileChangeApprovalManager();
    manager.registerToolStart({
      sessionKey: "main",
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: "write",
      path: filePath,
      backupPath: backup1,
    });
    manager.registerToolResult({
      runId: "run-1",
      toolCallId: "tool-1",
      isError: false,
    });

    manager.registerToolStart({
      sessionKey: "main",
      runId: "run-1",
      toolCallId: "tool-2",
      toolName: "write",
      path: filePath,
      backupPath: backup2,
    });
    manager.registerToolResult({
      runId: "run-1",
      toolCallId: "tool-2",
      isError: false,
    });

    const pending = manager.listPending("main");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.firstToolCallId).toBe("tool-1");
    expect(pending[0]?.lastToolCallId).toBe("tool-2");
    expect(pending[0]?.backupPath).toBe(backup1);
    expect(pending[0]?.changesCount).toBe(2);
    expect(await pathExists(backup2)).toBe(false);
  });

  it("rolls back from the stored baseline and deletes backup on resolve", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "target.txt");
    const backup1 = path.join(dir, "b1.bak");
    await fs.writeFile(filePath, "current", "utf-8");
    await fs.writeFile(backup1, "baseline", "utf-8");

    const manager = new FileChangeApprovalManager();
    manager.registerToolStart({
      sessionKey: "main",
      runId: "run-2",
      toolCallId: "tool-rollback",
      toolName: "edit",
      path: filePath,
      backupPath: backup1,
    });
    manager.registerToolResult({
      runId: "run-2",
      toolCallId: "tool-rollback",
      isError: false,
    });

    const resolved = manager.resolvePendingChange({
      sessionKey: "main",
      decision: "rollback",
      toolCallId: "tool-rollback",
    });

    expect(resolved.ok).toBe(true);
    expect(await fs.readFile(filePath, "utf-8")).toBe("baseline");
    expect(await pathExists(backup1)).toBe(false);
    expect(manager.listPending("main")).toHaveLength(0);
  });

  it("drops backup for failed first mutation and leaves no pending record", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "target.txt");
    const backup = path.join(dir, "failed.bak");
    await fs.writeFile(filePath, "current", "utf-8");
    await fs.writeFile(backup, "old", "utf-8");

    const manager = new FileChangeApprovalManager();
    manager.registerToolStart({
      sessionKey: "main",
      runId: "run-3",
      toolCallId: "tool-fail",
      toolName: "write",
      path: filePath,
      backupPath: backup,
    });
    manager.registerToolResult({
      runId: "run-3",
      toolCallId: "tool-fail",
      isError: true,
    });

    expect(await pathExists(backup)).toBe(false);
    expect(manager.listPending("main")).toHaveLength(0);
  });

  (sqliteAvailable ? it : it.skip)(
    "restores pending approvals from sqlite and resolves by persisted toolCallId",
    async () => {
      const dir = await makeTempDir();
      const dbPath = path.join(dir, "file-approvals.sqlite");
      const filePath = path.join(dir, "target.txt");
      const backup1 = path.join(dir, "b1.bak");
      const backup2 = path.join(dir, "b2.bak");
      await fs.writeFile(filePath, "current", "utf-8");
      await fs.writeFile(backup1, "baseline", "utf-8");
      await fs.writeFile(backup2, "intermediate", "utf-8");

      const manager = new FileChangeApprovalManager({ dbPath });
      manager.registerToolStart({
        sessionKey: "main",
        runId: "run-db",
        toolCallId: "tool-1",
        toolName: "write",
        path: filePath,
        backupPath: backup1,
      });
      manager.registerToolResult({
        runId: "run-db",
        toolCallId: "tool-1",
        isError: false,
      });
      manager.registerToolStart({
        sessionKey: "main",
        runId: "run-db",
        toolCallId: "tool-2",
        toolName: "write",
        path: filePath,
        backupPath: backup2,
      });
      manager.registerToolResult({
        runId: "run-db",
        toolCallId: "tool-2",
        isError: false,
      });
      manager.close();

      const restored = new FileChangeApprovalManager({ dbPath });
      const pending = restored.listPending("main");
      expect(pending).toHaveLength(1);
      expect(pending[0]?.backupPath).toBe(backup1);
      expect(pending[0]?.changesCount).toBe(2);

      const resolved = restored.resolvePendingChange({
        sessionKey: "main",
        decision: "accept",
        toolCallId: "tool-2",
      });
      expect(resolved.ok).toBe(true);
      expect(await pathExists(backup1)).toBe(false);
      restored.close();

      const afterResolve = new FileChangeApprovalManager({ dbPath });
      expect(afterResolve.listPending("main")).toHaveLength(0);
      afterResolve.close();
    },
  );
});
