# dsh-switch

[English](#english) | [中文](#中文)

<a id="english"></a>

## English

A DeepSeek Harness (DSH) plugin that bridges [cc-switch](https://github.com/farion1231/cc-switch):

- **Live sync — no apply clicks** — the plugin watches the cc-switch database files and mirrors every usable provider into the DSH `llm-pi-ai` settings namespace the moment you hit save in cc-switch (a slow signature poll remains as a safety net). Whatever you configure or switch to in cc-switch is usable in DSH within a second; provider keys are stored in the DSH credentials service (settings only reference their names, values never land in settings.yaml). The sync is self-healing: externally lost or edited `ccs-*` entries are restored automatically. When you switch the current provider in cc-switch, the DSH `agent-default-model` follows.
- **All provider kinds** — Claude (→ `anthropic-messages`), Codex/GPT with API-key auth (→ `openai-responses` / `openai-completions` via `wire_api`), Gemini-shaped OpenAI-compatible relays (→ `openai-completions`), and DSH-shaped OpenClaw configs. OAuth-login providers (ChatGPT/Gemini official) and native-Gemini endpoints cannot be expressed as DSH routes and are listed as skipped with a reason.
- **Models appear the moment cc-switch saves** — a sync that changes providers or models announces the change on DSH's own event bus (`llm/adapters-updated`), and the plugin's settings card + composer badge also re-read on DSH's forwarded `settings/document-updated` / `llm/adapters-updated` events. So a provider added, renamed, or given new models in cc-switch is visible in the DSH model picker and in this plugin's surfaces within about a second — no restart, no reopening the settings tab, no waiting for a poll tick. Each provider row additionally reports whether DSH already serves it (`live in DSH` / `awaiting DSH`) and how many of its models DSH lists, so a half-applied state is visible rather than silent.
- **Usage badge while using a model** — when the model in use belongs to a provider that has a usage query configured in cc-switch, a small badge next to the session composer's model selector shows that provider's quota/balance live: plan windows for `token_plan` (Volcano Ark, MiniMax — CN/Intl detected from the base URL) or remaining balance for the built-in `balance` template (DeepSeek, StepFun, SiliconFlow CN/EN, OpenRouter, Novita AI — detected from the base URL, mirroring cc-switch's own balance service) and for `general`/`newapi` scripts (executed in a sandboxed `node:vm` with request/extractor from the cc-switch script, placeholder substitution for `{{baseUrl}}`/`{{apiKey}}`/`{{accessToken}}`/`{{userId}}`). Results are cached per route honoring the script's auto-query interval; error messages are scrubbed of every credential the row contributed. The badge follows **the session's own model**: it subscribes to the client's model-selection store, so picking a different model in the composer swaps the usage immediately (the last answer per provider is cached client-side, so flipping back and forth paints instantly). No badge is shown for providers without a usage query. Additionally, the plugin's settings card shows a usage line for **every** provider whose usage query is enabled in cc-switch (not just the one in use) — plan windows or remaining balance, with a per-line refresh button.

### Install

```bash
# from a clone / local checkout
dsh plugin --profile desktop add link:/path/to/dsh-switch

# or straight from this repository (pnpm builds it on install)
dsh plugin --profile desktop add git+ssh://git@github.com/a981008/dsh-switch.git
```

(or add `"dsh-switch": "link:/path/to/dsh-switch"` to the profile `package.json` dependencies + `dsh.profile.bundles`, then `pnpm install`.)

`lib/` (the built host + client bundles) is committed and the package declares no `prepare` script, so a git install needs no build step and pnpm never asks you to approve a build script. To rebuild after editing `src/`:

```bash
node build.mjs && node test/run.mjs   # run.mjs typechecks first, then runs smoke + integration
```

Restart DSH Desktop afterwards so the next generation composes the new bundle.

### Uninstall / recovery

```bash
dsh plugin --profile desktop remove dsh-switch
```

Removing the plugin leaves the synced `ccs-*` provider entries in your DSH settings; delete them by hand if unwanted. If DSH Desktop fails to start after installing, remove `dsh-switch` from both `dependencies` and `dsh.profile.bundles` in `~/.dsh/profiles/desktop/package.json`, then relaunch.

### Requirements

- cc-switch installed locally (`~/.cc-switch/cc-switch.db`)
- Syncable providers need an API key in cc-switch: OAuth/subscription logins (ChatGPT, Gemini official) cannot authenticate DSH routes

### Privacy

The database is opened **read-only**. Key values are never sent to the browser — the UI only shows the last 4 characters. Volcano AK/SK and every other usage-query credential are read from cc-switch's own `usage_script` config host-side only, never echoed (upstream error messages have the credentials scrubbed); nothing lands in settings.yaml.

---

<a id="中文"></a>

## 中文

一个打通 [cc-switch](https://github.com/farion1231/cc-switch) 的 DeepSeek Harness（DSH）插件：

- **实时同步，无需手动应用** — 插件通过文件监听（fs.watch）监视 cc-switch 数据库：在 cc-switch 里保存供应商的瞬间即触发同步，把所有可用供应商镜像到 DSH 的 `llm-pi-ai` 设置命名空间（另有一个慢速签名轮询作为兜底）。保存后约一秒内 DSH 即可使用；API key 存入 DSH 凭据服务（配置只引用名称，明文不落 settings.yaml）。同步是自愈式的：外部丢失或被改动的 `ccs-*` 条目会自动恢复。在 cc-switch 中切换「当前供应商」时，DSH 的 `agent-default-model` 自动跟随。
- **全类型支持** — Claude（→ `anthropic-messages`）、API key 方式的 Codex/GPT（→ 按 `wire_api` 映射 `openai-responses` / `openai-completions`）、Gemini 形状的 OpenAI 兼容中转（→ `openai-completions`）、以及本身就是 DSH 形状的 OpenClaw 配置。OAuth 登录类供应商（ChatGPT / Gemini 官方）与 Gemini 原生端点无法表达为 DSH 路由，会在列表中标出跳过原因。
- **cc-switch 一保存，模型立刻可用** —— 同步改动了供应商或模型后，插件会在 DSH 自己的事件总线上广播 `llm/adapters-updated`，同时设置卡片与输入栏徽章也会在 DSH 转发的 `settings/document-updated` / `llm/adapters-updated` 事件上重新读取。因此在 cc-switch 中新增、改名或改了模型列表的供应商，约一秒内就会出现在 DSH 模型选择器和本插件的界面上 —— 无需重启、无需重新打开设置页、无需等轮询。每个供应商行还会显示 DSH 是否已经提供该路由（`已在 DSH 生效` / `待 DSH 注册`）以及 DSH 已加载的模型数量，半生效状态一眼可见。
- **使用模型时显示用量** — 当正在使用的模型属于配置了「用量查询」的供应商时，会话输入栏模型选择器旁会出现一个小徽章，实时显示该供应商的套餐/余额：`token_plan`（火山方舟、MiniMax —— 按 base_url 自动区分国内/国际站）显示套餐窗口，内置 `balance` 模板（DeepSeek、StepFun、SiliconFlow 国内/国际、OpenRouter、Novita AI —— 按 base_url 自动识别，与 cc-switch 自带余额服务一致）和 `general`/`newapi` 脚本显示剩余余额（脚本在 `node:vm` 沙箱中执行 request/extractor，自动替换 `{{baseUrl}}`/`{{apiKey}}`/`{{accessToken}}`/`{{userId}}` 占位符）。结果按路由缓存（遵循脚本配置的自动查询间隔）；错误信息中的所有凭据都会被脱敏。徽章跟随**会话自己的模型**：它订阅客户端的模型选择状态，在输入栏切换模型的瞬间即换成该供应商的用量（每个供应商的上次结果在客户端缓存，来回切换零等待）。未配置用量查询的供应商不显示徽章。此外，插件设置卡片会为**每一个**启用了用量查询的供应商显示一行用量（不限于正在使用的那个）—— 套餐窗口或剩余余额，每行带独立刷新按钮。

### 安装

```bash
# 本地目录
dsh plugin --profile desktop add link:/path/to/dsh-switch

# 或直接从本仓库安装（安装时由 pnpm 构建）
dsh plugin --profile desktop add git+ssh://git@github.com:a981008/dsh-switch.git
```

（或手动在 profile 的 `package.json` 依赖中加入 `"dsh-switch": "link:/path/to/dsh-switch"` 并加入 `dsh.profile.bundles`，然后 `pnpm install`。）

`lib/`（构建后的宿主端与客户端 bundle）已提交入库，且包内没有 `prepare` 脚本 —— 从 git 安装无需额外构建，pnpm 也不会要求你审批构建脚本。修改 `src/` 后重新构建：

```bash
node build.mjs && node test/run.mjs
```

安装后需重启 DSH Desktop，下一个 generation 才会组合新 bundle。

### 卸载 / 恢复

```bash
dsh plugin --profile desktop remove dsh-switch
```

卸载插件不会删除已同步到 DSH 设置里的 `ccs-*` 供应商条目；不需要的话请手动删除。如果安装后 DSH Desktop 无法启动：从 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 中移除 `dsh-switch`，再重新启动即可。

### 要求

- 本机已安装 cc-switch（`~/.cc-switch/cc-switch.db`）
- 可同步的供应商需要在 cc-switch 里配置了 API key；OAuth/订阅登录（ChatGPT、Gemini 官方）无法为 DSH 路由鉴权

### 隐私

数据库以**只读**方式打开。密钥值不会发送到浏览器 —— 界面只显示末 4 位。火山 AK/SK 及其他用量查询凭据一律自动读取 cc-switch 自带的「用量查询」配置，只在宿主侧使用，绝不下发（上游报错信息中的凭据也会被脱敏），绝不写入 settings.yaml。

### 开发

```bash
pnpm install
pnpm build        # 产出 lib/index.js（宿主）+ lib/client.js（浏览器，__ModuleLoader__ 包装）
pnpm watch        # watch 模式
pnpm typecheck    # tsc --noEmit：esbuild 只剥离类型不做检查，这一步能拦住接口形状写错
pnpm test         # 先类型检查，再跑 smoke（多类型解析/同步引擎/签名）+ integration（mock ctx 驱动全部路由与自动同步循环）
```

可选：设置 `DSH_SWITCH_TEST_AK`/`DSH_SWITCH_TEST_SK` 环境变量可让 smoke 测试额外跑一次真实的火山方舟额度查询。

### 设置

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关；关闭后同步暂停、路由返回 disabled |
| `dbPath` | cc-switch 数据库路径覆盖（默认 `~/.cc-switch/cc-switch.db`） |
| `syncInterval` | 兜底轮询间隔（秒，1–3600，默认 30）；保存 cc-switch 会通过文件监听立即触发同步，此间隔仅覆盖监听可能遗漏的事件 |

## License

MIT
