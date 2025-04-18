import type { TerminalRendererOptions } from "marked-terminal";
import type {
  ResponseFunctionToolCallItem,
  ResponseFunctionToolCallOutputItem,
  ResponseInputMessageItem,
  ResponseItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
} from "openai/resources/responses/responses";

import { useTerminalSize } from "../../hooks/use-terminal-size";
import { parseToolCall, parseToolCallOutput } from "../../utils/parsers";
import chalk, { type ForegroundColorName } from "chalk";
import { Box, Text } from "ink";
import { parse, setOptions } from "marked";
import TerminalRenderer from "marked-terminal";
import React, { useMemo } from "react";

export default function TerminalChatResponseItem({
  item,
  fullStdout = false,
}: {
  item: ResponseItem;
  fullStdout?: boolean;
}): React.ReactElement {
  switch (item.type) {
    case "message":
      return <TerminalChatResponseMessage message={item} />;
    case "function_call":
      return <TerminalChatResponseToolCall message={item} />;
    case "function_call_output":
      return (
        <TerminalChatResponseToolCallOutput
          message={item}
          fullStdout={fullStdout}
        />
      );
    default:
      break;
  }

  // @ts-expect-error `reasoning` is not in the responses API yet
  // @ts-expect-error `reasoning` 尚未在响应API中
  if (item.type === "reasoning") {
    return <TerminalChatResponseReasoning message={item} />;
  }

  return <TerminalChatResponseGenericMessage message={item} />;
}

// TODO: this should be part of `ResponseReasoningItem`. Also it doesn't work.
// TODO: 这应该是 `ResponseReasoningItem` 的一部分。而且它不起作用。
// ---------------------------------------------------------------------------
// Utility helpers
// 实用工具函数
// ---------------------------------------------------------------------------

/**
 * Guess how long the assistant spent "thinking" based on the combined length
 * of the reasoning summary. The calculation itself is fast, but wrapping it in
 * `useMemo` in the consuming component ensures it only runs when the
 * `summary` array actually changes.
 *
 * 根据推理摘要的组合长度来猜测助手花费了多长时间“思考”。
 * 计算本身很快，但在消费组件中将其包装在`useMemo`中可确保
 * 它仅在`summary`数组实际变化时运行。
 */
// TODO: use actual thinking time
// TODO: 使用实际思考时间
//
// function guessThinkingTime(summary: Array<ResponseReasoningItem.Summary>) {
//   const totalTextLength = summary
//     .map((t) => t.text.length)
//     .reduce((a, b) => a + b, summary.length - 1);
//   return Math.max(1, Math.ceil(totalTextLength / 300));
// }

export function TerminalChatResponseReasoning({
  message,
}: {
  message: ResponseReasoningItem & { duration_ms?: number };
}): React.ReactElement | null {
  // Only render when there is a reasoning summary
  // 仅在有推理摘要时渲染
  if (!message.summary || message.summary.length === 0) {
    return null;
  }
  return (
    <Box gap={1} flexDirection="column">
      {message.summary.map((summary, key) => {
        const s = summary as { headline?: string; text: string };
        return (
          <Box key={key} flexDirection="column">
            {s.headline && <Text bold>{s.headline}</Text>}
            <Markdown>{s.text}</Markdown>
          </Box>
        );
      })}
    </Box>
  );
}

const colorsByRole: Record<string, ForegroundColorName> = {
  assistant: "magentaBright",
  user: "blueBright",
};

function TerminalChatResponseMessage({
  message,
}: {
  message: ResponseInputMessageItem | ResponseOutputMessage;
}) {
  return (
    <Box flexDirection="column">
      <Text bold color={colorsByRole[message.role] || "gray"}>
        {message.role === "assistant" ? "codex" : message.role}
      </Text>
      <Markdown>
        {message.content
          .map(
            (c) =>
              c.type === "output_text"
                ? c.text
                : c.type === "refusal"
                ? c.refusal
                : c.type === "input_text"
                ? c.text
                : c.type === "input_image"
                ? "<Image>"
                : c.type === "input_file"
                ? c.filename
                : "", // unknown content type
          )
          .join(" ")}
      </Markdown>
    </Box>
  );
}

