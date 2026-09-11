# tgrep 可选全文检索索引集成实施计划

## 1. 目标与边界

为 OCP 增加一个**默认关闭、外部可选**的 tgrep 集成，用于在大仓库内加速高频全文/正则检索。它是文本检索缓存层，不取代 Serena、CodeGraph 或 GitNexus：

- Serena 继续负责实时 LSP 符号定位；
- CodeGraph 继续作为默认单仓调用链与影响面图谱；
- GitNexus 继续作为可选的跨仓/流程深度图谱；
- tgrep 仅改善等价于 `grep`/`rg` 的文件内容搜索。

### 非目标

1. 不将 tgrep 二进制、`.tgrep/` 索引或常驻服务打包进默认发行物。
2. 不自动下载或安装 tgrep，不更改用户的 PATH。
3. 不用 tgrep 替换 CodeGraph/GitNexus/Serena 的语义或图查询。
4. 不允许陈旧索引作为“当前工作树无匹配”的证明。
5. 本阶段不制作自定义 MCP server；先接入项目索引生命周期和 Agent 工具指引。

## 2. 设计约束与决策

| 主题 | 决策 | 理由 |
| --- | --- | --- |
| 集成类型 | 外部、默认关闭的 CLI 后端 | tgrep 是 Rust 原生二进制；避免增加跨平台下载、校验、升级和供应链职责。 |
| 索引位置 | 仓库根目录 `.tgrep/` | tgrep 默认约定；便于 CLI/server 自动发现。 |
| 首次建索引 | `/project init` 仅在 tgrep 已启用、CLI 已安装且索引缺失时执行 `tgrep index .` | 与 CodeGraph/GitNexus 的“首次初始化”语义一致，且绝不隐式安装。 |
| 日常更新 | 由用户或会话宿主启动的每工作树一个 `tgrep serve .` watcher 维护 | 复用服务，避免每个 agent/搜索产生新进程。 |
| `/project index` | 仅当 `.tgrep/` 已有而服务未运行或索引策略/版本不匹配时，执行 `tgrep index .`；健康 server 不全量重建 | tgrep 是检索缓存；正常更新由 watcher 处理，频繁重建抵消收益。 |
| 新鲜度 | 刚编辑后或要做穷尽/否定结论时，使用 `tgrep --no-index` 或现有 `rg` | watcher 是异步的；索引可能尚未吸收最后一次保存。 |
| 失败行为 | 缺 CLI、索引不完整、服务不可用或不支持的查询参数时，透明回退现有 `grep`/`rg` 路径 | 结果正确性优先于性能。 |

## 3. 前置验收条件

- [ ] tgrep 采用 MIT 许可，且用户明确选择启用外部集成。
- [ ] 在 Windows x64/ARM64、macOS x64/ARM64、Linux x64/ARM64 上确认官方预编译包或源码安装路径可用。
- [ ] tgrep 的安装、索引和服务命令均在目标工作区运行，不接受不受控路径参数。
- [ ] `.tgrep/` 被忽略，且项目已有的 `.gitignore` 不被覆盖。
- [ ] 在目标项目对 `rg` 与 tgrep 完成基准：冷索引、热索引、常驻服务、频繁写入和宽泛匹配查询。

## 4. 实施任务

### Phase A — 配置与生命周期注册

#### A1. 扩展全局可选功能开关

**修改文件**

- `install/options.jsonc`
- `install/locales/en.json`
- `install/locales/zh-CN.json`
- `docs/maintenance/options.md`
- `docs/zh/maintenance/options.md`

**实现**

1. 新增 `tgrep` 开关，默认 `false`。
2. 文案明确：用户须自行安装 tgrep；该功能创建本地 `.tgrep/` 缓存，不能提交；它不提供语义代码图能力。
3. 若 options 配置并非 MCP 配置，不要将 tgrep 伪装为 MCP server。
4. 配置支持可选的固定索引策略字段（至少：`indexPath`、`maxFileSize`、`exclude`、`noRequireGit`），并定义默认值与 schema 校验；未配置时只使用 tgrep 默认行为。

**验收测试**

- 默认安装/配置后 tgrep 为禁用状态。
- 开关开启时，配置解析产出稳定的、可复用的索引参数数组。
- 非法参数（空排除目录、非法文件大小、越出项目根目录的 indexPath）被拒绝并给出可行动错误。

