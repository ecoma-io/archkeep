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
  <strong>मानव और एजेंटिक सॉफ़्टवेयर विकास के लिए एक वास्तुकला प्राधिकरण।</strong><br />
  जिस वास्तुकला का आप इरादा रखते हैं, उसे घोषित करें। Archkeep उसकी तुलना आपकी रिपॉजिटरी में वास्तव में मौजूद वास्तुकला से करता है और निर्धारणात्मक, साक्ष्य-समर्थित निर्णय उत्पन्न करता है।
</p>

<p align="center">
  <a href="docs/README.md">दस्तावेज़</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=bug_report.yml">बग रिपोर्ट करें</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=feature_request.yml">फ़ीचर अनुरोध</a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Archkeep" width="100%" />
</p>

## Archkeep क्यों

वास्तुकला शायद ही कभी एक साथ विफल होती है। यह धीरे-धीरे क्षरित होती है।

एक टीम परतों, स्वामित्व और निर्भरता सीमाओं पर सहमत होती है। फिर रिपॉजिटरी बदलती है: एक सुविधाजनक import एक सीमा पार कर जाता है, एक अस्थायी अपवाद स्थायी बन जाता है, दस्तावेज़ीकरण वास्तविकता से विचलित हो जाता है, और कोडिंग एजेंट उसी समस्या को और तेज़ी से बढ़ा देते हैं।

बिल्ड अब भी पास हो सकता है। टेस्ट अब भी पास हो सकते हैं। लिंटर अब भी साफ़ रिपोर्ट कर सकता है।

जो प्रश्न नहीं पूछा जा रहा, वह है:

> **क्या कोड अब भी उस वास्तुकला के अनुरूप है जिसे हमने चुना था?**

Archkeep उस प्रश्न को एक मशीन-जाँच योग्य अनुबंध में बदल देता है।

## मूल विचार

```text
ARCHITECTURE INTENT
        ↓
OBSERVED REALITY
        ↓
DETERMINISTIC EVIDENCE
        ↓
AUTHORITATIVE VERDICT
```

जो सीमाएँ और निर्भरता नियम मायने रखते हैं, आप उन्हें घोषित करते हैं। Archkeep रिपॉजिटरी का स्थैतिक रूप से निरीक्षण करता है, प्रासंगिक ग्राफ़ और साक्ष्य बनाता है, वास्तविकता की तुलना इरादे से करता है, और एक निर्धारणात्मक निर्णय लौटाता है।

इसी प्राधिकरण का उपयोग मनुष्य, CI और कोडिंग एजेंट कर सकते हैं।

## यह अलग क्यों है

| उपकरण          | उत्तर                                                     |
| -------------- | --------------------------------------------------------- |
| कंपाइलर        | क्या यह बिल्ड होता है?                                    |
| टेस्ट          | क्या यह सही व्यवहार करता है?                              |
| लिंटर          | क्या कोड भाषा/शैली के नियमों का पालन करता है?             |
| निर्भरता उपकरण | कोड कैसे जुड़ा हुआ है?                                    |
| AI कोड समीक्षा | क्या कोई मॉडल सोचता है कि यह बदलाव उचित लगता है?          |
| **Archkeep**   | **क्या कोड उस वास्तुकला के अनुरूप है जिसे हमने चुना था?** |

Archkeep इन उपकरणों की जगह नहीं लेता। यह उनके बीच की वास्तुकला सीमा का स्वामित्व रखता है।

## एजेंटिक विकास में यह कैसे फिट बैठता है

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

एजेंट निरीक्षण कर सकते हैं, समझा सकते हैं और प्रस्ताव रख सकते हैं। जब उनके बदलाव वास्तुकला से मेल नहीं खाते, तो वे वास्तुकला को फिर से परिभाषित नहीं करते।

## मुख्य क्षमताएँ

