# ChatGPT Computer-Use 设计逆向分析

> 状态：**v0.1 初稿**（2026-10-19，供 DSH 复刻设计评审）
> 分析对象：① ChatGPT 网页/PWA Agent 模式（公开文档 + 安装包/缓存）② OpenAI 官方 ChatGPT 浏览器扩展 1.26.1006.11559（浏览器版 computer-use 参考实现）
> 方法：只读本地证据（扩展源码、PWA 包、Edge/Chrome 缓存）+ 在线文档抓取。所有结论标注 **[observed]/[inferred]/[unknown]** 并给证据编号（见 §1）。
> 写作约束：本报告只写 `computer-use-rebuild/` 下的文件；未改 `~/.dsh`、未安装依赖。

---

## 0. 摘要（评审可直接用）

1. **OpenAI 官方浏览器 computer-use 是"两层"设计**：模型面是一个 **JS REPL 工具**（扩展内 MCP server `node-repl-work`，工具仅 `js` + `turn_ended`），模型写 JavaScript 调 `tab.cua` / `tab.ax` / `tab.playwright` 等能力对象；底层是扩展经 `chrome.debugger`（CDP）+ Playwright 风格命令执行的浏览器控制协议。**[observed]**
2. **动作有两套坐标体系**：`tab.cua.*` 用 **像素坐标 x/y**（click/scroll/double_click/type/keypress/drag/move/downloadMedia，与 OpenAI computer-use API 的 action 命名高度一致）；`tab.ax.*` 用 **a11y 元素索引 element_index**（click/paste/pressKey/scroll/selectText/setValue/typeText/performSecondaryAction/drag）。**[observed]**
3. **观察既返回无障碍文本，也可返回截图**：`tab.ax.get("state"|"screenshot"|"both")`，底层命令 `tab_ax_get_state{content:axState|screenshot|axStateAndScreenshot, disable_diffing}`，返回 `{state:string, data:base64, screenshot_unavailable:string}`。截图不可用时可降级为纯 state。**[observed]**
4. **无障碍快照不是原始树**：`browser-accessibility.wasm.br` 负责把快照 JSON 渲染成**紧凑文本**（revision text），并给每个元素**稳定 identity**、判断**值是否可写（is_value_settable）**，支持基于上一 revision 的 **diff**（`disable_diffing`、mode `auto|full`）。**[observed]**（渲染规则本身 **[unknown]**）
5. **观察-动作循环没有强制"每步截图"**：由模型在 state/screenshot/both 间选择；a11y 动作以 `element_index` 定位，像素动作以 x/y 定位；命令通道异步，失败以错误抛回 JS，无扩展层自动重试/验证。**[observed]**；ChatGPT Agent 端到端编排策略 **[unknown]**
6. **安全模型是"每浏览器首启同意 + 每资源（origin/download/upload/full_cdp）策略 + 审批模式 + auto review + 持久审批"**，并有**凭证投递期间的观察封锁**和**人工接管（manual handoff）**；企业策略可统一开关 browser/computer use。**[observed]**（auto review 的判定逻辑 **[unknown]**）
7. **坐标单位（扩展）**：`tab.cua` 的 x/y 作用于页面 viewport/CSS 像素（可与 scrollX/scrollY、crop 截图对应），非屏幕绝对坐标；DPR 处理 **[unknown]**。**[inferred]**
8. **PWA 只是壳**：Appx 包无业务 JS，仅 `AppxManifest.xml`（start-url `https://chatgpt.com/?openaicom_referred=true`、app-id、profile-directory `Default`）。**[observed]**
9. **缓存线索是误报（重要更正）**：`Cache_Data/data_1`、`data_3` **不含任何 chatgpt.com 内容**（`chatgpt`/`oaistatic`/`openai.com` 均 0 命中）；其中 `computer-use` 字样来自 GitHub 搜索结果与仓库页面（含 `Anionex/dsh-computer-use` 的 fixture PNG 跳转）。因此 **无法从缓存还原 chatgpt.com 的 computer_use JS**。**[observed，负结果]**
10. **在线文档抓取失败**：`learn.chatgpt.com/docs/computer-use`、`developers.openai.com/training/walkthroughs/using-your-computer-and-browser`、`developers.openai.com/api/docs/guides/agents-api/tools/computer-use` 均返回 fetch failed / HTTP 403；仅通过搜索确认文档存在。**ChatGPT Agent 模式模型侧工具 schema 细节标 [unknown]，本报告不转述记忆内容。** **[observed，抓取状态]**

---

## 1. 证据清单与置信度

置信度定义：
- **[observed]**：本地文件直接读到（含引文/行号/偏移），或命令输出直接证明。
- **[inferred]**：由 observed 事实 + 常规工程语义推导，未直接看到消费者/运行时。
- **[unknown]**：本轮未取得证据，或在线文档不可达；不做脑补。

