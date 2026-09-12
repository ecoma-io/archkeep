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
  <strong>人間とエージェント駆動開発のためのアーキテクチャの権威。</strong><br />
  実現したいアーキテクチャを宣言してください。Archkeep はそれをリポジトリが実際に持つアーキテクチャと比較し、決定的でエビデンスに裏付けられた判定を生成します。
</p>

<p align="center">
  <a href="docs/README.md">ドキュメント</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=bug_report.yml">バグを報告</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=feature_request.yml">機能リクエスト</a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Archkeep" width="100%" />
</p>

## Archkeep を選ぶ理由

アーキテクチャが一度に壊れることはほとんどありません。少しずつ侵食されていきます。

チームはレイヤー、所有権、依存関係の境界について合意します。しかし、リポジトリは変化していきます。便利だからという理由で import が境界を越え、一時的な例外が恒久的なものになり、ドキュメントは現実から乖離し、コーディングエージェントは同じ問題をより速いスケールで広げていきます。

ビルドは依然として通ります。テストも依然として通ります。リンターもクリーンと報告します。

欠けている問いはこれです：

> **コードは、私たちが選んだアーキテクチャに依然として適合しているか？**

Archkeep はその問いを機械で検証可能な契約に変えます。

## 核となるアイデア

```text
ARCHITECTURE INTENT
        ↓
OBSERVED REALITY
        ↓
DETERMINISTIC EVIDENCE
        ↓
AUTHORITATIVE VERDICT
```

重要な境界と依存関係のルールを宣言してください。Archkeep はリポジトリを静的に観察し、関連するグラフとエビデンスを構築して、現実と意図を比較し、決定的な判定を返します。

同じ権威は、人間、CI、コーディングエージェントが利用できます。

## 何が違うのか

| ツール            | 答え                                                         |
| ----------------- | ------------------------------------------------------------ |
| コンパイラ        | ビルドできるか？                                             |
| テスト            | 期待どおりに動作するか？                                     |
| リンター          | コードは言語/スタイルのルールに従っているか？                |
| 依存関係ツール    | コードはどのようにつながっているか？                         |
| AI コードレビュー | モデルはこの変更が妥当だと思うか？                           |
| **Archkeep**      | **コードは、私たちが選んだアーキテクチャに適合しているか？** |

Archkeep はこれらのツールを置き換えるものではありません。それらの間にあるアーキテクチャ上の境界を担います。

## エージェント駆動開発にどう適合するか

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

エージェントは調査し、説明し、提案することができます。エージェントの変更がアーキテクチャに合わない場合でも、アーキテクチャを再定義することはありません。

## 主要機能

- **アーキテクチャの強制** — ポリグロットなリポジトリにわたる依存関係と境界のルール。
- **決定的なエビデンス** — バージョン管理されバイト単位で安定した JSON を備えた 24 のコマンド。カバレッジと由来を伴う再現可能な判定。
- **ガバナンス** — ウェイバー、ADR、フィットネス関数、明示的な決定。
- **アーキテクチャの進化** — 乖離、変更の影響、履歴、健全性、負債。
- **エージェント統合** — CLI、MCP、VS Code、アーキテクチャを認識するエージェントスキル。

## 設計思想としてのポリグロット

Archkeep は、Go、Rust、Python、TypeScript/JavaScript、Vue、Java/Kotlin、C# のリポジトリにわたってアーキテクチャを評価し、Nx や Moon などのワークスペースシステムと統合するか、プロジェクトをネイティブに検出します。

目標は、言語ごとの強制メカニズムではなく、言語の境界を越えた単一のアーキテクチャポリシーです。

## クイックスタート

```bash
pnpm add -D @ecoma-io/archkeep
```

Archkeep を Nx に登録するか、ネイティブの `archkeep.json` ワークスペース検出を使用するか、リポジトリに適した統合を設定してください。

次に、以下を実行します：

```bash
pnpm exec archkeep check
```

既存のリポジトリの場合は、ディスカバリから始めてください：

```bash
pnpm exec archkeep discover
```

**Node.js ≥ 22 が必要です。静的解析に言語ツールチェーンは不要です。**

→ [はじめに](docs/getting-started/installation.md)

## 小さな例

次のようなルールを宣言します：

```js
export const depConstraints = [
  {
    sourceTag: "layer:domain",
    onlyDependOnLibsWithTags: ["layer:domain"],
    description: "The domain outlives frameworks, queues and databases.",
  },
];
```

ドメインプロジェクトがインフラストラクチャを import した場合：

```text
libs/pricing/src/discount.go:14:2  onlyTagsConstraintViolation
  A project tagged with "layer:domain" can only depend on libs tagged with layer:domain
  import      "github.com/acme/mq-client/publish" (static)  pricing → mq-client
  constraint  sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain]
  rule        The domain outlives frameworks, queues and databases.
```

重要なのは、チェックが失敗することだけではありません。判定はエビデンスを伴い、それを引き起こしたアーキテクチャのルールに言及します。

## Ecoma エコシステムでの利用

Archkeep は以下のプロジェクトでドッグフーディングされています：

- [Loom](https://github.com/ecoma-io/loom)
- [Action-Agents](https://github.com/ecoma-io/action-agents)
- [Release-Craft](https://github.com/ecoma-io/release-craft)

## ドキュメント

- [はじめに](docs/getting-started/installation.md)
- [アーキテクチャモデル](docs/doctrine/architecture-authority.md)
- [ガバナンスライフサイクル](docs/concepts/governance-lifecycle.md)
- [CLI リファレンス](docs/reference/cli.md)
- [統合](docs/concepts/integrations.md)
- [エージェントスキル](docs/skills/overview.md)
- [全ドキュメント](docs/README.md)

## コントリビューション

最も価値のあるコントリビューションは、[見逃された違反](.github/ISSUE_TEMPLATE/missed_violation.yml)、つまり Archkeep が検出できなかった実際のアーキテクチャの境界です。

[CONTRIBUTING.md](CONTRIBUTING.md)、[行動規範](CODE_OF_CONDUCT.md)、[SECURITY.md](SECURITY.md) を参照してください。

## ライセンス

[Apache License 2.0](LICENSE)
