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
  <strong>Une autorité d'architecture pour le développement logiciel humain et agentique.</strong><br />
  Déclarez l'architecture que vous avez en tête. Archkeep la compare avec l'architecture réellement présente dans votre dépôt et produit des verdicts déterministes, fondés sur des preuves.
</p>

<p align="center">
  <a href="docs/README.md">Documentation</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=bug_report.yml">Signaler un bug</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=feature_request.yml">Demander une fonctionnalité</a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Archkeep" width="100%" />
</p>

## Pourquoi Archkeep

Une architecture échoue rarement d'un seul coup. Elle s'érode.

Une équipe se met d'accord sur les couches, les responsabilités et les frontières de dépendances. Puis le dépôt change : un import commode franchit une frontière, une exception temporaire devient permanente, la documentation s'écarte de la réalité et les agents de codage accélèrent l'amplification du même problème.

La compilation peut toujours passer. Les tests peuvent toujours passer. Un linter peut toujours rendre un rapport propre.

La question qui manque est :

> **Le code est-il encore conforme à l'architecture que nous avons choisie ?**

Archkeep transforme cette question en un contrat vérifiable par machine.

## Le principe fondamental

```text
ARCHITECTURE INTENT
        ↓
OBSERVED REALITY
        ↓
DETERMINISTIC EVIDENCE
        ↓
AUTHORITATIVE VERDICT
```

Vous déclarez les frontières et les règles de dépendances qui comptent. Archkeep observe statiquement le dépôt, construit le graphe et les preuves pertinents, compare la réalité à l'intention et renvoie un verdict déterministe.

Cette même autorité peut être utilisée par les humains, la CI et les agents de codage.

## En quoi c'est différent

| Outil                    | Réponse                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| Compilateur              | Est-ce que ça compile ?                                               |
| Tests                    | Est-ce que ça se comporte correctement ?                              |
| Linter                   | Le code respecte-t-il les règles de langage et de style ?             |
| Outillage de dépendances | Comment le code est-il connecté ?                                     |
| Revue de code par IA     | Un modèle pense-t-il que ce changement semble raisonnable ?           |
| **Archkeep**             | **Le code est-il conforme à l'architecture que nous avons choisie ?** |

Archkeep ne remplace pas ces outils. Il est l'autorité sur la frontière architecturale qui les sépare.

## Comment cela s'intègre au développement agentique

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

Les agents peuvent inspecter, expliquer et proposer. Ils ne redéfinissent pas l'architecture lorsque leurs changements s'en écartent.

## Fonctionnalités clés

- **Application de l'architecture** — règles de dépendances et de frontières dans des dépôts polyglottes.
- **Preuves déterministes** — 24 commandes avec un JSON versionné, stable au niveau des octets ; verdicts reproductibles avec couverture et provenance.
- **Gouvernance** — dérogations, ADR, fonctions de fitness et décisions explicites.
- **Évolution de l'architecture** — dérive, impact des changements, historique, santé et dette.
- **Intégration des agents** — CLI, MCP, VS Code et compétences d'agents conscientes de l'architecture.

## Polyglotte par conception

Archkeep évalue l'architecture dans des dépôts Go, Rust, Python, TypeScript/JavaScript, Vue, Java/Kotlin et C#, tout en s'intégrant aux systèmes d'espaces de travail tels que Nx et Moon ou en découvrant les projets nativement.

L'objectif est une seule politique d'architecture à travers les frontières de langages, et non un mécanisme d'application par langage.

## Démarrage rapide

```bash
pnpm add -D @ecoma-io/archkeep
```

Enregistrez Archkeep avec Nx, utilisez la découverte native d'espace de travail `archkeep.json`, ou configurez l'intégration adaptée à votre dépôt.

Puis exécutez :

```bash
pnpm exec archkeep check
```

Pour un dépôt existant, commencez par la découverte :

```bash
pnpm exec archkeep discover
```

**Node.js ≥ 22 est requis. Aucune chaîne d'outils de langage n'est nécessaire pour l'analyse statique.**

→ [Commencer](docs/getting-started/installation.md)

## Un petit exemple

Déclarez une règle telle que :

```js
export const depConstraints = [
  {
    sourceTag: "layer:domain",
    onlyDependOnLibsWithTags: ["layer:domain"],
    description: "The domain outlives frameworks, queues and databases.",
  },
];
```

Si un projet du domaine importe de l'infrastructure :

```text
libs/pricing/src/discount.go:14:2  onlyTagsConstraintViolation
  A project tagged with "layer:domain" can only depend on libs tagged with layer:domain
  import      "github.com/acme/mq-client/publish" (static)  pricing → mq-client
  constraint  sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain]
  rule        The domain outlives frameworks, queues and databases.
```

L'important n'est pas seulement que la vérification échoue. Le verdict porte les preuves et renvoie à la règle d'architecture qui en est la cause.

## Utilisé dans l'écosystème Ecoma

Archkeep est utilisé en interne par :

- [Loom](https://github.com/ecoma-io/loom)
- [Action-Agents](https://github.com/ecoma-io/action-agents)
- [Release-Craft](https://github.com/ecoma-io/release-craft)

## Documentation

- [Commencer](docs/getting-started/installation.md)
- [Modèle d'architecture](docs/doctrine/architecture-authority.md)
- [Cycle de vie de la gouvernance](docs/concepts/governance-lifecycle.md)
- [Référence CLI](docs/reference/cli.md)
- [Intégrations](docs/concepts/integrations.md)
- [Compétences des agents](docs/skills/overview.md)
- [Documentation complète](docs/README.md)

## Contribuer

La contribution la plus précieuse est une [violation manquée](.github/ISSUE_TEMPLATE/missed_violation.yml) : une véritable frontière architecturale qu'Archkeep n'a pas réussi à détecter.

Consultez [CONTRIBUTING.md](CONTRIBUTING.md), le [Code de conduite](CODE_OF_CONDUCT.md) et [SECURITY.md](SECURITY.md).

## Licence

[Apache License 2.0](LICENSE)
