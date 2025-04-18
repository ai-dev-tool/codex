import type { ExecInput, ExecResult } from "./sandbox/interface.js";
import type { SpawnOptions } from "child_process";

import { process_patch } from "./apply-patch.js";
import { SandboxType } from "./sandbox/interface.js";
import { execWithSeatbelt } from "./sandbox/macos-seatbelt.js";
import { exec as rawExec } from "./sandbox/raw-exec.js";
import { formatCommandForDisplay } from "../../format-command.js";
import fs from "fs";
import os from "os";

const DEFAULT_TIMEOUT_MS = 10_000; // 10 seconds
// 10秒

/**
 * This function should never return a rejected promise: errors should be
 * mapped to a non-zero exit code and the error message should be in stderr.
 *
 * 该函数不应该返回被拒绝的promise：错误应该映射为
 * 非零的退出代码，错误消息应该在stderr中。
 */
export function exec(
  {
    cmd,
    workdir,
    timeoutInMillis,
    additionalWritableRoots,
  }: ExecInput & { additionalWritableRoots: ReadonlyArray<string> },
  sandbox: SandboxType,
  abortSignal?: AbortSignal,
): Promise<ExecResult> {
  // This is a temporary measure to understand what are the common base commands
  // until we start persisting and uploading rollouts
  // 这是一种临时措施，用于了解常见的基本命令
  // 直到我们开始持久化和上传展开

  const execForSandbox =
    sandbox === SandboxType.MACOS_SEATBELT ? execWithSeatbelt : rawExec;

  const opts: SpawnOptions = {
    timeout: timeoutInMillis || DEFAULT_TIMEOUT_MS,
    ...(workdir ? { cwd: workdir } : {}),
  };
  // Merge default writable roots with any user-specified ones.
  // 将默认的可写根目录与用户指定的根目录合并。
  const writableRoots = [
    process.cwd(),
    os.tmpdir(),
    ...additionalWritableRoots,
  ];
  return execForSandbox(cmd, opts, writableRoots, abortSignal);
}

export function execApplyPatch(patchText: string): ExecResult {
  // This is a temporary measure to understand what are the common base commands
  // until we start persisting and uploading rollouts
  // 这是一种临时措施，用于了解常见的基本命令
  // 直到我们开始持久化和上传展开

  try {
    const result = process_patch(
      patchText,
      (p) => fs.readFileSync(p, "utf8"),
      (p, c) => fs.writeFileSync(p, c, "utf8"),
      (p) => fs.unlinkSync(p),
    );
    return {
      stdout: result,
      stderr: "",
      exitCode: 0,
    };
  } catch (error: unknown) {
    // @ts-expect-error error might not be an object or have a message property.
    // @ts-expect-error 错误可能不是对象或没有message属性。
    const stderr = String(error.message ?? error);
    return {
      stdout: "",
      stderr: stderr,
      exitCode: 1,
    };
  }
}

export function getBaseCmd(cmd: Array<string>): string {
  const formattedCommand = formatCommandForDisplay(cmd);
  return formattedCommand.split(" ")[0] || cmd[0] || "<unknown>";
}
