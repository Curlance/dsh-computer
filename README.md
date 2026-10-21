# dsh-computer

独立自研的 DSH 常驻 computer 插件（施工中）：纯 ESM JavaScript + JSDoc，零构建、零运行时依赖。

## 状态

骨架阶段：配置归一化（`lib/config.js`）与空插件入口（`index.js`）。工具、后端、审批与审计由后续任务接入。

## 开发

要求 Node.js 24。

```bash
node --test tests/*.test.mjs
```

`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 由 DSH host 提供；测试只覆盖不依赖 host 的模块。
