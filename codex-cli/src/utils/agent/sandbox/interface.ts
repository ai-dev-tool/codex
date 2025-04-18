export enum SandboxType {
  NONE = "none",
  MACOS_SEATBELT = "macos.seatbelt",
  LINUX_LANDLOCK = "linux.landlock",
}

export type ExecInput = {
  cmd: Array<string>;
  workdir: string | undefined;
  timeoutInMillis: number | undefined;
};

/**
 * Result of executing a command. Caller is responsible for checking `code` to
 * determine whether the command was successful.
 *
 * 执行命令的结果。调用者负责检查`code`以
 * 确定命令是否成功。
 */
export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/**
 * Value to use with the `metadata` field of a `ResponseItem` whose type is
 * `function_call_output`.
 *
 * 用于类型为`function_call_output`的`ResponseItem`的
 * `metadata`字段的值。
 */
export type ExecOutputMetadata = {
  exit_code: number;
  duration_seconds: number;
};
