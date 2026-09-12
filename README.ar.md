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
  <strong>سلطة معمارية لتطوير البرمجيات البشرية والوكيلية.</strong><br />
  صرِّح بالمعمارية التي تقصدها؛ يقارنها Archkeep بالمعمارية التي لدى مستودعك فعلًا، وينتج أحكامًا حتمية مدعومة بالأدلة.
</p>

<p align="center">
  <a href="docs/README.md">التوثيق</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=bug_report.yml">الإبلاغ عن خطأ</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=feature_request.yml">طلب ميزة</a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Archkeep" width="100%" />
</p>

## لماذا Archkeep

نادرًا ما تنهار المعمارية دفعة واحدة؛ إنها تتآكل.

تتفق الفرق على الطبقات وحدود الملكية والتبعيات. ثم يتغيّر المستودع: استيرادٌ مريح يعبر حدًّا، استثناءٌ مؤقت يصبح دائمًا، توثيقٌ يبتعد عن الواقع، ووكلاء البرمجة يجعلون المشكلة نفسها تتضخم أسرع.

قد يظل البناء ناجحًا. قد تجتاز الاختبارات. قد يظل المُدقِّق اللغوي يبلّغ عن نتيجة نظيفة. ومع ذلك يكون المستودع قد انحرف بهدوء.

السؤال المفقود هو:

> **هل ما زال الكود مطابقًا للمعمارية التي اخترناها؟**

يحوّل Archkeep هذا السؤال إلى عقد قابل للفحص آليًا.

## الفكرة الأساسية

```text
ARCHITECTURE INTENT
        ↓
OBSERVED REALITY
        ↓
DETERMINISTIC EVIDENCE
        ↓
AUTHORITATIVE VERDICT
```

تُصرِّح بالحدود وقواعد التبعيات المهمة بالنسبة إليك. يرصد Archkeep المستودع رصدًا ثابتًا، ويبني الرسم البياني والأدلة ذات الصلة، ويقارن الواقع بالقصد، ثم يعيد حكمًا حتميًا.

يمكن للبشر وCI ووكلاء البرمجة استخدام السلطة نفسها.

## لماذا يختلف عن غيره

| الأداة                         | تجيب عن                                      |
| ------------------------------ | -------------------------------------------- |
| المُترجِم                      | هل يُبنى الكود؟                              |
| الاختبارات                     | هل يتصرف الكود كما ينبغي؟                    |
| المُدقِّق اللغوي               | هل يتبع الكود قواعد اللغة/النمط؟             |
| أدوات التبعيات                 | كيف يرتبط الكود ببعضه؟                       |
| مراجعة الكود بالذكاء الاصطناعي | هل يرى النموذج أن هذا التغيير معقول؟         |
| **Archkeep**                   | **هل يلتزم الكود بالمعمارية التي اخترناها؟** |

لا يستبدل Archkeep هذه الأدوات؛ بل يملك الحد المعماري بينها.

## كيف يتناسب مع التطوير الوكيلي

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

يمكن للوكلاء أن يفحصوا ويشرحوا ويقترحوا؛ لكنهم لا يعيدون تعريف المعمارية عندما تتعارض تغييراتهم معها.

## القدرات الأساسية

- **فرض المعمارية** — قواعد التبعيات والحدود عبر مستودعات متعددة اللغات البرمجية.
- **أدلة حتمية** — 24 أمرًا مع JSON ذو إصدارات ومستقر على مستوى البايت؛ أحكام قابلة لإعادة الإنتاج مع التغطية ومصدر البيانات.
- **الحوكمة** — الإعفاءات، وسجلات قرارات المعمارية (ADRs)، ودوال الملاءمة، والقرارات الصريحة.
- **تطوّر المعمارية** — الانحراف، وأثر التغيير، والسجل التاريخي، والصحة، والدين التقني.
- **تكامل الوكلاء** — CLI وMCP وVS Code ومهارات وكلاء مدرِكة للمعمارية.

## متعدد اللغات البرمجية بتصميم

يقيّم Archkeep المعمارية عبر مستودعات Go وRust وPython وTypeScript/JavaScript وVue وJava/Kotlin وC#، ويتكامل مع أنظمة مساحات العمل مثل Nx وMoon، أو يكتشف المشاريع بشكل أصلي.

الهدف هو سياسة معمارية واحدة عبر حدود اللغات، لا آلية فرض منفصلة لكل لغة.

## بدء سريع

```bash
pnpm add -D @ecoma-io/archkeep
```

سجِّل Archkeep مع Nx، أو استخدم اكتشاف مساحة العمل الأصلي `archkeep.json`، أو هيِّئ التكامل المناسب لمستودعك.

ثم نفّذ:

```bash
pnpm exec archkeep check
```

بالنسبة إلى مستودع قائم، ابدأ بالاكتشاف:

```bash
pnpm exec archkeep discover
```

**مطلوب Node.js ≥ 22. لا يُشترط أي سلسلة أدوات للغات البرمجة لإجراء التحليل الثابت.**

→ [البدء](docs/getting-started/installation.md)

## مثال صغير

صرِّح بقاعدة مثل:

```js
export const depConstraints = [
  {
    sourceTag: "layer:domain",
    onlyDependOnLibsWithTags: ["layer:domain"],
    description: "The domain outlives frameworks, queues and databases.",
  },
];
```

إذا استورد مشروعٌ من الطبقة المجالية بنيةً تحتية:

```text
libs/pricing/src/discount.go:14:2  onlyTagsConstraintViolation
  A project tagged with "layer:domain" can only depend on libs tagged with layer:domain
  import      "github.com/acme/mq-client/publish" (static)  pricing → mq-client
  constraint  sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain]
  rule        The domain outlives frameworks, queues and databases.
```

المهم ليس فقط أن الفحص يفشل؛ فالحكم يحمل الأدلة ويشير إلى القاعدة المعمارية التي تسببت في الفشل.

## مستخدم في إيكوسيستم Ecoma

يُستخدم Archkeep داخليًا من قِبل:

- [Loom](https://github.com/ecoma-io/loom)
- [Action-Agents](https://github.com/ecoma-io/action-agents)
- [Release-Craft](https://github.com/ecoma-io/release-craft)

## التوثيق

- [البدء](docs/getting-started/installation.md)
- [نموذج المعمارية](docs/doctrine/architecture-authority.md)
- [دورة حياة الحوكمة](docs/concepts/governance-lifecycle.md)
- [مرجع CLI](docs/reference/cli.md)
- [التكاملات](docs/concepts/integrations.md)
- [مهارات الوكلاء](docs/skills/overview.md)
- [التوثيق الكامل](docs/README.md)

## المساهمة

أكثر المساهمات قيمةً هي الإبلاغ عن [انتهاك لم يُكتشَف](.github/ISSUE_TEMPLATE/missed_violation.yml): حد معماري حقيقي فشل Archkeep في اكتشافه.

انظر [CONTRIBUTING.md](CONTRIBUTING.md) و[مدونة قواعد السلوك](CODE_OF_CONDUCT.md) و[SECURITY.md](SECURITY.md).

## الترخيص

[رخصة Apache 2.0](LICENSE)
