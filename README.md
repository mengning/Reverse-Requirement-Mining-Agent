# Program Requirement Agent

从实验仓库的挖掘任务工单或仓库 ChatBot 发起委托。每次选择一个 ProgramBench 官方任务，例如 `tomnomnom__gron.88a6234`；目录中唯一的程序名也可以使用。Agent 复用 mini-SWE-agent 的 ProgramBench 运行器，读取官方任务文档并实际运行参考程序。

成功后创建一张普通需求工单；从任务工单发起时，回帖附上新工单链接。报告区分实测、文档依据、推断和未验证边界。Planner 在需求工单上建议委托，人工授权后由 Spec Agent 提交规格 PR。

## 实例配置

沿用模板的 `.devstar/entrypoint.sh` 和 `.devstar/agent-runtime` 子模块。实例以 repository 范围启动，不使用用户级或全站运行规则。

| 配置 | 用途 |
| --- | --- |
| `DEVSTAR_AGENT_SCOPE_KIND=repository`、`DEVSTAR_AGENT_SCOPE_REPO_ID` | 由 Agent Team 指定仓库范围；事件必须来自同一仓库 ID |
| `WORK_REPO_ID`、`WORK_REPO_OWNER`、`WORK_REPO_NAME` | 平台的项目仓库绑定（若提供）；核对任务仓库，不使用模板仓库名 |
| `MINING_AGENT_REPOSITORY` | 可选的旧配置，仅用于额外校验仓库全名；Agent Team 启动无需手填 |
| `MINING_AGENT_STATE_DIR` | 可选的私有持久绝对路径；默认存到 Agent 工作区 `AGENT_REPO_PATH/.devstar/runtime/mining`，按仓库和事件隔离发布回执 |
| `OPENJIUWEN_API_BASE`、`OPENJIUWEN_MODEL`、`OPENJIUWEN_API_KEY` | 探索模型配置，密钥通过实例 Secrets 注入 |
| `MINING_PYTHON` | 运行固定 Python 依赖的解释器；模板构建的镜像已配置 |
| `MINING_OFFICIAL_INSTANCE` | 可选，将当前实验限制到官方目录中的一个明确实例 ID |

运行环境需要能连接经管理员批准的专用 Docker 执行环境并获取官方参考镜像。镜像只安装 Docker 客户端所需软件，不自动挂载宿主 socket、不启用特权模式。模型负责根据公开文档选择普通功能探测；参考程序在断网、非 root 的容器中运行。工单写入使用当前委托事件的服务账号，不使用模型凭证、用户令牌或实例注册令牌。

添加模板后直接选择仓库范围并启动。注册只依赖 DevStar 注入的仓库范围、实例和认证配置；模型与 Docker 在收到实际挖掘任务后使用。独立运行并且没有持久化 Agent 工作区时，须指定 `MINING_AGENT_STATE_DIR`。

本分支不接收源码 URL、仓库相对目录或自带探测后端。官方运行器根据任务和探索范围自行设计用例；收到明确要求原样运行的固定输入时，Agent 会拒绝该委托，不会悄悄替换成模型设计的用例。官方评分套件独立用于已有实现的验收，不在规格流程内运行。

探测失败且尚未发出建单请求时，同一事件可以重试，失败材料留在旁边的 `.incomplete-*` 目录。有发布回执但结果不明确时，先核对仓库中的工单，再决定如何恢复，不要删除回执后直接重跑。

## 本地验证

```sh
git submodule update --init
npm test
docker build -f .devstar/Dockerfile -t program-requirement:test .
```

测试覆盖模板注册、官方样例选择、无效命令与跨仓库拒绝、真实发布代码的模拟 HTTP 边界、回执重放与回复。这些测试不调用模型。
