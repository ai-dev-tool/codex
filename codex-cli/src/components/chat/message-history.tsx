import type { TerminalHeaderProps } from "./terminal-header.js";
import type { GroupedResponseItem } from "./use-message-grouping.js";
import type { ResponseItem } from "openai/resources/responses/responses.mjs";

import TerminalChatResponseItem from "./terminal-chat-response-item.js";
import TerminalHeader from "./terminal-header.js";
import { Box, Static } from "ink";
import React from "react";

// A batch entry can either be a standalone response item or a grouped set of
// items (e.g. auto‑approved tool‑call batches) that should be rendered
// together.
// 批处理条目可以是独立的响应项，也可以是应该一起渲染的
// 分组项目集（例如自动批准的工具调用批处理）。
type BatchEntry = { item?: ResponseItem; group?: GroupedResponseItem };
type MessageHistoryProps = {
  batch: Array<BatchEntry>;
  groupCounts: Record<string, number>;
  items: Array<ResponseItem>;
  userMsgCount: number;
  confirmationPrompt: React.ReactNode;
  loading: boolean;
  headerProps: TerminalHeaderProps;
};

const MessageHistory: React.FC<MessageHistoryProps> = ({
  batch,
  headerProps,
}) => {
  const messages = batch.map(({ item }) => item!);

  return (
    <Box flexDirection="column">
      {/*
       * The Static component receives a mixed array of the literal string
       * "header" plus the streamed ResponseItem objects.  After filtering out
       * the header entry we can safely treat the remaining values as
       * ResponseItem, however TypeScript cannot infer the refined type from
       * the runtime check and therefore reports property‑access errors.
       *
       * A short cast after the refinement keeps the implementation tidy while
       * preserving type‑safety.
       *
       * Static组件接收一个混合数组，包含字面量字符串"header"和流式
       * ResponseItem对象。在过滤掉header条目后，我们可以安全地将剩余值
       * 视为ResponseItem，但TypeScript无法从运行时检查中推断出精细的类型，
       * 因此报告属性访问错误。
       *
       * 在精细化后进行简短的类型转换可以保持实现整洁，同时保证类型安全。
       */}
      <Static items={["header", ...messages]}>
        {(item, index) => {
          if (item === "header") {
            return <TerminalHeader key="header" {...headerProps} />;
          }

          // After the guard above `item` can only be a ResponseItem.
          // 经过上面的守卫后，`item`只能是ResponseItem。
          const message = item as ResponseItem;
          return (
            <Box
              key={`${message.id}-${index}`}
              flexDirection="column"
              borderStyle={
                message.type === "message" && message.role === "user"
                  ? "round"
                  : undefined
              }
              borderColor={
                message.type === "message" && message.role === "user"
                  ? "gray"
                  : undefined
              }
              marginLeft={
                message.type === "message" && message.role === "user" ? 0 : 4
              }
              marginTop={
                message.type === "message" && message.role === "user" ? 0 : 1
              }
            >
              <TerminalChatResponseItem item={message} />
            </Box>
          );
        }}
      </Static>
    </Box>
  );
};

export default React.memo(MessageHistory);
