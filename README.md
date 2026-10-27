# pi-dsweb

为 [Pi](https://pi.dev/) 提供 DeepSeek **网页搜索**与 **Markdown 网页抓取**工具的扩展包。

- 不需要 MCP 服务或独立后台进程。
- 不需要将当前对话模型切换为 DeepSeek。
- 支持复用 Pi 的 DeepSeek 凭据，也可以通过环境变量指定 API Key。
- 支持在终端查看结果，也可通过 codemode 获取原始响应。

## 环境要求

- Node.js 22 或更高版本。
- Pi：使用 `@earendil-works/pi-coding-agent` 扩展 API，已按 **1.3.0** 验证。
- 有可用余额的 DeepSeek API Key。工具只读，但调用可能收费。

## 安装与快速开始

以下命令在项目根目录执行。如果已经在 Pi 中配置了 `deepseek` 提供商，例如通过 `/login` 保存 API Key，可以直接加载扩展：

```powershell
pi -e ./index.ts
```

也可以在启动 Pi 前显式指定或覆盖密钥：

```powershell
# PowerShell
$env:DEEPSEEK_API_KEY = "sk-你的密钥"
pi -e ./index.ts
```

```bash
# Linux / macOS
export DEEPSEEK_API_KEY="sk-your-key"
pi -e ./index.ts
```

要持久安装为 Pi package，可选择用户级或项目级安装：

```powershell
pi install ./
# 或只安装到当前项目
pi install ./ --local
```

安装后在 Pi 中执行 `/reload`，或重新启动 Pi。安装命令会修改对应范围的 Pi settings，本扩展不会自行修改这些配置。环境变量必须在启动 Pi **之前**设置；已启动的进程不会自动获得后来设置的变量。

直接以扩展文件加载时，Pi 会提供宿主依赖，无需编译。本地 package 的开发依赖由作者自行管理，开发前请执行 `npm ci`，详见[开发](#开发)。

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
| `need_content` | boolean | 是否同时返回网页正文，API 默认 false |

可选字段未提供时不发送，由 API 应用默认值。搜索语法原样发送，支持：

```text
site:github.com
-site:example.com
-关键词
-"排除短语"
"精确短语"
lang:zh,en
after:2025-01-01
before:2026
site:github.com OR site:huggingface.co
```

**模型可见文本**按结果顺序包含：标题、URL、站点、日期、`rerank_score`、`authority` 和原始 `summary`。

- `summary` 不二次摘要、不回退到 `snippet`，搜索文本不做整体长度截断。
- 非空 `content` 不内联，而是保存为临时 Markdown 文件，供模型用 `read` 查看。
- 没有匹配结果时返回 `No matching web results.`，属于正常成功。

### web_fetch

请求 `POST https://api.deepseek.com/v1/tools/fetch`。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string，必填 | 最多 8192 字符的 HTTP/HTTPS URL，必须有 host，不能包含用户名或密码 |

**模型可见文本**：

```text
Title: 页面标题

原始 content
```

- 标题折叠为单行；为空时省略。
- 正文超过 **50 KiB 或 2000 行**时，只返回开头片段，并将完整正文保存为临时 Markdown 文件。首行本身超限时会提示只显示了部分内容。
- 限制仅计算正文，不包括标题和提示；未超限时不创建文件。

实际抓取由 DeepSeek 服务端完成，不使用本地浏览器。目标站点的访问策略、可用性或内容类型可能导致抓取失败。

### codemode 结构化结果

通过 codemode 调用时，获得**完整原始 API 响应**：

| 工具 | 结构化结果 |
| --- | --- |
| `web_search` | `{ results: [...] }`，保留每条结果的全部原始字段，包括 `snippet`、`summary` 和 `content` |
| `web_fetch` | `{ title, content }`，正文始终完整 |

示例（需要启用 Pi 的 codemode 工具）：

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

### 临时正文文件

| 来源 | 创建条件 | 系统临时目录下的路径 |
| --- | --- | --- |
| Search | 结果含非空 `content` | `pi-dsweb-search-*/result-N.md` |
| Fetch | 正文超过截断阈值 | `pi-dsweb-fetch-<16位随机十六进制>.md` |

文件保存原始正文，不保存完整 JSON。路径提供给模型；Fetch 的超限警告也在终端展示路径。

取消或执行失败时会清理本次创建的文件；**成功结果的临时文件不会随会话结束自动删除**，不再需要时可手动删除。内容可能敏感，请注意临时目录及会话的访问权限。

## 终端展示

调用行显示搜索词或 URL。搜索结果展示标题、URL 和摘要预览；抓取结果展示标题和正文。

正常结果和错误结果收起时显示前 **5 个视觉行**；有隐藏内容时会显示展开快捷键。工具执行时显示耗时，完成后显示总耗时。

**UI 收起不等于正文截断。** Fetch 展开后仍受正文的 50 KiB／2000 行限制；超限时显示警告和完整正文文件路径，例如：

```text
[Full output: <临时文件路径>. Truncated: showing X of Y lines]
```

完整正文可通过文件路径读取，codemode 原始结果不受影响。

## 配置与凭据

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 无，可选 | 优先使用的 DeepSeek Bearer API Key；未设置时复用 Pi 的 `deepseek` 凭据 |
| `DSWEB_TIMEOUT_MS` | `60000` | HTTP 请求总超时，包含重试和退避；范围 1–600000 ms |
| `DSWEB_MAX_RETRIES` | `2` | 瞬时 HTTP 错误的额外重试次数；范围 0–5 |

每次工具执行时按以下顺序解析凭据：

1. 非空的 `DEEPSEEK_API_KEY` 环境变量。
2. Pi 已配置的 `deepseek` 凭据。
3. 都不可用时，提示设置环境变量或通过 `/login` 配置 DeepSeek。

凭据存储及命令型密钥等解析由 Pi 负责。本扩展不直接读取或修改 `auth.json`，不自动加载 `.env`，不自行长期缓存密钥，也不会借用当前对话模型的密钥。若 DeepSeek 使用其他自定义提供商 ID，请设置 `DEEPSEEK_API_KEY`。

API 域名固定为 `https://api.deepseek.com`，不跟随重定向，避免将密钥发送给其他主机。

## 错误处理与安全

- 仅对 HTTP **408、429、5xx** 自动重试，采用指数退避；支持 `Retry-After` 秒数或 HTTP 日期，单次等待上限 30 秒，总时长仍受超时配置约束。
- 其他 4xx 不自动重试；402 会提示充值。
- 网络异常或响应体读取失败不自动重试，避免结果不明确时重复潜在的计费请求。
- Pi 取消信号会中断请求、退避等待和正文文件写入。
- API 错误消息会隐藏当前密钥和 Bearer token，不回显非 JSON 的代理错误页面。
- 网页内容是不可信外部资料，不是系统指令；工具提示会提醒模型引用来源并忽略网页中的指令注入。

## 计费与限速

本扩展直接调用 DeepSeek Search / Fetch API，不应因为工具只读或某些宿主的服务端工具暂时免费，就假定本扩展免费。

按本项目参考的官方指南，Search / Fetch 各为 **5 元／1000 次成功且产生结果的请求**，不按 token 或结果条数计费；Search 无结果或请求失败不计费。**实际价格及计费条件以官方最新文档和账单为准。**

Search 与 Fetch 按账号分别独立限速，Fetch 还受目标域名限速影响。本扩展没有全局账号级限流器；多个 Pi 实例或其他应用共享账号额度，收到 429 时按上述规则退避重试。具体 QPS 请查看[官方指南](https://api-docs.deepseek.com/zh-cn/guides/search/)。

## 开发

```sh
npm ci
npm run check
npm pack --dry-run
```

`npm run check` 执行 TypeScript 类型检查和离线测试，不访问真实接口或消耗余额。测试覆盖请求与响应校验、凭据解析、重试、取消、临时文件，以及 Pi 实际工具组件中的折叠展开、窄终端和计时行为。

`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 和 `typebox` 声明为 `peerDependencies: "*"`，同时作为开发依赖用于检查与测试；不是运行时 dependencies，不打包进扩展。

### 项目结构

```text
pi-dsweb/
├── index.ts               # 对外加载入口，转导出 src/index.ts
├── src/
│   ├── index.ts           # 注册工具和生命周期处理
│   ├── client.ts          # 参数校验、HTTP、超时、取消、重试
│   ├── schemas.ts         # TypeBox 请求/响应 schema
│   ├── output.ts          # 模型文本、结构化结果、截断和临时文件
│   ├── presentation.ts    # 展示数据、共用 Fetch 布局和文本安全处理
│   ├── renderers.ts       # UI 数据校验、调用行、共用预览和展开结果
│   └── timing.ts          # 实时 Elapsed / 最终 Took 计时和清理
├── tests/                 # 离线测试
├── .env.example
├── package.json
├── package-lock.json
├── tsconfig.json
├── LICENSE
└── README.md
```

### 发布

发布前执行检查和打包预览，再运行 `npm publish`。发布后可以使用 `pi install npm:pi-dsweb` 安装；请先确认 npm 包名及发布状态，本地加载不依赖 npm 发布。

## 官方参考

- [网页搜索与抓取指南](https://api-docs.deepseek.com/zh-cn/guides/search/)
- [Search API](https://api-docs.deepseek.com/zh-cn/api/search)
- [Fetch API](https://api-docs.deepseek.com/zh-cn/api/fetch)

## License

MIT
