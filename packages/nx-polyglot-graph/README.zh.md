---
name: nx-polyglot-graph
lang: zh
description: Nx 插件，为 Go/Rust/Python 添加跨项目依赖边，并在 ESLint 读不了的语言中强制执行模块边界。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# nx-polyglot-graph

## 为什么存在

只有当一个依赖在 Nx project graph 中显现为一条边时，`nx affected` 才知道它，而 Nx
自身的图推断并不理解 Go 的 import、Cargo 的 path dependency，或
`[tool.uv.sources]` 中的条目。没有这个插件，修改一个 Go library 永远不会把同级的
Go 项目标记为 affected —— 对工作区中的每一个多语言项目，这都在无声中让
`nx affected` 失效。社区中处理这一问题的插件（gonx、`@nxlv/python`）的做法是连
target 也一并从 toolchain 推断出来。本插件刻意不这么做：target 仍然手写在各自的
`project.json` 里，因此"一个 target 做什么"只有一个真相来源。本插件只补上缺失的那
些边。

这个缺口还有另一半。`@nx/enforce-module-boundaries` 只读 JavaScript、TypeScript
和 Vue，所以在 Go 或 Rust 项目里，`layer:`、`scope:` 和 `license:` 这些 tag 只是没
有任何机制支撑的声明：一个 `.go` 文件被加上违反 layer 轴的 import，依然会在图里显
示这条边，也依然能通过 `lint`，因为对 `.go`，ESLint 的回答是 "File ignored because
no matching configuration was supplied"。`src/analysis/` 和 `src/rules/` 正是让它
变成一项真实检查的地方 —— 覆盖 `@nx/enforce-module-boundaries` 的全部十五种违规类
型、它的八个 option，运行在分析记录之上而不是 ESLint 的 AST 之上。

## 安装

```shell
pnpm add -D @ecoma-io/nx-polyglot-graph
```

在 `nx.json` 中注册它，并告诉它你的工作区如何命名这些文件：

```json
{
  "plugins": [
    {
      "plugin": "@ecoma-io/nx-polyglot-graph",
      "options": {
        "boundaryConfig": "module-boundaries.config.mjs",
        "tsConfig": "tsconfig.base.json"
      }
    }
  ]
}
```

两个 option 的默认值就是上面这两个 —— 也就是 Nx 的约定 —— 所以遵循约定的工作区只
需按名字注册插件即可。二者都是被**读取**而不是被假定，因为它们是工作区有权改名的
约定，而一个把它们写死的工具，会对一个自己读错了的工作区给出十足自信的回答。未知
的 key 会**抛错**而不是回落到默认值：把 `tsConfig` 误写成 `tsconfigBase` 却悄悄用
上默认值，意味着整整一次绿色的运行，跑的是一条没人写过的规则。

`nx` 是 peer dependency，从你的工作区解析，因此本工具读取的图，正是你自己的 `nx`
命令构建出来的那一张。

## 边界配置文件

工作区根目录下的一个文件 —— 由 `boundaryConfig` 指名的那个 —— 承载约束表和上游的
八个 option。它导出的 `depConstraints` 与 `@nx/enforce-module-boundaries` 接受的形
状完全一致，所以在 TypeScript 工作区里，同一个文件同时喂给两个执行器，只有一张表
而不是两张：

```js
export const depConstraints = [
  { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
  { sourceTag: "scope:billing", onlyDependOnLibsWithTags: ["scope:billing", "scope:shared"] },
];

export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

export const boundarySuppressions = [];
```

本 package 不会为任何一条约束或任何一个 option 设定默认值。这里的默认值只会是那个
文件已经声明过的值的第二份副本，而在其中一方改变的那一天，两份就会互相矛盾。

## 在终端中运行

`nx-polyglot-graph` 这个 bin 读取 Nx 图，分析一个项目所拥有的每一个被追踪的源文
件，并为每一处违规报出开发者可以据以行动的 `file:line:column`：

```shell
pnpm exec nx-polyglot-graph check
pnpm exec nx-polyglot-graph check --format sarif --output boundaries.sarif
pnpm exec nx-polyglot-graph check --config boundaries.custom.mjs
```

四个 exit code，其中真正要紧的区别是 **3** 与 **0**：

| code | 含义                                             |
| ---- | ------------------------------------------------ |
| 0    | 干净 —— 且每一个被选中的文件都已被分析           |
| 1    | 发现违规                                         |
| 2    | 用法错误                                         |
| 3    | 无结论 —— 运行无法开始，或某个被选中的文件读不了 |

一个"看不了"的检查器绝不能被误认为"看过了而没发现问题"的检查器。这就是 exit 3 存
在的理由，也是它既覆盖彻底失败、也覆盖**部分完成**的运行的理由：一个读不了的文
件、一个没有 analyzer 的文件、一个加载不了的 `tsconfig` —— 每一种都留下一个被汇总
计入、却没有任何规则审视过的文件。因此每一个结论都会说明它究竟看了什么：