#### A2. 将 tgrep 追加到项目生命周期 registry

**修改文件**

- `plugins/project-manager/project-hooks.jsonc`
- `plugins/project-manager/project-hooks-loader.ts`
- `plugins/project-manager/project-manager-index.ts`
- `plugins/project-manager/project-manager-command.ts`

**实现**

1. 将 registry 的 backend 类型从固定的 `codegraph | gitnexus | dbhub` 扩展为包含 `tgrep`，并保持未知 backend 的安全拒绝。
2. 新增 tgrep CLI 探测：Windows 使用 `where.exe tgrep`；类 Unix 使用 `command -v tgrep`，随后运行 `tgrep --version` 确认可执行。
3. 新增 tgrep probe 状态，至少包含：启用状态、CLI 状态、`.tgrep/` 是否存在、server 可达性、`tgrep status .` 是否报告 `Indexing: complete`、索引策略指纹是否匹配。
4. registry 的 init action 在 `enabled + CLI installed + index missing` 时运行参数一致的 `tgrep index .`。
5. registry 的 index action 仅在 `enabled + CLI installed + index exists + server not healthy` 或“策略/版本不匹配”时运行 `tgrep index .`；健康 server 必须产生 skipped 结果和原因。
6. 任何 `tgrep status`、版本探测或构建失败不得使 `/project init` / `/project index` 整体崩溃；记录为该 backend 的 `failed` 或 `skipped`。

**验收测试**

- tgrep 禁用或 CLI 缺失时，不产生子进程调用。
- 缺少 `.tgrep/` 时 `/project init` 规划 `tgrep index .`，`/project index` 不负责首次构建。
- 有 `.tgrep/` 且 server 健康时 `/project index` 跳过重建。
- 有 `.tgrep/` 但服务不存在、索引不完整或策略不一致时 `/project index` 规划重建。
- Windows 与非 Windows 的 CLI 探测命令均被单元测试覆盖。

#### A3. 安全处理 `.tgrep/`

**修改文件**

- `plugins/project-manager/project-manager-scaffold.ts`
- `plugins/project-manager/project-manager-command.ts`
- `tests/test-project-manager-unit.ts`

**实现**

1. 增加一个“只追加、幂等、不覆盖”的 `.gitignore` 条目管理函数，写入 `.tgrep/`。
2. 仅在 tgrep 成功启用/初始化时调用该函数；不因用户仅安装 tgrep 而修改项目文件。
3. 已有 `.gitignore`、已有等价规则（`.tgrep`、`.tgrep/`、`**/.tgrep/`）或不存在 Git 仓库时都必须有明确定义：前两者不重复写入；非 Git 仓库不创建 `.gitignore`，但在结果里提示索引为本地缓存。
4. 不删除用户的 `.gitignore` 规则；关闭开关也不自动删除 `.tgrep/` 或 ignore 条目。

**验收测试**

- 新条目恰好追加一次；重复执行字节稳定。
- 用户自定义 `.gitignore` 原样保留。
- 等价忽略规则不重复。
- 非 Git 目录不创建 `.gitignore`。

### Phase B — 服务管理与查询路由

#### B1. 定义显式的 server 生命周期接口

**新增文件**

- `plugins/tgrep/tgrep-service.ts`
- `plugins/tgrep/tgrep-config.ts`

**修改文件**

- `plugins/project-manager/project-manager-index.ts`
- `plugins/project-profiler/*`（仅注入紧凑就绪状态）

**实现**

1. 实现纯函数/薄封装，负责构造 `tgrep index .`、`tgrep serve .`、`tgrep status .` 命令以及固定参数；严禁从 Agent 文本直接拼 shell 命令。
2. `ensureServer(root)` 只在显式启用的会话入口调用：先查询 status，已有健康 server 即复用；无 server 但完整索引存在时才启动 `tgrep serve .`。
3. `serve` 进程必须记录其 PID、root、启动参数、启动时间和退出状态；并避免同一 root 并发启动多个 server。
4. 进程启动后轮询 `tgrep status .`，直到 complete 或给定超时。构建中不得把索引搜索声明为可用。
5. 会话退出仅清理由 OCP 启动且无其他租约的 server；绝不杀死用户手工启动、无法归属或属于另一工作区的进程。
6. 若无法安全托管后台进程，降级到磁盘索引模式，且 readiness 标记为 `disk-index`，不是 `server`。

