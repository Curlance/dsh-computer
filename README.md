# dsh-computer-use

> **让 DeepSeek Harness（DSH）用独立 AI 光标操作 Windows 桌面。**
> 观察屏幕/UIA 控件树、滑行光标、点击、输入、按键、滚动、拖拽；自带 **Computer Use** 预设，装好后新会话即可使用。

这是社区插件 `dsh-computer-use` 的 **0.4.1 重建版**（原作者 [988hj7tczd-oss](https://github.com/988hj7tczd-oss/dsh-computer-use)，MIT）。重建目标：让它重新兼容 **DSH 0.2.1-rc.2**，并修好「操作时只看到自己的鼠标、没有独立 AI 光标」的问题。

## 特性

- **独立 AI 光标**：点击/输入/按键前，一个可见的 agent cursor 会滑行到目标；不移动、不劫持你的真实鼠标（后台投递；必要时才走前台并请求批准）。
- **12 个模型友好工具**：`screen_observe`、`screen_zoom`、`computer_click` / `double_click` / `right_click`、`computer_type`、`computer_key`、`computer_scroll`、`computer_drag`、`computer_wait`、`app_list`、`app_launch`。
- **双通道观察**：AX/UIA 控件树（文本模型）+ 原生截图直读（视觉模型，`mode="native"`）。
- **安全护栏**：动作必须基于新鲜观察快照；密码框拒绝输入；危险词审批；`background_unavailable` 时按审批转前台重试；点击不移动真实鼠标。
- **DSH 0.2.1 预设**：插件自带 `Computer Use` 预设，安装后无需手工编辑 profile。

## 要求

- DeepSeek Harness Desktop **0.2.1-rc.2**
- [cua-driver](https://cua.ai/docs/cua-driver) **≥ 0.36.0**（0.20 的 AI 光标不上报位置、动作时不显示；升级：`cua-driver update --apply`）
- Windows（本版验证平台）

## 安装

```bash
cd plugin
./install.sh --dry-run   # 预演
./install.sh             # 链接到 profile node_modules + 写入 HOME 层 preset
```

安装会写两处，不动 profile 配置文件：

1. `~/.dsh/profiles/<profile>/node_modules/dsh-computer-use`（链接）
2. `~/.dsh/cordis.patch.yml` 中带 `>>> dsh-computer-use` / `<<< dsh-computer-use` 标记的 preset 段

安装后重启 DeepSeek Harness，新建会话选择 **Computer Use** 预设。

卸载：`./uninstall.sh`

## 使用

```
先 screen_observe(window=目标进程号或标题) 观察
→ 用 computer_click(element=编号) 或 computer_click(x=, y=)
→ 动作后重新观察验证
```

- 文本模型：用 `mode="ax"` 的元素编号操作。
- 视觉模型：用 `mode="native"` 看截图，点击坐标就是截图上的像素。
- 商店应用启动用 AUMID，例如 `Microsoft.WindowsNotepad_8wekyb3d8bbwe!App`。

## 背景与文档

- [docs/chatgpt-computer-use-analysis.md](docs/chatgpt-computer-use-analysis.md) — ChatGPT computer-use/扩展实现逆向分析
- [docs/dsh-diagnosis.md](docs/dsh-diagnosis.md) — 本机 DSH 旧插件失效诊断（0.2.1 版本门禁）
- [docs/design.md](docs/design.md) — 复刻设计
- [docs/verification.md](docs/verification.md) — 验证记录（单测、DSH 会话、AI 光标可见性）

## 测试

```bash
node --test tests/*.test.mjs   # 44 项
node scripts/smoke.mjs         # 只读观察真机冒烟
node scripts/smoke-action.mjs  # 启动记事本→输入→回读验证
```

## 许可证与归因

MIT。基于 [988hj7tczd-oss/dsh-computer-use](https://github.com/988hj7tczd-oss/dsh-computer-use) 0.3.2 重建；0.4.x 适配 DSH 0.2.1-rc.2、cua-driver 0.36 与独立 AI 光标。
