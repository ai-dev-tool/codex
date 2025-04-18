import type { ReviewDecision } from "./review.js";
import type { ApplyPatchCommand, ApprovalPolicy } from "../../approvals.js";
import type { AppConfig } from "../config.js";
import type {
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseItem,
} from "openai/resources/responses/responses.mjs";
import type { Reasoning } from "openai/resources.mjs";

import { log, isLoggingEnabled } from "./log.js";
import { OPENAI_BASE_URL, OPENAI_TIMEOUT_MS } from "../config.js";
import { parseToolCallArguments } from "../parsers.js";
import {
  ORIGIN,
  CLI_VERSION,
  getSessionId,
  setCurrentModel,
  setSessionId,
} from "../session.js";
import { handleExecCommand } from "./handle-exec-command.js";
import { randomUUID } from "node:crypto";
import OpenAI, { APIConnectionTimeoutError } from "openai";

// Wait time before retrying after rate limit errors (ms).
// 在遇到速率限制错误后重试前的等待时间(毫秒)。
const RATE_LIMIT_RETRY_WAIT_MS = parseInt(
  process.env["OPENAI_RATE_LIMIT_RETRY_WAIT_MS"] || "2500",
  10,
);

export type CommandConfirmation = {
  /** 审查决定的结果 */
  review: ReviewDecision;
  /** 可选的补丁应用命令 */
  applyPatch?: ApplyPatchCommand | undefined;
  /** 可选的自定义拒绝消息 */
  customDenyMessage?: string;
  /** 可选的解释说明 */
  explanation?: string;
};

const alreadyProcessedResponses = new Set();

type AgentLoopParams = {
  /** 使用的AI模型名称 */
  model: string;
  /** 应用程序配置 */
  config?: AppConfig;
  /** 给AI的指令 */
  instructions?: string;
  /** 命令审批策略 */
  approvalPolicy: ApprovalPolicy;
  /** 处理响应项的回调函数 */
  onItem: (item: ResponseItem) => void;
  /** 处理加载状态的回调函数 */
  onLoading: (loading: boolean) => void;

  /** Extra writable roots to use with sandbox execution. */
  /** 与沙箱执行一起使用的额外可写根目录。 */
  additionalWritableRoots: ReadonlyArray<string>;

  /** Called when the command is not auto-approved to request explicit user review. */
  /** 当命令未被自动批准时调用，以请求明确的用户审查。 */
  getCommandConfirmation: (
    command: Array<string>,
    applyPatch: ApplyPatchCommand | undefined,
  ) => Promise<CommandConfirmation>;
  onLastResponseId: (lastResponseId: string) => void;
};

export class AgentLoop {
  private model: string;
  private instructions?: string;
  private approvalPolicy: ApprovalPolicy;
  private config: AppConfig;
  private additionalWritableRoots: ReadonlyArray<string>;

  // Using `InstanceType<typeof OpenAI>` sidesteps typing issues with the OpenAI package under
  // the TS 5+ `moduleResolution=bundler` setup. OpenAI client instance. We keep the concrete
  // type to avoid sprinkling `any` across the implementation while still allowing paths where
  // the OpenAI SDK types may not perfectly match. The `typeof OpenAI` pattern captures the
  // instance shape without resorting to `any`.
  // 使用`InstanceType<typeof OpenAI>`避开了在TS 5+的`moduleResolution=bundler`设置下OpenAI包的类型问题。
  // OpenAI客户端实例。我们保留具体类型以避免在实现中散布`any`，同时仍然允许paths where
  // the OpenAI SDK types may not perfectly match. The `typeof OpenAI` pattern captures the
  // instance shape without resorting to `any`.
  private oai: OpenAI;

  private onItem: (item: ResponseItem) => void;
  private onLoading: (loading: boolean) => void;
  private getCommandConfirmation: (
    command: Array<string>,
    applyPatch: ApplyPatchCommand | undefined,
  ) => Promise<CommandConfirmation>;
  private onLastResponseId: (lastResponseId: string) => void;

  /**
   * A reference to the currently active stream returned from the OpenAI
   * client. We keep this so that we can abort the request if the user decides
   * to interrupt the current task (e.g. via the escape hot‑key).
   */
  /**
   * 对OpenAI客户端返回的当前活动流的引用。我们保留这个引用，以便在用户决定
   * 中断当前任务时可以中止请求（例如通过Escape热键）。
   */
  private currentStream: unknown | null = null;
  /** Incremented with every call to `run()`. Allows us to ignore stray events
   * from streams that belong to a previous run which might still be emitting
   * after the user has canceled and issued a new command. */
  /** 每次调用`run()`时递增。允许我们忽略来自属于先前运行的流的游离事件，
   * 这些事件可能在用户取消并发出新命令后仍在发送。 */
  private generation = 0;
  /** AbortController for in‑progress tool calls (e.g. shell commands). */
  /** 用于正在进行的工具调用（例如shell命令）的AbortController。 */
  private execAbortController: AbortController | null = null;
  /** Set to true when `cancel()` is called so `run()` can exit early. */
  /** 当调用`cancel()`时设置为true，以便`run()`可以提前退出。 */
  private canceled = false;
  /** Function calls that were emitted by the model but never answered because
   *  the user cancelled the run.  We keep the `call_id`s around so the *next*
   *  request can send a dummy `function_call_output` that satisfies the
   *  contract and prevents the
   *    400 | No tool output found for function call …
   *  error from OpenAI. */
  /** 由模型发出但由于用户取消运行而从未得到回答的函数调用。我们保留`call_id`，
   * 以便*下一个*请求可以发送一个符合约定的虚拟`function_call_output`，
   * 防止出现来自OpenAI的
   *    400 | No tool output found for function call …
   * 错误。 */
  private pendingAborts: Set<string> = new Set();
  /** Set to true by `terminate()` – prevents any further use of the instance. */
  /** 由`terminate()`设置为true - 防止实例的任何进一步使用。 */
  private terminated = false;
  /** Master abort controller – fires when terminate() is invoked. */
  /** 主中止控制器 - 在调用terminate()时触发。 */
  private readonly hardAbort = new AbortController();