function TerminalChatResponseToolCall({
  message,
}: {
  message: ResponseFunctionToolCallItem;
}) {
  const details = parseToolCall(message);
  return (
    <Box flexDirection="column" gap={1}>
      <Text color="magentaBright" bold>
        command
      </Text>
      <Text>
        <Text dimColor>$</Text> {details?.cmdReadableText}
      </Text>
    </Box>
  );
}

function TerminalChatResponseToolCallOutput({
  message,
  fullStdout,
}: {
  message: ResponseFunctionToolCallOutputItem;
  fullStdout: boolean;
}) {
  const { output, metadata } = parseToolCallOutput(message.output);
  const { exit_code, duration_seconds } = metadata;
  const metadataInfo = useMemo(
    () =>
      [
        typeof exit_code !== "undefined" ? `code: ${exit_code}` : "",
        typeof duration_seconds !== "undefined"
          ? `duration: ${duration_seconds}s`
          : "",
      ]
        .filter(Boolean)
        .join(", "),
    [exit_code, duration_seconds],
  );
  let displayedContent = output;
  if (message.type === "function_call_output" && !fullStdout) {
    const lines = displayedContent.split("\n");
    if (lines.length > 4) {
      const head = lines.slice(0, 4);
      const remaining = lines.length - 4;
      displayedContent = [...head, `... (${remaining} more lines)`].join("\n");
    }
  }

  // -------------------------------------------------------------------------
  // Colorize diff output: lines starting with '-' in red, '+' in green.
  // This makes patches and other diff‑like stdout easier to read.
  // We exclude the typical diff file headers ('---', '+++') so they retain
  // the default color. This is a best‑effort heuristic and should be safe for
  // non‑diff output – only the very first character of a line is inspected.
  // -------------------------------------------------------------------------
  // 给diff输出上色：以'-'开头的行显示为红色，以'+'开头的行显示为绿色。
  // 这使补丁和其他类似diff的标准输出更易于阅读。
  // 我们排除了典型的diff文件头部('---', '+++')，以便它们保留
  // 默认颜色。这是一种尽力而为的启发式方法，应该对非diff输出是安全的
  // - 只检查行的第一个字符。
  const colorizedContent = displayedContent
    .split("\n")
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("++")) {
        return chalk.green(line);
      }
      if (line.startsWith("-") && !line.startsWith("--")) {
        return chalk.red(line);
      }
      return line;
    })
    .join("\n");
  return (
    <Box flexDirection="column" gap={1}>
      <Text color="magenta" bold>
        command.stdout{" "}
        <Text dimColor>{metadataInfo ? `(${metadataInfo})` : ""}</Text>
      </Text>
      <Text dimColor>{colorizedContent}</Text>
    </Box>
  );
}

export function TerminalChatResponseGenericMessage({
  message,
}: {
  message: ResponseItem;
}): React.ReactElement {
  return <Text>{JSON.stringify(message, null, 2)}</Text>;
}

export type MarkdownProps = TerminalRendererOptions & {
  children: string;
};

export function Markdown({
  children,
  ...options
}: MarkdownProps): React.ReactElement {
  const size = useTerminalSize();

  const rendered = React.useMemo(() => {
    // Configure marked for this specific render
    // 为这个特定渲染配置marked
    setOptions({
      // @ts-expect-error missing parser, space props
      // @ts-expect-error 缺少解析器，空间属性
      renderer: new TerminalRenderer({ ...options, width: size.columns }),
    });
    const parsed = parse(children, { async: false }).trim();

    // Remove the truncation logic
    // 移除截断逻辑
    return parsed;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- options is an object of primitives
    // eslint-disable-next-line react-hooks/exhaustive-deps -- options是一个原始值对象
  }, [children, size.columns, size.rows]);

  return <Text>{rendered}</Text>;
}