| 编号 | 证据 | 路径 / 位置 | 要点 |
|---|---|---|---|
| E1 | 扩展 manifest | `C:\Users\b1778\AppData\Local\Microsoft\Edge\User Data\Default\Extensions\odlomjlbamekndcpllcnffbgeohgkmjh\1.26.1006.11559_0\manifest.json` | name `ChatGPT`，description `Control your browser with ChatGPT.`；权限含 `debugger`、`scripting`、`tabs`、`nativeMessaging`、`webNavigation`、`downloads`、`history`、`bookmarks`、`tabGroups`、`sessions`、`sidePanel`；`sandbox.pages: ["js-kernel.html"]` |
| E2 | 扩展 MCP server | `background.js` @172996（minified，单行 430014B） | `serverInfo` + `registerMethod("tools/list")` + `registerMethod("tools/call")`；`name:"node-repl-work", version:"0.0.1"` @186132 |
| E3 | 模型面工具 | `background.js` @186132/@186444 | `registerTool("js", {description:"Execute JavaScript in the selected browser instance.", inputSchema:{code, instance_id}})`；`registerTool("turn_ended", {description:"Release browser control after a completed turn."})` |
| E4 | 动作 schema（union） | `background.js` @260096/@260213 | `ao("kind",[...])`：`paste` `click` `drag` `perform_secondary_action` `press_key` `scroll` `select_text` `set_value` `type_text` |
| E5 | 观察 schema | `background.js` @260096 | `tab_ax_get_state`：`{content: axState\|screenshot\|axStateAndScreenshot, disable_diffing?, browser_id, tab_id}` → `{state?, data?, screenshot_unavailable?}`；`tab_screenshot`：`{fullPage?, cropX?, cropY?, cropWidth?, cropHeight?}` → `{data}` |
| E6 | 像素动作 SDK | `chunks/js-kernel-Ja-7IJxY.js` L5559-5646 | `cua.click{x,y,button,keypress}`、`scroll{x,y,scrollX,scrollY,keypress}`、`double_click`、`type{text}`、`keypress{keys[]}`、`drag{path[{x,y}],keys}`、`move`、`downloadMedia` |
| E7 | a11y SDK | `chunks/js-kernel-Ja-7IJxY.js` L5647-5780 | `ax.get("state"\|"screenshot"\|"both")`、`ax.write(...)`（display 给用户）、`ax.click(target)`、`drag`、`paste`、`performSecondaryAction`、`pressKey`、`scroll`、`selectText`、`setValue`、`typeText` |
| E8 | Tab 能力对象 | `chunks/js-kernel-Ja-7IJxY.js` L6569-6619 | `tab.playwright`/`tab.dom_cua`/`tab.cua`/`tab.ax`/`tab.content`/`tab.clipboard`/`tab.dev`/`tab.capabilities`/`tab.goto`/`tab.markHandoff` |
| E9 | 文档服务端化 | `chunks/js-kernel-Ja-7IJxY.js` L2909-2919, L5901-5913 | `get_documentation` / `get_browser_documentation`；能力对象 `documentation()` = `documentationApi.get("capabilities/browser/<id>")` / `"capabilities/tab/<id>"` |
| E10 | a11y wasm 接口 | `chunks/browser-accessibility-X0H1iF3d.js`（6.8KB，单行） | 导出：`computer_use_browser_wasm_revision_create/release/text_length/copy_text/identity_length/copy_identity/is_value_settable`；`buildRevision(snapshotJSON, {mode:"auto"\|"full"})`；`FinalizationRegistry` 释放 revision |
| E11 | 首启控制同意 | `background.js` @189341-190143 | `browserUseControlAllowed`（chrome.storage.sync）；`createElicitation` 文案 “ChatGPT can read your open tabs and take actions in them…”，tool_name `allow_browser_control`，connector `browser-use`；`requestMeta["openai/browser_context"].browser_control_consent` challenge 机制 |
| E12 | 企业策略 | `background.js` @159552 | `allow_browser_and_computer_use`；`browser_use{allow_webmcp, allow_history_access, disable_auto_review, allow_global_persistent_approval, default_origin_policy, origins{access,downloads,uploads,full_cdp_access,auto_review,persistent_approval,access_approval_lifetime}}` |
| E13 | 每资源策略/审批模式 | `chunks/js-kernel-host-BlQQhdU0.js`（minified，单行 1.2MB） | 默认 `approval_mode:"always_ask"`、`history_approval_mode:"always_ask"`、`iab_history_approval_mode:"always_ask"`、`download_approval_mode/upload_approval_mode:"always_ask"`、`disable_auto_review:false`、`full_cdp_access_enabled:false`、`webmcp_enabled:true`；资源规则 `origins/downloads/uploads/full_cdp` 的 `allowed/denied` 列表 |
| E14 | 审批决策来源/类型 | `chunks/js-kernel-host-BlQQhdU0.js` | 决策来源：`guardian-auto-review`、`guardian-origin-cache`、`user_decision`、`browser-use-turn-cache`、`browser-use-persisted-state`、`codex-history-policy`、`codex-network-policy`、`navigation-url-policy`、`site-status`、`security-mode`、`config`；授权类型：`browser_auth`、`browser_history`、`browser_origin_access`、`file_download`、`file_upload`、`full_cdp_access`、`webmcp_access` 等 |
| E15 | 凭证保护/接管 | `chunks/js-kernel-host-BlQQhdU0.js` | `CredentialObservationError` 原因：`credential_delivery_in_progress`、`credential_observation_restricted`、`retained_data_restricted`、`credential_state_unavailable`、`protected_command_failed`；文案提到 `Tab.requestManualHandoff()` 人工接管；`tab_manual_handoff_request`、`mark_tab(status: handoff\|deliverable)` |
| E16 | 浏览器命令面（部分） | `chunks/js-kernel-host-BlQQhdU0.js` | `cua_click/cua_double_click/cua_drag/cua_keypress/cua_move/cua_scroll/cua_type`、`dom_cua_*`、`tab_ax_action`、`tab_ax_get_state`、`tab_screenshot`、`tab_handle_js_dialog`、`playwright_*`、`create_tab`、`tab_manual_handoff_request`、`get_documentation` 等 |
| E17 | 自身页面保护 | `chunks/js-kernel-host-BlQQhdU0.js` | `assertBrowserUrlAllowed`：`["chatgpt.com","chat.com"]` 及子域被拒，错误 “The standalone Chrome extension cannot access ChatGPT pages.” |
| E18 | 缓存负结果 | `...\Edge\User Data\Default\Cache\Cache_Data\data_0..3`（复制后扫描） | `chatgpt` 0、`oaistatic` 0、`openai.com` 0 命中；`computer-use` 命中 40 处均为 GitHub/Bing/Bilibili 内容 |
| E19 | PWA 壳 | `C:\Program Files\WindowsApps\chatgpt.com-FB022A08_1.0.0.0_neutral__ch69rtgtz055j\AppxManifest.xml` | `start-url https://chatgpt.com/?openaicom_referred=true`、`app-id=ojpfomfldajadfjnijlokinjpampjimk`、`profile-directory Default`、HostRuntime=Edge Stable；包内仅 AppxManifest/Images/resources.pri，无 `.js` |
| E20 | DSH 现状 | `C:\Users\b1778\.dsh\skills\computer-use\SKILL.md`；`C:\Users\b1778\.dsh\plugins\dsh-computer-use-virtual-cursor\package.json` | 后端 `dsh-computer-use 0.3.2`（Cua Driver）；12 工具 `screen_observe/screen_zoom/computer_click/computer_double_click/computer_right_click/computer_type/computer_key/computer_scroll/computer_drag/computer_wait/app_list/app_launch`；ax/native/vision 三模式；30s 观察过期；虚拟光标；危险词审批、密码框保护 |