  /**
   * Abort the ongoing request/stream, if any. This allows callers (typically
   * the UI layer) to interrupt the current agent step so the user can issue
   * new instructions without waiting for the model to finish.
   */
  /**
   * 中止正在进行的请求/流（如果有）。这允许调用者（通常是UI层）中断当前代理步骤，
   * 以便用户可以发出新指令，而无需等待模型完成。
   */
  public cancel(): void {
    if (this.terminated) {
      return;
    }

    // Reset the current stream to allow new requests
    // 重置当前流以允许新请求
    this.currentStream = null;
    if (isLoggingEnabled()) {
      log(
        `AgentLoop.cancel() invoked – currentStream=${Boolean(
          this.currentStream,
        )} execAbortController=${Boolean(
          this.execAbortController,
        )} generation=${this.generation}`,
      );
    }
    (
      this.currentStream as { controller?: { abort?: () => void } } | null
    )?.controller?.abort?.();

    this.canceled = true;

    // Abort any in-progress tool calls
    // 中止任何正在进行的工具调用
    this.execAbortController?.abort();

    // Create a new abort controller for future tool calls
    // 为未来的工具调用创建一个新的中止控制器
    this.execAbortController = new AbortController();
    if (isLoggingEnabled()) {
      log("AgentLoop.cancel(): execAbortController.abort() called");
    }

    // NOTE: We intentionally do *not* clear `lastResponseId` here.  If the
    // stream produced a `function_call` before the user cancelled, OpenAI now
    // expects a corresponding `function_call_output` that must reference that
    // very same response ID.  We therefore keep the ID around so the
    // follow‑up request can still satisfy the contract.
    // 注意：我们故意*不*在此处清除`lastResponseId`。如果流在用户取消之前
    // 产生了`function_call`，OpenAI现在期望相应的`function_call_output`
    // 必须引用同一个响应ID。因此，我们保留该ID，以便后续请求仍然可以满足约定。

    // If we have *not* seen any function_call IDs yet there is nothing that
    // needs to be satisfied in a follow‑up request.  In that case we clear
    // the stored lastResponseId so a subsequent run starts a clean turn.
    // 如果我们尚未看到任何function_call ID，那么在后续请求中没有需要满足的内容。
    // 在这种情况下，我们清除存储的lastResponseId，以便后续运行开始一个干净的轮次。
    if (this.pendingAborts.size === 0) {
      try {
        this.onLastResponseId("");
      } catch {
        /* ignore */
      }
    }

    this.onLoading(false);

    /* Inform the UI that the run was aborted by the user. */
    /* 通知UI运行被用户中止。 */
    // const cancelNotice: ResponseItem = {
    //   id: `cancel-${Date.now()}`,
    //   type: "message",
    //   role: "system",
    //   content: [
    //     {
    //       type: "input_text",
    //       text: "⏹️  Execution canceled by user.",
    //     },
    //   ],
    // };
    // this.onItem(cancelNotice);

    this.generation += 1;
    if (isLoggingEnabled()) {
      log(`AgentLoop.cancel(): generation bumped to ${this.generation}`);
    }
  }

  /**
   * Hard‑stop the agent loop. After calling this method the instance becomes
   * unusable: any in‑flight operations are aborted and subsequent invocations
   * of `run()` will throw.
   */
  /**
   * 硬停止代理循环。调用此方法后，实例变得不可用：任何正在进行的操作都会被中止，
   * 随后调用`run()`将抛出异常。
   */
  public terminate(): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;

    this.hardAbort.abort();

