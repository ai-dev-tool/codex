# Codex CLI 项目依赖库说明

本文档详细说明了 Codex CLI 项目中使用的各个依赖库及其主要作用。

## 主要依赖 (dependencies)

### 核心依赖
- **@inkjs/ui**: Ink.js 的 UI 组件库，用于构建命令行界面
- **ink**: 用于构建命令行界面的 React 渲染器
- **react**: React 核心库，用于构建用户界面
- **openai**: OpenAI API 客户端库，用于与 OpenAI 服务进行交互

### 工具和工具类
- **chalk**: 终端字符串样式库，用于美化命令行输出
- **diff**: 用于比较文本差异的库
- **dotenv**: 环境变量管理工具
- **fast-deep-equal**: 深度对象比较工具
- **figures**: 提供 Unicode 符号的库
- **file-type**: 文件类型检测库
- **js-yaml**: YAML 解析和序列化库
- **marked**: Markdown 解析器
- **marked-terminal**: 将 Markdown 渲染到终端的工具
- **meow**: CLI 应用辅助工具
- **open**: 用于打开文件、URL 等的工具
- **shell-quote**: 用于解析和引用 shell 命令
- **strip-ansi**: 移除 ANSI 转义序列的工具
- **to-rotated**: 文本旋转工具
- **use-interval**: React Hook 用于实现间隔定时器
- **zod**: TypeScript 优先的 schema 验证库

## 开发依赖 (devDependencies)

### 类型定义
- **@types/diff**: diff 库的类型定义
- **@types/js-yaml**: js-yaml 的类型定义
- **@types/marked-terminal**: marked-terminal 的类型定义
- **@types/react**: React 的类型定义
- **@types/shell-quote**: shell-quote 的类型定义

### 代码质量和格式化
- **@eslint/js**: ESLint 核心规则
- **@typescript-eslint/eslint-plugin**: TypeScript 的 ESLint 插件
- **@typescript-eslint/parser**: TypeScript 的 ESLint 解析器
- **eslint-plugin-import**: ESLint 导入规则插件
- **eslint-plugin-react**: React 的 ESLint 规则
- **eslint-plugin-react-hooks**: React Hooks 的 ESLint 规则
- **eslint-plugin-react-refresh**: React Fast Refresh 的 ESLint 规则
- **prettier**: 代码格式化工具

### 构建和测试
- **esbuild**: 极速 JavaScript 打包工具
- **ink-testing-library**: Ink 的测试工具库
- **ts-node**: TypeScript 执行环境
- **typescript**: TypeScript 编译器
- **vitest**: 现代化的测试框架

### Git 工具
- **husky**: Git hooks 工具
- **lint-staged**: 对暂存文件运行 linters 的工具

### 其他工具
- **punycode**: Unicode 域名转换工具
- **whatwg-url**: WHATWG URL 标准的实现

## 版本覆盖 (resolutions 和 overrides)

项目使用 resolutions 和 overrides 来强制使用特定版本的依赖：
- **braces**: ^3.0.3
- **micromatch**: ^4.0.8
- **semver**: ^7.7.1
- **punycode**: ^2.3.1

这些版本覆盖主要用于解决依赖冲突和确保使用安全的依赖版本。

## 项目特点

从依赖库的选择可以看出，Codex CLI 是一个：
1. 基于 React 的命令行工具
2. 使用 TypeScript 开发
3. 注重代码质量和测试
4. 与 OpenAI API 集成
5. 支持 Markdown 渲染
6. 提供丰富的命令行界面功能 