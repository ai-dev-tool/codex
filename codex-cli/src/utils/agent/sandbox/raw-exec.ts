import type { ExecResult } from "./interface";
import type {
  ChildProcess,
  SpawnOptions,
  SpawnOptionsWithStdioTuple,
  StdioNull,
  StdioPipe,
} from "child_process";

import { log, isLoggingEnabled } from "../log.js";
import { adaptCommandForPlatform } from "../platform-commands.js";
import { spawn } from "child_process";
import * as os from "os";

const MAX_BUFFER = 1024 * 100; // 100 KB
// 100 KB

/**
 * This function should never return a rejected promise: errors should be
 * mapped to a non-zero exit code and the error message should be in stderr.
 *
 * 该函数不应该返回被拒绝的promise：错误应该映射为
 * 非零的退出代码，错误消息应该在stderr中。
 */
export function exec(
  command: Array<string>,
  options: SpawnOptions,
  _writableRoots: Array<string>,
  abortSignal?: AbortSignal,
): Promise<ExecResult> {
  // Adapt command for the current platform (e.g., convert 'ls' to 'dir' on Windows)
  // 为当前平台调整命令（例如，在Windows上将'ls'转换为'dir'）
  const adaptedCommand = adaptCommandForPlatform(command);

  if (
    isLoggingEnabled() &&
    JSON.stringify(adaptedCommand) !== JSON.stringify(command)
  ) {
    log(
      `Command adapted for platform: ${command.join(
        " ",
      )} -> ${adaptedCommand.join(" ")}`,
    );
  }

  const prog = adaptedCommand[0];
  if (typeof prog !== "string") {
    return Promise.resolve({
      stdout: "",
      stderr: "command[0] is not a string",
      exitCode: 1,
    });
  }

  // We use spawn() instead of exec() or execFile() so that we can set the
  // stdio options to "ignore" for stdin. Ripgrep has a heuristic where it
  // may try to read from stdin as explained here:
  // 我们使用spawn()而不是exec()或execFile()，这样我们可以将stdin的
  // stdio选项设置为"ignore"。Ripgrep有一个启发式算法，它可能尝试
  // 从标准输入读取，如这里所解释的：
  //
  // https://github.com/BurntSushi/ripgrep/blob/e2362d4d5185d02fa857bf381e7bd52e66fafc73/crates/core/flags/hiargs.rs#L1101-L1103
  //
  // This can be a problem because if you save the following to a file and
  // run it with `node`, it will hang forever:
  // 这可能是个问题，因为如果你将以下内容保存到文件并用
  // `node`运行，它将永远挂起：
  //
  // ```
  // const {execFile} = require('child_process');
  //
  // execFile('rg', ['foo'], (error, stdout, stderr) => {
  //   if (error) {
  //     console.error(`error: ${error}n\nstderr: ${stderr}`);
  //   } else {
  //     console.log(`stdout: ${stdout}`);
  //   }
  // });
  // ```
  //
  // Even if you pass `{stdio: ["ignore", "pipe", "pipe"] }` to execFile(), the
  // hang still happens as the `stdio` is seemingly ignored. Using spawn()
  // works around this issue.
  // 即使你将`{stdio: ["ignore", "pipe", "pipe"] }`传递给execFile()，
  // 挂起仍然会发生，因为`stdio`似乎被忽略了。使用spawn()
  // 可以解决这个问题。
  const fullOptions: SpawnOptionsWithStdioTuple<
    StdioNull,
    StdioPipe,
    StdioPipe
  > = {
    ...options,
    // Inherit any caller‑supplied stdio flags but force stdin to "ignore" so
    // the child never attempts to read from us (see lengthy comment above).
    // 继承任何调用者提供的stdio标志，但强制stdin为"ignore"，
    // 这样子进程就不会尝试从我们这里读取（见上面的详细注释）。
    stdio: ["ignore", "pipe", "pipe"],
    // Launch the child in its *own* process group so that we can later send a
    // single signal to the entire group – this reliably terminates not only
    // the immediate child but also any grandchildren it might have spawned
    // (think `bash -c "sleep 999"`).
    // 在子进程自己的进程组中启动它，这样我们可以稍后向整个组
    // 发送单个信号 - 这不仅可靠地终止直接子进程，还终止它可能
    // 生成的任何孙进程（想想`bash -c "sleep 999"`）。
    detached: true,
  };

  const child: ChildProcess = spawn(prog, adaptedCommand.slice(1), fullOptions);
  // If an AbortSignal is provided, ensure the spawned process is terminated
  // when the signal is triggered so that cancellations propagate down to any
  // long‑running child processes. We default to SIGTERM to give the process a
  // chance to clean up, falling back to SIGKILL if it does not exit in a
  // timely fashion.
  // 如果提供了AbortSignal，确保在触发信号时终止生成的进程，
  // 以便取消传播到任何长时间运行的子进程。我们默认使用SIGTERM
  // 给进程一个清理的机会，如果它没有及时退出，则回退到SIGKILL。
  if (abortSignal) {
    const abortHandler = () => {
      if (isLoggingEnabled()) {
        log(`raw-exec: abort signal received – killing child ${child.pid}`);
      }
      const killTarget = (signal: NodeJS.Signals) => {
        if (!child.pid) {
          return;
        }
        try {
          try {
            // Send to the *process group* so grandchildren are included.
            // 发送到*进程组*，这样孙进程也包含在内。
            process.kill(-child.pid, signal);
          } catch {
            // Fallback: kill only the immediate child (may leave orphans on
            // exotic kernels that lack process‑group semantics, but better
            // than nothing).
            // 后备方案：只杀死直接子进程（在缺乏进程组语义的
            // 奇特内核上可能会留下孤儿进程，但总比没有好）。
            try {
              child.kill(signal);
            } catch {
              /* ignore */
          /* 忽略 */
            }
          }
        } catch {
          /* already gone */
        /* 已经消失 */
        }
      };

      // First try graceful termination.
      // 首先尝试优雅终止。
      killTarget("SIGTERM");

      // Escalate to SIGKILL if the group refuses to die.
      // 如果进程组拒绝终止，则升级到SIGKILL。
      setTimeout(() => {
        if (!child.killed) {
          killTarget("SIGKILL");
        }
      }, 2000).unref();
    };
    if (abortSignal.aborted) {
      abortHandler();
    } else {
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
  }
  // If spawning the child failed (e.g. the executable could not be found)
  // `child.pid` will be undefined *and* an `error` event will be emitted on
  // the ChildProcess instance.  We intentionally do **not** bail out early
  // here.  Returning prematurely would leave the `error` event without a
  // listener which – in Node.js – results in an "Unhandled 'error' event"
  // process‑level exception that crashes the CLI.  Instead we continue with
  // the normal promise flow below where we are guaranteed to attach both the
  // `error` and `exit` handlers right away.  Either of those callbacks will
  // resolve the promise and translate the failure into a regular
  // ExecResult object so the rest of the agent loop can carry on gracefully.
  //
  // 如果生成子进程失败（例如，找不到可执行文件），
  // `child.pid`将是undefined，*并且*在ChildProcess实例上会发出
  // `error`事件。我们有意**不**在这里提前退出。提前返回将使
  // `error`事件没有监听器，这在Node.js中会导致“未处理的'error'事件”
  // 进程级别异常，使 CLI 崩溃。相反，我们继续使用下面的正常
  // promise流程，在那里我们保证立即附加`error`和`exit`处理程序。
  // 这两个回调中的任何一个都将解析promise并将失败转化为常规
  // ExecResult对象，使代理循环的其余部分可以优雅地继续。

  const stdoutChunks: Array<Buffer> = [];
  const stderrChunks: Array<Buffer> = [];
  let numStdoutBytes = 0;
  let numStderrBytes = 0;
  let hitMaxStdout = false;
  let hitMaxStderr = false;

  return new Promise<ExecResult>((resolve) => {
    child.stdout?.on("data", (data: Buffer) => {
      if (!hitMaxStdout) {
        numStdoutBytes += data.length;
        if (numStdoutBytes <= MAX_BUFFER) {
          stdoutChunks.push(data);
        } else {
          hitMaxStdout = true;
        }
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      if (!hitMaxStderr) {
        numStderrBytes += data.length;
        if (numStderrBytes <= MAX_BUFFER) {
          stderrChunks.push(data);
        } else {
          hitMaxStderr = true;
        }
      }
    });
    child.on("exit", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      // Map (code, signal) to an exit code. We expect exactly one of the two
      // values to be non-null, but we code defensively to handle the case where
      // both are null.
      // 将(code, signal)映射到退出代码。我们期望这两个值中的一个
      // 为非空，但我们编写防御性代码来处理两者都为空的情况。
      let exitCode: number;
      if (code != null) {
        exitCode = code;
      } else if (signal != null && signal in os.constants.signals) {
        const signalNum =
          os.constants.signals[signal as keyof typeof os.constants.signals];
        exitCode = 128 + signalNum;
      } else {
        exitCode = 1;
      }

      if (isLoggingEnabled()) {
        log(
          `raw-exec: child ${child.pid} exited code=${exitCode} signal=${signal}`,
        );
      }
      resolve({
        stdout,
        stderr,
        exitCode,
      });
    });

    child.on("error", (err) => {
      resolve({
        stdout: "",
        stderr: String(err),
        exitCode: 1,
      });
    });
  });
}
