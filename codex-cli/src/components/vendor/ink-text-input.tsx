import React, { useEffect, useState } from "react";
import { Text, useInput } from "ink";
import chalk from "chalk";
import type { Except } from "type-fest";

export type TextInputProps = {
  /**
   * Text to display when `value` is empty.
   * 当`value`为空时显示的文本。
   */
  readonly placeholder?: string;

  /**
   * Listen to user's input. Useful in case there are multiple input components
   * at the same time and input must be "routed" to a specific component.
   * 监听用户输入。当同时有多个输入组件且输入必须“路由”到特定组件时非常有用。
   */
  readonly focus?: boolean; // eslint-disable-line react/boolean-prop-naming

  /**
   * Replace all chars and mask the value. Useful for password inputs.
   * 替换所有字符并遮蔽值。对密码输入非常有用。
   */
  readonly mask?: string;

  /**
   * Whether to show cursor and allow navigation inside text input with arrow keys.
   * 是否显示光标并允许使用箭头键在文本输入内导航。
   */
  readonly showCursor?: boolean; // eslint-disable-line react/boolean-prop-naming

  /**
   * Highlight pasted text
   * 高亮显示粘贴的文本
   */
  readonly highlightPastedText?: boolean; // eslint-disable-line react/boolean-prop-naming

  /**
   * Value to display in a text input.
   * 在文本输入中显示的值。
   */
  readonly value: string;

  /**
   * Function to call when value updates.
   * 当值更新时调用的函数。
   */
  readonly onChange: (value: string) => void;

  /**
   * Function to call when `Enter` is pressed, where first argument is a value of the input.
   * 当按下`Enter`键时调用的函数，其中第一个参数是输入的值。
   */
  readonly onSubmit?: (value: string) => void;
};

function findPrevWordJump(prompt: string, cursorOffset: number) {
  const regex = /[\s,.;!?]+/g;
  let lastMatch = 0;
  let currentMatch: RegExpExecArray | null;

  const stringToCursorOffset = prompt
    .slice(0, cursorOffset)
    .replace(/[\s,.;!?]+$/, "");

  // Loop through all matches
  // 遍历所有匹配项
  while ((currentMatch = regex.exec(stringToCursorOffset)) !== null) {
    lastMatch = currentMatch.index;
  }

  // Include the last match unless it is the first character
  // 包含最后一个匹配项，除非它是第一个字符
  if (lastMatch != 0) {
    lastMatch += 1;
  }
  return lastMatch;
}

function findNextWordJump(prompt: string, cursorOffset: number) {
  const regex = /[\s,.;!?]+/g;
  let currentMatch: RegExpExecArray | null;

  // Loop through all matches
  // 遍历所有匹配项
  while ((currentMatch = regex.exec(prompt)) !== null) {
    if (currentMatch.index > cursorOffset) {
      return currentMatch.index + 1;
    }
  }

  return prompt.length;
}

