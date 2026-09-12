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
  <strong>Uma autoridade de arquitetura para desenvolvimento de software humano e agêntico.</strong><br />
  Declare a arquitetura que você pretende. O Archkeep compara-a com a arquitetura que seu repositório realmente possui e produz vereditos determinísticos baseados em evidências.
</p>

<p align="center">
  <a href="docs/README.md">Docs</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=bug_report.yml">Reportar Bug</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=feature_request.yml">Solicitar Funcionalidade</a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Archkeep" width="100%" />
</p>

## Por que Archkeep

A arquitetura raramente falha de uma vez só. Ela se degrada.

Uma equipe concorda sobre camadas, propriedade e fronteiras de dependência. Então o repositório muda: uma importação conveniente cruza uma fronteira, uma exceção temporária se torna permanente, a documentação se desatualiza em relação à realidade, e agentes de codificação fazem esse problema escalar mais rapidamente.

A build pode ainda passar. Os testes podem ainda passar. Um linter ainda pode indicar que está tudo limpo.

A pergunta ausente é:

> **O código ainda está em conformidade com a arquitetura que escolhemos?**

O Archkeep transforma essa pergunta em um contrato verificável por máquina.

## A ideia central

```text
ARCHITECTURE INTENT
        ↓
OBSERVED REALITY
        ↓
DETERMINISTIC EVIDENCE
        ↓
AUTHORITATIVE VERDICT
```

Você declara as fronteiras e regras de dependência que importam. O Archkeep observa estaticamente o repositório, constrói o grafo relevante e as evidências, compara a realidade com a intenção e retorna um veredito determinístico.

A mesma autoridade pode ser usada por humanos, CI e agentes de codificação.

## Por que é diferente

| Ferramenta                 | Responde                                                            |
| -------------------------- | ------------------------------------------------------------------- |
| Compilador                 | Compila?                                                            |
| Testes                     | Comporta-se corretamente?                                           |
| Linter                     | O código segue as regras de linguagem/estilo?                       |
| Ferramentas de dependência | Como o código é conectado?                                          |
| Revisão de código IA       | Um modelo acha que essa mudança é razoável?                         |
| **Archkeep**               | **O código está em conformidade com a arquitetura que escolhemos?** |

O Archkeep não substitui essas ferramentas. Ele é dono da fronteira arquitetural entre elas.

## Como se encaixa no desenvolvimento agêntico

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

Agentes podem inspecionar, explicar e propor. Eles não redefinem a arquitetura quando suas mudanças discordam dela.

## Capacidades centrais

- **Aplicação de arquitetura** — regras de dependência e fronteira em repositórios poliglotas.
- **Evidência determinística** — 24 comandos com JSON versionado e estável byte a byte; vereditos reproduzíveis com cobertura e proveniência.
- **Governança** — dispensas, ADRs, funções de aptidão e decisões explícitas.
- **Evolução da arquitetura** — drift, impacto de mudanças, histórico, saúde e dívida.
- **Integração com agentes** — CLI, MCP, VS Code e skills de agentes com consciência arquitetural.

## Poliglota por design

O Archkeep avalia arquitetura em repositórios de Go, Rust, Python, TypeScript/JavaScript, Vue, Java/Kotlin e C#, enquanto se integra com sistemas de workspace como Nx e Moon ou descobre projetos nativamente.

O objetivo é uma política arquitetural única entre fronteiras de linguagem, não um mecanismo de aplicação por linguagem.

## Início rápido

```bash
pnpm add -D @ecoma-io/archkeep
```

Registre o Archkeep com Nx, use a descoberta nativa de workspace `archkeep.json` ou configure a integração apropriada para o seu repositório.

Em seguida, execute:

```bash
pnpm exec archkeep check
```

Para um repositório existente, comece com a descoberta:

```bash
pnpm exec archkeep discover
```

**Node.js ≥ 22 é obrigatório. Nenhuma cadeia de ferramentas de linguagem é necessária para análise estática.**

→ [Primeiros passos](docs/getting-started/installation.md)

## Um pequeno exemplo

Declare uma regra como:

```js
export const depConstraints = [
  {
    sourceTag: "layer:domain",
    onlyDependOnLibsWithTags: ["layer:domain"],
    description: "The domain outlives frameworks, queues and databases.",
  },
];
```

Se um projeto de domínio importa infraestrutura:

```text
libs/pricing/src/discount.go:14:2  onlyTagsConstraintViolation
  A project tagged with "layer:domain" can only depend on libs tagged with layer:domain
  import      "github.com/acme/mq-client/publish" (static)  pricing → mq-client
  constraint  sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain]
  rule        The domain outlives frameworks, queues and databases.
```

A parte importante não é apenas o fato de a verificação falhar. O veredito carrega as evidências e aponta de volta para a regra arquitetural que o causou.

## Usado no ecossistema Ecoma

O Archkeep é utilizado por:

- [Loom](https://github.com/ecoma-io/loom)
- [Action-Agents](https://github.com/ecoma-io/action-agents)
- [Release-Craft](https://github.com/ecoma-io/release-craft)

## Documentação

- [Primeiros passos](docs/getting-started/installation.md)
- [Modelo de arquitetura](docs/doctrine/architecture-authority.md)
- [Ciclo de vida da governança](docs/concepts/governance-lifecycle.md)
- [Referência da CLI](docs/reference/cli.md)
- [Integrações](docs/concepts/integrations.md)
- [Skills de agentes](docs/skills/overview.md)
- [Documentação completa](docs/README.md)

## Contribuindo

A contribuição mais valiosa é uma [violação não detectada](.github/ISSUE_TEMPLATE/missed_violation.yml): uma fronteira arquitetural real que o Archkeep não conseguiu detectar.

Veja [CONTRIBUTING.md](CONTRIBUTING.md), [Código de Conduta](CODE_OF_CONDUCT.md) e [SECURITY.md](SECURITY.md).

## Licença

[Licença Apache 2.0](LICENSE)
