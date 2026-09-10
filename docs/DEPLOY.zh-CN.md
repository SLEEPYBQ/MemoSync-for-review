# 匿名评审副本安装说明

使用投稿材料提供的匿名仓库地址，或解压源码归档。下列命令均在源码根目录执行。

## 安装

需要 macOS、Linux 或 Windows WSL，以及 Bun 1.3.5 或更新版本。使用 Codex 时，`codex` CLI 必须位于 `PATH`；Claude Agent SDK 随项目依赖安装。

```bash
bun --version
bun install --frozen-lockfile
cp .env.example .env
```

在本地 `.env` 填写 `GLM_API_KEY`。示例默认启用 `MEMOSYNC_ISOLATE_CLI=1`，使用独立的 Claude 与 Codex 配置目录。真实 key 不应写入源码或提交到仓库。

使用已有官方订阅时，移除本地的 `MEMOSYNC_ISOLATE_CLI` 与 `MEMOSYNC_CLI_PROFILE_DIR`，并选择官方服务。可选配置见 [README](../README.md#configuration)。

## 启动

```bash
bun run build
bun run start
```

打开 [本地应用](http://127.0.0.1:3210)，添加测试项目并选择引擎。Claude Code 使用 GLM 时选择 GLM 厂商；隔离 Codex 按配置使用 GLM。发送任务后，先完成候选、迁移与变更评审，再确认本轮工作记忆。

健康检查不调用模型：

```bash
curl -s http://127.0.0.1:3210/health
```

换端口可运行 `bun run start --port 4000`。

## 验证和预算

```bash
bun run check
bun test src/ --timeout 30000
```

真实模型测试会消耗所配置账号的额度，并创建临时项目和隔离配置：

```bash
bun run scripts/smoke-isolated-branches.ts claude
bun run scripts/smoke-isolated-branches.ts codex
bun run scripts/smoke-memosync-pipeline.ts claude
bun run scripts/smoke-memosync-pipeline.ts codex
```

完整流程测试运行两轮，自动处理临时测试记忆的评审，整体限时十分钟。每个记忆分析请求默认限时 120 秒；初始分析最多 6 个模型轮次或可观察步骤、4 次读取；评审续接最多 3 步、1 次读取；schema 修正最多 2 步且不得读取。Codex 可观察步骤不等同于内部模型轮次。详见 [分支执行说明](MEMORY_BRANCHES.md)。

## 常见问题

| 现象 | 检查方式 |
| --- | --- |
| 找不到 `bun` 或 `codex` | 检查安装和当前终端的 `PATH`。 |
| 默认端口无法启动 | 使用 `--port` 指定其他端口。 |
| 隔离模式提示没有凭据 | 检查本地 key 与当前厂商；隔离模式不会借用平常登录。 |
| 模型请求被拒绝或超时 | 检查凭据、额度、endpoint 与模型 ID；Codex 需要 Responses endpoint。 |
| 停在记忆评审界面 | 完成或跳过评审步骤，再确认工作记忆启动执行。 |
| 工作记忆选择失败 | 使用 Retry selection，或从池中手动选取后重试预期用途规划。 |
| audit 失败 | 查看明确失败状态；缺失或无效结果不会被当作成功判断。 |

应用数据写入本地；模型调用会将必要上下文发送给所选服务商。导出内容见 [数据说明](DATA_AND_TELEMETRY.md)。
