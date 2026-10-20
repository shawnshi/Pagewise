# 阅读助手 AI 服务与模型

## 当前选项

设置页仅提供以下五项。新建配置或首次切换到尚未配置的服务时，使用对应默认模型；每个服务的模型均可通过原生下拉框选择。

| 服务 | 默认模型 ID | 其他内置选择 |
|---|---|---|
| 内置试用通道 | `deepseek-ai/DeepSeek-V4-Flash` | 保持既有服务端策略，不要求用户密钥 |
| DeepSeek | `deepseek-flash` | `deepseek-v4-pro` |
| OpenAI | `gpt-6.1-sol` | `gpt-6-astra`、`gpt-6-luna` |
| Google Gemini | `gemini-4-argon` | `gemini-3.8-flash`、`gemini-3.5-flash-lite` |
| OpenRouter | `openai/gpt-6.1-sol` | GPT-6 Astra、Gemini 4 Argon、DeepSeek V4.1 Flash、`openrouter/auto` |

模型目录于 **2026-10-20** 依据公开官方资料核验。DeepSeek 的 `deepseek-flash` 为更新到当前 V4.1 Flash 的官方模型名；OpenAI 的 GPT-6.1 Sol 是新版本，GPT-6 Astra 仍作为高能力型号供选择。OpenRouter 是模型聚合服务，没有单一“最新 OpenRouter 模型”；这里默认选择其目录中的 GPT-6.1 Sol，自动路由作为可选项，不把自动路由描述为必然使用最新或某个固定模型。

此目录是有核验日期的内置清单，不会在启动设置页时自动联网拉取，不能保证未来永远最新。实际可用型号、权限、限额与价格仍由用户账户和服务商决定。

## 配置与兼容

- 新服务使用自己的默认地址和空密钥；切换服务时恢复该服务独立保存的地址、密钥及模型，不把其他服务的密钥带过去。
- 已有明确模型选择和自定义地址不被静默覆盖。已保存但不在内置目录中的模型会追加到下拉框并标注“已保存”；需要升级时主动选择标有“最新默认”的模型。
- 已移除服务商只保留为非活动历史配置，不能从服务列表重新选择。若启动时仍使用旧服务商，界面提示重新选择，连接测试和模型选择保持禁用；不自动改成试用通道，不自动向新服务转发请求。
- 试用通道不展示用户密钥输入，也不向服务器发送配置中残留的用户 API Key。密钥存储位置沿用现有设置机制，不声称密码输入框等于加密凭据存储。
- 阅读助手继续使用 `/chat/completions` 流式协议。当前 GPT 推理模型请求不发送不支持的 `temperature`，伴读的 `max_tokens` 转为 `max_completion_tokens`；Gemini 4 请求省略无效的采样温度。不会在鉴权失败、型号不存在、额度不足等错误时自动换服务。
- 退役服务配置在伴读中也保持关闭。另修复了此前按书授权的响应性：先读取属性以建立 Vue 依赖，再检查自有属性及严格布尔值；不降低首次同意或显式拒绝的门槛。

## 核验来源

- [DeepSeek 模型与价格](https://api-docs.deepseek.com/quick_start/pricing)：当前模型名与历史 Flash 别名说明。
- [OpenAI GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)：模型 ID、Chat Completions（不使用工具）支持及模型规格。
- [OpenAI GPT-6 使用指南](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)：推理模式下的采样参数限制。
- [Gemini 4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)、[Gemini OpenAI 兼容接口](https://ai.google.dev/gemini-api/docs/openai)：稳定型号与兼容端点说明。
- [OpenRouter 公共模型目录](https://openrouter.ai/api/v1/models)：命名空间模型 ID；目录会持续变化。

## 测试入口与边界

```sh
cd reader
npm run test:ai-providers
npm run e2e:ai-providers
```

单元测试使用合成配置与拦截传输，覆盖五项服务、模型默认值、保留旧配置、密钥隔离、参数兼容、错误不回退及取消/截断处理。浏览器检查挂载实际设置页，覆盖 992/390 宽度、键盘进入模型下拉、切换后恢复及零自动外联。

本次验证：前端生产构建通过；相关 Node 回归 **210/210**；两项设置/选择器浏览器测试通过；阅读助手长链路 **11/11** 场景通过，外联计数为 0。长链路测试覆盖原文边界、截断、翻译失败重试和翻页取消；测试仅使用合成书籍，不读取设备私人数据。独立只读审查及最终增量复核通过。

仍有 Vite 动静态导入不拆包提示；长链路开发服务器日志另有 `ResizeObserver loop completed with undelivered notifications` 诊断，不将其表述为零浏览器错误。主动 LSP 复查未返回错误，但部分服务器不能确认干净，以实际 Vue/TypeScript 构建及运行测试为主要验收证据。本次未使用真实账户或密钥验证付费调用，没有将公开资料核验、模拟传输或浏览器成功写成真实供应商调用成功。

本次修改仅在源码中完成；未重打 APK、未部署 relay、未更新设备或推送 GitHub。当前已安装的 1.3.0 包不包含此后源码变更。