    this.cancel();
  }

  public sessionId: string;
  /*
   * Cumulative thinking time across this AgentLoop instance (ms).
   * Currently not used anywhere – comment out to keep the strict compiler
   * happy under `noUnusedLocals`.  Restore when telemetry support lands.
   */
  /*
   * 该AgentLoop实例的累计思考时间（毫秒）。
   * 目前没有在任何地方使用 - 注释掉以保持在`noUnusedLocals`下严格编译器满意。
   * 当遥测支持实现时恢复。
   */
  // private cumulativeThinkingMs = 0;
  constructor({
    model,
    instructions,
    approvalPolicy,
    // `config` used to be required.  Some unit‑tests (and potentially other
    // callers) instantiate `AgentLoop` without passing it, so we make it
    // optional and fall back to sensible defaults.  This keeps the public
    // surface backwards‑compatible and prevents runtime errors like
    // "Cannot read properties of undefined (reading 'apiKey')" when accessing
    // `config.apiKey` below.
    // `config` 曾经是必需的。一些单元测试（以及可能的其他调用者）实例化`AgentLoop`
    // 时没有传递它，所以我们将其设为可选并回退到合理的默认值。这保持了公共接口的
    // 向后兼容性，并防止在下面访问`config.apiKey`时出现诸如
    // "Cannot read properties of undefined (reading 'apiKey')"之类的运行时错误。
    config,
    onItem,
    onLoading,
    getCommandConfirmation,
    onLastResponseId,
    additionalWritableRoots,
  }: AgentLoopParams & { config?: AppConfig }) {
    this.model = model;
    this.instructions = instructions;
    this.approvalPolicy = approvalPolicy;

    // If no `config` has been provided we derive a minimal stub so that the
    // rest of the implementation can rely on `this.config` always being a
    // defined object.  We purposefully copy over the `model` and
    // `instructions` that have already been passed explicitly so that
    // downstream consumers (e.g. telemetry) still observe the correct values.
    // 如果没有提供`config`，我们派生一个最小存根，以便实现的其余部分可以依赖于
    // `this.config`始终是一个已定义的对象。我们有意复制已经明确传递的`model`和
    // `instructions`，以便下游消费者（例如遥测）仍然能观察到正确的值。
    this.config =
      config ??
      ({
        model,
        instructions: instructions ?? "",
      } as AppConfig);
    this.additionalWritableRoots = additionalWritableRoots;
    this.onItem = onItem;
    this.onLoading = onLoading;
    this.getCommandConfirmation = getCommandConfirmation;
    this.onLastResponseId = onLastResponseId;
    this.sessionId = getSessionId() || randomUUID().replaceAll("-", "");
    // Configure OpenAI client with optional timeout (ms) from environment
    // 使用来自环境的可选超时（毫秒）配置OpenAI客户端
    const timeoutMs = OPENAI_TIMEOUT_MS;
    const apiKey = this.config.apiKey ?? process.env["OPENAI_API_KEY"] ?? "";
    this.oai = new OpenAI({
      // The OpenAI JS SDK only requires `apiKey` when making requests against
      // the official API.  When running unit‑tests we stub out all network
      // calls so an undefined key is perfectly fine.  We therefore only set
      // the property if we actually have a value to avoid triggering runtime
      // errors inside the SDK (it validates that `apiKey` is a non‑empty
      // string when the field is present).
      // OpenAI JS SDK只有在对官方API发出请求时才需要`apiKey`。当运行单元测试时，
      // 我们模拟所有网络调用，所以未定义的密钥完全可以接受。因此，我们只在实际
      // 有值时才设置该属性，以避免在SDK内部触发运行时错误（当该字段存在时，
      // 它会验证`apiKey`是一个非空字符串）。
      ...(apiKey ? { apiKey } : {}),
      baseURL: OPENAI_BASE_URL,
      defaultHeaders: {
        originator: ORIGIN,
        version: CLI_VERSION,
        session_id: this.sessionId,
      },
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    });

    setSessionId(this.sessionId);
    setCurrentModel(this.model);

    this.hardAbort = new AbortController();

    this.hardAbort.signal.addEventListener(
      "abort",
      () => this.execAbortController?.abort(),
      { once: true },
    );
  }

  private async handleFunctionCall(
    item: ResponseFunctionToolCall,
  ): Promise<Array<ResponseInputItem>> {
    // If the agent has been canceled in the meantime we should not perform any
    // additional work. Returning an empty array ensures that we neither execute
    // the requested tool call nor enqueue any follow‑up input items. This keeps
    // the cancellation semantics intuitive for users – once they interrupt a
    // task no further actions related to that task should be taken.
    // 如果代理在此期间已被取消，我们不应执行任何额外工作。返回空数组确保我们既不执行
    // 请求的工具调用，也不排队任何后续输入项。这使得取消语义对用户直观 - 一旦他们
    // 中断任务，就不应再采取与该任务相关的任何进一步行动。
    if (this.canceled) {
      return [];
    }
    // ---------------------------------------------------------------------
    // Normalise the function‑call item into a consistent shape regardless of
    // whether it originated from the `/responses` or the `/chat/completions`
    // endpoint – their JSON differs slightly.
    // ---------------------------------------------------------------------
    // ---------------------------------------------------------------------
    // 将函数调用项标准化为一致的形状，无论它是来自`/responses`还是
    // `/chat/completions`端点 - 它们的JSON略有不同。
    // ---------------------------------------------------------------------

    const isChatStyle =
      // The chat endpoint nests function details under a `function` key.
      // We conservatively treat the presence of this field as a signal that
      // we are dealing with the chat format.
      // 聊天端点将函数详情嵌套在`function`键下。
      // 我们保守地将此字段的存在视为我们正在处理聊天格式的信号。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (item as any).function != null;

    const name: string | undefined = isChatStyle
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (item as any).function?.name
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (item as any).name;

    const rawArguments: string | undefined = isChatStyle
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (item as any).function?.arguments
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (item as any).arguments;

    // The OpenAI "function_call" item may have either `call_id` (responses
    // endpoint) or `id` (chat endpoint).  Prefer `call_id` if present but fall
    // back to `id` to remain compatible.
    // OpenAI "function_call"项可能有`call_id`（responses端点）或`id`
    // （chat端点）。如果存在`call_id`则优先使用，但回退到`id`以保持兼容性。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callId: string = (item as any).call_id ?? (item as any).id;

    const args = parseToolCallArguments(rawArguments ?? "{}");
    if (isLoggingEnabled()) {
      log(
        `handleFunctionCall(): name=${
          name ?? "undefined"
        } callId=${callId} args=${rawArguments}`,
      );
    }

    if (args == null) {
      const outputItem: ResponseInputItem.FunctionCallOutput = {
        type: "function_call_output",
        call_id: item.call_id,
        output: `invalid arguments: ${rawArguments}`,
      };
      return [outputItem];
    }

    const outputItem: ResponseInputItem.FunctionCallOutput = {
      type: "function_call_output",
      // `call_id` is mandatory – ensure we never send `undefined` which would
      // trigger the "No tool output found…" 400 from the API.
      // `call_id`是必需的 - 确保我们从不发送`undefined`，否则会触发
      // API的"No tool output found…" 400错误。
      call_id: callId,
      output: "no function found",
    };

    // We intentionally *do not* remove this `callId` from the `pendingAborts`
    // set right away.  The output produced below is only queued up for the
    // *next* request to the OpenAI API – it has not been delivered yet.  If
    // the user presses ESC‑ESC (i.e. invokes `cancel()`) in the small window
    // between queuing the result and the actual network call, we need to be
    // able to surface a synthetic `function_call_output` marked as
    // "aborted".  Keeping the ID in the set until the run concludes
    // successfully lets the next `run()` differentiate between an aborted
    // tool call (needs the synthetic output) and a completed one (cleared
    // below in the `flush()` helper).
    // 我们有意不立即从`pendingAborts`集合中删除这个`callId`。下面产生的输出
    // 只是为*下一个*请求排队到OpenAI API - 它尚未被传递。如果用户在排队结果
    // 和实际网络调用之间的小窗口中按ESC-ESC（即调用`cancel()`），我们需要
    // 能够显示标记为"aborted"的合成`function_call_output`。将ID保留在集合中
    // 直到运行成功结束，可让下一个`run()`区分被中止的工具调用（需要合成输出）
    // 和已完成的工具调用（在下面的`flush()`助手中清除）。

    // used to tell model to stop if needed
    // 用于在需要时告诉模型停止
    const additionalItems: Array<ResponseInputItem> = [];

    // TODO: allow arbitrary function calls (beyond shell/container.exec)
    // TODO: 允许任意函数调用（除了shell/container.exec之外）
    if (name === "container.exec" || name === "shell") {
      const {
        outputText,
        metadata,
        additionalItems: additionalItemsFromExec,
      } = await handleExecCommand(
        args,
        this.config,
        this.approvalPolicy,
        this.additionalWritableRoots,
        this.getCommandConfirmation,
        this.execAbortController?.signal,
      );
      outputItem.output = JSON.stringify({ output: outputText, metadata });

      if (additionalItemsFromExec) {
        additionalItems.push(...additionalItemsFromExec);
      }
    }

    return [outputItem, ...additionalItems];
  }

  public async run(
    input: Array<ResponseInputItem>,
    previousResponseId: string = "",
  ): Promise<void> {
    // ---------------------------------------------------------------------
    // Top‑level error wrapper so that known transient network issues like
    // `ERR_STREAM_PREMATURE_CLOSE` do not crash the entire CLI process.
    // Instead we surface the failure to the user as a regular system‑message
    // and terminate the current run gracefully. The calling UI can then let
    // the user retry the request if desired.
    // ---------------------------------------------------------------------
    // ---------------------------------------------------------------------
    // 顶级错误包装器，使已知的临时网络问题（如`ERR_STREAM_PREMATURE_CLOSE`）
    // 不会使整个CLI进程崩溃。相反，我们将失败作为常规系统消息呈现给用户，
    // 并优雅地终止当前运行。调用UI可以让用户在需要时重试请求。
    // ---------------------------------------------------------------------

    try {
      if (this.terminated) {
        throw new Error("AgentLoop has been terminated");
      }
      // Record when we start "thinking" so we can report accurate elapsed time.
      // 记录我们开始"思考"的时间，以便我们可以报告准确的经过时间。
      const thinkingStart = Date.now();
      // Bump generation so that any late events from previous runs can be
      // identified and dropped.
      // 增加世代计数，以便可以识别并丢弃来自先前运行的任何延迟事件。
      const thisGeneration = ++this.generation;

      // Reset cancellation flag and stream for a fresh run.
      // 为新的运行重置取消标志和流。
      this.canceled = false;
      this.currentStream = null;

      // Create a fresh AbortController for this run so that tool calls from a
      // previous run do not accidentally get signalled.
      // 为此次运行创建一个新的AbortController，以便来自先前运行的工具调用
      // 不会意外地收到信号。
      this.execAbortController = new AbortController();
      if (isLoggingEnabled()) {
        log(
          `AgentLoop.run(): new execAbortController created (${this.execAbortController.signal}) for generation ${this.generation}`,
        );
      }
      // NOTE: We no longer (re‑)attach an `abort` listener to `hardAbort` here.
      // A single listener that forwards the `abort` to the current
      // `execAbortController` is installed once in the constructor. Re‑adding a
      // new listener on every `run()` caused the same `AbortSignal` instance to
      // accumulate listeners which in turn triggered Node's
      // `MaxListenersExceededWarning` after ten invocations.
      // 注意：我们不再在此处（重新）附加`abort`监听器到`hardAbort`。
      // 一个将`abort`转发到当前`execAbortController`的单一监听器在构造函数中
      // 只安装一次。在每次`run()`上重新添加新的监听器会导致同一个`AbortSignal`
      // 实例累积监听器，这反过来会在十次调用后触发Node的`MaxListenersExceededWarning`。

      let lastResponseId: string = previousResponseId;

      // If there are unresolved function calls from a previously cancelled run
      // we have to emit dummy tool outputs so that the API no longer expects
      // them.  We prepend them to the user‑supplied input so they appear
      // first in the conversation turn.
      // 如果有来自先前取消运行的未解决函数调用，我们必须发出虚拟工具输出，
      // 以便API不再期望它们。我们将它们预先添加到用户提供的输入中，以便它们
      // 在对话轮次中首先出现。
      const abortOutputs: Array<ResponseInputItem> = [];
      if (this.pendingAborts.size > 0) {
        for (const id of this.pendingAborts) {
          abortOutputs.push({
            type: "function_call_output",
            call_id: id,
            output: JSON.stringify({
              output: "aborted",
              metadata: { exit_code: 1, duration_seconds: 0 },
            }),
          } as ResponseInputItem.FunctionCallOutput);
        }
        // Once converted the pending list can be cleared.
        // 一旦转换，待处理列表就可以被清除。
        this.pendingAborts.clear();
      }

      let turnInput = [...abortOutputs, ...input];

      this.onLoading(true);

      const staged: Array<ResponseItem | undefined> = [];
      const stageItem = (item: ResponseItem) => {
        // Ignore any stray events that belong to older generations.
        // 忽略属于较旧世代的任何游离事件。
        if (thisGeneration !== this.generation) {
          return;
        }

        // Store the item so the final flush can still operate on a complete list.
        // We'll nil out entries once they're delivered.
        // 存储项目，以便最终刷新仍然可以对完整列表进行操作。
        // 一旦它们被传递，我们将清空条目。
        const idx = staged.push(item) - 1;

        // Instead of emitting synchronously we schedule a short‑delay delivery.
        // This accomplishes two things:
        //   1. The UI still sees new messages almost immediately, creating the
        //      perception of real‑time updates.
        //   2. If the user calls `cancel()` in the small window right after the
        //      item was staged we can still abort the delivery because the
        //      generation counter will have been bumped by `cancel()`.
        // 我们不是同步发出，而是计划一个短延迟的传递。
        // 这实现了两件事：
        //   1. UI几乎立即看到新消息，创造了实时更新的感觉。
        //   2. 如果用户在项目被暂存后的小窗口中调用`cancel()`，我们仍然可以
        //      中止传递，因为世代计数器将被`cancel()`增加。
        setTimeout(() => {
          if (
            thisGeneration === this.generation &&
            !this.canceled &&
            !this.hardAbort.signal.aborted
          ) {
            this.onItem(item);
            // Mark as delivered so flush won't re-emit it
            // 标记为已传递，以便刷新不会重新发出它
            staged[idx] = undefined;
          }
        }, 10);
      };

      while (turnInput.length > 0) {
        if (this.canceled || this.hardAbort.signal.aborted) {
          this.onLoading(false);
          return;
        }
        // send request to openAI
        // 向openAI发送请求
        for (const item of turnInput) {
          stageItem(item as ResponseItem);
        }
        // Send request to OpenAI with retry on timeout
        // 向OpenAI发送请求，超时时重试
        let stream;

        // Retry loop for transient errors. Up to MAX_RETRIES attempts.
        // 临时错误的重试循环。最多尝试MAX_RETRIES次。
        const MAX_RETRIES = 5;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            let reasoning: Reasoning | undefined;
            if (this.model.startsWith("o")) {
              reasoning = { effort: "high" };
              if (this.model === "o3" || this.model === "o4-mini") {
                // @ts-expect-error waiting for API type update
                reasoning.summary = "auto";
              }
            }
            const mergedInstructions = [prefix, this.instructions]
              .filter(Boolean)
              .join("\n");
            if (isLoggingEnabled()) {
              log(
                `instructions (length ${mergedInstructions.length}): ${mergedInstructions}`,
              );
            }
            // eslint-disable-next-line no-await-in-loop
            stream = await this.oai.responses.create({
              model: this.model,
              instructions: mergedInstructions,
              previous_response_id: lastResponseId || undefined,
              input: turnInput,
              stream: true,
              parallel_tool_calls: false,
              reasoning,
              tools: [
                {
                  type: "function",
                  name: "shell",
                  description: "Runs a shell command, and returns its output.",
                  strict: false,
                  parameters: {
                    type: "object",
                    properties: {
                      command: { type: "array", items: { type: "string" } },
                      workdir: {
                        type: "string",
                        description: "The working directory for the command.",
                      },
                      timeout: {
                        type: "number",
                        description:
                          "The maximum time to wait for the command to complete in milliseconds.",
                      },
                    },
                    required: ["command"],
                    additionalProperties: false,
                  },
                },
              ],
            });
            break;
          } catch (error) {
            const isTimeout = error instanceof APIConnectionTimeoutError;
            // Lazily look up the APIConnectionError class at runtime to
            // accommodate the test environment's minimal OpenAI mocks which
            // do not define the class.  Falling back to `false` when the
            // export is absent ensures the check never throws.
            // 在运行时延迟查找APIConnectionError类，以适应测试环境中
            // 最小化的OpenAI模拟（它们没有定义该类）。当导出不存在时
            // 回退到`false`确保检查永远不会抛出异常。
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ApiConnErrCtor = (OpenAI as any).APIConnectionError as  // eslint-disable-next-line @typescript-eslint/no-explicit-any
              | (new (...args: any) => Error)
              | undefined;
            const isConnectionError = ApiConnErrCtor
              ? error instanceof ApiConnErrCtor
              : false;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const errCtx = error as any;
            const status =
              errCtx?.status ?? errCtx?.httpStatus ?? errCtx?.statusCode;
            const isServerError = typeof status === "number" && status >= 500;
            if (
              (isTimeout || isServerError || isConnectionError) &&
              attempt < MAX_RETRIES
            ) {
              log(
                `OpenAI request failed (attempt ${attempt}/${MAX_RETRIES}), retrying...`,
              );
              continue;
            }

            const isTooManyTokensError =
              (errCtx.param === "max_tokens" ||
                (typeof errCtx.message === "string" &&
                  /max_tokens is too large/i.test(errCtx.message))) &&
              errCtx.type === "invalid_request_error";

            if (isTooManyTokensError) {
              this.onItem({
                id: `error-${Date.now()}`,
                type: "message",
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text: "⚠️  The current request exceeds the maximum context length supported by the chosen model. Please shorten the conversation, run /clear, or switch to a model with a larger context window and try again.",
                  },
                ],
              });
              this.onLoading(false);
              return;
            }

            const isRateLimit =
              status === 429 ||
              errCtx.code === "rate_limit_exceeded" ||
              errCtx.type === "rate_limit_exceeded" ||
              /rate limit/i.test(errCtx.message ?? "");
            if (isRateLimit) {
              if (attempt < MAX_RETRIES) {
                // Exponential backoff: base wait * 2^(attempt-1), or use suggested retry time
                // if provided.
                // 指数退避：基本等待时间 * 2^(尝试次数-1)，或者使用建议的重试时间（如果提供）。
                let delayMs = RATE_LIMIT_RETRY_WAIT_MS * 2 ** (attempt - 1);

                // Parse suggested retry time from error message, e.g., "Please try again in 1.3s"
                // 从错误消息中解析建议的重试时间，例如，"Please try again in 1.3s"
                const msg = errCtx?.message ?? "";
                const m = /(?:retry|try) again in ([\d.]+)s/i.exec(msg);
                if (m && m[1]) {
                  const suggested = parseFloat(m[1]) * 1000;
                  if (!Number.isNaN(suggested)) {
                    delayMs = suggested;
                  }
                }
                log(
                  `OpenAI rate limit exceeded (attempt ${attempt}/${MAX_RETRIES}), retrying in ${Math.round(
                    delayMs,
                  )} ms...`,
                );
                // eslint-disable-next-line no-await-in-loop
                await new Promise((resolve) => setTimeout(resolve, delayMs));
                continue;
              } else {
                // We have exhausted all retry attempts. Surface a message so the user understands
                // why the request failed and can decide how to proceed (e.g. wait and retry later
                // or switch to a different model / account).
                // 我们已用尽所有重试尝试。显示一条消息，让用户了解请求失败的原因，
                // 并可以决定如何继续（例如，等待并稍后重试，或切换到不同的模型/账户）。

                const errorDetails = [
                  `Status: ${status || "unknown"}`,
                  `Code: ${errCtx.code || "unknown"}`,
                  `Type: ${errCtx.type || "unknown"}`,
                  `Message: ${errCtx.message || "unknown"}`,
                ].join(", ");

                this.onItem({
                  id: `error-${Date.now()}`,
                  type: "message",
                  role: "system",
                  content: [
                    {
                      type: "input_text",
                      text: `⚠️  Rate limit reached. Error details: ${errorDetails}. Please try again later.`,
                    },
                  ],
                });

                this.onLoading(false);
                return;
              }
            }

            const isClientError =
              (typeof status === "number" &&
                status >= 400 &&
                status < 500 &&
                status !== 429) ||
              errCtx.code === "invalid_request_error" ||
              errCtx.type === "invalid_request_error";
            if (isClientError) {
              this.onItem({
                id: `error-${Date.now()}`,
                type: "message",
                role: "system",
                content: [
                  {
                    type: "input_text",
                    // Surface the request ID when it is present on the error so users
                    // can reference it when contacting support or inspecting logs.
                    // 当错误中存在请求ID时显示它，以便用户在联系支持或检查日志时可以引用它。
                    text: (() => {
                      const reqId =
                        (
                          errCtx as Partial<{
                            request_id?: string;
                            requestId?: string;
                          }>
                        )?.request_id ??
                        (
                          errCtx as Partial<{
                            request_id?: string;
                            requestId?: string;
                          }>
                        )?.requestId;

                      const errorDetails = [
                        `Status: ${status || "unknown"}`,
                        `Code: ${errCtx.code || "unknown"}`,
                        `Type: ${errCtx.type || "unknown"}`,
                        `Message: ${errCtx.message || "unknown"}`,
                      ].join(", ");

                      return `⚠️  OpenAI rejected the request${
                        reqId ? ` (request ID: ${reqId})` : ""
                      }. Error details: ${errorDetails}. Please verify your settings and try again.`;
                    })(),
                  },
                ],
              });
              this.onLoading(false);
              return;
            }
            throw error;
          }
        }
        turnInput = []; // clear turn input, prepare for function call results
                        // 清除轮次输入，准备函数调用结果

        // If the user requested cancellation while we were awaiting the network
        // request, abort immediately before we start handling the stream.
        // 如果用户在我们等待网络请求时请求取消，在我们开始处理流之前立即中止。
        if (this.canceled || this.hardAbort.signal.aborted) {
          // `stream` is defined; abort to avoid wasting tokens/server work
          // `stream`已定义；中止以避免浪费令牌/服务器工作
          try {
            (
              stream as { controller?: { abort?: () => void } }
            )?.controller?.abort?.();
          } catch {
            /* ignore */
          }
          this.onLoading(false);
          return;
        }

        // Keep track of the active stream so it can be aborted on demand.
        // 跟踪活动流，以便可以按需中止。
        this.currentStream = stream;

        // guard against an undefined stream before iterating
        // 在迭代之前防止未定义的流
        if (!stream) {
          this.onLoading(false);
          log("AgentLoop.run(): stream is undefined");
          return;
        }

        try {
          // eslint-disable-next-line no-await-in-loop
          for await (const event of stream) {
            if (isLoggingEnabled()) {
              log(`AgentLoop.run(): response event ${event.type}`);
            }

            // process and surface each item (no‑op until we can depend on streaming events)
            // 处理并显示每个项目（在我们可以依赖流式事件之前是无操作的）
            if (event.type === "response.output_item.done") {
              const item = event.item;
              // 1) if it's a reasoning item, annotate it
              // 1) 如果是推理项，对其进行注释
              type ReasoningItem = { type?: string; duration_ms?: number };
              const maybeReasoning = item as ReasoningItem;
              if (maybeReasoning.type === "reasoning") {
                maybeReasoning.duration_ms = Date.now() - thinkingStart;
              }
              if (item.type === "function_call") {
                // Track outstanding tool call so we can abort later if needed.
                // The item comes from the streaming response, therefore it has
                // either `id` (chat) or `call_id` (responses) – we normalise
                // by reading both.
                // 跟踪未完成的工具调用，以便在需要时可以稍后中止。
                // 该项来自流式响应，因此它有`id`（聊天）或`call_id`（响应）
                // - 我们通过读取两者来标准化。
                const callId =
                  (item as { call_id?: string; id?: string }).call_id ??
                  (item as { id?: string }).id;
                if (callId) {
                  this.pendingAborts.add(callId);
                }
              } else {
                stageItem(item as ResponseItem);
              }
            }

            if (event.type === "response.completed") {
              if (thisGeneration === this.generation && !this.canceled) {
                for (const item of event.response.output) {
                  stageItem(item as ResponseItem);
                }
              }
              if (event.response.status === "completed") {
                // TODO: remove this once we can depend on streaming events
                // TODO: 一旦我们可以依赖流式事件就删除这个
                const newTurnInput = await this.processEventsWithoutStreaming(
                  event.response.output,
                  stageItem,
                );
                turnInput = newTurnInput;
              }
              lastResponseId = event.response.id;
              this.onLastResponseId(event.response.id);
            }
          }
        } catch (err: unknown) {
          // Gracefully handle an abort triggered via `cancel()` so that the
          // consumer does not see an unhandled exception.
          // 优雅地处理通过`cancel()`触发的中止，以便消费者不会看到未处理的异常。
          if (err instanceof Error && err.name === "AbortError") {
            if (!this.canceled) {
              // It was aborted for some other reason; surface the error.
              // 它因其他原因被中止；显示错误。
              throw err;
            }
            this.onLoading(false);
            return;
          }
          throw err;
        } finally {
          this.currentStream = null;
        }

        log(
          `Turn inputs (${turnInput.length}) - ${turnInput
            .map((i) => i.type)
            .join(", ")}`,
        );
      }

      // Flush staged items if the run concluded successfully (i.e. the user did
      // not invoke cancel() or terminate() during the turn).
      // 如果运行成功结束（即用户在轮次期间没有调用cancel()或terminate()），
      // 则刷新暂存项。
      const flush = () => {
        if (
          !this.canceled &&
          !this.hardAbort.signal.aborted &&
          thisGeneration === this.generation
        ) {
          // Only emit items that weren't already delivered above
          // 只发出上面尚未传递的项目
          for (const item of staged) {
            if (item) {
              this.onItem(item);
            }
          }
        }

        // At this point the turn finished without the user invoking
        // `cancel()`.  Any outstanding function‑calls must therefore have been
        // satisfied, so we can safely clear the set that tracks pending aborts
        // to avoid emitting duplicate synthetic outputs in subsequent runs.
        // 在这一点上，轮次在用户没有调用`cancel()`的情况下结束。
        // 因此，任何未完成的函数调用都必须已经得到满足，所以我们可以安全地
        // 清除跟踪待处理中止的集合，以避免在后续运行中发出重复的合成输出。
        this.pendingAborts.clear();
        // Now emit system messages recording the per‑turn *and* cumulative
        // thinking times so UIs and tests can surface/verify them.
        // 现在发出系统消息，记录每轮*和*累计思考时间，以便UI和测试可以显示/验证它们。
        // const thinkingEnd = Date.now();

        // 1) Per‑turn measurement – exact time spent between request and
        //    response for *this* command.
        // 1) 每轮测量 - 此命令的请求和响应之间花费的确切时间。
        // this.onItem({
        //   id: `thinking-${thinkingEnd}`,
        //   type: "message",
        //   role: "system",
        //   content: [
        //     {
        //       type: "input_text",
        //       text: `🤔  Thinking time: ${Math.round(
        //         (thinkingEnd - thinkingStart) / 1000
        //       )} s`,
        //     },
        //   ],
        // });

        // 2) Session‑wide cumulative counter so users can track overall wait
        //    time across multiple turns.
        // 2) 会话范围的累计计数器，以便用户可以跟踪多个轮次的总等待时间。
        // this.cumulativeThinkingMs += thinkingEnd - thinkingStart;
        // this.onItem({
        //   id: `thinking-total-${thinkingEnd}`,
        //   type: "message",
        //   role: "system",
        //   content: [
        //     {
        //       type: "input_text",
        //       text: `⏱  Total thinking time: ${Math.round(
        //         this.cumulativeThinkingMs / 1000
        //       )} s`,
        //     },
        //   ],
        // });

        this.onLoading(false);
      };

      // Delay flush slightly to allow a near‑simultaneous cancel() to land.
      // 稍微延迟刷新，以允许几乎同时的cancel()落地。
      setTimeout(flush, 30);
      // End of main logic. The corresponding catch block for the wrapper at the
      // start of this method follows next.
      // 主逻辑结束。此方法开始处的包装器的相应catch块接下来。
    } catch (err) {
      // Handle known transient network/streaming issues so they do not crash the
      // CLI. We currently match Node/undici's `ERR_STREAM_PREMATURE_CLOSE`
      // error which manifests when the HTTP/2 stream terminates unexpectedly
      // (e.g. during brief network hiccups).
      // 处理已知的临时网络/流问题，以便它们不会使CLI崩溃。
      // 我们目前匹配Node/undici的`ERR_STREAM_PREMATURE_CLOSE`错误，
      // 该错误在HTTP/2流意外终止时表现出来（例如，在短暂的网络中断期间）。

      const isPrematureClose =
        err instanceof Error &&
        // eslint-disable-next-line
        ((err as any).code === "ERR_STREAM_PREMATURE_CLOSE" ||
          err.message?.includes("Premature close"));

      if (isPrematureClose) {
        try {
          this.onItem({
            id: `error-${Date.now()}`,
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text: "⚠️  Connection closed prematurely while waiting for the model. Please try again.",
              },
            ],
          });
        } catch {
          /* no‑op – emitting the error message is best‑effort */
          /* 无操作 - 发出错误消息是尽力而为 */
        }
        this.onLoading(false);
        return;
      }

      // -------------------------------------------------------------------
      // Catch‑all handling for other network or server‑side issues so that
      // transient failures do not crash the CLI. We intentionally keep the
      // detection logic conservative to avoid masking programming errors. A
      // failure is treated as retry‑worthy/user‑visible when any of the
      // following apply:
      //   • the error carries a recognised Node.js network errno ‑ style code
      //     (e.g. ECONNRESET, ETIMEDOUT …)
      //   • the OpenAI SDK attached an HTTP `status` >= 500 indicating a
      //     server‑side problem.
      //   • the error is model specific and detected in stream.
      // If matched we emit a single system message to inform the user and
      // resolve gracefully so callers can choose to retry.
      // -------------------------------------------------------------------
      // -------------------------------------------------------------------
      // 对其他网络或服务器端问题的全面处理，以便临时故障不会使CLI崩溃。
      // 我们有意保持检测逻辑保守，以避免掩盖编程错误。
      // 当以下任何一项适用时，故障被视为值得重试/用户可见：
      //   • 错误带有公认的Node.js网络errno风格代码（例如ECONNRESET，ETIMEDOUT…）
      //   • OpenAI SDK附加了HTTP `status` >= 500，表示服务器端问题。
      //   • 错误是特定于模型的，并在流中检测到。
      // 如果匹配，我们发出一个系统消息通知用户，并优雅地解决，以便调用者可以选择重试。
      // -------------------------------------------------------------------

      const NETWORK_ERRNOS = new Set([
        "ECONNRESET",
        "ECONNREFUSED",
        "EPIPE",
        "ENOTFOUND",
        "ETIMEDOUT",
        "EAI_AGAIN",
      ]);

      const isNetworkOrServerError = (() => {
        if (!err || typeof err !== "object") {
          return false;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e: any = err;

        // Direct instance check for connection errors thrown by the OpenAI SDK.
        // 对OpenAI SDK抛出的连接错误进行直接实例检查。
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ApiConnErrCtor = (OpenAI as any).APIConnectionError as  // eslint-disable-next-line @typescript-eslint/no-explicit-any
          | (new (...args: any) => Error)
          | undefined;
        if (ApiConnErrCtor && e instanceof ApiConnErrCtor) {
          return true;
        }

        if (typeof e.code === "string" && NETWORK_ERRNOS.has(e.code)) {
          return true;
        }

        // When the OpenAI SDK nests the underlying network failure inside the
        // `cause` property we surface it as well so callers do not see an
        // unhandled exception for errors like ENOTFOUND, ECONNRESET …
        // 当OpenAI SDK将底层网络故障嵌套在`cause`属性中时，我们也将其暴露出来，
        // 以便调用者不会看到诸如ENOTFOUND、ECONNRESET等错误的未处理异常。
        if (
          e.cause &&
          typeof e.cause === "object" &&
          NETWORK_ERRNOS.has((e.cause as { code?: string }).code ?? "")
        ) {
          return true;
        }

        if (typeof e.status === "number" && e.status >= 500) {
          return true;
        }

        // Fallback to a heuristic string match so we still catch future SDK
        // variations without enumerating every errno.
        // 回退到启发式字符串匹配，以便我们仍然能捕获未来的SDK变体，
        // 而无需枚举每个errno。
        if (
          typeof e.message === "string" &&
          /network|socket|stream/i.test(e.message)
        ) {
          return true;
        }

        return false;
      })();

      if (isNetworkOrServerError) {
        try {
          const msgText =
            "⚠️  Network error while contacting OpenAI. Please check your connection and try again.";
          this.onItem({
            id: `error-${Date.now()}`,
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text: msgText,
              },
            ],
          });
        } catch {
          /* best‑effort */
          /* 尽力而为 */
        }
        this.onLoading(false);
        return;
      }

      const isInvalidRequestError = () => {
        if (!err || typeof err !== "object") {
          return false;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e: any = err;

        if (
          e.type === "invalid_request_error" &&
          e.code === "model_not_found"
        ) {
          return true;
        }

        if (
          e.cause &&
          e.cause.type === "invalid_request_error" &&
          e.cause.code === "model_not_found"
        ) {
          return true;
        }

        return false;
      };

      if (isInvalidRequestError()) {
        try {
          // Extract request ID and error details from the error object
          // 从错误对象中提取请求ID和错误详情

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const e: any = err;

          const reqId =
            e.request_id ??
            (e.cause && e.cause.request_id) ??
            (e.cause && e.cause.requestId);

          const errorDetails = [
            `Status: ${e.status || (e.cause && e.cause.status) || "unknown"}`,
            `Code: ${e.code || (e.cause && e.cause.code) || "unknown"}`,
            `Type: ${e.type || (e.cause && e.cause.type) || "unknown"}`,
            `Message: ${
              e.message || (e.cause && e.cause.message) || "unknown"
            }`,
          ].join(", ");

          const msgText = `⚠️  OpenAI rejected the request${
            reqId ? ` (request ID: ${reqId})` : ""
          }. Error details: ${errorDetails}. Please verify your settings and try again.`;

          this.onItem({
            id: `error-${Date.now()}`,
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text: msgText,
              },
            ],
          });
        } catch {
          /* best-effort */
          /* 尽力而为 */
        }
        this.onLoading(false);
        return;
      }

      // Re‑throw all other errors so upstream handlers can decide what to do.
      // 重新抛出所有其他错误，以便上游处理程序可以决定如何处理。
      throw err;
    }
  }

  // we need until we can depend on streaming events
  // 我们需要直到我们可以依赖流式事件
  private async processEventsWithoutStreaming(
    output: Array<ResponseInputItem>,
    emitItem: (item: ResponseItem) => void,
  ): Promise<Array<ResponseInputItem>> {
    // If the agent has been canceled we should short‑circuit immediately to
    // avoid any further processing (including potentially expensive tool
    // calls). Returning an empty array ensures the main run‑loop terminates
    // promptly.
    // 如果代理已被取消，我们应该立即短路，以避免任何进一步的处理（包括可能昂贵的工具调用）。
    // 返回空数组确保主运行循环及时终止。
    if (this.canceled) {
      return [];
    }
    const turnInput: Array<ResponseInputItem> = [];
    for (const item of output) {
      if (item.type === "function_call") {
        if (alreadyProcessedResponses.has(item.id)) {
          continue;
        }
        alreadyProcessedResponses.add(item.id);
        // eslint-disable-next-line no-await-in-loop
        const result = await this.handleFunctionCall(item);
        turnInput.push(...result);
      }
      emitItem(item as ResponseItem);
    }
    return turnInput;
  }
}