**验收测试**

- 已有健康 server：不重复 spawn。
- 缺 server + 完整索引：只启动一个服务。
- 冷启动构建中：状态为 `building`，不会给查询路由发出“索引完整”的承诺。
- 子进程退出、错误 status 或超时：清理租约并标为不可用。
- 多次并发 `ensureServer`：只触发一次启动。

#### B2. 暴露受限的 tgrep 搜索能力并保留回退

**新增文件**

- `plugins/tgrep/tgrep-search.ts`
- `tests/test-tgrep-search-unit.ts`

**修改文件**

- `plugins/lite-tools.ts`
- `prompts/lite.md`
- `prompts/explore.md`
- `prompts/code.md`

**实现**

1. 定义结构化搜索输入：`pattern`、相对 root 的 `path`、受 allowlist 限制的 flags、`freshness: indexed | current`。
2. 对 path 做 canonicalize，拒绝解析后逃出 workspace root 的路径；pattern 永远通过 argv 传递，使用 `--` 分隔，禁止 shell 拼接。
3. 默认 `freshness=indexed`：tgrep ready 时直接走 watcher；no-watcher（磁盘索引存在但 watcher 未起）时工具内部 `ensureServer` 自动拉起 watcher 后再查询（首次有一次性启动开销）；no-index（CLI 在但 `.tgrep/` 不存在）时路由到现有 grep/ripgrep 搜索能力。自动拉起的目的是打破"LLM 看不到 ready 就不会调 tgrep_search、watcher 永远不会被触发"的死锁。
4. `freshness=current` 强制 `tgrep --no-index`，或在 tgrep 不可用时使用现有 grep/ripgrep；该模式用于编辑后确认、搜不到的否定结论和验证任务。
5. 对会绕过索引的 flags（如 `--hidden`、`--no-ignore`、`-a`、`--binary`、`--encoding`、显式单文件）做显式标注：要么直接执行 current/full scan，要么走回退，不可声称获得索引加速。
6. 正确处理 exit code：0=有结果，1=无结果，2=错误；保留 stderr，避免吞掉“索引不存在”“server 不可达”等诊断。
7. 只在 profile 报告 tgrep ready 后，提示 Agent 对宽泛、多次的文本检索优先使用 tgrep；符号、引用、影响面仍优先走 Serena/CodeGraph/GitNexus。

**验收测试**

- pattern 含空格、引号、`--`、正则元字符时不会造成参数注入。
- 路径越界、绝对路径越界、符号链接越界均拒绝。
- `indexed` 在服务不可用时回退；`current` 永不读取陈旧索引。
- exit code 1 映射为“无匹配”而非执行失败；exit code 2 保留 stderr。
- 不支持/绕过索引的 flags 不会被错误标示为 tgrep 快路径。

### Phase C — 文档、诊断与端到端验证

#### C1. 更新用户与维护文档

**修改文件**

- `docs/core/mcp-servers.md`
- `docs/zh/core/mcp-servers.md`
- `docs/workflows/plugins.md`
- `docs/zh/workflows/plugins.md`
- `docs/maintenance/ocp-cli.md`
- `docs/zh/maintenance/ocp-cli.md`
- `README.md`
- `README.zh-CN.md`

**内容要求**

1. 将 tgrep 描述为“可选全文检索索引”，不要写成 MCP、LSP 或代码图谱。
2. 文档化初始化、启动服务、状态检查、健康/构建中/磁盘索引/回退状态。
3. 明确 `.tgrep/` 不可提交，默认 64 MiB 文件大小限制，以及 index/serve/search 参数须保持一致。
4. 文档化强一致搜索规则：刚保存、验证变更、做“没有匹配”的断言时使用 current/full scan。
5. 文档化与 CodeGraph/GitNexus 的职责边界和维护时机对照。
6. 给出 Windows、macOS、Linux 的官方安装链接，不复制未校验的下载脚本；安装与校验由用户控制。

#### C2. 自动化测试与跨平台冒烟

**修改文件**

- `tests/test-project-manager-unit.ts`
- `tests/test-tgrep-search-unit.ts`
- `.github/workflows/*`（若现有 CI 有对应矩阵，否则新增单独的非阻断 job）