> 说明：`background.js` / `js-kernel-host-BlQQhdU0.js` 为单行压缩文件，引用用**字节偏移 @offset**（可用 §12 的脚本复现）；`js-kernel-Ja-7IJxY.js` 是已格式化的 7547 行文件，引用行号。

---

## 2. 本地缓存调查（负结果，务必先看）

任务提示：Edge 缓存 `data_1` / `data_3` 中 grep 到 `computer_use` / `computer-use`。实测**不成立**：

1. 把 4 个 block 文件以 `FileShare.ReadWrite` 复制到 `computer-use-rebuild/.scratch/cache/`（Edge 运行中直接 `open()` 会 `PermissionError`）。
2. 对 `data_0..3` 全量字节扫描：
   - `chatgpt` = 0，`oaistatic` = 0，`openai.com` = 0，`cdn.oaistatic` = 0；
   - `computer_use` = 0，`computer-use` = 40（data_1 38 + data_3 2）。
3. 命中上下文全部是**用户浏览过的 GitHub / Bing / Bilibili 页面**，例如：
   - `data_1 @3018158`：`...github.com/injaneity/pi-computer-use/funding_links...`、`...github.com/agent-sh/computer-use-linux...`、`...github.com/domdomegg/computer-use-mcp...`
   - `data_3 @35840293`：GitHub 302 响应头 `location:https://raw.githubusercontent.com/Anionex/dsh-computer-use/main/assets/computer-use-fixture.png`
4. 同样检查了 Chrome `Default\Cache\Cache_Data`：只有 WPS 配置里的 `openai_chatgpt` 字符串噪声，无 ChatGPT 站点缓存。
5. PWA 数据目录 `%LOCALAPPDATA%\Packages\chatgpt.com-FB022A08_ch69rtgtz055j\LocalCache` 下只有 Microsoft 常规目录，无浏览器 profile/cache。Service Worker `CacheStorage` 中也不存在 `SHA256("https://chatgpt.com")` 对应目录。

**结论 [observed]**：本机 Edge/Chrome 的 HTTP 缓存不含 chatgpt.com 的 JS bundle；因此 "从缓存提取 chatgpt.com computer_use 上下文" 这条路**不可用**。若后续仍需该证据，需在能抓取 chatgpt.com 网络的条件下重新采集（登录态、开发者工具/代理抓 HAR），或用官方文档/公开仓库替代。

---

## 3. 在线文档抓取状态

| URL | 结果 | 用途 |
|---|---|---|
| `https://learn.chatgpt.com/docs/computer-use` | `web_fetch` → fetch failed；搜索确认文档存在（同内容 `.md` 亦被搜索索引） | ChatGPT Agent/computer use 官方说明 |
| `https://learn.chatgpt.com/docs/computer-use.md` | fetch failed | 同上 |
| `https://developers.openai.com/training/walkthroughs/using-your-computer-and-browser` | HTTP **403 Forbidden**（`sin1::...` 拦截页） | “using your computer and browser” walkthrough |
| `https://developers.openai.com/api/docs/guides/agents-api/tools/computer-use` | HTTP 403 | computer-use 指南（action schema 权威来源） |
| `https://developers.openai.com/api/docs/guides/tools-computer-use.md` | HTTP 403 | 同上（.md 版） |
| `https://developers.openai.com/api/docs/guides/tools-computer-use-sdk-drivers` | 仅搜索摘要可见标题 | Browser/desktop drivers（参考实现） |
| `https://learn.microsoft.com/.../computer-use`（Azure OpenAI 版） | 仅搜索摘要可见片段（`double click at (x, y)`） | 动作 schema 的第三方转述，仅作旁证 |

**因此**：ChatGPT Agent 模式（模型侧 `computer` 工具的具体 action 列表、坐标空间、图片返回方式、每步是否强制截图）在本报告中一律 **[unknown]**；本报告 §4–§8 的 observed 结论来自**官方浏览器扩展实现**，它等价于"OpenAI 浏览器版 computer-use 的参考实现"，但不能直接等价于 Agent 模式模型 schema。

---

## 4. ChatGPT 浏览器 computer-use 架构

### 4.1 三层结构 [observed]

```
ChatGPT 后端 / Codex 界面
      │  MCP over tunnel (tools/list, tools/call)
      ▼
扩展 background.js  MCP server "node-repl-work" v0.0.1
  tools: js {code, instance_id} / turn_ended
      │  postMessage → 沙箱 iframe (js-kernel.html, sandbox allow-scripts)
      ▼
js-kernel (chunks/js-kernel-Ja-7IJxY.js) —— 模型 JS 的 SDK
  browser.* / tab.cua / tab.ax / tab.playwright / tab.dom_cua /
  tab.content / tab.clipboard / tab.dev / tab.capabilities
      │  JSON 命令通道（commandType + zod 校验）
      ▼
扩展/内核执行层：chrome.debugger(CDP) + Playwright 风格实现
  tab_ax_get_state / tab_ax_action / tab_screenshot / cua_* /
  playwright_* / browser_management_call / browser_viewport_set /
  browser_visibility_set / webmcp_* / cdp / auth handoff / bot detection
```

