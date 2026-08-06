---
name: nx-polyglot-graph
lang: vi
description: Nx plugin thêm cạnh graph liên project cho Go/Rust/Python và thực thi module boundary ở những ngôn ngữ ESLint không đọc được.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# nx-polyglot-graph

## Vì sao nó tồn tại

`nx affected` chỉ biết tới một dependency khi dependency ấy hiện lên thành một
cạnh trong Nx project graph, mà cơ chế suy luận graph của Nx thì không hiểu một
import Go, một Cargo path dependency, hay một mục `[tool.uv.sources]`. Không có
plugin này, sửa một Go library sẽ không bao giờ đánh dấu project Go anh em là
affected — làm `nx affected` mất tác dụng trong im lặng với mọi project đa ngôn
ngữ trong workspace. Các plugin cộng đồng cho vấn đề này (gonx, `@nxlv/python`)
giải quyết bằng cách suy luận luôn cả target từ toolchain. Plugin này cố ý
không: target vẫn viết tay trong từng `project.json`, nên "một target làm gì"
chỉ có một nguồn sự thật. Plugin này chỉ thêm những cạnh còn thiếu.

Khoảng trống đó có nửa thứ hai. `@nx/enforce-module-boundaries` chỉ đọc
JavaScript, TypeScript và Vue, nên trong một project Go hay Rust thì các tag
`layer:`, `scope:` và `license:` là lời khai báo không có cơ chế nào đứng sau:
một file `.go` được thêm import vi phạm trục layer vẫn hiện cạnh trong graph và
vẫn qua `lint`, vì với `.go` thì ESLint trả lời "File ignored because no matching
configuration was supplied". `src/analysis/` và `src/rules/` là nơi điều đó trở
thành một phép kiểm tra thật — đủ mười lăm loại vi phạm của
`@nx/enforce-module-boundaries`, dưới tám option của nó, chạy trên các bản ghi
phân tích thay vì trên AST của ESLint.

## Cài đặt

```shell
pnpm add -D @ecoma-io/nx-polyglot-graph
```

Đăng ký nó trong `nx.json`, và cho nó biết workspace của bạn đặt tên file ra sao:

```json
{
  "plugins": [
    {
      "plugin": "@ecoma-io/nx-polyglot-graph",
      "options": {
        "boundaryConfig": "module-boundaries.config.mjs",
        "tsConfig": "tsconfig.base.json"
      }
    }
  ]
}
```

Cả hai option đều mặc định đúng những giá trị trên — quy ước của Nx — nên một
workspace theo quy ước chỉ cần đăng ký plugin bằng tên. Cả hai được **đọc** thay
vì giả định, bởi đó là quy ước mà một workspace có quyền đổi tên, và một công cụ
hardcode chúng sẽ trả lời rất tự tin về một workspace nó đã đọc sai. Một key lạ
sẽ **ném lỗi** chứ không rơi về default: một `tsconfigBase` gõ nhầm thay cho
`tsConfig` mà lặng lẽ dùng default nghĩa là cả một lần chạy xanh trên một luật
không ai viết.

`nx` là peer dependency và được resolve từ workspace của bạn, nên graph công cụ
này đọc chính là graph mà lệnh `nx` của bạn dựng ra.

## File cấu hình boundary

Một file ở workspace root — file mà `boundaryConfig` gọi tên — giữ bảng ràng
buộc và tám option của upstream. Nó export `depConstraints` đúng hình dạng
`@nx/enforce-module-boundaries` nhận, nên trong một workspace TypeScript thì
cùng file đó nuôi cả hai bộ thực thi, và chỉ có một bảng thay vì hai:

```js
export const depConstraints = [
  { sourceTag: "layer:app", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
  { sourceTag: "scope:billing", onlyDependOnLibsWithTags: ["scope:billing", "scope:shared"] },
];

export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

export const boundarySuppressions = [];
```

Không chỗ nào trong package này đặt mặc định cho một ràng buộc hay một option.
Một default ở đây sẽ là bản sao thứ hai của giá trị mà file kia đã nói, và hai
bản sẽ lệch nhau ngay ngày một bên đổi.

## Chạy trong terminal

Bin `nx-polyglot-graph` đọc Nx graph, phân tích mọi file nguồn được theo dõi mà
một project sở hữu, và báo mọi vi phạm kèm `file:line:column` để lập trình viên
hành động được:

```shell
pnpm exec nx-polyglot-graph check
pnpm exec nx-polyglot-graph check --format sarif --output boundaries.sarif
pnpm exec nx-polyglot-graph check --config boundaries.custom.mjs
```

Bốn exit code, và khác biệt đáng giá nhất là **3** so với **0**:

| code | ý nghĩa                                                                     |
| ---- | --------------------------------------------------------------------------- |
| 0    | sạch — và mọi file được chọn đều đã được phân tích                          |
| 1    | tìm thấy vi phạm                                                            |
| 2    | sai cách dùng                                                               |
| 3    | không có kết luận — không chạy được, hoặc một file được chọn không đọc được |

Một bộ kiểm tra không nhìn được tuyệt đối không được bị nhầm với một bộ đã nhìn
và không thấy gì. Đó là lý do exit 3 tồn tại, và là lý do nó phủ cả một lần chạy
**dở dang** chứ không chỉ một lần chạy hỏng hoàn toàn: một file không đọc được,
một file không có analyzer, hay một `tsconfig` không nạp được — mỗi thứ đều để
lại một file mà bản tóm tắt có đếm nhưng không luật nào từng xét. Vì thế mọi kết
luận đều nói rõ nó đã soi những gì:

