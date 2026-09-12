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
  <strong>Una autoridad de arquitectura para el desarrollo de software humano y agéntico.</strong><br />
  Declara la arquitectura que pretendes. Archkeep la compara con la arquitectura que tu repositorio tiene realmente y produce veredictos deterministas respaldados por evidencia.
</p>

<p align="center">
  <a href="docs/README.md">Documentación</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=bug_report.yml">Informar de un error</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=feature_request.yml">Solicitar una función</a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Archkeep" width="100%" />
</p>

## Por qué Archkeep

La arquitectura rara vez falla de golpe. Se erosiona.

Un equipo se pone de acuerdo sobre capas, propiedad y límites de dependencias. Entonces el repositorio cambia: una importación cómoda cruza un límite, una excepción temporal se vuelve permanente, la documentación se desvía de la realidad y los agentes de codificación hacen que el mismo problema escale más rápido.

La compilación puede seguir pasando. Las pruebas pueden seguir pasando. Un linter puede seguir dando un resultado limpio.

La pregunta que falta es:

> **¿El código sigue ajustándose a la arquitectura que elegimos?**

Archkeep convierte esa pregunta en un contrato comprobable por máquina.

## La idea central

```text
ARCHITECTURE INTENT
        ↓
OBSERVED REALITY
        ↓
DETERMINISTIC EVIDENCE
        ↓
AUTHORITATIVE VERDICT
```

Declaras los límites y las reglas de dependencia que importan. Archkeep observa el repositorio de forma estática, construye el grafo y la evidencia relevantes, compara la realidad con la intención y devuelve un veredicto determinista.

La misma autoridad puede ser utilizada por humanos, CI y agentes de codificación.

## En qué se diferencia

| Herramienta                  | Responde                                                 |
| ---------------------------- | -------------------------------------------------------- |
| Compilador                   | ¿Compila?                                                |
| Pruebas                      | ¿Se comporta como se espera?                             |
| Linter                       | ¿El código sigue las reglas de lenguaje/estilo?          |
| Herramientas de dependencias | ¿Cómo está conectado el código?                          |
| Revisión de código con IA    | ¿Cree un modelo que este cambio parece razonable?        |
| **Archkeep**                 | **¿El código se ajusta a la arquitectura que elegimos?** |

Archkeep no reemplaza estas herramientas. Es dueño del límite arquitectónico entre ellas.

## Cómo encaja en el desarrollo agéntico

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

Los agentes pueden inspeccionar, explicar y proponer. No redefinen la arquitectura cuando sus cambios no coinciden con ella.

## Capacidades principales

- **Aplicación de la arquitectura** — reglas de dependencias y de límites en repositorios políglotas.
- **Evidencia determinista** — 24 comandos con JSON versionado y estable a nivel de bytes; veredictos reproducibles con cobertura y procedencia.
- **Gobernanza** — exenciones, ADR, funciones de fitness y decisiones explícitas.
- **Evolución de la arquitectura** — deriva, impacto de los cambios, historial, salud y deuda.
- **Integración con agentes** — CLI, MCP, VS Code y habilidades de agente conscientes de la arquitectura.

## Políglota por diseño

Archkeep evalúa la arquitectura en repositorios de Go, Rust, Python, TypeScript/JavaScript, Vue, Java/Kotlin y C#, a la vez que se integra con sistemas de workspace como Nx y Moon o descubre proyectos de forma nativa.

El objetivo es una única política de arquitectura a través de los límites de los lenguajes, no un mecanismo de aplicación por lenguaje.

## Inicio rápido

```bash
pnpm add -D @ecoma-io/archkeep
```

Registra Archkeep con Nx, usa la detección de workspace nativa `archkeep.json` o configura la integración adecuada para tu repositorio.

Después ejecuta:

```bash
pnpm exec archkeep check
```

Para un repositorio existente, empieza con la detección:

```bash
pnpm exec archkeep discover
```

**Se requiere Node.js ≥ 22. No se necesita ninguna cadena de herramientas de lenguaje para el análisis estático.**

→ [Primeros pasos](docs/getting-started/installation.md)

## Un pequeño ejemplo

Declara una regla como esta:

```js
export const depConstraints = [
  {
    sourceTag: "layer:domain",
    onlyDependOnLibsWithTags: ["layer:domain"],
    description: "The domain outlives frameworks, queues and databases.",
  },
];
```

Si un proyecto de dominio importa infraestructura:

```text
libs/pricing/src/discount.go:14:2  onlyTagsConstraintViolation
  A project tagged with "layer:domain" can only depend on libs tagged with layer:domain
  import      "github.com/acme/mq-client/publish" (static)  pricing → mq-client
  constraint  sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain]
  rule        The domain outlives frameworks, queues and databases.
```

La parte importante no es solo que la comprobación falle. El veredicto lleva la evidencia y señala la regla de arquitectura que lo causó.

## Usado en el ecosistema Ecoma

Archkeep se usa internamente en:

- [Loom](https://github.com/ecoma-io/loom)
- [Action-Agents](https://github.com/ecoma-io/action-agents)
- [Release-Craft](https://github.com/ecoma-io/release-craft)

## Documentación

- [Primeros pasos](docs/getting-started/installation.md)
- [Modelo de arquitectura](docs/doctrine/architecture-authority.md)
- [Ciclo de vida de la gobernanza](docs/concepts/governance-lifecycle.md)
- [Referencia de CLI](docs/reference/cli.md)
- [Integraciones](docs/concepts/integrations.md)
- [Habilidades de agente](docs/skills/overview.md)
- [Documentación completa](docs/README.md)

## Contribuciones

La contribución más valiosa es una [violación no detectada](.github/ISSUE_TEMPLATE/missed_violation.yml): un límite arquitectónico real que Archkeep no consiguió detectar.

Consulta [CONTRIBUTING.md](CONTRIBUTING.md), el [Código de Conducta](CODE_OF_CONDUCT.md) y [SECURITY.md](SECURITY.md).

## Licencia

[Licencia Apache 2.0](LICENSE)