```text
✔ no boundary violations (264 imports in 78 files across 1 project)
```

specifier 无法静态确定的 import 不属于这种情况 —— 那个文件已被审视，只是其中一个位
置没有答案。这些会在各自的标题下作为已声明的盲点打印出来，运行不会因它们而失败。

## 在编辑器中运行

`nx-polyglot-graph-lsp` 这个 bin 通过 stdio 讲 Language Server Protocol，为每一处
边界违规发布一条 diagnostic，携带的正是 `@nx/enforce-module-boundaries` 会为该
import 报出的那个 `messageId`。一个它分析不了的文件会得到一条明说此事的
diagnostic —— 所以来自这个 server 的空 diagnostic 列表永远意味着"没有违规"，绝不会
是"没有检查"。

之所以做成编辑器 server 而不是 ESLint 插件，是因为 ESLint 插件只在 ESLint 有
parser 的地方运行。在配置了 parser 的工作区里，那就是 JS、TS **和 Vue** —— 已经实
测：一个 import 了被禁 package 的 `.vue` 文件，从 ESLint 和从本工具会得到同一条
message，唯一的差别是各自下划线标在哪一列。Go、Rust 和 Python 则根本没有 parser，
而那正是 ESLint 插件永远够不到的那一半。

**Claude Code** 把它作为插件安装，来源就是本 repository 自己的 marketplace：

```shell
claude plugin marketplace add ecoma-io/lattice
claude plugin install nx-polyglot-graph@lattice
```

此后每一次编辑 Go、Rust、Python 或 Vue 文件，会话都会得到边界 diagnostic。server 的
声明是 `.claude-plugin/plugin.json` 中的 `lspServers`，它认领 analyzer 能处理的每一
个扩展名，唯独排除 JS/TS 一族：一个编辑器对每个文件扩展名只给一个 server，认领它们
就会挤掉开发者在那里真正需要的那个 language server。`.vue` 落在被认领的一侧，而
ESLint 也读它，这使 Vue 成为两个执行器同时覆盖的唯一扩展名。

**任何其他 LSP client** 启动的是同一个可执行文件：

```text
command                node <workspace>/node_modules/@ecoma-io/nx-polyglot-graph/lsp.mjs
transport              stdio
initializationOptions  { "workspaceRoot": "<workspace>" }
                       —— 仅当编辑器的 root 不是工作区 root 时才需要
watched files          边界配置文件、**/nx.json 和 **/project.json
```

工作区 root 依次取自 `initializationOptions`、`workspaceFolders`、`rootUri`、
`rootPath`，最后是工作目录。只声明支持全文同步。支持 dynamic registration 的
client 会被要求监视上面这三个文件 —— 其中包括 `nx.json`，因为指名边界配置文件的那
个 option 就住在那里，而一个只监视旧文件名的 server 会继续用一份它已经不再读取的
config 发布结论。无法动态注册的 client 会在 stderr 上被告知这一点。

## 它刻意不做的事

它从不创建 project node，也从不推断或附加 target —— 两者都仍然手写在各项目自己的
`project.json` 中。各个 resolver 从不 shell 出去调用 `go`、`cargo` 或 `uv`；它们只
读被追踪的 manifest 和源文件（对 gofmt 规范化的 Go import 用正则，对
`Cargo.toml`/`pyproject.toml` 用 `smol-toml`），因此在从未安装过这些 toolchain 的
机器上，图依然算得出来。它也从不把外部 package（crates.io、PyPI、Go module
proxy）记录为 `externalNodes` —— 对 `nx affected` 而言，只有项目与项目之间的边才有
意义。

没有任何 option 可以关掉某一种语言，而这一缺失正是设计本身。一种语言被关掉时的每
一份报告，会与该语言没有任何违规时的报告逐字节相同。在没有某语言的工作区里，每个
analyzer 本来就不花任何代价，因为解析是以一个并不存在的 manifest 为钥匙的。

而且这里没有任何地方假定任何工作区的项目名、区域或 tag 取值。一切都来自 Nx 算出的
图和工作区声明的配置 —— 这正是它能在从未见过的目录树上运行的原因。

## 状态

两半都在运行，而 CI 在本 repository 自己的源码上证明了这一点：同一条 `check` 命令
运行在 `lattice` 的 tag vocabulary 上，而那套词汇与本工具最初被写出来时所在的工作
区毫无共同之处。

`src/conformance/` 在 37 个为此专门构建的 fixture 工作区上，度量本引擎与 ESLint 在
哪里一致、在哪里不一致。两个执行器本就是要并肩运行的：ESLint 对 JavaScript、
TypeScript 和 Vue 保持权威；本工具覆盖 Go、Rust 和 Python —— 在那里 ESLint 什么也不
报。

机制、各语言的解析限制，以及每个项目一份 manifest 这一建模假设，都在
[`./CLAUDE.md`](./CLAUDE.md) 中。