function TextInput({
  value: originalValue,
  placeholder = "",
  focus = true,
  mask,
  highlightPastedText = false,
  showCursor = true,
  onChange,
  onSubmit,
}: TextInputProps) {
  const [state, setState] = useState({
    cursorOffset: (originalValue || "").length,
    cursorWidth: 0,
  });

  const { cursorOffset, cursorWidth } = state;

  useEffect(() => {
    setState((previousState) => {
      if (!focus || !showCursor) {
        return previousState;
      }

      const newValue = originalValue || "";
      // Sets the cursor to the end of the line if the value is empty or the cursor is at the end of the line.
      // 如果值为空或光标在行尾，则将光标设置到行尾。
      if (
        previousState.cursorOffset === 0 ||
        previousState.cursorOffset > newValue.length - 1
      ) {
        return {
          cursorOffset: newValue.length,
          cursorWidth: 0,
        };
      }

      return previousState;
    });
  }, [originalValue, focus, showCursor]);

  const cursorActualWidth = highlightPastedText ? cursorWidth : 0;

  const value = mask ? mask.repeat(originalValue.length) : originalValue;
  let renderedValue = value;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

  // Fake mouse cursor, because it's too inconvenient to deal with actual cursor and ansi escapes.
  // 伪鼠标光标，因为处理实际光标和ansi转义字符太不方便了。
  if (showCursor && focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(" ");

    renderedValue = value.length > 0 ? "" : chalk.inverse(" ");

    let i = 0;

    for (const char of value) {
      renderedValue +=
        i >= cursorOffset - cursorActualWidth && i <= cursorOffset
          ? chalk.inverse(char)
          : char;

      i++;
    }

    if (value.length > 0 && cursorOffset === value.length) {
      renderedValue += chalk.inverse(" ");
    }
  }

  useInput(
    (input, key) => {
      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && input === "c") ||
        key.tab ||
        (key.shift && key.tab)
      ) {
        return;
      }

      let nextCursorOffset = cursorOffset;
      let nextValue = originalValue;
      let nextCursorWidth = 0;

      // TODO: continue improving the cursor management to feel native
      // TODO: 继续改进光标管理以获得原生感觉
      if (key.return) {
        if (key.meta) {
          // This does not work yet. We would like to have this behavior:
          //     Mac terminal: Settings → Profiles → Keyboard → Use Option as Meta key
          //     iTerm2: Open Settings → Profiles → Keys → General → Set Left/Right Option as Esc+
          // And then when Option+ENTER is pressed, we want to insert a newline.
          // However, even with the settings, the input="\n" and only key.shift is True.
          // This is likely an artifact of how ink works.
          // 这还不能工作。我们希望有这样的行为：
          //     Mac终端：设置 → 配置 → 键盘 → 将Option用作元键
          //     iTerm2：打开设置 → 配置 → 键 → 一般 → 将左/右Option设置为Esc+
          // 然后当按下Option+ENTER时，我们希望插入一个新行。
          // 然而，即使有这些设置，input="\n"且只key.shift为True。
          // 这可能是ink工作方式的产物。
          nextValue =
            originalValue.slice(0, cursorOffset) +
            "\n" +
            originalValue.slice(cursorOffset, originalValue.length);
          nextCursorOffset++;
        } else {
          // Handle Enter key: support bash-style line continuation with backslash
          // -- count consecutive backslashes immediately before cursor
          // -- only a single trailing backslash at end indicates line continuation
          // 处理Enter键：支持bash风格的反斜线行续行
          // -- 计算光标前的连续反斜线
          // -- 只有单个尾随反斜线表示行续行
          const isAtEnd = cursorOffset === originalValue.length;
          const trailingMatch = originalValue.match(/\\+$/);
          const trailingCount = trailingMatch ? trailingMatch[0].length : 0;
          if (isAtEnd && trailingCount === 1) {
            nextValue += "\n";
            nextCursorOffset = nextValue.length;
            nextCursorWidth = 0;
          } else if (onSubmit) {
            onSubmit(originalValue);
            return;
          }
        }
      } else if ((key.ctrl && input === "a") || (key.meta && key.leftArrow)) {
        nextCursorOffset = 0;
      } else if ((key.ctrl && input === "e") || (key.meta && key.rightArrow)) {
        // Move cursor to end of line
        // 将光标移动到行尾
        nextCursorOffset = originalValue.length;
        // Emacs/readline-style navigation and editing shortcuts
        // Emacs/readline风格的导航和编辑快捷键
      } else if (key.ctrl && input === "b") {
        // Move cursor backward by one
        // 将光标向后移动一个字符
        if (showCursor) {
          nextCursorOffset = Math.max(cursorOffset - 1, 0);
        }
      } else if (key.ctrl && input === "f") {
        // Move cursor forward by one
        // 将光标向前移动一个字符
        if (showCursor) {
          nextCursorOffset = Math.min(cursorOffset + 1, originalValue.length);
        }
      } else if (key.ctrl && input === "d") {
        // Delete character at cursor (forward delete)
        // 删除光标处的字符（向前删除）
        if (cursorOffset < originalValue.length) {
          nextValue =
            originalValue.slice(0, cursorOffset) +
            originalValue.slice(cursorOffset + 1);
        }
      } else if (key.ctrl && input === "k") {
        // Kill text from cursor to end of line
        // 删除从光标到行尾的文本
        nextValue = originalValue.slice(0, cursorOffset);
      } else if (key.ctrl && input === "u") {
        // Kill text from start to cursor
        // 删除从开始到光标的文本
        nextValue = originalValue.slice(cursorOffset);
        nextCursorOffset = 0;
      } else if (key.ctrl && input === "w") {
        // Delete the word before cursor
        // 删除光标前的单词
        {
          const left = originalValue.slice(0, cursorOffset);
          const match = left.match(/\s*\S+$/);
          const cut = match ? match[0].length : cursorOffset;
          nextValue =
            originalValue.slice(0, cursorOffset - cut) +
            originalValue.slice(cursorOffset);
          nextCursorOffset = cursorOffset - cut;
        }
      } else if (key.meta && (key.backspace || key.delete)) {
        const regex = /[\s,.;!?]+/g;
        let lastMatch = 0;
        let currentMatch: RegExpExecArray | null;

        const stringToCursorOffset = originalValue
          .slice(0, cursorOffset)
          .replace(/[\s,.;!?]+$/, "");

        // Loop through all matches
        // 遍历所有匹配项
        while ((currentMatch = regex.exec(stringToCursorOffset)) !== null) {
          lastMatch = currentMatch.index;
        }

        // Include the last match unless it is the first character
        // 包含最后一个匹配项，除非它是第一个字符
        if (lastMatch != 0) {
          lastMatch += 1;
        }

        nextValue =
          stringToCursorOffset.slice(0, lastMatch) +
          originalValue.slice(cursorOffset, originalValue.length);
        nextCursorOffset = lastMatch;
      } else if (key.meta && (input === "b" || key.leftArrow)) {
        nextCursorOffset = findPrevWordJump(originalValue, cursorOffset);
      } else if (key.meta && (input === "f" || key.rightArrow)) {
        nextCursorOffset = findNextWordJump(originalValue, cursorOffset);
      } else if (key.leftArrow) {
        if (showCursor) {
          nextCursorOffset--;
        }
      } else if (key.rightArrow) {
        if (showCursor) {
          nextCursorOffset++;
        }
      } else if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          nextValue =
            originalValue.slice(0, cursorOffset - 1) +
            originalValue.slice(cursorOffset, originalValue.length);

          nextCursorOffset--;
        }
      } else {
        nextValue =
          originalValue.slice(0, cursorOffset) +
          input +
          originalValue.slice(cursorOffset, originalValue.length);

        nextCursorOffset += input.length;

        if (input.length > 1) {
          nextCursorWidth = input.length;
        }
      }

      if (cursorOffset < 0) {
        nextCursorOffset = 0;
      }

      if (cursorOffset > originalValue.length) {
        nextCursorOffset = originalValue.length;
      }

      setState({
        cursorOffset: nextCursorOffset,
        cursorWidth: nextCursorWidth,
      });

      if (nextValue !== originalValue) {
        onChange(nextValue);
      }
    },
    { isActive: focus },
  );

  return (
    <Text>
      {placeholder
        ? value.length > 0
          ? renderedValue
          : renderedPlaceholder
        : renderedValue}
    </Text>
  );
}

export default TextInput;

type UncontrolledProps = {
  readonly initialValue?: string;
} & Except<TextInputProps, "value" | "onChange">;

export function UncontrolledTextInput({
  initialValue = "",
  ...props
}: UncontrolledProps) {
  const [value, setValue] = useState(initialValue);

  return <TextInput {...props} value={value} onChange={setValue} />;
}
