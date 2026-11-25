# Program Requirement Agent

在实验仓库的工单中，向已绑定该仓库的实例发送 `@实例名 /mine chmln__sd.87d1ba5`。每条委托只接受一个官方 ProgramBench 实例标识，成功后创建一张普通需求工单，并在原工单回帖附上链接。报告区分实际输入输出、文档依据、推断和未验证边界。挖掘 Agent 不创建规格 PR；由 Planner 建议、人工授权后交给 Spec Agent。

## 实例配置

沿用模板的 `.devstar/entrypoint.sh` 和 `.devstar/agent-runtime` 子模块。实例以 repository 范围启动，不使用用户级或全站运行规则。

| 配置 | 用途 |
| --- | --- |
| `DEVSTAR_AGENT_SCOPE_KIND=repository`、`DEVSTAR_AGENT_SCOPE_REPO_ID` | 由 Agent Team 指定仓库范围；事件必须来自同一仓库 ID |
| `MINING_AGENT_REPOSITORY` | 目标仓库的完整名称（`OWNER/REPO`），与分派事件的仓库名称一致 |
| `MINING_AGENT_STATE_DIR` | Agent 私有的持久绝对路径；按仓库和事件隔离发布回执，重试不会重复建单 |
| `OPENJIUWEN_API_BASE`、`OPENJIUWEN_MODEL`、`OPENJIUWEN_API_KEY` | 探索模型配置，密钥通过实例 Secrets 注入 |
| `MINING_PYTHON` | 运行固定 Python 依赖的解释器；模板构建的镜像已配置 |

运行环境需要能连接经管理员批准的专用 Docker 执行环境并获取官方参考镜像。镜像只安装 Docker 客户端所需软件，不自动挂载宿主 socket、不启用特权模式。模型负责根据公开文档选择普通功能探测；参考程序在断网、非 root 的容器中运行。工单写入使用当前委托事件的服务账号，不使用模型凭证、用户令牌或实例注册令牌。

当前 `/mine` 只接受官方目录里的实例标识。接入目录外程序时，需要准备可运行的程序入口、可供探索的公开文档、明确的运行环境与依赖，以及可选的探索范围。旧工作流的源码接入能力尚未迁入这个 Agent，不能直接把源码 URL 传给 `/mine`。

探测失败且尚未发出建单请求时，同一事件可以重试，失败材料留在旁边的 `.incomplete-*` 目录。有发布回执但结果不明确时，先核对仓库中的工单，再决定如何恢复，不要删除回执后直接重跑。

## 本地验证

### 可选：独立 Pod 探测

此分支的 DevStar 模板选择 `pod-runner` 构建目标，复用旧模板缓存的系统依赖层，但不安装或运行 Python 基线和 PyPI 依赖，也不启动 Docker 服务。若部署旧 Docker 执行方式，选择 `docker-runner` 构建目标；直接构建 Dockerfile 的默认目标不变。

在已有受控探测 Pod 的实验实例上，把 `MINING_EXECUTION_BACKEND` 设为 `sd-pod`。此模式当前仅接受 `chmln__sd.87d1ba5` 的 `-F` 标准输入探测。实例需要以下私有配置，值不应提交到仓库：

- `MINING_SD_POD_URL`：内部 Pod 的 `/v1/probe` 地址；`MINING_SD_POD_TOKEN`：短时探测凭证。
- `MINING_SD_POD_TASK`：绝对路径，指向包含固定官方任务信息、探测范围和公开文档正文的 JSON。

先在实例内运行 `node src/adapter.mjs --pod-smoke`，确认回执包含真实输入、标准输出、标准错误与退出码，再发送 `/mine`。运行器核对二进制摘要、非 root 身份和断网标记；只执行关联到有文档依据的功能的输入，不把模型给出的输出当证据。该模式验证的是官方二进制，不代表使用了官方完整根文件系统。若正式任务失败，先看事件记录和发布回执，不要重复投递。

### 自动化测试

```sh
git submodule update --init
npm test
docker build -f .devstar/Dockerfile -t program-requirement:test .
```

测试覆盖模板注册、无效命令拒绝、跨仓库拒绝、真实发布代码的模拟 HTTP 边界、回执重放与回复。这些测试不调用模型。线上验收另外用一个官方样例跑完 `/mine` → 自动建单 → Planner 授权 → Spec Agent 规格 PR，不合并。
