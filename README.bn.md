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
  <strong>মানুষ এবং এজেন্টিক সফটওয়্যার ডেভেলপমেন্টের জন্য একটি আর্কিটেকচার কর্তৃপক্ষ।</strong><br />
  আপনি যে আর্কিটেকচার চান তা ঘোষণা করুন। Archkeep আপনার রিপোজিটরিতে প্রকৃতপক্ষে বিদ্যমান আর্কিটেকচারের সাথে এর তুলনা করে এবং নির্ধারক, প্রমাণ-ভিত্তিক রায় প্রদান করে।
</p>

<p align="center">
  <a href="docs/README.md">ডক্স</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=bug_report.yml">বাগ রিপোর্ট করুন</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=feature_request.yml">ফিচার রিকোয়েস্ট</a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Archkeep" width="100%" />
</p>

## কেন Archkeep

আর্কিটেকচার খুব কমই একবারে ভেঙে পড়ে। এটি ধীরে ধীরে ক্ষয়প্রাপ্ত হয়।

একটি দল স্তর, মালিকানা এবং ডিপেন্ডেন্সি সীমানা নিয়ে একমত হয়। এরপর রিপোজিটরি পরিবর্তিত হয়: একটি সুবিধাজনক ইমপোর্ট সীমানা অতিক্রম করে, একটি অস্থায়ী ব্যতিক্রম স্থায়ী হয়ে যায়, ডকুমেন্টেশন বাস্তবতা থেকে বিচ্যুত হয় এবং কোডিং এজেন্টরা একই সমস্যাকে আরও দ্রুত বাড়িয়ে তোলে।

বিল্ড তখনও সফল হতে পারে। টেস্ট তখনও পাস করতে পারে। লিন্টার তখনও পরিচ্ছন্ন ফলাফল দিতে পারে।

যে প্রশ্নটি অনুপস্থিত তা হলো:

> **কোডটি কি এখনও আমাদের নির্বাচিত আর্কিটেকচারের সাথে সঙ্গতিপূর্ণ?**

Archkeep সেই প্রশ্নটিকে একটি মেশিন-পরীক্ষণযোগ্য চুক্তিতে রূপান্তরিত করে।

## মূল ধারণা

```text
ARCHITECTURE INTENT
        ↓
OBSERVED REALITY
        ↓
DETERMINISTIC EVIDENCE
        ↓
AUTHORITATIVE VERDICT
```

আপনি যে সীমানা এবং ডিপেন্ডেন্সি নিয়মগুলি গুরুত্বপূর্ণ তা ঘোষণা করেন। Archkeep স্ট্যাটিকভাবে রিপোজিটরি পর্যবেক্ষণ করে, প্রাসঙ্গিক গ্রাফ এবং প্রমাণ তৈরি করে, বাস্তবতার সাথে অভিপ্রায়ের তুলনা করে এবং একটি নির্ধারক রায় ফেরত দেয়।

একই কর্তৃপক্ষ মানুষ, CI এবং কোডিং এজেন্টরা ব্যবহার করতে পারে।

## কেন এটি আলাদা

| টুল                | উত্তর                                                         |
| ------------------ | ------------------------------------------------------------- |
| কম্পাইলার          | এটি কি বিল্ড হয়?                                             |
| টেস্ট              | এটি কি প্রত্যাশামতো আচরণ করে?                                 |
| লিন্টার            | কোডটি কি ভাষা/স্টাইল নিয়ম মেনে চলে?                          |
| ডিপেন্ডেন্সি টুলিং | কোডটি কীভাবে সংযুক্ত?                                         |
| AI কোড রিভিউ       | একটি মডেল কি মনে করে এই পরিবর্তনটি যুক্তিসঙ্গত দেখাচ্ছে?      |
| **Archkeep**       | **কোডটি কি আমাদের নির্বাচিত আর্কিটেকচারের সাথে সঙ্গতিপূর্ণ?** |

Archkeep এই টুলগুলিকে প্রতিস্থাপন করে না। এটি এগুলির মধ্যকার আর্কিটেকচারাল সীমানার মালিক।

## এজেন্টিক ডেভেলপমেন্টে এর ভূমিকা

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

এজেন্টরা পরীক্ষা করতে, ব্যাখ্যা করতে এবং প্রস্তাব দিতে পারে। তাদের পরিবর্তন আর্কিটেকচারের সাথে সামঞ্জস্যপূর্ণ না হলে তারা আর্কিটেকচারটি পুনর্নির্ধারণ করে না।

## মূল সক্ষমতা

