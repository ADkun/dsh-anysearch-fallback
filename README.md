# dsh-anysearch-fallback

**给 DSH 的 `web_fetch` 加一条降级兜底：AnySearch 抽不出内容（HTTP 422）时，自动改用浏览器 UA 直抓。**
*Gives DSH's `web_fetch` a fallback: when AnySearch cannot extract a page (HTTP 422), fetch it directly with a browser-like user agent instead of failing the whole call.*

[中文](#中文) · [English](#english)

---

## 中文

### 它解决什么问题

DSH 的 `web_fetch` 走 AnySearch 的 `/v1/extract`。有些页面（`openai.com`、知乎问题页、不存在的路径……）上游会返回 **HTTP 422 `extract_failed`**，于是整次 `web_fetch` 直接报错。本插件在那个位置接一手：先照旧走 AnySearch，**上游一失败就直抓原文兜底**（唯一例外是"取消"），并在正文首行写明上游失败的真实原因。

### 工作机制

```
ctx.web 注册的 provider 链：
  anysearch-fallback (provider id: anysearch-fallback)   ← web_fetch 选中它
        │
        ├─ 代理到官方 AnySearch provider 的 extract
        │     ├─ 成功 → 原样返回（逐字段不变）
        │     ├─ 任何失败（422 / 401 / 402 / 403 / 429 / 超时 / 网络…）→ 进入直抓兜底
        │     │     兜底结果的正文首行写明上游失败原因（状态 + 摘要）
        │     └─ 取消 / abort → 原样抛错，绝不降级（调用方已要求停止）
        │
        └─ 直抓兜底：浏览器 UA + 协议/内网校验 + 5 MB 字节上限 + 15s 超时
              → 返回带标记的纯文本（正文顶部写入降级标记，模型一眼可辨）
```

- 本插件**不修改**官方 `@anysearch/anysearch-dsh` 的任何文件，也不改 DSH 私有字段；它以自己的 id `anysearch-fallback` 注册 provider，内部再按 id 调官方 `anysearch` provider。
- 官方插件升级/重装对本插件**无影响**（若官方改了 provider id，需要同步改 `index.mjs` 里的 `UPSTREAM_PROVIDER_ID`）。
- 兜底失败时，抛出的错误里同时带上「上游原始错误」与「直抓失败原因」+ 一句可行动提示，两侧信息都不吞。

### 关键行为

| 项目 | 取值 |
| --- | --- |
| provider id | `anysearch-fallback`（由本插件的 `- id: web` 覆盖把 `fetchProvider` 指到它；上游仍是官方 `anysearch`） |
| 触发降级 | **任何上游错误**：422 / 401（凭据）/ 402（额度）/ 403 / 429（限流）/ 5xx / 超时 / 网络错误 / 非 JSON 响应，无一例外 |
| 不降级（唯一例外） | **取消 / abort**：调用方的 `signal` 已中止，或错误链上有 `name: AbortError`、`code: ABORT_ERR / WEB_ABORTED / extract_canceled`、消息含 `abort`/`cancel` → 原样抛，不直抓 |
| 协议白名单 | 仅 `http:` / `https:`（`file:` / `data:` / `ftp:` / `blob:` 等拒绝） |
| 内网拒绝 | `localhost` / `*.localhost` / `*.local` / `.internal`；IPv4 `0.0.0.0`、`127/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10`；IPv6 `::1`、`fc00::/7`、`fe80::/10`；IPv4-mapped IPv6（`::ffff:127.0.0.1`） |
| 字节上限 | 5 MB，流式读取（`response.body`），超限立即 `cancel()` |
| 字符上限 | 与 DSH 工具侧一致（`DEFAULT_FETCH_MAX_OUTPUT_CHARS`），超出裁剪并置 `truncated: true` |
| 超时 | 自带 15s，串联上游 `signal`，任一触发即中止并说明来源 |
| 请求头 | 固定桌面 Chrome UA + `accept` + `accept-language`；**不带** Authorization / Cookie / Referer |
| 重定向 | `redirect: 'manual'`，最多 3 跳，**每一跳都重做协议与内网校验** |
| 磁盘缓存 | 无 |

### 降级标记（永远在返回正文的第一行）

标记会写明**上游失败的真实原因**（状态 + 截断到 240 字符的摘要）和**直抓实际拿到的状态**；正文为空时说清"没有正文"，免得"只有一行标记"被读成"这页面是空的"。

| 情形 | 第一行 |
| --- | --- |
| 上游 422，直抓 2xx 有正文 | `[anysearch-fallback] 上游抽取失败（HTTP 422）：AnySearch extract failed: … (HTTP 422, auth credential)；直抓成功（HTTP 200），以下为未经 AnySearch 清洗的直抓原文。` |
| 上游 429，直抓 2xx 有正文 | `[anysearch-fallback] 上游错误（HTTP 429 rate limit）：AnySearch extract failed: "too many requests"；直抓成功（HTTP 200），以下为未经 AnySearch 清洗的直抓原文。` |
| 直抓非 2xx，有正文 | `[anysearch-fallback] 上游错误（HTTP 429 rate limit）：…；直抓返回 HTTP 403（站点可能拒绝匿名访问），以下为站点返回的原始内容，未经 AnySearch 清洗。` |
| 直抓非 2xx，正文为空 | `[anysearch-fallback] 上游错误（HTTP 429 rate limit）：…；直抓返回 HTTP 403 且站点未返回任何正文内容（该页可能需要登录或被反爬拦截，建议换来源）。` |
| 直抓 2xx，正文为空 | `[anysearch-fallback] 上游错误（HTTP 500）：…；直抓成功（HTTP 200）但站点未返回任何正文内容（可能是空页或正文由脚本渲染，建议换来源）。` |

- 状态取上游错误里真实的 `httpStatus`；命中"抽取失败"那三种精确形状（`httpStatus === 422` / `errorCode` 字段值 `extract_failed` / 那句 `Unable to extract content from the URL.`）时措辞为**上游抽取失败**，否则为**上游错误**（并在拿得到时附上 `rate limit` / `auth credential` 这类标签）。
- 摘要**压平空白并截断**到 240 字符（`MAX_MARKER_UPSTREAM_CHARS`），标记行因此永远是一眼能读完的一行，不是日志。
- 每次降级还会记一条 `warn` 日志（含上游原因与直抓结果）。

### 安装

作为本地插件挂进某个 DSH profile：

```bash
# 1) 把本目录放到 <DSH_HOME>/plugins/dsh-anysearch-fallback/
# 2) 在 profile 的 package.json 里加依赖（相对路径写法）
#    "dsh-anysearch-fallback": "file:C:/Users/you/.dsh/plugins/dsh-anysearch-fallback"
# 3) 把它追加到 profile 的 dsh.profile.bundles 末尾
#    （放最后 = 它的 `- id: web` 覆盖在官方 anysearch 之后生效）
# 4) 在 profile 的 node_modules 下建同名入口（本机既有形状：真目录 + 硬链接）
# 5) 重启 DSH —— 新开一个对话不够，profile 的配置树是启动时组合的
```

本插件的 `cordis.patch.yml` 会 `insert` 自己的 bundle（id `dsh-anysearch-fallback`），并把 web 服务的 `fetchProvider` 覆盖为 `anysearch-fallback`（`searchProvider` 必须一起原样写上——patch 对 `config` 是整体替换、不深合并）。具体层内覆盖请按你的 profile 现状调整。

### 测试

```bash
npm test            # 离线单测：63 通过 / 1 跳过（联网用例默认跳过）
```

`test/integration.test.mjs` 是**联网实测**用例（真实 422 → 真实直抓）：它需要 `@anysearch/anysearch-dsh` 及其 peer 包可被解析。仓库内默认跳过；在本机已装好的环境里可按该文件头部的注释搭一个临时 staging 目录（`node_modules` 里为 `@deepseek-ai/*` 建 junction）后运行。

### 已知边界 / 未做

- **DNS rebinding 只防一半**：除字面 IP / 主机名判定外，会在 DNS 解析后再核一遍解析到的 IP（任一解析结果非公网即拒）；但**没有地址钉扎** —— 校验用的解析结果与真正建连之间有时间差（TOCTOU），极端的 rebinding 仍可能穿过。
  *(对比：`dsh-web` 自带的 `dsh-web-fetch-http` 用 `ipaddr.js` + undici pinned agent 做了完整钉扎；本插件刻意零依赖，故未复刻。)*
- **带 userinfo 的 URL 会被拒绝**：`http://user:pw@example.com/`（只给用户名也算）一律以 `WEB_BLOCKED_URL` 拒掉，错误消息里点名 userinfo；**不做静默剥离** —— 用户显式给了带凭证的 URL 就明确报错，比悄悄改写更可预测。
- **保守拒绝**：`168.63/16`、`198.18/15`、`192.0.0/24` 等非公网段被判为内网并拒绝，宁可误拒。
- **提取质量**：朴素 HTML 降噪（去 script/style、取标题、解实体、折叠空白），质量低于 AnySearch 的正文清洗；结果顶部有降级标记，便于人工/模型识别。
- **系统性问题现在也会降级（这是宽兜底的代价）**：上游 401（凭据失效）、402（额度耗尽）、429（限流）这类问题**不再整次报错**，而是静默降级为直抓结果 —— 直抓往往仍能成功，于是"接口已经不可用了，但抓取照常返回"。要判断集成是否正常，看**正文首行的标记**（里面写明上游错误，例如 `上游错误（HTTP 429 rate limit）：…`）与日志里的 `warn` 行。
- **不做重试**：无论上游还是直抓都不重试。
- **不改超时预算**：`web_fetch` 工具预算 30 s 由 DSH 工具层硬编码，本插件不碰；兜底直抓自带 15 s，若上游已耗尽大部分预算，兜底可能来不及完成。
- **非 2xx 不假装成功**：直抓拿到 4xx/5xx 时按真实状态码返回（并保留正文）。
- **反爬限制**：目标站可能对匿名直抓返回 403 或直接给反爬页（例：`openai.com` 返回 403 且正文为空；知乎问题页返回 403 + 一句反爬文案）。此时降级正文可能为空或根本不是真正文 —— 标记行会把这种情况说清楚（含"站点未返回任何正文内容"），但拿不到内容就是拿不到，建议换来源。
- **改完必须重启 DSH**：已启动的 DSH 进程加载的是启动时的代码；升级或改动本插件（包括只改了降级标记文案）后，**必须重启 DSH**（新开一个对话不够）新代码才生效。

### License

MIT

---

## English

**Problem.** `web_fetch` goes through AnySearch `/v1/extract`; for some pages the upstream answers **HTTP 422 `extract_failed`** and the whole fetch call fails. This plugin registers its own `anysearch-fallback` fetch provider, points the web service at it, delegates to the official `anysearch` provider first, and degrades to a guarded direct fetch on **any** upstream failure — the only exception is cancellation.

**Guarantees.**

- Success path unchanged, field for field.
- Cancellation (`signal` aborted, `AbortError`, `ABORT_ERR` / `WEB_ABORTED` / `extract_canceled`, abort/cancel wording) is never degraded: the original error surfaces untouched and no new request is sent.
- Any other upstream failure (401/402/403/429/timeouts/network) degrades, and the reason is written into the first line of the returned body plus a `warn` log line — never silently swallowed.
- Only `http:`/`https:`; localhost, private, link-local, CGNAT and IPv4-mapped IPv6 targets are refused.
- A URL carrying userinfo (`user:pw@host`) is refused as `WEB_BLOCKED_URL` and named as such — never silently stripped.
- Hard 5 MB byte cap read as a stream (`response.body`), never `response.text()`; character cap matches DSH's tool layer.
- 15 s own timeout chained to the upstream abort signal.
- Fixed desktop Chrome UA plus `accept`/`accept-language`; no Authorization, Cookie, Referer; no TLS bypass; no disk cache.
- Manual redirects, at most 3 hops, re-validated at every hop.
- Fallback output carries a visible marker line naming both real statuses, so a degraded result is never mistaken for cleaned text and an empty body is never mistaken for an empty page.

**Not done.** No address pinning after resolution (one re-check, then a separate connect — TOCTOU remains), no retry, no timeout-budget change, naive HTML reduction (lower quality than AnySearch extraction). Anti-bot sites may answer 403 with an empty body or a challenge page: the marker says so, but there is no content to return — change the source instead.

**Cost of the broad fallback.** Systemic upstream problems (401 credentials, 402 quota, 429 rate limit) now degrade instead of failing the call, so a broken integration can still return pages. Watch the marker line (it names the upstream error) and the `warn` log line.

**Restart required.** A running DSH process keeps the code it booted with; restart DSH after changing this plugin (a new chat is not enough).

**Test.** `npm test` — 63 passed / 1 skipped offline. The network integration test is skipped unless the installed official bundle and its peer packages are resolvable.

**License.** MIT