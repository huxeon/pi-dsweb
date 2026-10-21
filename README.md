# pi-dsweb

为 [Pi](https://pi.dev/) 提供 DeepSeek **网页搜索**与 **Markdown 网页抓取**工具的标准扩展包。不需要 MCP 服务、不需要启动后台进程，也不需要将当前对话模型切换为 DeepSeek。

## 环境要求

- Node.js 22 或更高版本。
- Pi：使用 `@earendil-works/pi-coding-agent` 扩展 API，已按 **1.3.0** 验证。
- 有可用余额的 DeepSeek API Key。

## 快速开始

如果已经在 Pi 中配置了 `deepseek` 提供商（例如通过 `/login` 保存 API Key），可以直接加载，无需再设置环境变量：

```powershell
pi -e ./extensions/index.ts
```

也可以在 PowerShell 中用环境变量显式指定或覆盖密钥：

```powershell
$env:DEEPSEEK_API_KEY = "sk-你的密钥"
pi -e ./extensions/index.ts
```

也可以按 Pi package 安装当前目录：

```powershell
# 用户级安装
pi install ./

# 或只安装到当前项目
pi install ./ --local
```

安装后在 Pi 中执行 `/reload`，或者重新启动 Pi。环境变量需要在启动 Pi **之前**设置；如果已启动的进程没有该环境变量，请先退出再启动。安装命令会修改对应范围的 Pi settings；本项目本身不会自动修改这些配置。

Linux/macOS：

```bash
export DEEPSEEK_API_KEY="sk-your-key"
pi -e ./extensions/index.ts
```

### 本地开发依赖

直接以扩展文件加载时，Pi 会提供宿主依赖；无需编译。本地目录 package 的依赖由作者自行管理，建议开发时先执行：

```sh
npm ci
npm run check
```

`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 和 `typebox` 都声明为 `peerDependencies: "*"`，同时作为开发依赖用于检查与测试；它们**不是运行时 dependencies，也不会打包进扩展**。

## 使用

直接告诉 Pi：

- “用 DeepSeek 搜索最近的 Node.js 发布说明，优先官方网站。”
- “搜索 `DeepSeek site:github.com lang:zh after:2025`，返回 5 条。”
- “用 DeepSeek 抓取 https://example.com/article 并总结。”

### web_search

请求 `POST https://api.deepseek.com/v1/tools/search`。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `query` | string，必填 | 1–128 个 Unicode 字符，不能全部为空白 |
| `count` | integer | 1–50，API 默认 10 |
| `ori_question` | string 或 null | 用户原始问题，1–128 字符；null 视为未提供 |
| `localization` | string | 用于本地化优先排序的 IP 地址，API 默认为空字符串 |
| `need_content` | boolean | 是否同时返回正文，API 默认 false |

保留官方参数名；未提供的可选字段不发送，由 API 应用默认值。

支持的 query 语法：`site:`、`-site:`、`-关键词`、`-"排除短语"`、`"精确短语"`、`lang:zh,en`、`after:2025-01-01`、`before:2026`，以及站点条件之间的 `OR`。搜索语法原样发送，不擅自改写。

模型可见的工具正文展示标题、URL、站点、时间、排名分、权威分和 `summary`，不回退到 `snippet`，不做整体字节数或行数截断。标题、URL、站点和时间会折叠为单行，避免换行在 Markdown 中注入额外结构；`summary` 保留原始内容。非空网页 `content` 不内联展示，而是逐条原样保存为系统临时目录下的 `pi-dsweb-search-*/result-N.md`，在对应条目中提供路径，供模型按需使用 `read` 读取。没有网页正文时不创建文件；保存失败则报错，取消或执行失败会清理本次已写入的正文文件。codemode 直接返回原始 API 响应，保留全部字段与完整正文，不增加包装或截断。没有匹配结果是正常成功，不是错误。

### web_fetch

请求 `POST https://api.deepseek.com/v1/tools/fetch`。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string，必填 | 最多 8192 字符的 HTTP/HTTPS URL，必须有 host，不能包含用户名或密码 |

模型正文以 `Title: 标题`、空行和原始正文展示，不额外重复请求 URL。标题会折叠为单行，为空时省略标题及分隔空行；正文不额外转义、反转义、清洗或摘要。正文超过约 **48 KiB／1900 行** 时，仅保留开头片段，并将完整原始正文保存到系统临时目录 `pi-dsweb-fetch-*/content.md`，在模型正文末尾提供路径和 `read` 提示；未截断时不创建文件。codemode 始终直接返回完整原始 `{ title, content }`，不包装、不截断。实际抓取在 DeepSeek 服务端进行，不是本地浏览器；目标站点的策略或内容类型可能导致无法抓取。

### 终端展示

- 调用行遵循 Pi 内置工具风格：加粗工具名 `web_search` / `web_fetch`，强调色显示搜索词或 URL，灰色显示可选参数（`count N`、`content`），缺少参数时显示 `...`。`web_search` 折叠态保持单行裁剪；`web_fetch` 与内置 `read`/`grep` 一致，折叠和展开都保留完整 URL 并通过 `Text` 自动换行，不再应用 300 字符上限。仅清理展示中的终端控制字符，不修改实际请求参数。
- 两个工具的结果都以一行空白与调用行分隔。搜索不显示总数：每条结果依次输出 `序号. 标题`、完整 URL 和 `snippet`，条目之间空行，全部使用普通文字色。两个工具的折叠态统一按逻辑行预览前 **5 行**，空行也计入预算，自动折行不额外计数；仅当还有未显示的行时追加灰色 `... (N more lines, to expand)`。抓取依次展示 `Title: 标题`、空行和原始正文，空标题省略，不显示正文大小。展开只补全后续内容，不重排或改写已展示的前缀。
- 计时对齐 Pi 内置 **shell 工具**：执行开始后在结果底部独立显示灰色 `Elapsed 0.0s`，每秒刷新；完成后在底部显示 `Took 1.2s`，抓取成功结果折叠时也保留该计时；错误结果仍直接可见。计时在列表／正文预览及省略提示之后显示，前面留一行空白，不放在顶部元数据行；两个工具只有计时时也与调用行留一行空白。优先使用 Pi 记录的最终耗时。超过一分钟显示 `1m 30s`，超过一小时显示 `1h 2m 3s`。不额外显示 `Searching...`／`Fetching...`，调用行不随执行状态改变；参数生成阶段不计时。成功、失败或取消后停止刷新，退出、重载或切换会话时清理活动计时器。计时仅用于前端，不写入模型正文、codemode 或结果 `details`。这是本扩展有意保留的例外：`read`/`grep` 等内置工具不显示计时，`web_search`/`web_fetch` 也不是 shell 工具。错误按 Pi fallback 风格预览前 10 个逻辑行，展开后显示完整错误文本。
- 使用 Pi 的工具展开操作（界面显示当前快捷键，也支持 Pi 提供的点击展开）查看详情。
- 搜索展开态展示全部结果，条目之间留一行空白；标题、URL 和 `snippet` 统一使用 Pi 的普通文字色，不再为标题加粗或为来源着灰色。不额外限制结果数量（API 的请求参数 `count` 范围仍为 1–50）。摘要只使用 `snippet`，不回退到 `summary`；模型正文只使用 `summary`。不铺开网页正文，也不显示完整 JSON 文件路径或相关入口提示。
- 抓取展开态显示 `Title: 标题`、空行和模型可见的正文片段（最多 48 KiB／1900 行），空标题省略；正文统一使用 `toolOutput` 普通文字，与 Pi 内置 `read` 显示 Markdown 源文一致，不做额外的 Markdown 渲染、标题加粗或颜色分层；折叠态预览前 5 个逻辑行，不限制展开内容。不额外添加请求 URL 或文件路径。展开内容与模型正文的截断阈值一致，不影响 codemode 原始响应。
- 搜索保存非空网页正文，抓取仅在正文截断时保存完整正文，均为原始 Markdown 文件；路径提供给模型，不在结果前端显示。不再保存完整 JSON 文件。保存发生在工具执行阶段，渲染函数不读写文件。
- 抓取正文截断时在结果末尾以警告色显示 `[Truncated: showing X of Y lines]`，与 Pi 内置工具“截断提示放在输出之后并带行数”的惯例一致；完整正文文件保存失败会报错，取消或执行失败会清理本次已写入的文件。未截断时不依赖临时文件。搜索不做整体输出截断。
- 外部文本中的终端控制序列与双向覆盖字符仅在展示时清理，不修改 API 原始响应。结果正文统一使用 Pi 主题的 `toolOutput`／`muted`／`warning` 颜色，不传递 OSC 超链接或终端控制命令。
- 搜索 `details` 直接使用结果数组 `[{ title, domain, url, snippet }, ...]`，没有 `view`、`kind`、`count` 或 `items` 包装。条目保存完整的安全展示标题、域名、URL 及 `snippet`，不保存冗余的 `truncated` 或临时目录元数据；渲染器使用标题、URL 和 `snippet`，域名保留在 `details` 中但不再单独展示（URL 已包含来源）。Pi 只向自定义渲染器传递 `content` 和 `details`，不传递 `structuredContent`，因此这些展示字段仍需保留。搜索渲染器只接受当前数组格式，不兼容旧对象格式或嵌套 `details.view`；没有可用数组时提示预览不可用，不回退展示含长摘要或文件路径的模型正文。抓取 `details` 为扁平的 `{ title, bytes, content, truncated, totalLines, outputLines }`：`title` 保留完整安全展示标题，非空时输出为 `Title: 标题`；`content` 是模型可见的正文片段，折叠态连同标题和分隔空行按前 5 行预览，展开态完整显示；`totalLines`/`outputLines` 仅用于截断警告。没有 `view`、`kind` 或文件路径包装，不兼容旧会话格式。
- 通过 Pi 的 `lastComponent` 复用结果组件和内部 `Text` 缓存，内容、主题或宽度变化时重建文本；`invalidate()` 只失效布局缓存，不重新读取响应或文件。

### 结构化输出与大结果

两个工具都声明原始响应 `outputSchema`，codemode 直接获得完整 API JSON，不包装、不截断。

**搜索：**

```typescript
{
  results: Array<{
    // 其余官方字段同样原样保留
    title: string;
    url: string;
    snippet: string;
    summary: string;
    content: string;
  }>;
}
```

**抓取：**

```typescript
{
  title: string;
  content: string;
}
```

普通模型正文与 codemode 的用途不同：

- 搜索正文使用完整 `summary`，网页 `content` 保存为临时 Markdown 文件并提供路径。
- 抓取正文直接展示 `content`，只在正文超过约 **48 KiB 或 1900 行** 时截断，并将完整原始正文保存为 Markdown 文件、向模型提供 `read` 路径。
- 抓取是否截断仅由正文决定，不再根据原始 JSON 的大小或行数截断；codemode 始终保留完整原始响应。
- 临时文件不会随会话结束自动删除，以便稍后读取；不再需要时可手动删除。内容可能敏感，请注意临时目录与会话的访问权限。

codemode 示例（需要先启用 Pi 的 codemode 工具）：

```javascript
const r = await tools.web_search({
  query: "DeepSeek site:github.com",
  count: 3,
});
text(r.results.map(item => ({
  title: item.title,
  url: item.url,
  summary: item.summary,
})));

const page = await tools.web_fetch({ url: "https://example.com/article" });
text(page.title);
text(page.content); // 完整原始正文，不是截断预览
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 无，可选 | 优先使用的 DeepSeek Bearer API Key；未设置时复用 Pi 的 `deepseek` 凭据 |
| `DSWEB_TIMEOUT_MS` | `60000` | 单次工具请求总超时，包括重试和退避；范围 1–600000 ms |
| `DSWEB_MAX_RETRIES` | `2` | 瞬时 HTTP 错误的额外重试次数；0–5 |

凭据解析顺序：

1. 非空的 `DEEPSEEK_API_KEY` 环境变量（优先）。
2. 通过 `ctx.modelRegistry.getApiKeyForProvider("deepseek")` 解析 Pi 已配置的 DeepSeek 凭据，包括 Pi 保存的 API Key；具体存储、命令型密钥等解析由 Pi 负责。
3. 两者都不可用时，提示设置环境变量或通过 `/login` 配置 DeepSeek。

不直接读取或修改 `auth.json`，不自动加载 `.env`，不将密钥写入结果、日志或项目文件。凭据在每次工具执行时解析，不在扩展加载时读取或自行长期缓存；当前对话即使使用其他提供商，也始终只解析 `deepseek` 的凭据，不会借用当前模型的密钥。若 DeepSeek 配置在其他自定义提供商 ID 下，需要设置 `DEEPSEEK_API_KEY`。

API 域名固定为官方 `https://api.deepseek.com`，不跟随重定向，避免将密钥发送给其他主机。

- 支持 Pi 取消信号；中断会同时停止请求或退避等待。
- 仅对 HTTP **408、429、5xx** 自动重试，采用指数退避；支持 `Retry-After` 秒数或 HTTP 日期，单次等待上限 30 秒。
- 其他 4xx 不自动重试；402 会提示充值。
- 网络连接异常不会自动重试，避免在结果不明确时重复潜在的计费请求。
- API 错误消息会隐藏当前密钥与 Bearer token；不回显非 JSON 的代理错误页面。
- 网页内容是不可信外部数据，不能作为新的系统指令；工具描述也会提醒模型引用来源、忽略网页中的指令注入。

## 与原始 API 的边界

已对照官方指南及 Search / Fetch Reference 校验端点、请求字段、默认值、响应字段及错误处理。以下是扩展的额外策略，不是 DeepSeek 原始 API 的保证：

- **未知请求字段**：官方 Search API 忽略未知字段；本扩展的工具 schema 使用 `additionalProperties: false` 提前拒绝拼错或未知的参数，HTTP 客户端也只转发已知字段。
- **URL 校验**：除 HTTP(S)、host、长度和无用户名/密码外，本扩展还拒绝首尾空白、控制字符和反斜杠，不让 Node 的 URL 解析器自动修复 `https:example.com` 等畸形输入。URL 不会被规范化后重新发送。
- **问题校验**：`query` 不允许全部为空白；`ori_question` 只按文档校验 1–128 个 Unicode 字符或 null，不额外套用 query 的空白限制。
- **响应校验**：仅把 HTTP 200 当作成功，校验必需字段及类型；`rerank_score` 为 0–3，`authority` 为 -1–4 的整数，`date` 为 RFC 3339 日期时间或 null。不会额外过滤低分结果，也不会重排结果。日期原样保留，不在本地转换时区。
- **结果处理**：搜索和抓取的 codemode 结果均直接使用完整官方响应。搜索普通正文只使用 `summary`，将网页正文保存为临时 Markdown 文件并提供路径，不整体截断；抓取普通正文直接展示标题和正文，正文超限时截断并提供完整 Markdown 文件路径。截断和展示元数据仅属于扩展输出，不修改 API 原始响应。
- **重试与安全**：官方建议 408 / 429 / 5xx 后等待重试；默认额外重试 2 次、指数退避、`Retry-After` 支持、等待上限、总请求超时、拒绝重定向和凭据复用，均为本扩展策略。网络或响应体读取异常不自动重试。

Pi 工具定义包含 `description`、`promptSnippet`、`promptGuidelines`、输入/输出 schema、`structuredContent` 和 `details`；扩展工厂不发网络请求，也不启动后台任务。

## 计费与限速

按照本项目所参考的官方指南，Search / Fetch 各为 **5 元 / 1000 次成功且产生结果的请求**；不是 token 计费，也不随 `count` 改变。Search 无结果或请求失败不计费。价格以官方最新文档为准。

官方指南还单独说明了 DeepSeek Harness / Claude Code / Codex 的 **Server 端工具调用**暂未计费，并将于北京时间 **2026-11-01 00:00** 开始收费。这不是对所有直接 API 请求的免费承诺；本扩展直接调用 Search / Fetch，不能据此假定免费，实际以官方规则和账单为准。

根据[官方指南](https://api-docs.deepseek.com/zh-cn/guides/search/)，Search 与 Fetch 按账号分别独立限速，互不占用额度：

| API | 账号级 QPS 限制 |
| --- | --- |
| Search | **100** |
| Fetch | **25** |

限速与使用哪个 API Key 无关，并与模型并发限制相互独立；Fetch 还受目标域名限速影响。本扩展没有全局账号级限流器，并发调用、其他 Pi 实例或其他应用共享账号额度，遇到 429 时按上述规则退避重试。请不要把“只读”误解为免费调用。

## 项目结构

```text
pi-dsweb/
├── package.json           # pi-package 关键字、pi.extensions manifest、宿主 peerDependencies
├── extensions/
│   └── index.ts           # 默认导出的 Pi 扩展工厂，注册两个工具
├── src/
│   ├── client.ts          # 参数校验、HTTP、超时、取消、重试
│   ├── schemas.ts         # TypeBox 请求/响应 schema
│   ├── output.ts          # 格式化、截断和临时文件
│   ├── presentation.ts    # 展示元数据和文本安全清理
│   ├── timing.ts          # 实时 Elapsed / 最终 Took 计时和清理
│   └── renderers.ts       # 调用行、折叠预览与展开结果
├── tests/                 # 离线测试，不访问真实接口或消耗余额
├── .env.example
├── tsconfig.json
├── package-lock.json
├── LICENSE
└── README.md
```

开发检查与打包检查：

```sh
npm run check
npm pack --dry-run
```

发布时运行 `npm publish`；发布后可使用 `pi install npm:pi-dsweb` 安装（需先确认 npm 包名可用；当前目录尚未发布）。

## 官方参考

- [网页搜索与抓取指南](https://api-docs.deepseek.com/zh-cn/guides/search/)
- [Search API](https://api-docs.deepseek.com/zh-cn/api/search)
- [Fetch API](https://api-docs.deepseek.com/zh-cn/api/fetch)

## License

MIT