要点：
- 模型不需要逐个调用 click/type 工具，而是**写一段 JS**，在 JS 里组合多步观察/动作，一次工具调用完成一个子任务。这是"**code-as-action / CUA REPL**"设计。证据：E2、E3，以及 `chunks/js-kernel-host-BlQQhdU0.js` 中的 `CUA_REPL_ENABLED_SURFACES`、`CUA_REPL_BROWSER_DOCUMENTATION_ADDENDUM` 环境变量名。
- 扩展是 MV3 service worker + sandbox iframe；`js-kernel.html` 被列入 `sandbox.pages`，CSP 为 `script-src 'self' 'unsafe-eval'`，即 JS 在**独立 sandbox origin** 中执行（E1）。[observed]
- `turn_ended` 工具显式释放浏览器控制（“Release browser control after a completed turn.”），并且附带 aborted JS 清理（E3 @186444 下文：按 `[scope, session_id, turn_id]` 终止 jsCalls）。[observed]

### 4.2 模型可见工具面 [observed]

`background.js` 内注册的 MCP 工具只有两个：

```js
this.registerTool("js", {
  description: "Execute JavaScript in the selected browser instance.",
  inputSchema: { properties: { code: {type:"string"}, instance_id: {type:"string"} },
                 required: ["code","instance_id"], type: "object" } }, ...)
this.registerTool("turn_ended", {
  _meta: {ui:{visibility:["app"]}},
  description: "Release browser control after a completed turn.",
  inputSchema: { properties: {}, type: "object" } }, ...)
```

- `js` 的 `code` 返回内容由内核 `contentItems`（文本/图片等）回传；`responseMeta` 可回传截图与 tab 元数据（见 `qo()`/`eN()` 写 `openai/browser_use` meta）。[observed]
- 能力文档不写死在 schema 中，而是模型/运行时按需 `get_documentation` / `get_browser_documentation` 拉取（E9）；文档 key 如 `capabilities/browser/viewport`、`capabilities/tab/botDetection`、`capabilities/tab/browserAuth`、`capabilities/tab/cdp`、`capabilities/tab/pageAssets`、`screenshots`、`cloud-auth`、`browser-troubleshooting` 等（E13 同文件 `H1` 集合）。这是**工具文档服务端化**：schema 极小、文档可热更新。[observed]
- 这解释了为什么背景里 `browser_*` 名字远多于模型工具：它们是 kernel 内部命令，不是模型直接见的 tool。[inferred]

### 4.3 能力对象（模型 JS 可用的 API）[observed]

`Tab` 构造器装配（E8，L6574-6608）：

| 对象 | 作用 | 关键方法 |
|---|---|---|
| `tab.cua` | 像素级 computer use | click / double_click / scroll / type / keypress / drag / move / downloadMedia |
| `tab.ax` | 无障碍语义操作 + 观察 | get / write / click / drag / paste / pressKey / scroll / selectText / setValue / typeText / performSecondaryAction |
| `tab.playwright` | Playwright 风格 locator | getByRole / getByText / getByTestId / getByPlaceholder / getByLabel / locator / click / fill / press / waitFor / evaluate / …（E8 周边 + E16 命令名） |
| `tab.dom_cua` | DOM 坐标/选择器路径的 CU | dom_cua_click / double_click / keypress / scroll / type / get_visible_dom / download_media |
| `tab.content` | 内容导出 | export / exportGsuite / exportYouTubeTranscript |
| `tab.clipboard` | 剪贴板读写 | readText / writeText / read / write |
| `tab.dev` | 开发者能力 | logs（console 日志） |
| `tab.capabilities` | 可插拔能力 | pageAssets / webmcp / viewport / visibility / management / cdp / browserAuth / botDetection |
| `tab` 本体 | 导航/会话 | goto / markHandoff / … |

---

## 5. 动作集合、参数与坐标

### 5.1 两套动作 schema（原文级证据）

**(A) 像素动作 `tab.cua.*`**（E6，`js-kernel-Ja-7IJxY.js` L5559-5646）[observed]：

| 方法 | 参数 | 备注 |
|---|---|---|
| `click({x,y,button?,keypress?})` | `x,y` number；`button` 可选；`keypress` 附加按键 | 命令 `cua_click` |
| `double_click({x,y,keypress?})` | | `cua_double_click` |
| `scroll({x,y,scrollX,scrollY,keypress?})` | 滚动增量 | `cua_scroll` |
| `type({text})` | | `cua_type` |
| `keypress({keys:[...]})` | 非空数组 | `cua_keypress` |
| `drag({path:[{x,y}...],keys?})` | 路径 | `cua_drag` |
| `move({x,y,keys?})` | | `cua_move` |
| `downloadMedia({x,y,timeoutMs?})` | | 媒体下载 |

命名与 OpenAI computer-use API 的 `click/double_click/scroll/type/keypress/drag/move` 高度一致（外网文档不可达，不能断言字段完全一致）。**[inferred]**

**(B) 语义动作 `tab.ax.*`**（E7，L5647-5780；schema E4 @260096）[observed]：

| kind | 参数 | 说明 |
|---|---|---|
| `click` | `target: element_index \| [x,y]`；`mouse_button: left/right/middle/l/m/r`；`click_count`；`key`；`duration` | target 联合类型 = **元素索引或坐标** |
| `drag` | `from`、`to`（各为 element_index 或 [x,y]） | |
| `paste` | `element_index`（nullable）、`text`、`format: text/md/html` | 富文本粘贴 |
| `perform_secondary_action` | `element_index`、`action` | 次动作（如上下文菜单项） |
| `press_key` | `element_index`（nullable）、`key`、`duration?` | |
| `scroll` | `target`、`direction: up/down/left/right/u/d/l/r`、`pages?` | 语义滚动，按页 |
| `select_text` | `element_index`、`text`、`prefix?`、`suffix?`、`selection_type: text/cursor_before/cursor_after` | 精准选文本 |
| `set_value` | `element_index`、`value` | 直接赋值（依赖 is_value_settable） |
| `type_text` | `element_index`（nullable）、`text` | 逐字输入 vs 粘贴 |

### 5.2 坐标单位

