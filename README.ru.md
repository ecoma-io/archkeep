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
  <strong>Архитектурный арбитр для разработки ПО людьми и ИИ-агентами.</strong><br />
  Объявите архитектуру, которую вы задумали. Archkeep сравнивает её с архитектурой, которая реально есть в вашем репозитории, и выдаёт детерминированные вердикты, подкреплённые доказательствами.
</p>

<p align="center">
  <a href="docs/README.md">Документация</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=bug_report.yml">Сообщить об ошибке</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=feature_request.yml">Предложить возможность</a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Archkeep" width="100%" />
</p>

## Зачем нужен Archkeep

Архитектура редко рушится вся сразу. Она размывается постепенно.

Команда договаривается о слоях, зонах ответственности и границах зависимостей. Затем репозиторий меняется: удобный импорт пересекает границу, временное исключение становится постоянным, документация расходится с реальностью, а агенты, пишущие код, ускоряют рост той же проблемы.

Сборка по-прежнему может проходить. Тесты по-прежнему могут проходить. Линтер по-прежнему может сообщать, что всё чисто.

Недостаёт вопроса:

> **Соответствует ли код по-прежнему выбранной нами архитектуре?**

Archkeep превращает этот вопрос в контракт, проверяемый машиной.

## Основная идея

```text
ARCHITECTURE INTENT
        ↓
OBSERVED REALITY
        ↓
DETERMINISTIC EVIDENCE
        ↓
AUTHORITATIVE VERDICT
```

Вы объявляете границы и правила зависимостей, которые важны. Archkeep статически наблюдает репозиторий, строит релевантный граф и доказательства, сравнивает реальность с замыслом и возвращает детерминированный вердикт.

Этим же арбитром могут пользоваться люди, CI и агенты, пишущие код.

## Чем он отличается

| Инструмент                  | Что определяет                                       |
| --------------------------- | ---------------------------------------------------- |
| Компилятор                  | Собирается ли код?                                   |
| Тесты                       | Ведёт ли себя код правильно?                         |
| Линтер                      | Следует ли код правилам языка и стиля?               |
| Инструментарий зависимостей | Как связан код?                                      |
| AI-ревью кода               | Считает ли модель это изменение разумным?            |
| **Archkeep**                | **Соответствует ли код выбранной нами архитектуре?** |

Archkeep не заменяет эти инструменты. Он владеет архитектурной границей между ними.

## Как это вписывается в агентную разработку

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

Агенты могут изучать, объяснять и предлагать. Они не переопределяют архитектуру, когда их изменения расходятся с ней.

## Ключевые возможности

- **Контроль архитектуры** — правила зависимостей и границ в полиглотных репозиториях.
- **Детерминированные доказательства** — 24 команды с версионируемым, побайтово стабильным JSON; воспроизводимые вердикты с покрытием и происхождением.
- **Управление архитектурой** — исключения, ADR, фитнес-функции и явные решения.
- **Эволюция архитектуры** — дрейф, влияние изменений, история, здоровье и долг.
- **Интеграция с агентами** — CLI, MCP, VS Code и навыки агентов с учётом архитектуры.

## Полиглот по замыслу

Archkeep оценивает архитектуру в репозиториях на Go, Rust, Python, TypeScript/JavaScript, Vue, Java/Kotlin и C#, интегрируясь с системами рабочих пространств, такими как Nx и Moon, или обнаруживая проекты нативно.

Цель — единая архитектурная политика поверх языковых границ, а не отдельный механизм контроля для каждого языка.

## Быстрый старт

```bash
pnpm add -D @ecoma-io/archkeep
```

Зарегистрируйте Archkeep в Nx, используйте нативное обнаружение рабочего пространства `archkeep.json` или настройте интеграцию, подходящую вашему репозиторию.

Затем выполните:

```bash
pnpm exec archkeep check
```

Для существующего репозитория начните с обнаружения:

```bash
pnpm exec archkeep discover
```

**Требуется Node.js ≥ 22. Для статического анализа не нужен языковой тулчейн.**

→ [Начало работы](docs/getting-started/installation.md)

## Небольшой пример

Объявите правило, например такое:

```js
export const depConstraints = [
  {
    sourceTag: "layer:domain",
    onlyDependOnLibsWithTags: ["layer:domain"],
    description: "The domain outlives frameworks, queues and databases.",
  },
];
```

Если доменный проект импортирует инфраструктуру:

```text
libs/pricing/src/discount.go:14:2  onlyTagsConstraintViolation
  A project tagged with "layer:domain" can only depend on libs tagged with layer:domain
  import      "github.com/acme/mq-client/publish" (static)  pricing → mq-client
  constraint  sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain]
  rule        The domain outlives frameworks, queues and databases.
```

Важно не только то, что проверка завершается неудачей. Вердикт несёт доказательства и указывает на архитектурное правило, которое её вызвало.

## Используется в экосистеме Ecoma

Archkeep применяется на собственных проектах:

- [Loom](https://github.com/ecoma-io/loom)
- [Action-Agents](https://github.com/ecoma-io/action-agents)
- [Release-Craft](https://github.com/ecoma-io/release-craft)

## Документация

- [Начало работы](docs/getting-started/installation.md)
- [Архитектурная модель](docs/doctrine/architecture-authority.md)
- [Жизненный цикл управления](docs/concepts/governance-lifecycle.md)
- [Справочник CLI](docs/reference/cli.md)
- [Интеграции](docs/concepts/integrations.md)
- [Навыки агентов](docs/skills/overview.md)
- [Полная документация](docs/README.md)

## Участие в разработке

Самый ценный вклад — [пропущенное нарушение](.github/ISSUE_TEMPLATE/missed_violation.yml): реальная архитектурная граница, которую Archkeep не смог обнаружить.

См. [CONTRIBUTING.md](CONTRIBUTING.md), [Кодекс поведения](CODE_OF_CONDUCT.md) и [SECURITY.md](SECURITY.md).

## Лицензия

[Apache License 2.0](LICENSE)
