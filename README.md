# ST-Generation-Retry-Notifier

SillyTavern 第三方前端扩展。

功能：

- 对文本生成 API 请求做自动重试
- 在前端面板里直接修改重试策略和参数
- 生成完成后发送浏览器通知

可配置项：

- 重试策略：固定间隔 / 线性退避 / 指数退避
- 最大重试次数
- 基础等待时间
- 指数倍数
- 单次最大等待
- 抖动开关与抖动比例
- 是否对网络异常重试
- 可重试 HTTP 状态码
- 是否显示重试 toast
- 页面有焦点时是否也推送通知

当前拦截的生成端点：

- `/api/backends/chat-completions/generate`
- `/api/backends/text-completions/generate`
- `/api/backends/kobold/generate`
- `/api/backends/koboldhorde/generate`
- `/api/novelai/generate`
- `/api/horde/generate-text`

说明：

- 这是浏览器端扩展，因此通知依赖浏览器 `Notification` 权限。
- 目前重试的是“请求建立失败 / 返回可重试状态码”的场景；流式响应已经建立后中途断流，不一定能透明重放。
