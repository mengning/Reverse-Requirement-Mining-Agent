# DevStar Agent Template

这是 DevStar 业务 Agent 的项目模板。新 Agent 应通过“从模板创建”生成独立仓库，不再通过 Fork 关系同步公共运行代码。

## 仓库职责

Template 只提供：

- `.devstar/agent.json` Agent 能力声明；
- `.devstar/entrypoint.sh` 通用启动入口；
- `.devstar/Dockerfile` 基础容器构建方式；
- `.devstar/workflows/ci.yaml` 干净环境和容器启动验证；
- `src/adapter.mjs` 示例业务处理入口；
- `.devstar/agent-runtime` 公共 Runtime 子模块。

注册、事件轮询、心跳、Git 凭据和评论回写由独立的 `devstar/agent-runtime` 仓库维护，并通过 `.devstar/agent-runtime` 子模块引入，不在业务 Agent 中复制。

## 创建业务 Agent

1. 在 DevStar 创建仓库时选择模板 `templates/agent-template`。
2. 修改 `.devstar/agent.json` 中的名称、说明、运行模式和能力。
3. 在 `src/adapter.mjs` 中实现业务事件处理。
4. 声明业务需要的系统、Python 或 npm 依赖。
5. 运行测试后，将业务 Agent 仓库添加到 DevStar Agent Team。

通过模板生成的仓库是独立仓库，不需要继续同步 Template。

## Runtime 依赖

`.devstar/agent-runtime` 是跟踪 `main` 分支的 Git Submodule。每次 Agent 构建启动时，`.devstar/entrypoint.sh` 会执行等价于以下命令的更新：

```bash
git submodule sync --recursive
git submodule update --force --init --remote --recursive --depth 1
```

Runtime 目录由启动入口作为只读依赖管理，本地改动会在更新时被覆盖。启动日志会输出实际使用的 Runtime commit。业务 Agent 不需要提交 Runtime 升级 PR，下一次构建启动会自动获取最新版本。

## 实现业务逻辑

```js
import {
  extractCommand,
  extractSourceEvent,
  replyToSourceComment,
  runDevstarAgent,
} from "../.devstar/agent-runtime/src/index.mjs";

async function handleEvent(eventPayload) {
  const result = await myAgentRun(extractCommand(eventPayload));
  const source = extractSourceEvent(eventPayload);
  if (source === "issue_comment" || source === "pull_request_comment") {
    await replyToSourceComment(eventPayload, result);
  }
  return {summary: result};
}

await runDevstarAgent({handleEvent});
```

## 两种运行模式

- `subscription_service`：常驻运行，持续轮询事件并发送心跳。
- `job_runner`：领取一条任务，处理完成后退出。

`.devstar/agent.json` 的 `launch_kind` 必须与 `.devstar/entrypoint.sh` 中的 `AGENT_LAUNCH_KIND` 一致。

## 依赖声明

业务 Agent 可以在 `.devstar/entrypoint.sh` 中声明：

```sh
export AGENT_REQUIREMENTS_ALPINE="python3 py3-pip"
export AGENT_REQUIREMENTS_DEBIAN="python3 python3-pip"
export AGENT_REQUIREMENTS_PIP="requests"
export AGENT_REQUIREMENTS_NPM=""
```

Runtime 会根据容器系统安装这些依赖。依赖安装或业务 Adapter 启动失败时，启动过程直接失败并输出日志。

## 本地检查

```bash
npm test
sh .devstar/entrypoint.sh
docker build -f .devstar/Dockerfile -t my-agent:test .
```

CI 会分别验证源码启动和当前 Dockerfile 构建启动，不依赖业务仓库中的额外验证脚本。