- `tab.cua` 的 `x/y` 是**页面 viewport 内的 CSS 像素**：它可以与 `scrollX/scrollY`（相对滚动量）和 `tab_screenshot{cropX,cropY,cropWidth,cropHeight,fullPage}` 配套；a11y 语义动作 `click.target` 也允许直接退化为 `[x,y]`。**[inferred，源自参数组合]**
- 非屏幕绝对坐标：扩展目标是 tab 内部页面而非桌面；`tab_screenshot` 有 crop 参数，说明截图坐标系是页面坐标。**[inferred]**
- DPR/缩放、是否相对于 iframe、是否使用 CDP `Input.dispatchMouseEvent` 的 CSS 像素语义：**[unknown]**（执行层 `cua_*` 在 host 内，未逐行确认）。

### 5.3 观察接口

| 命令 | 入参 | 出参 | 证据 |
|---|---|---|---|
| `tab_ax_get_state` | `browser_id, tab_id, content: "axState"\|"screenshot"\|"axStateAndScreenshot", disable_diffing?` | `{state?: string, data?: string, screenshot_unavailable?: string}` | E5 |
| `tab_screenshot` | `fullPage?, cropX?, cropY?, cropWidth?, cropHeight?` | `{data: string}` | E5 |
| `tab_handle_js_dialog` | `action: accept/dismiss` + `dialog_id` + `prompt_text?` | — | E16，E7 的 dialog 类（alert/confirm/prompt/beforeunload） |

- SDK 将 `ax.get("state")` 返回字符串；`"screenshot"` 返回图片（`Ce(a.data)`，形似 data URL → Image/缓冲，具体实现 **[unknown]**）；`"both"` 返回 `{state, screenshot}`；若 `both` 下 `data` 缺失且 `screenshot_unavailable` 为字符串，则**降级返回 `{state}`**（E7 L5755-5760）。[observed]
- `ax.write(mode)` 把 state/screenshot 通过 `display` 通道**展示给用户**（用于"给用户看"的 live view），与"给模型看"分离。[observed]

---

## 6. 观察-动作循环

### 6.1 循环形状 [observed + inferred]

1. 模型在 `js` 工具里先 `await tab.ax.get("state")`（或 `"both"`）拿观察；可选 `screenshot`。
2. 模型用 `tab.ax.click(element_index)` 或 `tab.cua.click({x,y})` 执行动作；动作命令 `cua_*`/`tab_ax_action` 是**请求-响应**式（JS await）。
3. 失败以 Error 抛回 JS；模型可在同一段 JS 里 catch/重试/重新观察；跨工具调用则由 ChatGPT 编排。
4. 一次 turn 结束调用 `turn_ended` 释放控制并中止残留 JS。
5. **没有证据表明扩展强制"每步截图"**；截图与 a11y 文本是观察的可选项。ChatGPT Agent 模式是否每步都用截图 **[unknown]**。

### 6.2 观察与 diff [observed]

- `tab_ax_get_state` 的 `disable_diffing`：不传时**默认 diff**；传入时返回全量。wasm 保留上一 revision（`previousPointer`）并基于它生成 diff（E10）。[observed：参数存在 + wasm revision API]
- 结果里 `screenshot_unavailable` 是显式降级信号，而非 throw：[observed]（E5/E7）。
- **观察过期/动作后失效**：扩展有 `observationRevision` / `revision`、导航事件时 `invalidateObservations`、凭证投递时整体封锁（E15）——即语义上"快照有版本，版本变了就不能继续用旧元素索引"。具体把版本号暴露给模型的方式 **[unknown]**（模型只看到文本/截图，可能由内核渲染时编码）。[observed for mechanism / inferred for exposure]
- 像素动作无"元素索引失效"概念；a11y 动作的 `element_index` 对应**当前 revision**，跨 revision 复用会错位——这是 DSH 设计要抄的关键约束。[inferred]

### 6.3 失败/超时 [observed 部分]

- 每个命令有 zod 校验；参数不合法直接 throw（如 `cua.click requires x and y`）。
- `downloadMedia`/`tab_screenshot` 等有 `timeout_ms`；`playwright_wait_for_*` 有超时语义。
- `turn_ended` 会 abort 该 turn 下所有 jsCalls；`finishExecution` 有 `afterSubmittedCodeHook` 超时（超时→reset kernel）。
- 没有看到自动重试/自动验证的扩展层实现；是否由 ChatGPT 侧做 "guardian/auto review" 之外的验证 **[unknown]**。

### 6.4 对话框、下载、剪贴板、展示 [observed]

- JS 对话框：alert/confirm/prompt/beforeunload 对象 + accept/dismiss（prompt 需文本）→ 模型可显式处理。
- 下载：`downloadMedia`、`playwright_*download*`、`browser` 策略里有 `downloads` allow/deny、`download_approval_mode`。
- 剪贴板：`tab.clipboard.readText/writeText/read/write`（MIME entries + presentation_style）。
- 展示：`tab.ax.write` / display bridge（把状态或截图给用户看）。
- 媒体/PDF/YouTube/GSuite 导出：`tab.content.export*`、`captureTabPdfToLibrary`。

---

## 7. OpenAI 如何表示无障碍快照

### 7.1 wasm 的职责 [observed]

`chunks/browser-accessibility-X0H1iF3d.js` 是一个**纯函数式渲染/索引层**：

- `buildRevision(snapshotJSON, options)`：
  - `options.mode: "auto" | "full"`（默认 `auto`）；
  - 把 `JSON.stringify(snapshot)` 传入 wasm，返回 revision 句柄；
  - 同一 runtime 可持有上一 revision，用于 diff（`previousPointer`）。
- Revision 对象暴露：
  - `text` → `revision_text_length` + `revision_copy_text`，UTF-8 解码；
  - `identityForElement(elementId)` → `revision_identity_length/copy_identity`，为元素返回稳定 identity 字符串；
  - `isValueSettableForElement(elementId)` → `revision_is_value_settable` 返回 `undefined | boolean`（<0 未知，1=true，0=false）。
- 元素 ID 是 **int32**（`Number.isSafeInteger` + `[-2147483648, 2147483647]`），这就是动作里的 `element_index`。[observed]
- 释放走 `FinalizationRegistry` → `revision_release`。[observed]