const prefix = `You are operating as and within the Codex CLI, a terminal-based agentic coding assistant built by OpenAI. It wraps OpenAI models to enable natural language interaction with a local codebase. You are expected to be precise, safe, and helpful.
// 你作为并在Codex CLI内运行，这是一个由OpenAI构建的基于终端的智能编码助手。它封装了OpenAI模型，以实现与本地代码库的自然语言交互。你应当精确、安全且有帮助。

You can:
// 你可以：
- Receive user prompts, project context, and files.
// - 接收用户提示、项目上下文和文件。
- Stream responses and emit function calls (e.g., shell commands, code edits).
// - 流式传输响应并发出函数调用（例如，shell命令、代码编辑）。
- Apply patches, run commands, and manage user approvals based on policy.
// - 应用补丁、运行命令，并根据策略管理用户批准。
- Work inside a sandboxed, git-backed workspace with rollback support.
// - 在具有回滚支持的沙盒、git支持的工作空间内工作。
- Log telemetry so sessions can be replayed or inspected later.
// - 记录遥测数据，以便会话可以稍后重放或检查。
- More details on your functionality are available at \`codex --help\`
// - 有关你功能的更多详情可在\`codex --help\`中获取

The Codex CLI is open-sourced. Don't confuse yourself with the old Codex language model built by OpenAI many moons ago (this is understandably top of mind for you!). Within this context, Codex refers to the open-source agentic coding interface.
// Codex CLI是开源的。不要将自己与OpenAI很久以前构建的旧Codex语言模型混淆（这对你来说可以理解为首要考虑的事情！）。在此上下文中，Codex指的是开源的智能编码接口。

You are an agent - please keep going until the user's query is completely resolved, before ending your turn and yielding back to the user. Only terminate your turn when you are sure that the problem is solved. If you are not sure about file content or codebase structure pertaining to the user's request, use your tools to read files and gather the relevant information: do NOT guess or make up an answer.
// 你是一个代理 - 请继续直到用户的查询完全解决，然后再结束你的回合并让位给用户。只有当你确定问题已解决时才终止你的回合。如果你不确定与用户请求相关的文件内容或代码库结构，请使用你的工具阅读文件并收集相关信息：不要猜测或编造答案。

Please resolve the user's task by editing and testing the code files in your current code execution session. You are a deployed coding agent. Your session allows for you to modify and run code. The repo(s) are already cloned in your working directory, and you must fully solve the problem for your answer to be considered correct.
// 请通过在当前代码执行会话中编辑和测试代码文件来解决用户的任务。你是一个已部署的编码代理。你的会话允许你修改和运行代码。仓库已经克隆在你的工作目录中，你必须完全解决问题才能被认为是正确的答案。

You MUST adhere to the following criteria when executing the task:
// 执行任务时，你必须遵守以下标准：
- Working on the repo(s) in the current environment is allowed, even if they are proprietary.
// - 允许在当前环境中处理仓库，即使它们是专有的。
- Analyzing code for vulnerabilities is allowed.
// - 允许分析代码的漏洞。
- Showing user code and tool call details is allowed.
// - 允许显示用户代码和工具调用详情。
- User instructions may overwrite the *CODING GUIDELINES* section in this developer message.
// - 用户指令可能会覆盖此开发者消息中的*编码指南*部分。
- Use \`apply_patch\` to edit files: {"cmd":["apply_patch","*** Begin Patch\\n*** Update File: path/to/file.py\\n@@ def example():\\n-  pass\\n+  return 123\\n*** End Patch"]}
// - 使用\`apply_patch\`编辑文件：{"cmd":["apply_patch","*** Begin Patch\\n*** Update File: path/to/file.py\\n@@ def example():\\n-  pass\\n+  return 123\\n*** End Patch"]}
- If completing the user's task requires writing or modifying files:
// - 如果完成用户的任务需要编写或修改文件：
    - Your code and final answer should follow these *CODING GUIDELINES*:
    // - 你的代码和最终答案应遵循这些*编码指南*：
        - Fix the problem at the root cause rather than applying surface-level patches, when possible.
        // - 尽可能从根本原因修复问题，而不是应用表面级别的补丁。
        - Avoid unneeded complexity in your solution.
        // - 避免在你的解决方案中出现不必要的复杂性。
            - Ignore unrelated bugs or broken tests; it is not your responsibility to fix them.
            // - 忽略不相关的错误或损坏的测试；修复它们不是你的责任。
        - Update documentation as necessary.
        // - 根据需要更新文档。
        - Keep changes consistent with the style of the existing codebase. Changes should be minimal and focused on the task.
        // - 保持更改与现有代码库风格一致。更改应当是最小的，并专注于任务。
            - Use \`git log\` and \`git blame\` to search the history of the codebase if additional context is required; internet access is disabled.
            // - 如果需要额外上下文，使用\`git log\`和\`git blame\`搜索代码库的历史；互联网访问被禁用。
        - NEVER add copyright or license headers unless specifically requested.
        // - 除非特别要求，否则绝不添加版权或许可证头。
        - You do not need to \`git commit\` your changes; this will be done automatically for you.
        // - 你不需要\`git commit\`你的更改；这将自动为你完成。
        - If there is a .pre-commit-config.yaml, use \`pre-commit run --files ...\` to check that your changes pass the pre-commit checks. However, do not fix pre-existing errors on lines you didn't touch.
        // - 如果有.pre-commit-config.yaml，使用\`pre-commit run --files ...\`检查你的更改是否通过预提交检查。但是，不要修复你没有触碰的行上预先存在的错误。
            - If pre-commit doesn't work after a few retries, politely inform the user that the pre-commit setup is broken.
            // - 如果预提交在几次重试后不起作用，礼貌地通知用户预提交设置已损坏。
        - Once you finish coding, you must
        // - 一旦你完成编码，你必须
            - Check \`git status\` to sanity check your changes; revert any scratch files or changes.
            // - 检查\`git status\`以理智检查你的更改；恢复任何草稿文件或更改。
            - Remove all inline comments you added as much as possible, even if they look normal. Check using \`git diff\`. Inline comments must be generally avoided, unless active maintainers of the repo, after long careful study of the code and the issue, will still misinterpret the code without the comments.
            // - 尽可能删除你添加的所有内联注释，即使它们看起来正常。使用\`git diff\`检查。通常应避免内联注释，除非仓库的活跃维护者在长时间仔细研究代码和问题后，仍然会误解没有注释的代码。
            - Check if you accidentally add copyright or license headers. If so, remove them.
            // - 检查你是否意外添加了版权或许可证头。如果是，请删除它们。
            - Try to run pre-commit if it is available.
            // - 如果可用，尝试运行预提交。
            - For smaller tasks, describe in brief bullet points
            // - 对于较小的任务，用简短的要点描述
            - For more complex tasks, include brief high-level description, use bullet points, and include details that would be relevant to a code reviewer.
            // - 对于更复杂的任务，包括简短的高级描述，使用要点，并包括与代码审核者相关的详细信息。
- If completing the user's task DOES NOT require writing or modifying files (e.g., the user asks a question about the code base):
// - 如果完成用户的任务不需要编写或修改文件（例如，用户询问有关代码库的问题）：
    - Respond in a friendly tune as a remote teammate, who is knowledgeable, capable and eager to help with coding.
    // - 以友好的语调回应，就像一个远程团队成员，他知识渊博，能力强，渴望帮助编码。
- When your task involves writing or modifying files:
// - 当你的任务涉及编写或修改文件时：
    - Do NOT tell the user to "save the file" or "copy the code into a file" if you already created or modified the file using \`apply_patch\`. Instead, reference the file as already saved.
    // - 如果你已经使用\`apply_patch\`创建或修改了文件，不要告诉用户"保存文件"或"将代码复制到文件中"。相反，引用文件为已保存。
    - Do NOT show the full contents of large files you have already written, unless the user explicitly asks for them.
    // - 不要显示你已经编写的大文件的完整内容，除非用户明确要求它们。`;
