# OCP 命令行参考（`ocp` / `opencode-prime`）

完成一次 `register`（或默认安装）后，仓库会在 `~/.local/bin` 注册两个全局命令：`ocp`（3 字母极简形式）与 `opencode-prime`（完整品牌名）。两者共用同一个分发器（bash 为 `bin/opencode-prime`，PowerShell 7+ 为 `bin/opencode-prime.ps1`），因此下文所有命令对每个名字都同样适用。

> 💡 自 v0.8.0 起，CLI 同时也是一个**运行时启动器**：直接运行不带参数的 `ocp` 会启动 OpenCode 终端界面，而不再是打开安装控制台。全景控制台仍然一条命令直达 —— `ocp dashboard`。

---

## 命令清单

| 命令 | 别名 | 说明 |
| :--- | :--- | :--- |
| `ocp` *（无参数）* | | 在当前 shell **直接启动 OpenCode 终端界面** |
| `ocp tui` | | 默认通过所选的**工作区包装器**（Herdr 或 Luvus）启动 OpenCode 终端 TUI。加 `--init` 可在启动前创建/激活当前目录的 OCP 项目；加 `--direct`、`--herdr` 或 `--luvus` 可单次覆盖启动模式。 |
| `ocp serve` | | 启动无头 OpenCode 服务（`opencode serve`）；额外参数透传（如 `ocp serve --port 4096`） |
| `ocp web` | | 启动 **OpenChamber Web 界面**（`openchamber serve`）；自动生成 `--ui-password`，未指定端口时自动从 3000 起挑选空闲端口（详见[端口与密码策略](#web-端口与密码策略)） |
| `ocp code` | | 在 **VS Code** 中打开当前项目（同时探测 `code-insiders` / `codium` / `cursor` / `windsurf`），并保证 OpenChamber 编辑器扩展就绪：缺失时自动通过编辑器 CLI 安装 `fedaykindev.openchamber`。加 `--init` 可在启动前创建/激活 OCP 项目；裸 `.` 会原样透传，让 VS Code 打开当前目录 |
| `ocp desktop` | `ocp ui` | 启动 **OpenChamber 原生桌面应用**（需从 [openchamber.dev/download](https://openchamber.dev/download) 单独下载） |
| `ocp project` | | 在当前目录创建或激活 OCP 项目；交互终端中会打开项目向导 |
| `ocp project init` | | 在当前目录创建或激活 OCP 项目：缺少基线文件时创建，已有项目时同步并刷新索引 |
| `ocp project index` | | 手动刷新当前项目的代码智能索引 |
| `ocp project sync` | | 将新增的模板开关追加到现有项目配置（仅追加，绝不覆盖） |
| `ocp usage [--all\|.\|sessionId]` | | 打开 Token 与费用用量视图：默认跨全部项目，也可限定当前目录或单个会话 |
| `ocp session list` | | 列出会话（透传 `opencode session list`） |
| `ocp session delete` | | 按 ID 删除会话（透传 `opencode session delete`） |
| `ocp session clean` | | 按日期批量清理旧会话。用法：`ocp session clean --days 7 [--dry-run] [-y] [--project <id|name>] [--directory <path>]` |
| `ocp install` | | 将当前版本的清单应用到目标目录（默认 `~/.config/opencode`） |
| `ocp update` | | 检查套件本体（`main` 分支最新 `install/version.json` 对比 `~/.config/opencode` 已安装版本）**和**配套工具（`opencode`、`openchamber`）。所有可用更新默认全部勾选——交互终端中按回车应用、输 `n` 跳过；加 `-y` 可不经确认自动应用全部待更新项（适合脚本/定时任务）；加 `--check-only` 则只探测版本、不做任何修改（非交互运行且未加 `-y` 时默认如此）。大陆用户遇到 raw.githubusercontent.com 探测失败时设 `OCP_RAW_MIRROR`；探测 rtk/herdr/opencode 用的 `api.github.com` 经常被限速（HTTP 429）时设 `OCP_API_MIRROR`（镜像变量都接受 ghproxy 类 prefix 拼接）。 |
| `ocp upgrade` | | 拉取最新发布包并重新应用安装器：git 克隆走 `git pull --ff-only`，否则从 GitHub Releases 下载 `opencode-prime-latest.{tar.gz,zip}`（与一键安装同源；官方源失败时可用 `OCP_RELEASE_MIRROR` 设置 ghproxy 类镜像前缀回退；版本探测的 raw.githubusercontent.com 失败则用 `OCP_RAW_MIRROR`）。加 `--force` 可在版本相同时强制重放 |
| `ocp init` | | 备份并清空整个目标目录，全新开始 |
| `ocp uninstall` | | 从目标目录移除当前版本清单中的文件 |
| `ocp status` | | 对比已安装版本与仓库版本 |
| `ocp register` | | 将全局 shim（`opencode-prime`、`ocp`）安装到 `~/.local/bin`，**并**确保该目录已加入 `PATH` |
| `ocp unregister` | | 移除 `~/.local/bin` 中的全局 shim |
| `ocp wizard` | `ocp menu` | 交互式 TUI 安装向导（首次安装与重新配置） |
| `ocp dashboard` | `ocp cc`、`ocp matrix` | 单屏 TUI 全景控制台 —— 切换 MCP 服务 / 插件 / RTK、循环调整 Agent 模型梯队，然后一键安装 |
| `ocp provider` | | 管理模型服务商 —— 不带子命令时运行与 `/provider` 相同的 standalone 对话框向导（添加、导入、编辑、删除）；`ocp provider list` 无需 TTY 即可列出已配置服务商 |
| `ocp profile` | | 管理模型层级预设 —— 不带子命令时运行与 `/profile` 相同的 standalone 对话框向导；`ocp profile list`、`ocp profile apply <名称>`、`ocp profile reset --yes` 可非交互运行（裸 `profile reset` 会先要求确认） |
| `ocp auth open` | | 用默认编辑器打开 OpenCode 的 `auth.json`；文件不存在时会自动创建一个空文件 |
| `ocp version` | `ocp --version`、`ocp -v` | 打印仓库当前版本（`install/version.json`） |
| `ocp help` | `ocp -h`、`ocp --help` | 打印命令帮助 |
| *（其他任意输入）* | | 透传给 `install.ps1` / `install.sh`，因此未知参数与未来新增子命令在升级后依然可用 |

---

## 启动类子命令详解

### `ocp tui` — 终端界面

要求 `opencode` 在 PATH 上（安装器会自动拉取）。`tui` 之后的全部参数原样传给 `opencode`：

```bash
ocp tui                     # 直接进入终端界面
ocp tui --version           # opencode 自身的 --version
```

`ocp tui` 是经工作区包装的终端客户端：可在安装向导中选择 **Herdr** 或 **Luvus**，选中的集成会在其受管工作区中启动 OpenCode；希望直接使用终端客户端时，请运行裸 `ocp`。

单次直接启动终端界面：

```bash
ocp tui --direct            # 强制 direct（当前 shell 启动 opencode）
ocp tui --herdr             # 单次强制使用 Herdr 工作区包装器
ocp tui --luvus             # 单次强制使用 Luvus 工作区包装器
```

裸调用 `ocp`（不带任何参数）始终直接打开 `opencode`。

### `ocp serve` — 无头服务

纯透传给 `opencode serve`，适合 ACP/HTTP 客户端连接常驻引擎：

```bash
ocp serve                   # 默认由 opencode 随机分配端口
ocp serve --port 4096       # 固定端口
```

### `ocp web` — OpenChamber Web 界面

依赖 `openchamber` CLI（在 `install/options.jsonc` 中设 `"openchamber_web": true` 后才会自动拉取，需 Node.js 22+）。行为要点：

- **全新会话**：若已有 OpenChamber 实例在运行，会先将其停止（否则携带新 `--ui-password` 的启动会因端口占用而失败，白白泄露一个密码）；
- **密码**：除非你自己传入 `--ui-password`，否则会自动生成并打印一个随机密码（`🔑 OpenChamber web UI password: ...`）；
- 其余参数透传给 `openchamber serve`。

```bash
ocp web                     # 自动空闲端口（从 3000 起）+ 自动生成密码
ocp web --port 3200         # 固定端口（尽量从僵尸进程手中回收）
ocp web --ui-password s3cret # 自带密码
```

#### Web 端口与密码策略

| 情形 | `ocp web` 的处理 |
| :--- | :--- |
| 未指定 `--port` / `-p` / `--port=N` | 自动挑选 `3000–3199` 中第一个空闲端口并注入 |
| 请求 `--port 0`（随机端口） | 同样解析为 `3000–3199` 中第一个空闲端口 |
| 指定端口被占用（僵尸守护进程） | 先执行 `openchamber stop --port <n>` 并等待最多 5 秒，随后**仅当**监听进程命令行确认属于 OpenChamber 时强制结束。若端口仍无法回收：`ocp` / `opencode-prime` 分发器会报出占用 PID 后退出（可手动 `taskkill` / `kill`），而 TS 引擎路径（`install.ps1 web`）会自动回退到下一个空闲端口 |
| OpenChamber 已在运行 | 停止现有实例，以新密码启动全新会话 |

### `ocp desktop`（别名 `ocp ui`）— 原生桌面应用

基于 Tauri 的桌面应用通常不在 `PATH` 上，启动器会探测常见安装位置（Windows：`%LOCALAPPDATA%\Programs`、`%LOCALAPPDATA%`、`Program Files*`；Linux：`~/.Applications`、`/usr/local/bin`、`/opt`；macOS：经 LaunchServices 执行 `open -a OpenChamber`）。找不到时会提示前往 <https://openchamber.dev/download> 下载 —— 安装器从不下载桌面应用，只会拉取支撑 `ocp web` 的 `openchamber` **CLI**。

### `ocp code` — 带 OpenChamber 扩展的 VS Code

在 VS Code 中打开当前项目，并确保 OpenChamber 编辑器扩展（VS Code Marketplace 上的 `fedaykindev.openchamber`，同时发布于 OpenVSX）已安装——该扩展在编辑器内提供同一套 OpenChamber 审查界面。

编辑器 CLI 解析顺序：`code` → `code-insiders` → `codium` → `cursor` → `windsurf`，取第一个可解析的 CLI。在 Windows 上解析器经由 `where.exe` 并只接受 `.cmd` shim，因此即使 GUI 的 `Code.exe` 在 PATH 上遮蔽了 CLI，也不会静默吞掉扩展检查。

- `--init`：启动前在当前目录创建/激活 OCP 项目（同 `ocp ui --init`）。
- 裸 `.` **不会**被吞掉：VS Code 自身将其解释为"打开当前目录"，因此 `ocp code .` 会原样透传。
- 其余参数全部原样转发（`ocp code -n` 新开窗口、`ocp code <dir>` 打开指定目录等）。
- 扩展安装失败不会阻塞启动——只报告结果并照常打开编辑器。
- 自动安装默认关闭；在 `install/options.jsonc` 中设 `"openchamber_vscode": true` 才启用。关闭时 `ocp code` 仅打开编辑器。

```bash
ocp code                 # 打开 VS Code，确保扩展就绪
ocp code .               # 同上，并打开当前目录
ocp code --init          # 先创建/激活 OCP 项目，再打开 VS Code
ocp code -n .            # 在新窗口中打开当前目录
```

### `ocp session` — 会话管理

统一的会话管理入口。`list` 和 `delete` 原样透传给 `opencode` CLI；`clean` 提供按日期批量清理功能。

#### 透传命令

```bash
ocp session list                        # 列出近期会话
ocp session list --format json -n 20    # JSON 输出，最近 20 条
ocp session delete <sessionID>          # 删除指定会话
```

#### `ocp session clean` — 批量清理

通过官方 `opencode session delete` CLI 删除旧会话 —— 不直接操作数据库，所有存储操作均经由引擎。需要 `opencode` 在 PATH 上。

| 参数 | 别名 | 说明 |
| :--- | :--- | :--- |
| `--days <n>` | `-d <n>` | 删除超过 *n* 天的会话（默认 7） |
| `--all` | | 删除当前工作区的全部会话（包括子代理会话）。即使指定 `-y` 也需要确认。 |
| `--projects` | | 与 `--all` 一起使用，删除所有已保存项目的会话。不能与 `--project`、`--directory` 或 `--cwd` 同用；始终需要确认。 |
| `--all-projects` | | `--all --projects` 的简写。 |
| `--project <id\|name>` | | 按 `project_id` 或项目路径/名称删除。如果值不是 40 位十六进制 ID，会自动按路径解析为 ID。 |
| `--project-name <name>` | | `--project` 的别名，用于明确按名称/路径传入时 |
| `--directory <path>` | `--dir <path>` | 仅删除工作区路径完全匹配的会话。使用 `--cwd` 匹配当前目录。 |
| `--cwd` | | 匹配当前工作目录（`--directory <当前目录>` 的简写） |
| `--dry-run` | | 预览将被删除的内容，不实际执行 |
| `--include-subagents` | | 同时删除子代理（子）会话（默认排除） |
| `-y`、`--yes` | | 跳过确认提示 |

```bash
ocp session clean --dry-run             # 预览 —— 哪些会话会被删除？
ocp session clean --days 3              # 删除超过 3 天的会话
ocp session clean --days 30 -y          # 删除超过 30 天的会话，不提示
ocp session clean -d 7 --include-subagents  # 包含子代理会话
ocp session clean --cwd --days 1        # 清理当前工作空间的旧会话
ocp session clean --all --projects --dry-run  # 预览清理所有项目的全部会话
ocp session clean --all --projects      # 删除所有项目的全部会话（需要确认）
ocp session clean --all-projects        # --all --projects 的简写
ocp session clean --project <project_id> --days 7  # 清理指定项目的旧会话
ocp session clean --project opencode-prime --days 7  # 按项目路径/名称清理
```

命令在删除前会打印摘要：会话数量、时间分布、Token 用量，以及最多 10 条示例会话标题。删除操作通过 `opencode session delete`（官方 CLI）执行，所有存储操作均经由引擎 —— 不直接操作数据库。

---

## 项目子命令

`ocp project` 是 `/project` 斜杠命令族的终端入口，操作对象为**当前工作目录**，而不是安装目标目录。不带子命令时等同 `ocp project init`，交互终端中会打开项目向导；脚本中使用 `ocp project init --headless` 跳过提示。

| 命令 | 说明 |
| :--- | :--- |
| `ocp project init` | 缺少基线文件时创建；已有项目时同步配置并刷新索引。绝不覆盖现有文件。启用 gitnexus 时注册 `post-commit`、`post-merge`、`post-checkout` Git hook；未启用时移除它们。 |
| `ocp project index` | 刷新已有代码智能索引（`codegraph sync`，以及过期时的 `gitnexus analyze`）。 |
| `ocp project sync` | 将新增模板开关追加到项目配置；已有内容不变。 |

```bash
ocp project                 # 在当前目录创建/激活项目
ocp project init            # 同上
ocp project index           # 刷新已有项目的索引
ocp project sync            # 追加缺失的模板开关
```

---

## 用量统计

`ocp usage [--all|.|sessionId]` 打开 Token 与费用用量视图：

| 参数 | 范围 |
| :--- | :--- |
| *(不传)* 或 `--all` | 全部项目（默认） |
| `.` | 当前工作目录 |
| `<sessionId>` | 指定单个会话 |

```bash
ocp usage                 # 查看全部项目的用量
ocp usage .               # 查看当前目录的用量
ocp usage <sessionId>     # 直接查看指定会话
```

---

## 安装类子命令

`install` / `update` / `upgrade` / `init` / `uninstall` / `status` 是 `install.ps1` / `install.sh`（同一套 TypeScript 引擎）的薄封装。常用透传参数：

| 参数 | 别名 | 说明 |
| :--- | :--- | :--- |
| `-Target <dir>` | `--target`、`-t` | 覆盖安装目标目录（默认 `~/.config/opencode`） |
| `-Force` | `--force`、`-f` | 即使文件未变化也全量重放清单 |
| `-BinDir <dir>` | | 为 `register` / `unregister` 指定自定义 shim 目录（默认 `~/.local/bin`） |

```bash
ocp install                 # 常规安装 / 升级（凭证全保留）
ocp install -Force          # 强制重放全部文件
ocp install -t ~/oc-test    # 安装到临时目标目录
ocp register -BinDir ~/bin  # shim 安装到自定义目录
```

### `register` 与 `unregister`

`register` 现在做两件事：把三个 shim 写入 bin 目录，**并**确保该目录在新终端中可用 —— Windows 上将其追加进用户 `PATH` 注册表值（通过 `[Environment]::SetEnvironmentVariable`，绝不使用 `setx`，长 PATH 值不会被截断）；POSIX 上向 shell 配置文件（`~/.zshrc`、`~/.bashrc` 或 `~/.profile`，带托管标记守卫）追加 `export PATH` 块。`unregister` 只移除 shim，不会改动你的 `PATH`。

---

## 服务商与配置方案命令

这些命令与 TUI 的 `/provider`、`/profile` 共享状态和核心逻辑。

```bash
ocp provider list             # 列出已配置服务商
ocp provider                  # 添加、导入、编辑或删除服务商
ocp profile list              # 列出已安装配置方案
ocp profile apply <名称>     # 应用配置方案并写入 opencode.jsonc
ocp profile reset --yes      # 非交互直接移除模型引用
ocp profile                  # 交互式选择并应用配置方案
```

不带子命令时，`ocp provider` 与 `ocp profile` 直接运行与 `/provider`、`/profile` 相同的 standalone 对话框向导，包含嵌套菜单、确认步骤和 Esc 逐级返回。模型目录走统一的 OpenCode bridge：内置 TUI 使用 OpenCode SDK bridge，standalone 使用 `opencode` CLI bridge（`models --verbose`）；不可用时自动落到 `models.dev` / 本地配置文件。交互与斜杠命令一致。`provider list`、`profile list`、`profile apply <名称>`、`profile reset --yes` 可非交互运行；非 TTY 下交互模式返回退出码 1 并提示替代命令。

## 相关页面

- [安装器选项与进阶配置](/zh/maintenance/options) —— 安装命令、`options.jsonc` 开关（含 `global_commands` 与 `openchamber`）与字段保留策略
- [快速安装与全景控制台](/zh/getting-started/) —— 首次安装与 TUI 控制中心
- [客户端与交互界面](/zh/getting-started/clients) —— TUI / Web / 桌面端一览