```text
✔ no boundary violations (264 imports in 78 files across 1 project)
```

Một import mà specifier không xác định được tĩnh thì không thuộc trường hợp đó —
file ấy đã được xét, chỉ một vị trí trong nó là không có câu trả lời. Những chỗ
này được in dưới mục riêng như những điểm mù đã khai báo, và lần chạy không fail
vì chúng.

## Chạy trong editor

Bin `nx-polyglot-graph-lsp` nói Language Server Protocol qua stdio và publish
một diagnostic cho mỗi vi phạm boundary, mang đúng `messageId` mà
`@nx/enforce-module-boundaries` báo cho import đó. Một file nó không phân tích
được sẽ nhận một diagnostic nói đúng điều ấy — nên một danh sách diagnostic rỗng
từ server này luôn có nghĩa "không vi phạm", không bao giờ là "chưa kiểm tra".

Là một editor server chứ không phải một ESLint plugin, vì ESLint plugin chỉ chạy
ở nơi ESLint có parser. Trong một workspace có cấu hình parser, đó là JS, TS
**và Vue** — đã đo: một file `.vue` import một package bị cấm nhận cùng một
message từ ESLint và từ công cụ này, chỉ khác cột mà mỗi bên gạch chân. Go, Rust
và Python không có parser nào cả, và đó là nửa mà một ESLint plugin không bao
giờ với tới.

**Claude Code** cài nó như một plugin, từ marketplace của chính repository này:

```shell
claude plugin marketplace add ecoma-io/lattice
claude plugin install nx-polyglot-graph@lattice
```

Sau đó mỗi session sẽ nhận diagnostic boundary ở mỗi lần sửa một file Go, Rust,
Python hay Vue. Khai báo server là `lspServers` trong
`.claude-plugin/plugin.json`, và nó nhận mọi phần mở rộng mà các analyzer xử lý
được, trừ họ JS/TS: một editor chỉ cho một server trên mỗi phần mở rộng file,
nên nhận thêm chúng sẽ đẩy văng đúng cái language server mà lập trình viên thực
sự cần ở đó. `.vue` nằm ở phía được nhận của ranh giới đó và ESLint cũng đọc nó,
nên Vue là phần mở rộng duy nhất được cả hai enforcer phủ.

**Bất kỳ LSP client nào khác** khởi chạy đúng executable đó:

```text
command                node <workspace>/node_modules/@ecoma-io/nx-polyglot-graph/lsp.mjs
transport              stdio
initializationOptions  { "workspaceRoot": "<workspace>" }
                       — chỉ cần khi root của editor không phải root workspace
watched files          file boundary config, **/nx.json, và **/project.json
```

Root của workspace được lấy từ `initializationOptions`, rồi `workspaceFolders`,
rồi `rootUri`, rồi `rootPath`, rồi thư mục làm việc. Chỉ đồng bộ toàn văn bản
được quảng cáo. Client nào hỗ trợ dynamic registration sẽ được yêu cầu theo dõi
ba file trên — trong đó có `nx.json`, vì đó là nơi chứa option gọi tên file
boundary config, và một server chỉ theo dõi tên file cũ sẽ tiếp tục publish kết
luận từ một config nó không còn đọc nữa. Client nào không đăng ký động được sẽ
được báo trên stderr.

## Những gì nó cố ý không làm

Nó không bao giờ tạo project node và không bao giờ suy luận hay gắn target — cả
hai vẫn viết tay trong `project.json` của từng project. Các resolver không bao
giờ shell ra `go`, `cargo`, hay `uv`; chúng chỉ đọc file manifest và source đã
được track (regex trên import Go theo format chuẩn gofmt, `smol-toml` cho
`Cargo.toml`/`pyproject.toml`), nên graph tính được trên máy chưa từng cài các
toolchain đó. Nó cũng không bao giờ ghi external package (crates.io, PyPI, Go
module proxy) thành `externalNodes` — chỉ cạnh giữa project với project mới có ý
nghĩa với `nx affected`.

Không có option nào để tắt một ngôn ngữ, và sự vắng mặt đó chính là thiết kế.
Mọi báo cáo của một ngôn ngữ bị tắt sẽ giống hệt từng byte với báo cáo của một
ngôn ngữ không có vi phạm nào. Mỗi analyzer vốn đã không tốn gì trong một
workspace không có ngôn ngữ đó, vì việc resolve khoá theo một manifest không tồn
tại.

Và không chỗ nào ở đây giả định tên project, khu vực, hay giá trị tag của bất kỳ
workspace nào. Mọi thứ đến từ graph Nx tính ra và từ config workspace khai báo —
đó là điều cho phép nó chạy trên những cây thư mục nó chưa từng thấy.

## Trạng thái

Cả hai nửa đều chạy, và CI chứng minh điều đó trên chính source của repository
này: cùng lệnh `check` chạy trên bộ tag vocabulary của `lattice`, thứ không chia
sẻ gì với workspace mà công cụ được viết ra ở đó.

`src/conformance/` đo chỗ engine này và ESLint đồng thuận và chỗ không, trên 37
fixture workspace dựng riêng cho mục đích ấy. Hai enforcer được thiết kế để chạy
song song: ESLint giữ thẩm quyền cho JavaScript, TypeScript và Vue; công cụ này
phủ Go, Rust và Python — những thứ ESLint hoàn toàn không đọc được.

Cơ chế, giới hạn parse theo từng ngôn ngữ, và giả định một-manifest-mỗi-project
nằm trong [`./CLAUDE.md`](./CLAUDE.md).