**推论**：快照 JSON 来自 CDP/扩展的 AX 树；wasm 将其压缩成模型可读的文本，并保留"元素 → identity / 是否可写"的映射；`auto` 可能做裁剪/去噪，`full` 保留完整树。**[inferred；渲染规则、去噪白名单、diff 格式 [unknown]]**

### 7.2 元素身份与可写性 [observed + inferred]

- `identityForElement` 返回的字符串是元素的**跨 revision 稳定 identity**（否则无需 wasm 单独导出）；用途推测是：diff 时对齐元素、判断同一元素在两次观察间是否变化。**[inferred]**
- `isValueSettableForElement` 在 SDK 层没有直接暴露（`js-kernel-Ja` 未调用它；`js-kernel-host` 有 1 处 `settable` 命中），最可能用于 **决定 `set_value`/`paste`/`type_text` 的合法性与路由**。**[inferred]**
- `element_index` 是**快照内序号**，动作命令 `tab_ax_action{action:{kind,element_index,...}}` 由内核映射回真实 DOM/节点。[observed for protocol；映射实现 [unknown]]

### 7.3 auto vs full [inferred]

- `auto`：默认压缩/过滤（可能只保留可交互/可读节点）；
- `full`：完整渲染（调试/兜底）。
- 两者都由 wasm 内部实现，JS 侧只传 0/1。**[inferred]**；实际差异在 `browser-accessibility.wasm.br`（扩展目录中**未找到该 wasm 文件**，运行时按 `./browser-accessibility.wasm.br` 加载；本机扩展目录只有 `zxing_reader` wasm —— 说明它可能由宿主/服务端注入或该版本资源未随包分发，需动态加载路径 **[unknown]**）。

---

## 8. 安全与审批（这是 OpenAI 设计里最值得抄的部分）

### 8.1 首次控制授权 [observed]

- 首次 `js` 调用前检查 `chrome.storage.sync.browserUseControlAllowed === true`；否则弹 **elicitation**：
  - 文案：`"ChatGPT can read your open tabs and take actions in them to help complete your tasks."`
  - `tool_name: "allow_browser_control"`、`tool_title: \`Allow ChatGPT to use your ${browser}?\``、`connector_id: "browser-use"`、`codex_approval_kind: "mcp_tool_call"`。
  - 用户 `accept` 后写 storage flag；拒绝返回 `"Browser control was not allowed."` + `isError:true`。
- chat 模式下还有 **challenge/consent** 双阶段：`_meta["openai/browser_control_consent"] = {elicitation_id, challenge, browser_name}`，模型需把 challenge 带回 `requestMeta["openai/browser_context"].browser_control_consent`，防止跨实例重放。[observed，E11]

### 8.2 每资源策略 + 审批模式 [observed]

默认设置（E13）：

```js
{
  approval_mode: "always_ask", history_approval_mode: "always_ask",
  iab_history_approval_mode: "always_ask",
  download_approval_mode: "always_ask", upload_approval_mode: "always_ask",
  disable_auto_review: false, full_cdp_access_enabled: false, webmcp_enabled: true,
  origins: {allowed:[], denied:[]}, downloads: {...}, uploads: {...}, full_cdp: {...}
}
```

- 资源维度：`origins`（页面访问）、`downloads`、`uploads`、`full_cdp`（原始 CDP）；每条规则 `allow/deny`，可在运行中 patch（`nF` 生成 `rule_updates`）。
- 审批模式：`always_ask` / `never_ask`；history 还有 `disabled`。
- **auto review**（guardian）：`disable_auto_review` 可关；默认开启，配合 `guardian-auto-review` / `guardian-origin-cache` 决策来源，说明典型流程是"自动安全审查 → 通过则放行 → 否则问用户；用户同意后可缓存到 origin/turn/持久状态"。[observed for keys, inferred for flow]
- **持久审批**：企业策略含 `allow_global_persistent_approval`；决策来源有 `browser-use-persisted-state`；每 origin 有 `access_approval_lifetime`。[observed]

### 8.3 决策审计 [observed]

每条安全决策可输出：

```
{schema_version:1, permission: browser_auth|browser_history|browser_origin_access|
 file_download|file_upload|full_cdp_access|webmcp_access|...,
 decision: allowed|denied, decision_context: evaluated|cached|not_required|cancelled|error,
 decided_by: automated_review|user|saved_user_permission|history_policy|network_policy|
 builtin_rule|openai_site_policy|security_mode|...,
 policy, reason, origin, connector_id, tool_name, backend, duration_ms}
```

（`oN`/`aN`/`sN`/`lN` 映射表，E14）——**可审计、可回放**，对 DSH 的安全合规很值得抄。

### 8.4 凭证/登录/支付/接管 [observed]

- **凭证投递期间封锁观察**：`CredentialObservationError` 的 5 种 reason（E15），例如"credential delivery in progress 期间不能 observe"；含原生凭证的文档观察受限，必须导航到新文档；保留数据受限要新开 tab。
- **手动接管**：`Tab.requestManualHandoff()` / `tab_manual_handoff_request`；`mark_tab(status: "handoff"|"deliverable")`；`manualSavingTabs` / `ordinaryInteractionTabs` 处理用户接管后的保存/交互。
- **认证流程专门工具**：`tab.browserAuth` 能力 + 工具描述 "**MUST read its documentation before the first interaction with any authentication or sign-in flow** … covers method selection, secure user-provided credentials, and post-authentication verification and recovery."（E16 的 `browserAuth` 描述）。
- **支付**：扩展层未看到显式 payment 策略（可能由 ChatGPT 侧审批）；**[unknown]**。
- 自身页面保护：禁止操作 `chatgpt.com` / `chat.com`（避免自指/提示注入回环），E17。[observed]

### 8.5 企业策略 [observed]

`enterprise_managed` 可下发（E12）：
- `allow_browser_and_computer_use`
- `browser_use.allow_webmcp` / `allow_history_access` / `disable_auto_review` / `allow_global_persistent_approval`
- `default_origin_policy` + `origins[]`，每 origin 可配 `access/downloads/uploads/full_cdp_access/auto_review/persistent_approval/access_approval_lifetime`

