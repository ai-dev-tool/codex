# 生成dependencies.md
把package.json文件给分析下，列出引用的包和包的作用，给写到docs\learn\dependencies.md文件里面。 

# 生成codex-cli-structure的tree结果
## 要求
1、分析当前目录codex-cli，但是需要排除codex-cli\.husky、codex-cli\bin、codex-cli\examples， codex-cli\tests  这四个目录
2、遍历当前目录codex-cli其它文件和目录及其子目录的文件，再分析文件的作用，如果有文件夹及需要获取文件夹下面的文件和文件夹继续分析，把那个把文件名、作用说明。
3、需要每个文件都说明，使用tree方式给我，写到docs\learn\codex-cli-structure.md文件里面。 
4、排序规则，就是文件夹下面的每个文件或者文件夹的tree应该是按照字母a-z顺序的， 文件夹排在前面


上面可能不会遍历文件夹，则后面继续把指定文件夹发给他让继续遍历就可以。



# 生成 getting-started.md
@dependencies.md @codex-cli-structure.md  @README.md 我想要学习这个项目，之后想要继续开发这个项目，那我如何开始，怎么开始。请写出详细的步骤，目的是需要快速了解进入开发，也把过程就在docs\learn文件夹下面用md给我

1. **CLI 入口** (`bin/codex.js`)中的`bin/codex.js文件是没有的，是bin/codex，那这样目的呢？ 安装之后执行codex命令就是对应那吗。，

这个每个写文件的地方都要说明下使用的主要用什么技术栈实现的，还有 同时还写上是来源哪个依赖包吧，比如
**聊天组件** (`src/components/chat/`)
   - `terminal-chat.tsx`: 聊天主界面（基于 React + Ink 实现，使用 TypeScript 类型系统，依赖：`react`, `ink`, `@types/react`）

，写到docs\learn\getting-started.md文件里面。 


第二步

@getting-started.md  @codex-cli-structure.md @dependencies.md 完善getting-started.md中的## 5. 核心功能学习路径部分，里面关于依赖的库，有时候几个依赖库，不知道依赖库的作用，补上依赖库作用


# 提取核心文件路径
1、 提取路径：getting-started.md（当前目录中）中 5. 核心功能学习路径  点提到文件(是基于codex-cli目录下的)
2、获取完整路径，如个codex-cli目录下的，需要补上codex-cli，使用一行给我，多个路劲使用,分开。

# 注释翻译为中文
1、翻译文件就是  codex-cli/bin/codex,  codex-cli/src/app.tsx,  codex-cli/src/cli.tsx,  codex-cli/src/components/chat/terminal-chat.tsx,  codex-cli/src/components/chat/terminal-chat-input.tsx,  codex-cli/src/components/chat/terminal-chat-response-item.tsx,  codex-cli/src/components/chat/message-history.tsx,  codex-cli/src/components/vendor/ink-spinner.tsx,  codex-cli/src/components/vendor/ink-text-input.tsx,  codex-cli/src/components/vendor/ink-select,  codex-cli/src/utils/agent/agent-loop.ts,  codex-cli/src/utils/agent/exec.ts,  codex-cli/src/utils/agent/apply-patch.ts,  codex-cli/src/utils/agent/sandbox/interface.ts,  codex-cli/src/utils/agent/sandbox/macos-seatbelt.ts,  codex-cli/src/utils/agent/sandbox/raw-exec.ts,  codex-cli/src/utils/storage/command-history.ts，使用的，分开的多个文件。
2、翻译的范围：代码中的定义变量、常量、输出的等非中文也不要翻译，只翻译注释代码为中文，注释一般是用/*  */ ,// ,#。

3、翻译的方式，不要删除之前的注释，通过新增注释方式。
4、翻译文件还只要翻译为ts、tsx扩展名的，只翻译没有翻译过的，注意不要二次翻译。
5、请用中文回答。