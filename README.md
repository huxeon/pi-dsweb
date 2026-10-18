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
pi install D:/workspaces/pi-dsweb

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

`@earendil-works/pi-coding-agent` 和 `typebox` 都声明为 `peerDependencies: "*"`，同时作为开发依赖用于检查与测试；它们**不是运行时 dependencies，也不会打包进扩展**。

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

工具正文展示标题、URL、站点、时间、排名分、权威分、长摘要（缺失时使用短摘要）和可选正文。结构化响应保留官方全部字段，包括 `snippet`、`summary`、`site_icon` 等。没有匹配结果是正常成功，不是错误。

### web_fetch

请求 `POST https://api.deepseek.com/v1/tools/fetch`。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string，必填 | 最多 8192 字符的 HTTP/HTTPS URL，必须有 host，不能包含用户名或密码 |

返回页面标题和 Markdown 正文。实际抓取在 DeepSeek 服务端进行，不是本地浏览器；目标站点的策略或内容类型可能导致无法抓取。

### 结构化输出与大结果

两个工具都声明了 `outputSchema`，可由 Pi 的 codemode 调用。正常结果的结构为：

```typescript
{
  preview: string;          // 与模型可见正文相同
  truncated: false;
  response: {
    results: Array<...>;   // search：官方完整 JSON
  } | {
    title: string;         // fetch：官方完整 JSON
    content: string;
  };
}
```

当正文超出约 **48 KiB 或 1900 行**，或原始 JSON 超过相同阈值时：

- 模型和 codemode 只收到有界的 `preview`、`truncated: true` 和 `fullOutputPath`。
- `response` 被省略，避免通过结构化返回值或 `details` 绕过截断。
- 完整 API JSON 保存在系统临时目录 `pi-dsweb-*/response.json`，可使用 `read` 分段读取。
- 临时文件不会随会话结束自动删除，以便稍后读取；不再需要时可手动删除。内容可能敏感，请注意临时目录与会话的访问权限。

codemode 示例（需要先启用 Pi 的 codemode 工具）：

```javascript
const r = await tools.web_search({
  query: "DeepSeek site:github.com",
  count: 3,
});
if (r.truncated) {
  text({ preview: r.preview, fullOutputPath: r.fullOutputPath });
} else {
  text(r.response.results.map(item => ({
    title: item.title,
    url: item.url,
    summary: item.summary,
  })));
}
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
- **结果封装**：`preview`、`response`、`truncated`、`fullOutputPath` 是扩展输出层；不是官方响应字段。响应较小时 `response` 保存官方 JSON，较大时改为完整 JSON 文件。
- **重试与安全**：官方建议 408 / 429 / 5xx 后等待重试；默认额外重试 2 次、指数退避、`Retry-After` 支持、等待上限、总请求超时、拒绝重定向和凭据复用，均为本扩展策略。网络或响应体读取异常不自动重试。

Pi 工具定义包含 `description`、`promptSnippet`、`promptGuidelines`、输入/输出 schema、`structuredContent` 和 `details`；扩展工厂不发网络请求，也不启动后台任务。

## 计费与限速

按照本项目所参考的官方指南，Search / Fetch 各为 **5 元 / 1000 次成功且产生结果的请求**；不是 token 计费，也不随 `count` 改变。Search 无结果或请求失败不计费。价格以官方最新文档为准。

官方指南还单独说明了 DeepSeek Harness / Claude Code / Codex 的 **Server 端工具调用**暂未计费，并将于北京时间 **2026-11-01 00:00** 开始收费。这不是对所有直接 API 请求的免费承诺；本扩展直接调用 Search / Fetch，不能据此假定免费，实际以官方规则和账单为准。

Search 与 Fetch 分别按账号限速 **5 QPS**，Fetch 还受目标域名限速影响。本扩展没有全局账号级限流器；并发调用、其他 Pi 实例或其他应用共享账号额度，遇到 429 时按上述规则退避重试。请不要把“只读”误解为免费调用。

## 项目结构

```text
pi-dsweb/
├── package.json           # pi-package 关键字、pi.extensions manifest、宿主 peerDependencies
├── extensions/
│   └── index.ts           # 默认导出的 Pi 扩展工厂，注册两个工具
├── src/
│   ├── client.ts          # 参数校验、HTTP、超时、取消、重试
│   ├── schemas.ts         # TypeBox 请求/响应 schema
│   └── output.ts          # 格式化、截断和临时文件
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

- [网页搜索与抓取指南](https://api-docs.deepseek.com/zh-cn/guides/search)
- [Search API](https://api-docs.deepseek.com/zh-cn/api/search)
- [Fetch API](https://api-docs.deepseek.com/zh-cn/api/fetch)

## License

MIT