### 8.6 其他护栏 [observed]

- `browser_visibility_set/get`（工作放后台，用户可要求可见）；
- `browser_viewport_set/reset`（响应式测试，需复位）；
- `bot_detection_report`（CAPTCHA/登录循环时上报）；
- `full_cdp_access` 默认关闭；
- `webmcp` 页面工具调用单独授权（`webmcp_access`）；
- 网络/历史/导航策略独立（`codex-network-policy`、`codex-history-policy`、`navigation-url-policy`、`site-status`）。

---

## 9. 与 DSH `dsh-computer-use 0.3.2` 的差异清单

DSH 侧证据：`~/.dsh/skills/computer-use/SKILL.md`、`~/.dsh/plugins/dsh-computer-use-virtual-cursor/package.json`（E20）。
DSH 入口（12 个模型友好工具）：`screen_observe/screen_zoom/computer_click/computer_double_click/computer_right_click/computer_type/computer_key/computer_scroll/computer_drag/computer_wait/app_list/app_launch`，Cua Driver 后端、虚拟光标、ax/native/vision 三模式、30s 观察过期。

| 维度 | ChatGPT 扩展（browser CU） | DSH dsh-computer-use 0.3.2（desktop CU） | 差异/可借鉴 |
|---|---|---|---|
| 作用域 | 浏览器 tab 内页面（tab 级） | 桌面窗口/应用（window 级） | 目标不同；DSH 若要扩浏览器，可加"tab 作用域"层 |
| 模型工具面 | 1 个 `js` REPL + `turn_ended`；能力对象在文档里 | 固定 12 个 schema 工具 | **code-as-action vs tool-per-action**：DSH 可保留固定工具，另加受控 `js`/macro 工具 |
| 观察主通道 | a11y **渲染文本**（wasm 压缩） + 可选截图 | `mode=ax` 返回 AX 树；`native` 截图；`vision` 视觉描述 | DSH 已有三模式；可加 `both` 与"文本优先、截图兜底"的渲染层 |
| 元素身份 | `element_index`（int32）+ wasm 稳定 identity + revision/diff | AX 树元素编号 + 30s 过期 | 都走"观察 token"；DSH 可补 diff 与跨 revision 身份 |
| 语义动作 | element_index：click/paste/pressKey/scroll/selectText/setValue/typeText/secondary_action | 以坐标为主（click/type/key/scroll/drag） | DSH 可加元素索引动作 + "可写性"判断 |
| 像素动作 | cua.click/double_click/scroll/type/keypress/drag/move/downloadMedia | screen_observe + computer_click/double_click/right_click/type/key/scroll/drag | 基本对齐；扩展多了 move/downloadMedia，DSH 多了 right_click |
| 坐标单位 | viewport CSS px（inferred） | 窗口本地截图像素（SKILL 明确） | 需显式声明 scope + 单位，避免混用 |
| 观察-动作循环 | 模型自选 state/screenshot/both；diff 默认开；无强制截图 | 每次动作后重新观察；30s 过期；每动作验证 | 语义一致；DSH 的"过期拒绝"值得保留，ChatGPT 用 revision invalidation |
| 审批 | 首启 consent + 每资源 allow/deny + always_ask/never_ask + auto review + 持久审批 + 审计决策 | 危险词审批、密码框保护、作用域权限、后台输入失败→单次批准→前台重试 | **ChatGPT 的资源/来源维度更细**；DSH 的词表/密码框可保留 |
| 凭证/登录 | 凭证投递期封锁观察、protected document、manual handoff、browserAuth 文档 | 无登录 broker（unknown） | DSH 若要浏览器自动化，需补"凭证隔离 + 接管" |
| 浏览器管理 | tabs/window/groups/bookmarks/visibility/viewport/webmcp/cdp | `app_list`/`app_launch` | 浏览器场景需要 tab 管理面 |
| 剪贴板/对话框/下载 | 有（clipboard/dialog/downloadMedia/upload 策略） | 无（面向桌面窗口，unknown） | 可按需补 |
| 自身页面保护 | 拒绝 chatgpt.com/chat.com | 无对应概念 | 建议 DSH 加"自身宿主页面/窗口保护" |
| 文档 | 服务端按需 `get_documentation` | 静态 tool description + skill | 可借鉴"文档服务端化"，减少 schema 膨胀 |
| 后端 | chrome.debugger(CDP) + Playwright 风格 | Cua Driver（原生） | 后端不同，但抽象（observe/act/verify）可统一 |

---

## 10. 面向 DSH 复刻的可落地设计要点

> 目标：在 DSH 现有 `screen_observe + computer_*` 语义上吸收 ChatGPT/扩展的设计，不引入浏览器/桌面双后端分裂。

**P0（低成本、高收益）**
1. **统一观察结果结构**：`{mode, state|screenshot|both, degraded_reason?}`。保留 DSH 的 ax/native/vision，新增 `both`；截图失败时降级为 state 而不是整体失败（对齐 E7 L5755-5760）。
2. **观察 token + revision**：`screen_observe` 返回 `snapshot_id/revision`；所有动作携带 token，服务端校验"token 仍是最新且未过期"；比固定 30s 更稳（ChatGPT 用 revision invalidation，E15）。
3. **动作分两级**：语义动作（element/ref/坐标中心）与像素动作（x,y）并存；参数里允许 `target: elementRef | {x,y}` 联合类型（对齐 E4 `click.target`）。像素动作补齐 `double_click`、`move`、`drag(path)`、`keypress(keys[])`、`scroll(dx,dy)`。
4. **元素可写性**：观察结果给每个可交互元素标 `settable: true/false`（对齐 wasm `is_value_settable`，E10）；`computer_type`/`set_value` 据此选择"直接赋值 vs 逐字输入"。
5. **动作后强制轻量复核**：动作结果返回 `{changed: bool, snapshot_delta?}`；若 changed=false 且动作非幂等，提示模型复核（DSH 现在的"重新观察"可保留为默认）。