**实现**

1. 将 tgrep 规划、配置指纹、状态解析和命令构造写成不依赖真实 tgrep 的单元测试。
2. 为真实 CLI 增加 opt-in integration suite：环境变量指定已安装的 `tgrep`；否则明确 skip，不能让默认 CI 下载未固定版本的二进制。
3. 集成测试临时 Git 仓库覆盖：初建索引、serve 增量更新、刚写入后的 current 搜索、server 终止后的磁盘索引、策略变更重建。
4. 在 Windows、macOS、Linux runner 上运行同一套 opt-in 冒烟；最低要求是 `tgrep --version`、`index`、`status`、固定字符串搜索和 `--no-index` 搜索。
5. 为高频搜索准备可复现 benchmark 脚本：记录仓库文件数、冷建索引时间、热查询 P50/P95、`rg` 对照、tgrep 索引大小和内存；不把供应商 README 中的基准当作本项目验收。

**验收门槛**

- 所有现有 project-manager 单测继续通过。
- 新增 planner/search 单测在 Windows 与 Linux 上通过。
- 三平台冒烟在固定 tgrep 版本上通过，或明确标识 unsupported 架构。
- 目标大仓库的热查询 P95 相比 `rg` 有可测收益；若没有收益，保持默认关闭且不宣传性能加速。

## 5. 建议实施顺序与依赖

1. **A1**（配置）→ 后续所有任务。
2. **A2**（registry/planner）与 **A3**（ignore 管理）并行。
3. **B1** 依赖 A1/A2；先建立 server 状态模型。
4. **B2** 依赖 B1；只有 readiness 和回退语义稳定后才调整 Agent 指引。
5. **C1/C2** 依赖 A、B 完成；文档以最终状态字段和命令行为准。

## 6. 回滚与故障处置

| 风险 | 检测 | 处置 |
| --- | --- | --- |
| tgrep 索引不完整或 watcher 滞后 | `status` 非 complete、编辑后缺匹配、server 错误 | 不使用索引；current/full scan 回退；后台重建或重启。 |
| server 僵尸、端口冲突或重复启动 | PID/port 与 `serve.json`、进程归属不一致 | 只停止由 OCP 可证明启动的服务；其他情况报告给用户，不强杀。 |
| 规则参数不一致导致漏文件 | 策略指纹与 `.tgrep` metadata 不同 | 标记 stale，重建；查询走 full scan 直到成功。 |
| `.tgrep/` 被提交 | Git 状态/CI 检查发现 | 添加 ignore 条目；不自动删除已跟踪文件，提示用户显式处理。 |
| tgrep 安装、版本或平台不可用 | CLI probe / integration test | 禁用后端、保留 rg/grep 行为；不阻塞其他 project backends。 |
| 外部二进制供应链风险 | 安装流程审计 | OCP 不自动下载；仅文档化官方 release 与 checksum 验证。 |

## 7. 最终验收清单

- [ ] tgrep 默认为关闭；未安装时 OCP 所有既有行为不变。
- [ ] 用户显式启用且已安装 CLI 后，`/project init` 只进行首次本地索引构建。
- [ ] 健康的 `tgrep serve` 负责日常增量更新，`/project index` 不无谓重建。
- [ ] 当前工作树验证始终走 `--no-index` 或 `rg`，不会依赖异步索引。
- [ ] 所有搜索路径阻止目录逃逸和参数注入，并保留原始 stderr/退出码语义。
- [ ] `.tgrep/` 不会被提交，且用户 `.gitignore` 从不被覆盖。
- [ ] CodeGraph、GitNexus、Serena 的启用、查询与索引维护语义没有回归。
- [ ] 文档、单元测试、可选集成测试和跨平台冒烟均已完成并记录实际结果。

## 8. 实现完成后的验证命令

```text
bun run tests/test-project-manager-unit.ts
bun run tests/test-tgrep-search-unit.ts
bun run tests/test-sdd-unit.ts
```

真实 CLI（仅在用户已安装并显式启用 tgrep 的临时测试仓库）应额外执行：

```text
tgrep --version
tgrep index .
tgrep serve .
tgrep status .
tgrep -F -- "known literal" .
tgrep --no-index -F -- "just-written literal" .
```