- **আর্কিটেকচার প্রয়োগ** — পলিগ্লট রিপোজিটরি জুড়ে ডিপেন্ডেন্সি এবং সীমানা নিয়ম।
- **নির্ধারক প্রমাণ** — সংস্করণ-সহ, বাইট-স্থিতিশীল JSON সহ 24টি কমান্ড; কভারেজ এবং প্রোভেন্যান্সসহ পুনরুৎপাদনযোগ্য রায়।
- **গভর্নেন্স** — ওয়েভার, ADR, ফিটনেস ফাংশন এবং সুস্পষ্ট সিদ্ধান্ত।
- **আর্কিটেকচার বিবর্তন** — বিচ্যুতি, পরিবর্তনের প্রভাব, ইতিহাস, স্বাস্থ্য এবং ঋণ।
- **এজেন্ট ইন্টিগ্রেশন** — CLI, MCP, VS Code এবং আর্কিটেকচার-সচেতন এজেন্ট স্কিল।

## নকশা অনুযায়ী পলিগ্লট

Archkeep Go, Rust, Python, TypeScript/JavaScript, Vue, Java/Kotlin এবং C# রিপোজিটরি জুড়ে আর্কিটেকচার মূল্যায়ন করে, পাশাপাশি Nx এবং Moon-এর মতো ওয়ার্কস্পেস সিস্টেমের সাথে একীভূত হয় বা নেটিভভাবে প্রজেক্ট আবিষ্কার করে।

লক্ষ্য হলো ভাষার সীমানা জুড়ে একটি একক আর্কিটেকচার নীতি, প্রতি ভাষার জন্য আলাদা প্রয়োগ প্রক্রিয়া নয়।

## দ্রুত শুরু

```bash
pnpm add -D @ecoma-io/archkeep
```

Nx-এর সাথে Archkeep নিবন্ধন করুন, নেটিভ `archkeep.json` ওয়ার্কস্পেস ডিসকভারি ব্যবহার করুন, অথবা আপনার রিপোজিটরির জন্য উপযুক্ত ইন্টিগ্রেশন কনফিগার করুন।

তারপর চালান:

```bash
pnpm exec archkeep check
```

বিদ্যমান রিপোজিটরির জন্য, ডিসকভারি দিয়ে শুরু করুন:

```bash
pnpm exec archkeep discover
```

**Node.js ≥ 22 প্রয়োজন। স্ট্যাটিক বিশ্লেষণের জন্য কোনো ভাষা টুলচেইনের প্রয়োজন নেই।**

→ [শুরু করা](docs/getting-started/installation.md)

## একটি ছোট উদাহরণ

এমন একটি নিয়ম ঘোষণা করুন:

```js
export const depConstraints = [
  {
    sourceTag: "layer:domain",
    onlyDependOnLibsWithTags: ["layer:domain"],
    description: "The domain outlives frameworks, queues and databases.",
  },
];
```

যদি একটি ডোমেইন প্রজেক্ট ইনফ্রাস্ট্রাকচার ইমপোর্ট করে:

```text
libs/pricing/src/discount.go:14:2  onlyTagsConstraintViolation
  A project tagged with "layer:domain" can only depend on libs tagged with layer:domain
  import      "github.com/acme/mq-client/publish" (static)  pricing → mq-client
  constraint  sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain]
  rule        The domain outlives frameworks, queues and databases.
```

গুরুত্বপূর্ণ বিষয়টি কেবল এই নয় যে চেকটি ব্যর্থ হয়। রায়টি প্রমাণ বহন করে এবং যে আর্কিটেকচারাল নিয়মটি এর কারণ তা নির্দেশ করে।

## Ecoma ইকোসিস্টেমে ব্যবহৃত

Archkeep নিজেই নিম্নলিখিত প্রজেক্টগুলিতে ব্যবহৃত হয়:

- [Loom](https://github.com/ecoma-io/loom)
- [Action-Agents](https://github.com/ecoma-io/action-agents)
- [Release-Craft](https://github.com/ecoma-io/release-craft)

## ডকুমেন্টেশন

- [শুরু করা](docs/getting-started/installation.md)
- [আর্কিটেকচার মডেল](docs/doctrine/architecture-authority.md)
- [গভর্নেন্স লাইফসাইকেল](docs/concepts/governance-lifecycle.md)
- [CLI রেফারেন্স](docs/reference/cli.md)
- [ইন্টিগ্রেশন](docs/concepts/integrations.md)
- [এজেন্ট স্কিল](docs/skills/overview.md)
- [সম্পূর্ণ ডকুমেন্টেশন](docs/README.md)

## অবদান

সবচেয়ে মূল্যবান অবদান হলো একটি [মিসড ভায়োলেশন](.github/ISSUE_TEMPLATE/missed_violation.yml): Archkeep সনাক্ত করতে ব্যর্থ হয়েছে এমন একটি বাস্তব আর্কিটেকচারাল সীমানা।

দেখুন [CONTRIBUTING.md](CONTRIBUTING.md), [আচরণবিধি](CODE_OF_CONDUCT.md) এবং [SECURITY.md](SECURITY.md)।

## লাইসেন্স

[Apache License 2.0](LICENSE)