- **वास्तुकला प्रवर्तन** — बहुभाषी रिपॉजिटरीज़ में निर्भरता और सीमा नियम।
- **निर्धारणात्मक साक्ष्य** — संस्करणित, बाइट-स्थिर JSON वाले 24 कमांड; कवरेज और उत्पत्ति के साथ पुनरुत्पादनीय निर्णय।
- **शासन** — छूट, ADR, फ़िटनेस फ़ंक्शन और स्पष्ट निर्णय।
- **वास्तुकला विकास** — विचलन, बदलाव का प्रभाव, इतिहास, स्वास्थ्य और ऋण।
- **एजेंट एकीकरण** — CLI, MCP, VS Code और वास्तुकला-जागरूक एजेंट कौशल।

## डिज़ाइन से बहुभाषी

Archkeep Go, Rust, Python, TypeScript/JavaScript, Vue, Java/Kotlin और C# रिपॉजिटरीज़ में वास्तुकला का मूल्यांकन करता है, साथ ही Nx और Moon जैसे वर्कस्पेस सिस्टम से एकीकृत होता है या प्रोजेक्ट्स को मूल रूप से खोजता है।

लक्ष्य भाषा सीमाओं के पार एक ही वास्तुकला नीति है, न कि प्रति भाषा एक प्रवर्तन तंत्र।

## त्वरित आरंभ

```bash
pnpm add -D @ecoma-io/archkeep
```

Archkeep को Nx के साथ पंजीकृत करें, मूल `archkeep.json` वर्कस्पेस डिस्कवरी का उपयोग करें, या अपनी रिपॉजिटरी के लिए उपयुक्त एकीकरण कॉन्फ़िगर करें।

फिर चलाएँ:

```bash
pnpm exec archkeep check
```

किसी मौजूदा रिपॉजिटरी के लिए, डिस्कवरी से शुरू करें:

```bash
pnpm exec archkeep discover
```

**Node.js ≥ 22 आवश्यक है। स्थैतिक विश्लेषण के लिए किसी भाषा टूलचेन की आवश्यकता नहीं है।**

→ [आरंभ करना](docs/getting-started/installation.md)

## एक छोटा उदाहरण

ऐसा नियम घोषित करें, जैसे:

```js
export const depConstraints = [
  {
    sourceTag: "layer:domain",
    onlyDependOnLibsWithTags: ["layer:domain"],
    description: "The domain outlives frameworks, queues and databases.",
  },
];
```

यदि कोई डोमेन प्रोजेक्ट इन्फ्रास्ट्रक्चर import करता है:

```text
libs/pricing/src/discount.go:14:2  onlyTagsConstraintViolation
  A project tagged with "layer:domain" can only depend on libs tagged with layer:domain
  import      "github.com/acme/mq-client/publish" (static)  pricing → mq-client
  constraint  sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain]
  rule        The domain outlives frameworks, queues and databases.
```

महत्वपूर्ण बात केवल यह नहीं है कि जाँच विफल होती है। निर्णय साक्ष्य को अपने साथ ले जाता है और उस वास्तुकला नियम की ओर इशारा करता है जिसके कारण यह हुआ।

## Ecoma पारिस्थितिकी तंत्र में उपयोग

Archkeep इन परियोजनाओं में स्वयं प्रयोग किया जाता है:

- [Loom](https://github.com/ecoma-io/loom)
- [Action-Agents](https://github.com/ecoma-io/action-agents)
- [Release-Craft](https://github.com/ecoma-io/release-craft)

## दस्तावेज़ीकरण

- [आरंभ करना](docs/getting-started/installation.md)
- [वास्तुकला मॉडल](docs/doctrine/architecture-authority.md)
- [शासन जीवनचक्र](docs/concepts/governance-lifecycle.md)
- [CLI संदर्भ](docs/reference/cli.md)
- [एकीकरण](docs/concepts/integrations.md)
- [एजेंट कौशल](docs/skills/overview.md)
- [पूर्ण दस्तावेज़ीकरण](docs/README.md)

## योगदान

सबसे मूल्यवान योगदान एक [छूटा हुआ उल्लंघन](.github/ISSUE_TEMPLATE/missed_violation.yml) है: एक वास्तविक वास्तुकला सीमा जिसे Archkeep पहचानने में विफल रहा।

देखें [CONTRIBUTING.md](CONTRIBUTING.md), [आचार संहिता](CODE_OF_CONDUCT.md) और [SECURITY.md](SECURITY.md)।

## लाइसेंस

[Apache License 2.0](LICENSE)
