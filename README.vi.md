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
  <strong>Một quyền uy kiến trúc cho phát triển phần mềm của con người và tác tử.</strong><br />
  Hãy khai báo kiến trúc bạn dự định. Archkeep so sánh nó với kiến trúc mà kho lưu trữ của bạn thực sự đang có và đưa ra các phán quyết tất định, dựa trên bằng chứng.
</p>

<p align="center">
  <a href="docs/README.md">Tài liệu</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=bug_report.yml">Báo lỗi</a> ·
  <a href="https://github.com/ecoma-io/archkeep/issues/new?template=feature_request.yml">Đề xuất tính năng</a>
</p>

<p align="center">
  <img src=".github/assets/banner.png" alt="Archkeep" width="100%" />
</p>

## Vì sao chọn Archkeep

Kiến trúc hiếm khi sụp đổ cùng một lúc. Nó bị bào mòn dần.

Một nhóm thống nhất về các tầng, quyền sở hữu và ranh giới phụ thuộc. Rồi kho lưu trữ thay đổi: một câu lệnh import tiện lợi vượt qua ranh giới, một ngoại lệ tạm thời trở thành vĩnh viễn, tài liệu sai lệch so với thực tế, và các tác tử lập trình khiến cùng một vấn đề lan rộng nhanh hơn.

Bản build vẫn có thể thành công. Các bài kiểm thử vẫn có thể vượt qua. Trình lint vẫn có thể báo sạch.

Câu hỏi còn thiếu là:

> **Mã nguồn có còn tuân thủ kiến trúc mà chúng ta đã chọn không?**

Archkeep biến câu hỏi đó thành một hợp đồng có thể kiểm tra bằng máy.

## Ý tưởng cốt lõi

```text
ARCHITECTURE INTENT
        ↓
OBSERVED REALITY
        ↓
DETERMINISTIC EVIDENCE
        ↓
AUTHORITATIVE VERDICT
```

Bạn khai báo các ranh giới và quy tắc phụ thuộc quan trọng. Archkeep quan sát tĩnh kho lưu trữ, xây dựng đồ thị và bằng chứng liên quan, so sánh thực tế với ý định, rồi trả về một phán quyết tất định.

Quyền uy này có thể được sử dụng bởi con người, CI và các tác tử lập trình.

## Điều gì làm nó khác biệt

| Công cụ             | Trả lời                                                       |
| ------------------- | ------------------------------------------------------------- |
| Trình biên dịch     | Nó có build được không?                                       |
| Kiểm thử            | Nó có hoạt động đúng không?                                   |
| Trình lint          | Mã nguồn có tuân thủ quy tắc ngôn ngữ/phong cách không?       |
| Công cụ phụ thuộc   | Mã nguồn được kết nối với nhau như thế nào?                   |
| Đánh giá mã bằng AI | Mô hình có cho rằng thay đổi này trông hợp lý không?          |
| **Archkeep**        | **Mã nguồn có tuân thủ kiến trúc mà chúng ta đã chọn không?** |

Archkeep không thay thế các công cụ này. Nó nắm giữ ranh giới kiến trúc giữa chúng.

## Vị trí trong phát triển agentic

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

Các tác tử có thể kiểm tra, giải thích và đề xuất. Chúng không định nghĩa lại kiến trúc khi thay đổi của chúng không khớp với kiến trúc.

## Năng lực cốt lõi

- **Thực thi kiến trúc** — các quy tắc phụ thuộc và ranh giới trên các kho đa ngôn ngữ.
- **Bằng chứng tất định** — 24 lệnh với JSON theo phiên bản, ổn định đến từng byte; các phán quyết có thể tái lập kèm độ phủ và nguồn gốc.
- **Quản trị** — miễn trừ, ADR, hàm thích nghi và các quyết định tường minh.
- **Tiến hóa kiến trúc** — sai lệch, tác động của thay đổi, lịch sử, sức khỏe và nợ kiến trúc.
- **Tích hợp tác tử** — CLI, MCP, VS Code và các kỹ năng tác tử hiểu biết kiến trúc.

## Đa ngôn ngữ theo thiết kế

Archkeep đánh giá kiến trúc trên các kho Go, Rust, Python, TypeScript/JavaScript, Vue, Java/Kotlin và C#, đồng thời tích hợp với các hệ thống workspace như Nx và Moon hoặc tự phát hiện dự án theo cách nguyên bản.

Mục tiêu là một chính sách kiến trúc duy nhất xuyên qua các ranh giới ngôn ngữ, chứ không phải một cơ chế thực thi cho từng ngôn ngữ.

## Bắt đầu nhanh

```bash
pnpm add -D @ecoma-io/archkeep
```

Đăng ký Archkeep với Nx, sử dụng cơ chế phát hiện workspace `archkeep.json` nguyên bản, hoặc cấu hình tích hợp phù hợp với kho lưu trữ của bạn.

Sau đó chạy:

```bash
pnpm exec archkeep check
```

Với một kho lưu trữ hiện có, hãy bắt đầu bằng phát hiện:

```bash
pnpm exec archkeep discover
```

**Yêu cầu Node.js ≥ 22. Không cần toolchain ngôn ngữ nào cho phân tích tĩnh.**

→ [Bắt đầu](docs/getting-started/installation.md)

## Một ví dụ nhỏ

Khai báo một quy tắc như sau:

```js
export const depConstraints = [
  {
    sourceTag: "layer:domain",
    onlyDependOnLibsWithTags: ["layer:domain"],
    description: "The domain outlives frameworks, queues and databases.",
  },
];
```

Nếu một dự án domain import cơ sở hạ tầng:

```text
libs/pricing/src/discount.go:14:2  onlyTagsConstraintViolation
  A project tagged with "layer:domain" can only depend on libs tagged with layer:domain
  import      "github.com/acme/mq-client/publish" (static)  pricing → mq-client
  constraint  sourceTag layer:domain → onlyDependOnLibsWithTags [layer:domain]
  rule        The domain outlives frameworks, queues and databases.
```

Phần quan trọng không chỉ là việc kiểm tra thất bại. Phán quyết mang theo bằng chứng và chỉ ra quy tắc kiến trúc đã gây ra nó.

## Được dùng trong hệ sinh thái Ecoma

Archkeep được chính Ecoma dùng nội bộ:

- [Loom](https://github.com/ecoma-io/loom)
- [Action-Agents](https://github.com/ecoma-io/action-agents)
- [Release-Craft](https://github.com/ecoma-io/release-craft)

## Tài liệu

- [Bắt đầu](docs/getting-started/installation.md)
- [Mô hình kiến trúc](docs/doctrine/architecture-authority.md)
- [Vòng đời quản trị](docs/concepts/governance-lifecycle.md)
- [Tài liệu tham khảo CLI](docs/reference/cli.md)
- [Tích hợp](docs/concepts/integrations.md)
- [Kỹ năng tác tử](docs/skills/overview.md)
- [Toàn bộ tài liệu](docs/README.md)

## Đóng góp

Đóng góp giá trị nhất là một [vi phạm bị bỏ sót](.github/ISSUE_TEMPLATE/missed_violation.yml): một ranh giới kiến trúc có thật mà Archkeep không phát hiện được.

Xem [CONTRIBUTING.md](CONTRIBUTING.md), [Quy tắc ứng xử](CODE_OF_CONDUCT.md) và [SECURITY.md](SECURITY.md).

## Giấy phép

[Giấy phép Apache 2.0](LICENSE)