**P1（安全/审计，建议尽快）**
6. **资源级审批策略**：DSH 当前是"危险词 + 密码框 + 作用域"；建议增加 `scope → allow/deny`（按应用/窗口/URL/域名）与 `approval_mode: always_ask|never_ask`（对齐 E13）。
7. **auto review + 持久审批**：先自动安全预检（可规则化），通过则放行；用户同意后可缓存到 scope/turn/持久（对齐 E13/E14 的 decision source 枚举）；所有决策输出结构化审计行（E14 的 `{permission, decision, decided_by, policy, reason, origin, tool_name}`）。
8. **凭证/敏感期封锁**：用户输入密码/支付/登录期间，禁止观察与动作（对齐 E15 的 credential gate），并提供 `request_manual_handoff` 让用户接管（DSH 已有"用户交互时让路"，可升级为显式状态机）。
9. **自身宿主保护**：拒绝操作 DSH 自己的窗口/页面（对齐 E17 的 chatgpt.com 拒绝），防提示注入回环。

**P2（能力面，浏览器场景）**
10. **浏览器 tab 层**：若 DSH 要复刻"网页 Agent"，在 app/window 之上加 tab 抽象（list/create/close/activate/visibility/viewport），观察/动作带 tab_id（对齐 E8/E16）。桌面场景不受影响。
11. **对话框/下载/剪贴板**：JS dialog accept/dismiss、下载允许与策略、剪贴板读写（对齐 E7/E16）。
12. **文档服务端化/按需加载**：工具 schema 保持小，能力文档（如 browserAuth、cdp、screenshots、viewport）按需注入（对齐 E9）；避免 12+ 工具 schema 挤占上下文。
13. **可选 code-as-action**：给高级模型一个受 sandbox 约束的 `js`/`macro` 工具，把"观察→动作→再观察"组合在一次调用内（对齐 E2/E3 的 `js`/`turn_ended`），但必须复用同一套审批/审计中间件。

**不建议照抄**
- 不建议把"每步必须截图"写死（OpenAI 扩展并没有，ChatGPT 侧是否如此 [unknown]）。
- 不建议把模型工具面直接换成单 `js`（DSH 的模型/工具生态以固定 schema 为主，REPL 可作为增量模式）。

---

## 11. 未解问题（unknown，按优先级）

1. **ChatGPT Agent 模式（网页/PWA）模型侧 computer 工具的权威 schema**：action 列表、是否每步 screenshot、图片如何编码返回、坐标空间/缩放到多少像素。原因：learn.chatgpt.com / developers.openai.com 均 403/fetch failed。
2. **Agent 模式的观察策略**：是否使用 a11y 树（浏览器扩展有，但 Agent 模式可能走虚拟桌面截图）；a11y 与截图的取舍规则。
3. **`browser-accessibility.wasm.br` 的渲染规则**：auto/full 的具体差异、diff 文本格式、identity 字符串构成；且本机扩展目录**未找到该 wasm 文件**，需确认加载来源（宿主注入/动态下发）。
4. **`is_value_settable` 的消费点**：SDK 未直接调用，可能在 host 内部用于 `set_value` 路由。
5. **auto review / guardian 的判定逻辑**：哪些操作自动放行、哪些必须问、缓存 TTL/scope 语义。
6. **支付/敏感操作的专门策略**：扩展层只看到凭证保护，未见 payment 专项（可能在 ChatGPT 后端）。
7. **ChatGPT 扩展与 Agent 模式的关系**：扩展面向 "Codex/ChatGPT Work 浏览器插件"（manifest/字符串 `chatgpt-work-browser-plugin`、connector `browser-use`），是否就是 Agent 模式的同一后端 **[unknown]**。
8. **DSH `dsh-computer-use` 的精确 action/schema**：本报告只读了 SKILL/package.json 与工具名，未逐行读 `lib/actions.js`；差异表中 DSH 列的动作细节以 SKILL 描述为准。
9. **本机缓存为何没有 chatgpt.com**：可能 PWA 未在 Default profile 使用、缓存被清理、或 PWA 使用独立 profile；需运行中的抓包/HAR 才能补证。
10. **screenshot 数据编码**：`Ce(a.data)` 的实现未展开；是 data URL、base64 还是 Blob **[unknown]**。

---

## 12. 附录：复现命令

```bash
# 1) 扩展关键点（单行压缩文件用字节偏移）
python3 computer-use-rebuild/.scratch/extract.py \
  "<EXT>/background.js" "allow_browser_control|browser_viewport_set" 500 800 3
python3 computer-use-rebuild/.scratch/extract.py \
  "<EXT>/background.js" "tab_ax_get_state|type_text" 400 700 6

# 2) a11y wasm 接口（格式化查看）
sed 's/;/;\n/g; s/}/}\n/g; s/{/{\n/g' \
  "<EXT>/chunks/browser-accessibility-X0H1iF3d.js" | head -160

# 3) SDK 能力对象（已格式化文件）
sed -n '5559,5780p;6400,6619p' "<EXT>/chunks/js-kernel-Ja-7IJxY.js"

# 4) 缓存负结果
python3 computer-use-rebuild/.scratch/scan_cache.py <copy-of-data_1> "computer-use" 800 1200 6
```

> 注：`<EXT>` = `C:\Users\b1778\AppData\Local\Microsoft\Edge\User Data\Default\Extensions\odlomjlbamekndcpllcnffbgeohgkmjh\1.26.1006.11559_0`；缓存扫描脚本位于 `computer-use-rebuild/.scratch/`（scratch 目录，非交付物）。

---

### 自检记录

- 每条结论均引用 E 编号；E1-E20 全部可在本机复现（除 E 中标注的在线地址不可达）。
- observed/inferred/unknown 已逐条标注；未把公开文档记忆当作证据。
- 已知缺口集中在 §11，尤其"ChatGPT Agent 模式模型 schema"因外网不可达而未能补证。
- 本报告 v0.1，建议评审后再决定是否投入时间重抓 ChatGPT 网络流量以补 §11-1/2/7。
