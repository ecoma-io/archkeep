<!-- harmonise:skip-start -->
<p align="center">
  <a href="https://github.com/ecoma-io/archkeep/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/archkeep/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/archkeep/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/archkeep/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://www.npmjs.com/package/@ecoma-io/archkeep"><img src="https://img.shields.io/npm/dm/@ecoma-io/archkeep.svg" alt="npm downloads per month" /></a>
</p>
<!-- harmonise:skip-end -->

<p align="center">
  <img src=".github/assets/logo.png" alt="Archkeep" width="64px" />
</p>

<h1 align="center">Archkeep</h1>

<!-- harmonise:skip-start -->
<p align="center">
<a href="README.md">English</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh.md">中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.es.md">Español</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a> | <a href="README.pt.md">Português</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.ru.md">Русский</a> | <a href="README.fr.md">Français</a>
</p>
<!-- harmonise:skip-end -->

<p align="center">
  <strong>面向人类与智能体软件开发的架构权威。</strong><br />
  声明你打算采用的架构。Archkeep 会将它与仓库实际呈现的架构进行比较，并产出确定性的、有证据支撑的裁决。
</p>

<p align="center">
  <a href="docs/README.md">文档</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=bug_report.yml">报告问题</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=feature_request.yml">功能建议</a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Archkeep" width="100%" />
</p>

## 为什么选择 Archkeep

架构很少会一次性崩溃，它是逐渐被侵蚀的。

一个团队就分层、所有权和依赖边界达成一致。然后仓库不断变化：一次图省事的导入越过了边界，一个临时的例外成了永久状态，文档与现实渐行渐远，编码智能体则让同样的问题以更快的速度蔓延。

构建依然可以通过。测试依然可以通过。Linter 依然可以报告一切正常。

缺失的那个问题是：

> **代码是否仍然符合我们所选择的架构？**

Archkeep 将这个问题变成一个可以由机器检查的契约。

## 核心思想

```text
ARCHITECTURE INTENT
        ↓
OBSERVED REALITY
        ↓
DETERMINISTIC EVIDENCE
        ↓
AUTHORITATIVE VERDICT
```

你声明重要的边界与依赖规则。Archkeep 静态地观察仓库，构建相关的图与证据，将现实与意图进行比较，并给出确定性的裁决。

同样的权威，人类、CI 和编码智能体都可以使用。

## 为什么与众不同

| 工具         | 回答的问题                         |
| ------------ | ---------------------------------- |
| 编译器       | 它能构建吗？                       |
| 测试         | 它的行为符合预期吗？               |
| Linter       | 代码遵循语言/风格规则吗？          |
| 依赖工具     | 代码之间是如何连接的？             |
| AI 代码审查  | 模型认为这个改动看起来合理吗？     |
| **Archkeep** | **代码是否符合我们所选择的架构？** |

Archkeep 不会取代这些工具，它掌控着它们之间的架构边界。

## 它如何融入智能体开发

```text
Human declares architecture
            ↓
      Coding agent
   reads architecture context
            ↓
       changes code
            ↓
       Archkeep check
            ↓
     deterministic verdict
            ↓
             CI
```

智能体可以检查、解释并提出建议。当它们的改动与架构不符时，它们不会重新定义架构。

## 核心能力

- **架构强制** —— 跨多语言仓库的依赖与边界规则。
- **确定性证据** —— 24 条命令，输出带版本号、字节稳定的 JSON；裁决可复现，且带有覆盖范围与溯源。
- **治理** —— 豁免、ADR、适应度函数与明确的决策。
- **架构演进** —— 漂移、变更影响、历史、健康状况与架构债。
- **智能体集成** —— CLI、MCP、VS Code 以及具备架构意识的智能体技能。

## 天生多语言

Archkeep 可以评估 Go、Rust、Python、TypeScript/JavaScript、Vue、Java/Kotlin 与 C# 仓库中的架构，同时与 Nx、Moon 等工作区系统集成，也能原生地发现项目。

目标是让一种架构策略跨越语言边界，而不是每种语言各搞一套强制机制。

## 快速开始

```bash
pnpm add -D @ecoma-io/archkeep
```

将 Archkeep 注册到 Nx，使用原生的 `archkeep.json` 工作区发现能力，或为你的仓库配置合适的集成。

然后运行：

```bash
pnpm exec archkeep check
```

对于已有仓库，从发现开始：

```bash
pnpm exec archkeep discover
```

**需要 Node.js ≥ 22。静态分析无需任何语言工具链。**

→ [开始使用](docs/getting-started/installation.md)

## 一个小示例

声明一条这样的规则：

```js
export const depConstraints = [
  {
    sourceTag: "layer:domain",
    onlyDependOnLibsWithTags: ["layer:domain"],
    description: "The domain outlives frameworks, queues and databases.",
  },
];
```

如果某个领域项目导入了基础设施：

```text
libs/pricing/src/discount.go:14:2  onlyTagsConstraintViolation
  A project tagged with "layer:domain" can only depend on libs tagged with layer:domain
  import      "github.com/acme/mq-client/publish" (static)  pricing → mq-client
  constraint  sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain]
  rule        The domain outlives frameworks, queues and databases.
```

重要的不只是检查失败本身。裁决会携带证据，并指向导致失败的那条架构规则。

## 在 Ecoma 生态中的应用

以下项目正在自用 Archkeep：

- [Loom](https://github.com/ecoma-io/loom)
- [Action-Agents](https://github.com/ecoma-io/action-agents)
- [Release-Craft](https://github.com/ecoma-io/release-craft)

## 文档

- [开始使用](docs/getting-started/installation.md)
- [架构模型](docs/doctrine/architecture-authority.md)
- [治理生命周期](docs/concepts/governance-lifecycle.md)
- [CLI 参考](docs/reference/cli.md)
- [集成](docs/concepts/integrations.md)
- [智能体技能](docs/skills/overview.md)
- [完整文档](docs/README.md)

## 参与贡献

最有价值的贡献是报告一个[遗漏的违规](.github/ISSUE_TEMPLATE/missed_violation.yml)：一个 Archkeep 未能检测到的真实架构边界。

请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)、[行为准则](CODE_OF_CONDUCT.md) 与 [SECURITY.md](SECURITY.md)。

## 许可证

[Apache License 2.0](LICENSE)
