# Audio Annotator V1 Implementation Plan

> **For agentic workers:** REQUIRED: Use the `subagent-driven-development` skill to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付用户已批准的 Windows 本地音频频谱标注应用，完成真实分析、1–6 通道标注、双文件对比、试听与暂存屏蔽、可靠保存及文件分享。

**Architecture:** React/TypeScript 管理工作区和交互，Rust 核心库管理媒体、分析、文档及 DSP，Tauri 2 提供命令、二进制 tile 传输和 Windows 宿主。业务模型以秒、Hz、通道索引和稳定 ID 表达；缓存和视图不成为标注真相源。所有实现阶段在一个隔离 worktree 中顺序完成，经双审查后前进。

**Tech Stack:** React 19、TypeScript、Vite、Tauri 2；Rust/MSVC、Serde、Symphonia、RustFFT、CPAL、Rubato、SHA-256、ZIP；Vitest/Testing Library、Rust tests、Selenium + tauri-driver。安装时锁定满足本机工具链的具体依赖版本并提交两个 lockfile。

---

## 0. 基线、执行规则和环境

规格：`docs/double-sdd/specs/2026-10-22-audio-annotator-design.md`，用户已于 2026-10-22 确认；独立审查 PASS。

当前仓库只有工作流配置和规格，没有应用代码。规格提交为 `c320f01`；实际实施基线必须在计划提交和 worktree 准备完成后重新记录，不能硬编码该提交为最终集成基线。

2026-10-22 已检查本机：Windows 11 Enterprise x64，AMD Ryzen 5 5600GT，约 31.3 GiB RAM；Node 22.23.3、npm 10.9.9、Rust/Cargo 1.91.0 MSVC、Visual Studio C++ 工具及 WebView2 155.0.4283.62 已存在。FFmpeg、tauri-driver、msedgedriver 不在 PATH，测试准备必须处理这点，不能将“命令不存在”误报为应用失败或跳过后算通过。

整个首版使用本计划一个文件；下列任务是依赖顺序，不是可单独删减的产品范围。每个任务由一个新 implementer 完成；不得并行修改同一计划的不同实现任务。每阶段结束均由 spec-code-reviewer 和 quality-code-reviewer 并行审查同一 `Base..Head`，先裁定规格审查。审查工作遵循 `code-review`，完成声明遵循 `verification-before-completion`。

实施前 orchestration 步骤：

- [x] 提交已审查计划，只暂存指定文档，不把 `.agents/`、`.codex/`、`.double-sdd/` 等现有用户配置顺带提交。
- [x] 将 `.worktrees/` 加入 `.git/info/exclude`（如果未忽略），检查 `git check-ignore .worktrees/check`。
- [x] 记录 `git branch --show-current` 和 `git rev-parse HEAD` 为不可变 `MAIN_BRANCH`/`MAIN_BASE`，保存在主工作区 `.worktrees/audio-annotator-v1.meta`；创建 `git worktree add .worktrees/audio-annotator-v1 -b feature/audio-annotator-v1 <MAIN_BASE>`。
- [x] 从此所有下面的相对路径及命令均在该 worktree 根目录执行。每任务开始记录当前 HEAD 为 TaskBase；实现提交使用 `tmp/sdd: ...`，修复仍通过 implementer。
- [x] 最终只 squash 集成完整通过的文件变更；不得把临时检查点以普通 merge 带回主分支，不覆盖主工作区期间新增的用户改动。

每个任务内的复合工程工作已经拆成可勾选小步骤；必要时 implementer 可在不改变接口和范围的前提下继续细分。未通过的测试不得更新期望值来掩盖错误。除数据/数值/交互边界之外，不为纯样式或文件存在性机械添加测试。

## 1. 目录与职责

| 路径 | 职责 |
|---|---|
| `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `index.html` | 前端构建、脚本和锁定依赖 |
| `Cargo.toml`, `Cargo.lock` | Rust workspace：`crates/annotator-core` 与 `src-tauri` |
| `src-tauri/src/lib.rs`, `main.rs`, `state.rs` | 宿主启动、服务持有和生命周期 |
| `src-tauri/src/commands/{project,media,analysis,playback,exchange}.rs` | 窄 Tauri 适配层；不把 DSP 或文件格式逻辑写进命令 |
| `src-tauri/tauri.conf.json`, `capabilities/main.json`, `build.rs`, `icons/` | Windows 配置、权限与安装资源 |
| `crates/annotator-core/src/model/{project,media,annotation,analysis,edit,validation}.rs` | 权威模型和规则，Serde camelCase |
| `crates/annotator-core/src/project/{session,history,store,recovery,lock}.rs` | revision、编辑历史、原子保存、恢复与写锁 |
| `crates/annotator-core/src/media/{decode,identity,pcm_cache,registry}.rs` | 导入、流式指纹、分块 PCM、资源绑定 |
| `crates/annotator-core/src/analysis/{stft,mel,tiles,scheduler,cache}.rs` | 数值分析与任务调度，和 UI 解耦 |
| `crates/annotator-core/src/audio/{mask,stft_processor,mixer,resample,engine,device}.rs` | 稳定处理链、混合、重采样和原生输出 |
| `crates/annotator-core/src/exchange/{manifest,import,export,limits}.rs` | 交换文件、包校验与发布 |
| `crates/annotator-core/src/{lib,error}.rs` | 公开服务接口与可序列化错误 |
| `src/app/{App,AppShell}.tsx`, `src/app/{store,commands}.ts` | 页面组合、异步状态和命令串行队列 |
| `src/bridge/{client,types,events}.ts` | 类型与 Tauri 绑定；测试双替身只能在测试环境使用 |
| `src/features/project/`, `media/`, `spectrogram/`, `annotations/`, `playback/`, `exchange/` | 功能组件、hooks 和领域 UI |
| `src/styles/{tokens,global,layout,controls}.css` | 统一视觉、布局和交互状态 |
| `tests/fixtures/`, `scripts/generate-fixtures.mjs` | 自生成信号、压缩音频样本、来源和哈希 |
| `tests/desktop/`, `scripts/setup-webdriver.ps1`, `scripts/run-desktop-tests.mjs` | 真实 Windows 应用的 WebDriver 验证 |
| `docs/{development,user-guide,verification,third-party}.md` | 开发、使用、验收及许可记录 |

各 Rust 子目录均包含 `mod.rs`；前端组件由以下任务列出。一个模块超过其单一职责时可继续拆文件，但不得建立没有实际用途的通用插件框架。

## 2. 先锁定的接口和算法

### 2.1 文档与命令

所有 JSON 使用 camelCase；ID 为 UUID 字符串；时间/Hz 为有限 f64；时间戳为 UTC ISO8601；`formatVersion=1`。`ProjectDocument` 包含 `projectId,name,revision,createdAt,updatedAt,media,categories,annotations,edits,analysis,playbackMix,viewState,algorithmVersions`。`playbackMix` 按媒体 ID 保存 `{soloChannels: number[], mutedChannels: number[]}`，校验通道范围、去重并保存重开后恢复。缺失、恢复、计算、瞬时播放（设备句柄、缓冲、play/pause、游标）和保存状态属于运行态，不伪装成文档字段；混合选择不属于瞬时播放状态。

`MediaDescriptor` 包含 `id,displayName,sourceRef,sha256,byteLength,sampleRate,frameCount,channelCount,channelLayout,note,channelNotes`。`sourceRef` 只在本地文档包含路径，分享清单改为媒体相对路径或待关联描述。频谱区域统一为 `mediaId,channelIndex,startSeconds,endSeconds,lowHz,highHz`。

核心编辑入口固定为：`apply_change(projectId, expectedRevision, change) -> ProjectSnapshot`。`change` 是受限枚举，不接受任意 JSON patch：媒体导入/移除、三层备注、类别增删改、区域增删改、屏蔽增删改/启用、分析参数、`UpdatePlaybackMix` 与持久视图更新。媒体移除提示并处理其引用，包括对应 playbackMix；所有校验通过后一次性提交文档和 revision。撤销恢复内容时仍生成更高 revision，不能回退版本计数。混合选择和视图一样持久化但不进入内容撤销栈。

前端串行化持久变更；每次读取最新 revision，不同时对同一个旧 revision 发出多个写入。`RevisionConflict` 时保留文本草稿、刷新快照并提示，不盲目重放删除等不可交换操作。视图更新可合并且不进入内容撤销栈；`dirtyRevision` 与 `persistedRevision` 区分，较旧保存完成不能把较新文档标成已保存。

Tauri commands：`create_project`、`open_project`、`get_project_snapshot`、`apply_change`、`undo`、`redo`、`save_project`、`close_project`、`import_media`、`relink_media`、`request_tile`、`cancel_generation`、`set_playback`、`list_devices`、`export_annotations`、`export_bundle`、`import_exchange`。参数带明确项目/媒体标识；长任务返回 taskId 并通过 Channel/Event 报告进度，取消和错误是独立终态。

错误结构：`code,message,entityId?,retryable,details?`；code 至少覆盖 `InvalidInput,RevisionConflict,MissingMedia,IdentityMismatch,UnsupportedFormat,UnsupportedChannels,Cancelled,DecodeFailed,AnalysisFailed,DeviceFailed,SaveFailed,ProjectLocked,UnsupportedVersion,InvalidArchive,ResourceLimit`。日志不输出 PCM 或备注正文。

### 2.2 频谱与传输

STFT 幅度采用 `abs(FFT)/sum(window)`，非 DC/Nyquist bin 乘 2；dB 为 `20log10(max(amplitude,1e-8))`。固定参考下满幅 bin 对齐正弦接近 0 dB。梅尔使用单边能量补偿后的 `abs(FFT)^2/sum(window)^2`，三角带权重按权重和归一化；带 dB 为 `10log10(max(power,1e-16))`，UI 标注为相对带功率而非等同 STFT 幅度。

tile 基础分块为 256 分析帧；聚合 LOD 用线性功率均值，不能直接平均 dB。频率聚合保留 bin 区间/梅尔边界供渲染定位。请求包含 generation、分析配置 hash、通道、帧范围和 LOD，限制单响应为 4 MiB；返回少量 metadata 及独立原始 ArrayBuffer 数据，禁止 JSON/base64 浮点大数组。前端用同一请求 ID 关联头和数据并检查长度。

内存上限初值：Rust PCM 块缓存 128 MiB、分析 tile 缓存 128 MiB；前端 tile/图像缓存 96 MiB；后台分析工作线程上限 2，待处理队列最多 32，优先当前可见 tile。磁盘缓存初值 2 GiB LRU，活跃资源可暂时超出但禁止把项目媒体当缓存删除。解码 PCM 临时文件另计，按已知帧数预估空间并在写入时处理空间不足；失败删除自身未完成临时文件。

### 2.3 稳定试听处理

DSP v1 固定 FFT/window=2048、hop=512，periodic Hann 分析与合成，按累积窗平方权重逐样本归一化。首尾至少补一个窗的静音，输出裁剪回原始精确帧数；调可视 STFT 不改变 DSP v1。

频率边缘采用 raised-cosine 平滑，过渡宽度取 max(2 个 DSP bin, 20Hz)，且不超过选定带宽的一半；时间边缘取 min(10ms, 区域时长/2)。区域内部抑制权重为 1，边缘平滑到 0；所有启用区域的权重取 max，最终 mask=1-maxWeight。负频率镜像处理，不破坏实信号共轭对称。选区用相同带边缘的保留 mask。播放请求显式携带 `mode: original|processed|selection`；selection 另带 `selectionSource: original|processed`。原始选区忽略全部屏蔽但保留带通、时间裁剪和循环；处理后选区先应用屏蔽再执行同样的带通/裁剪/循环。整体旁路使本次处理走 original 来源而不删除屏蔽数据，UI 同时明确当前实际来源。

CPAL callback 仅消费预分配有界环形缓冲区、更新原子计数，不持文档锁、分配大块内存、读文件或 FFT。后台工作线程处理 PCM、混合和 Rubato 重采样；跳转、模式/通道/编辑变化递增 generation，清空旧缓冲并重新预缓冲。输出帧数结合设备采样率与源位置计算时间，不用 UI 计时器累加代替播放时钟。

### 2.4 文件与资源界限

本地目录：`project.json`、`project.json.bak`、`recovery.json`、`.project.lock`、可选 `media/`。当前工作草稿在原子发布前写为带 checksum/revision 的 recovery envelope；同目录临时写入 + flush/sync + Windows 原子替换实现主文件发布，备份保留上一有效文档。故障注入验证每个写入/替换边界；不得用“删除旧文件再重命名”的空窗替代。

锁使用 OS 文件锁（`fs2` 或同等 Windows 支持实现），锁内保存进程提示信息但不以遗留锁文件存在判断占用。崩溃后 OS 释放锁，第二实例不能写入活跃项目。恢复选项不默认为静默覆盖用户文档。

交换限制初值：清单 ≤16 MiB；ZIP ≤4096 entries、总解压 ≤20 GiB、单媒体 ≤8 GiB；流式累计实际解压字节，不只信任 central directory。内部路径禁止绝对路径、盘符、UNC、`..`、链接和 Windows 保留设备名；Windows 大小写折叠后检测重复。所有文件只写入本次新建的暂存目录，失败只清理该目录。

## Task 1: 可构建的 Windows 桌面骨架与视觉基础

**Files:** Create `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `index.html`, `.gitignore`, `Cargo.toml`, `Cargo.lock`, `crates/annotator-core/Cargo.toml`, `crates/annotator-core/src/lib.rs`, `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/main.json`, `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`, `src/main.tsx`, `src/app/App.tsx`, `src/app/AppShell.tsx`, `src/styles/tokens.css`, `src/styles/global.css`, `src/styles/layout.css`, `src/styles/controls.css`, `docs/development.md`.

- [x] 创建 React/TypeScript/Vite 项目和 Rust workspace，使用 `annotator-core` 为纯 Rust 库、`annotator-desktop` 为 Tauri 宿主。只生成需要的结构，不保留计数器模板页面。
- [x] 安装 React、Tauri API/dialog 插件和 lucide-react；开发依赖安装 TypeScript、Vite React 插件、Vitest、jsdom、Testing Library 和 Tauri CLI。选择兼容 Node 22.23/Rust 1.91 的版本，提交 lockfiles，不依赖未锁定全局 CLI。
- [x] 定义脚本 `dev`, `build`（类型检查后构建）, `typecheck`, `test`（vitest run）, `tauri`；Vite 使用固定 localhost 端口、strictPort，配置 Tauri beforeDevCommand/beforeBuildCommand 和 dist 路径。
- [x] 配置主窗口、中文标题、最小尺寸、CSP 和最小 capabilities；不开放 shell 或任意目录删除。注册 dialog 插件，空启动展示真实空态。
- [x] 实现五区布局与可折叠侧栏，中央为导入空态；统一 spacing、边框、字阶和暖色强调，按钮具备焦点/禁用/忙状态。未实现的操作不能呈现虚假成功。
- [x] 运行 `npm.cmd run build`、`cargo check --workspace`，期望 exit 0；运行 `npm.cmd run tauri -- dev`，确认真实窗口启动，记录 WebView2 错误（若有），终止本次启动进程而非全局杀同名进程。
- [x] 将工具链、开发命令和初始构建结果记入 `docs/development.md`。记录临时检查点 `tmp/sdd: desktop foundation`，进入双审查。

## Task 2: 文档模型、编辑事务和历史

**Files:** Create `crates/annotator-core/src/error.rs`, `crates/annotator-core/src/model/mod.rs`, `project.rs`, `media.rs`, `annotation.rs`, `analysis.rs`, `edit.rs`, `validation.rs`（后六项在 model/）；`crates/annotator-core/src/project/mod.rs`, `session.rs`, `history.rs`；`src/bridge/types.ts`, `src/bridge/client.ts`, `src/bridge/events.ts`, `src/app/commands.ts`, `src/app/store.ts`；`crates/annotator-core/tests/document.rs`, `tests/fixtures/document-v1.json`, `src/bridge/contracts.test.ts`, `src/app/commands.test.ts`. Modify 两个 lib.rs 及 Cargo manifests。

- [x] 先写 `document` 集成测试：非法/非有限区域、跨媒体通道引用、重复类别名、旧 revision、原子回滚、撤销后 revision 仍增长、混合选择的通道校验与媒体移除清理。`cargo test -p annotator-core --test document` 初次应因缺少模型或行为失败。
- [x] 实现上文 2.1 的模型和严格校验，所有创建/加载/导入共用验证器；格式版本先检查，再反序列化具体版本。时间上限以 frameCount/sampleRate 计算。
- [x] 实现受限 Change 枚举、事务、历史、撤销/重做。删除类别把相关区域设为未分类；删除媒体的关联区域/屏蔽在一个可撤销事务内处理。
- [x] 将媒体导入完成作为明确的可持久变更，未解码成功不进入文档；解码任务状态独立保存。文本变更支持合并键，视图变更不污染内容历史。
- [x] 实现 TS 对应类型与运行时输入边界，固定一份 document-v1.json 同时被 Rust/TS 测试读取，检查关键枚举/字段约定，防止两个类型系统漂移。
- [x] 实现前端串行命令队列：持久变更串行、草稿保留、revision conflict 不盲重放；测试两次快速编辑均保留，以及旧保存完成不清除新 dirty 状态。
- [x] 运行 `cargo test -p annotator-core --test document`、`npm.cmd test -- src/bridge/contracts.test.ts src/app/commands.test.ts`、`npm.cmd run typecheck`，期望全部通过；临时提交 `tmp/sdd: project model and transactions`。

## Task 3: 项目保存、恢复、锁和窗口生命周期

**Files:** Create `crates/annotator-core/src/project/store.rs`, `recovery.rs`, `lock.rs`；`src-tauri/src/state.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/commands/project.rs`；`src/features/project/ProjectActions.tsx`, `SaveIndicator.tsx`, `RecoveryDialog.tsx`, `useProjectLifecycle.ts`；`crates/annotator-core/tests/persistence.rs`, `src/features/project/lifecycle.test.tsx`. Modify `project/session.rs`, `src/app/App.tsx`, `src/app/store.ts`, `src-tauri/src/lib.rs`。

- [x] 先写临时目录集成测试：保存/重开（包括各媒体 solo/mute 选择）、主文件损坏且备份有效、recovery 较新、模拟写失败、两个 session 争抢锁、锁释放后重新打开。先运行并确认红灯源于缺失实现。
- [x] 实现 FileStore 及可注入故障点，按 2.4 原子发布，不删除已有主文件制造替换空窗。recovery/backup 具有可校验的 envelope；加载恢复候选但不自动作用户决定。
- [x] 实现 OS 写锁与释放路径，文件句柄生命周期绑定项目 session；清理仅限本次临时文件，始终使用规范化项目根路径。
- [x] 在 Rust 注册项目命令；create/open 使用原生文件夹/文件对话框，目录存在时不得静默覆盖项目。保存路径返回给 UI 时不混同分享路径。
- [x] 实现保存调度：1 秒防抖、5 秒最大尝试间隔、单保存队列、revision 快照一致；保存失败保留内存，状态可重试。
- [x] 实现切换/关闭前提交草稿与等待保存；Tauri CloseRequested 阻止未处理关闭，失败展示重试/另存/放弃/取消，不启动多个递归关闭处理器。
- [x] 接入项目菜单、保存状态、恢复对话框，快捷键 Ctrl+S 在编辑器中仍能先提交草稿。
- [x] 运行 `cargo test -p annotator-core --test persistence`、`npm.cmd test -- src/features/project/lifecycle.test.tsx`、`cargo check --workspace`、`npm.cmd run build`，全部通过后提交 `tmp/sdd: durable local projects`。

## Task 4: 音频导入、指纹和分块采样

**Files:** Create `crates/annotator-core/src/media/mod.rs`, `decode.rs`, `identity.rs`, `pcm_cache.rs`, `registry.rs`；`src-tauri/src/commands/media.rs`；`src/features/media/MediaList.tsx`, `ImportProgress.tsx`, `RelinkDialog.tsx`；`scripts/generate-fixtures.mjs`, `tests/fixtures/README.md`, `tests/fixtures/audio/`；`crates/annotator-core/tests/media.rs`. Modify `package.json`, lockfiles, `src/app/App.tsx`, `src-tauri/src/state.rs`。

- [x] 添加仅开发使用的 `ffmpeg-static`，`scripts/generate-fixtures.mjs` 用内置 Node Buffer 产生确定的 PCM WAV，再通过 spawnSync(ffmpegPath, argsArray) 产生 FLAC/MP3。命令 `npm.cmd run fixtures` 输出短的 mono/stereo/six-channel、自选整数/浮点 WAV、静音/短于窗长/双音样本和 SHA-256 清单；压缩样本来自自生成信号，不下载未知版权音频。
- [x] 将小样本和生成方式提交；`npm.cmd run fixtures -- --perf` 单独生成 10 分钟/48k/6ch 性能文件到忽略的 `.test-output/`，不把大型生成文件提交仓库。
- [x] 写 `media` 测试：WAV 16/24/32/float、FLAC、MP3 的实际解码，1/2/6 通道可区分频率；损坏/0 帧/7 通道拒绝；MP3 以实际解码帧数而非近似容器时长建立元数据。
- [x] 用 Symphonia 明确启用 wav/pcm/flac/mp3 支持，分块读取和解码为交错 f32 临时 PCM 文件，记录精确帧数；读错误和不支持编码不得映射为 EOS 成功。
- [x] 流式计算原字节 SHA-256，导入前后确认 size/mtime 未改变；解码取消或失败不发布半成品缓存。非有限 float 输入映射为明确损坏错误，不让 NaN 进入 DSP。
- [x] 实现按帧范围读 PCM、128 MiB LRU 和媒体指纹/元数据关联；外部文件移动可按指纹重绑，不同指纹拒绝。播放和分析前重检源 stat，发现变化进入重新校验流程。
- [x] 接入批量导入、逐文件失败结果与取消、音频列表搜索/计数，以及缺失媒体的重新关联 UI；缺失媒体仍可显示文档文字。
- [x] 运行 `npm.cmd run fixtures`、`cargo test -p annotator-core --test media`、`cargo check --workspace`、`npm.cmd run build`；确认测试真实打开格式文件。提交 `tmp/sdd: audio import and chunked media`。

## Task 5: 数值频谱、tile 缓存与后台任务

**Files:** Create `crates/annotator-core/src/analysis/mod.rs`, `stft.rs`, `mel.rs`, `tiles.rs`, `scheduler.rs`, `cache.rs`；`src-tauri/src/commands/analysis.rs`；`crates/annotator-core/tests/spectra.rs`, `analysis_jobs.rs`；`src/features/spectrogram/tileClient.ts`, `tileClient.test.ts`. Modify `src-tauri/src/state.rs`, commands/mod.rs, model/analysis.rs。

- [x] 写基于单音/双音/静音/短帧的数值测试，固定期望频率、帧数、幅度及梅尔滤波中心；先运行 `cargo test -p annotator-core --test spectra` 确认缺少行为失败。
- [x] 实现窗函数、FFT 缓存和单边幅度/功率，归一化严格遵循 2.2；计算帧数量为覆盖每个合法 frameIndex×hop<frameCount 的帧，末帧零填充。
- [x] 实现固定梅尔滤波组和空滤波带处理（权重和为 0 则输出下限），正确覆盖 Nyquist；max/min 参数由 model 验证器复用。
- [x] 实现 256 帧 tile 和功率 LOD 聚合，边界不足块保留实际有效范围；输出 metadata 明确频率边界和原始帧步长。
- [x] 实现线程上限 2、队列 32、generation 取消及 stale-result 丢弃；progress throttling，取消触发通知后工作线程在块边界停止。
- [x] 实现 128 MiB tile LRU 与 2 GiB 磁盘缓存；所有键包含 media hash、通道和算法/配置。缓存损坏重建，颜色/轴参数不改变分析键。
- [x] 通过 Tauri Response/Channel 发送原始 bytes，前端检查字节数与元数据；单响应大于 4 MiB 拒绝并细分请求，关闭项目释放请求资源。
- [x] 运行 `cargo test -p annotator-core --test spectra --test analysis_jobs`、`npm.cmd test -- src/features/spectrogram/tileClient.test.ts`、`cargo check --workspace`；测快速换参数时迟到任务不覆盖。提交 `tmp/sdd: spectral analysis and tiled transport`。

## Task 6: 频谱绘制、坐标、通道与双文件工作区

**Files:** Create `src/features/spectrogram/coordinates.ts`, `coordinates.test.ts`, `viewport.ts`, `viewport.test.ts`, `palette.ts`, `renderer.ts`, `SpectrogramCanvas.tsx`, `ChannelPane.tsx`, `FilePane.tsx`, `CompareWorkspace.tsx`, `AnalysisSettings.tsx`, `AxisRulers.tsx`, `ColorScale.tsx`, `useTiles.ts`；`src/features/spectrogram/workspace.test.tsx`. Modify `src/app/AppShell.tsx`, `src/app/App.tsx`, `src/styles/layout.css`。

- [x] 写坐标测试并先运行红灯：多比例、零 Hz、Nyquist、视口缩放后的 pixel↔Hz/sec 往返 ≤0.5 px。核心映射的完整定义如下：

```ts
export function frequencyScale(f: number, nyquist: number, mix: number): number {
  return (1 - mix) * f / nyquist
    + mix * Math.log1p(f / 20) / Math.log1p(nyquist / 20);
}
export function inverseFrequencyScale(value: number, nyquist: number, mix: number): number {
  let lo = 0;
  let hi = nyquist;
  const target = Math.max(0, Math.min(1, value));
  for (let i = 0; i < 52; i++) {
    const mid = (lo + hi) / 2;
    if (frequencyScale(mid, nyquist, mix) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
```

- [x] 以同一坐标模块实现 STFT、梅尔、ruler 和命中测试；频率上高下低，鼠标锚点缩放，拖动约束到合法范围。mix 改变时保留实际 lowHz/highHz 窗口。
- [x] 实现 canvas 频谱纹理与 96 MiB 有界缓存；使用色表 LUT、像素比校正和预计算频率采样表。优先 Canvas2D 的离屏 tile 栅格化，实测不达标时在本模块内替换 WebGL 纹理渲染，公共接口不变。
- [x] 实现当前视口请求、预取相邻 tile、LOD 选择和取消旧 generation；加载时保留清晰进度/空白区域，不显示另一文件的旧图。
- [x] 实现轴刻度、单位、色阶，增益和动态范围仅重绘；加入线性/对数混合滑块、STFT/梅尔切换和分析设置约束。输入参数反馈 samples+ms。
- [x] 实现同文件多通道同步视口、默认两个通道、全部通道滚动与选择；不同通道数据/标签使用不同稳定 key。
- [x] 实现上下两文件对比及秒轴联动开关；短文件尾部留空、不同 Nyquist 各自显示，单文件设置互不污染。
- [x] 运行 `npm.cmd test -- src/features/spectrogram/coordinates.test.ts src/features/spectrogram/viewport.test.ts src/features/spectrogram/workspace.test.tsx`、`npm.cmd run build`；桌面实际打开真实音频检查图像、混合滑块、缩放和六通道，记录 UI 结果。提交 `tmp/sdd: multichannel spectrogram workspace`。

## Task 7: 区域标注、属性、类别和备注

**Files:** Create `src/features/annotations/selection.ts`, `selection.test.ts`, `AnnotationOverlay.tsx`, `AnnotationInspector.tsx`, `AnnotationList.tsx`, `CategoryManager.tsx`, `NotesEditor.tsx`, `AnnotationTools.tsx`, `annotations.test.tsx`；`src/features/project/shortcuts.ts`, `shortcuts.test.ts`. Modify `ChannelPane.tsx`, `src/app/App.tsx`, `src/app/commands.ts`；Rust document tests 增加 UI 触发的边界回归。

- [x] 写 selection 测试：四方向拖动归一化、零面积取消、越界钳制、移动保持宽度、高频/时间边界 resize、重叠选中循环或明确 topmost 规则；先运行红灯。
- [x] 实现 select/annotate/mask 三种可见工具状态；此任务中 mask 只进入下阶段的编辑模型入口，不伪装播放处理已可用。
- [x] 用共享坐标渲染和命中矩形；选中区域有手柄/类别文本，拖动时本地预览，pointerup 提交一个事务，Escape 取消预览。
- [x] 实现区域属性（数值边界、类别、备注）、音频备注、通道备注；切换对象先提交草稿或保留失败草稿，不能将上一对象备注写到新对象。
- [x] 实现类别增删改及引用数量提示；同名校验，删除后未分类和撤销结果可见。
- [x] 实现标注列表筛选、摘要和点击定位；自动切换到目标通道，不触发播放。对比模式下通过 mediaId 定位正确面板。
- [x] 实现 Ctrl+Z/Y、Delete、Escape 等快捷键及文本输入保护，保存与历史状态统一，不以浏览器原生撤销误改项目数据。
- [x] 运行 `npm.cmd test -- src/features/annotations src/features/project/shortcuts.test.ts`、`cargo test -p annotator-core --test document`、`npm.cmd run build`；在桌面完成一次标注→改轴→改类别→撤销→保存重开，提交 `tmp/sdd: annotation workflow`。

## Task 8: 稳定频段 DSP 与混合重采样

**Files:** Create `crates/annotator-core/src/audio/mod.rs`, `mask.rs`, `stft_processor.rs`, `mixer.rs`, `resample.rs`；`crates/annotator-core/tests/dsp.rs`. Modify model/edit.rs 以及 analysis/stft.rs 的可复用 FFT 基础（不得将视觉参数耦合进 DSP）。

- [x] 写 DSP 测试并确认失败：恒等 RMS≤1e-4、精确输出长度、短文件首尾、DC/高频实数重建、双音保留/抑制、重叠 mask 并集、跨通道隔离。
- [x] 实现 2.3 的固定参数 STFT/ISTFT 和窗平方归一化，首尾 padding 后裁剪，不对原 PCM 缓存原地修改。
- [x] 实现时间/频率 raised-cosine 权重与 max 并集；测试两个重叠区域不多次相乘，全部禁用等于恒等。
- [x] 实现 selectionSource 分支：original 忽略所有屏蔽后带通及时间裁剪，processed 先屏蔽再带通及裁剪。对同一个与屏蔽重叠的选区验证两条路径输出不同且符合双音幅度预期；不同可视化窗长/hop 不改变输出，处理版本不支持时报明确错误。
- [x] 实现混合：mono 居中，stereo 保留 L/R，stereo 独听任一通道居中，3–6ch 对可听通道求平均居中，全部静音输出零。静音/独听优先级固定为 solo 集合再应用 mute。
- [x] 接入 Rubato，后台分块重采样；处理重采样延迟、块尾和输出精确播放时间，48k→44.1k、44.1k→48k 用已知单音验证频率和时长。
- [x] 运行 `cargo test -p annotator-core --test dsp`，测试抑制≥30dB、保留偏差≤1dB（测量区间避开边界与淡变），通过后提交 `tmp/sdd: nondestructive spectral dsp`。

## Task 9: 原生播放、频段试听与屏蔽编辑 UI

**Files:** Create `crates/annotator-core/src/audio/engine.rs`, `device.rs`；`src-tauri/src/commands/playback.rs`；`src/features/playback/TransportBar.tsx`, `ChannelMixer.tsx`, `PlaybackMode.tsx`, `EditList.tsx`, `usePlayback.ts`, `playback.test.tsx`；`crates/annotator-core/tests/playback_state.rs`. Modify `AnnotationOverlay.tsx`, `AnnotationTools.tsx`, `src-tauri/src/state.rs`, `src/app/App.tsx`。

- [x] 写 engine 状态测试（可注入计数输出设备）：play/pause/stop/seek/结束、同一选区 original/processed 两来源的循环边界、切换文件、generation 丢弃和欠载计数；未实现时先确认失败。
- [x] 用 CPAL 列出并选择输出设备，支持常见 F32/I16/U16 格式，构建有界 ring buffer 与工作线程；callback 不运行 DSP 或磁盘操作。
- [x] 实现 play/pause/stop 语义：记录本次播放起点；seek 重新预缓冲；结束停在末尾；循环按选区精确源帧边界；切文件先停止旧源。设备错误变为可恢复状态。
- [x] 实现输出时钟进度事件（约 30Hz），UI 插值绘制但以设备消费计数纠正；静音和过载保护，测试不得用 sleep 推断实际播放帧数。
- [x] 接入原音/处理后/选区、循环、音量、设备选择、独听/静音和整体旁路；选区模式显示“原始选区/处理后选区”来源选择，将 selectionSource 传入 DSP，准确显示试听通道及范围。独听/静音通过 UpdatePlaybackMix 保存并重开恢复，不仅修改 engine 临时状态。
- [x] 将屏蔽工具连接真实 Edit 模型与 DSP：新增、移动/resize、启用、删除、列表定位、撤销；处理版本改变重新预缓冲，generation 防旧音频继续播放。
- [x] 运行 `cargo test -p annotator-core --test playback_state --test dsp`、`npm.cmd test -- src/features/playback/playback.test.tsx`、`cargo check --workspace`、`npm.cmd run build`。
- [x] 实际 Windows 输出设备执行播放和不同模式检查，记录设备、进度、欠载数；若无可用设备，标记该项未验证并保留可重试操作，不能以 fake sink 通过冒充真实试听。提交 `tmp/sdd: native playback and spectral audition`。

## Task 10: 标注文件、项目包及安全导入

**Files:** Create `crates/annotator-core/src/exchange/mod.rs`, `manifest.rs`, `import.rs`, `export.rs`, `limits.rs`；`src-tauri/src/commands/exchange.rs`；`src/features/exchange/ExportDialog.tsx`, `ImportDialog.tsx`, `MediaAssociation.tsx`, `exchange.test.tsx`；`crates/annotator-core/tests/exchange.rs`. Modify project/session.rs、media/registry.rs、src/app/App.tsx。

- [x] 写交换往返测试：JSON/ZIP 保留全部语义（包括各媒体 solo/mute 配置）、新 projectId、无源绝对路径、缺失媒体可导入待关联、不同指纹拒绝、未知更高版本拒绝；先运行红灯。
- [x] 实现专用 Manifest DTO，导出只捕获一个 revision，不直接 serialize 包含绝对路径的本地文档。导出临时文件成功后才发布。
- [x] 实现完整包按媒体 ID 命名、流式复制原字节及指纹检查；输入源被修改或缺失时失败，不导出失真的“完整包”。不包含 caches/backups/recovery。
- [x] 实现 2.4 的边界检查及流式字节计数，测试 `../`、盘符、UNC、大小写重名、链接、超大/超项/未知字段版本、悬空 ID 和非法频率范围。
- [x] 导入到新建暂存目录，校验全通过后发布新项目；新 ID 的引用重映射必须一致。取消/失败只删除本次已核验暂存目录，不触碰现有项目。
- [x] 实现分享与导入对话框、进度、结果位置、关联缺失媒体和错误恢复；导入不在没有保存当前项目时直接切换。
- [x] 运行 `cargo test -p annotator-core --test exchange`、`npm.cmd test -- src/features/exchange/exchange.test.tsx`、`npm.cmd run build`；用实际两个项目完成文件交接往返。提交 `tmp/sdd: portable annotations and project bundles`。

## Task 11: 集成、性能、桌面自动化和交付

**Files:** Create `scripts/setup-webdriver.ps1`, `scripts/run-desktop-tests.mjs`, `tests/desktop/project-flow.test.mjs`, `tests/desktop/spectral-flow.test.mjs`, `tests/desktop/sharing-flow.test.mjs`, `scripts/measure-performance.mjs`, `crates/annotator-core/examples/benchmark.rs`, `docs/user-guide.md`, `docs/verification.md`, `docs/third-party.md`, `README.md`；`src-tauri/icons/` 原创几何图标；必要时 `src-tauri/src/e2e.rs` 仅在 e2e feature 下。Modify `package.json`, lockfiles, `src-tauri/tauri.conf.json`, `docs/development.md`；修复只能涉及证实的问题。

- [x] 完善错误/缺失/恢复/取消/无通道/空项目状态和键盘焦点，确认 1280×800 双文件和六通道不会挤坏主区域；审视文字、对齐、密度及色彩一致性，不把测试控件放进产品 UI。
- [x] 用官方安装源准备 `tauri-driver`（安装到项目忽略的 `.tools/`）及匹配 WebView2 的 Microsoft EdgeDriver。`scripts/setup-webdriver.ps1` 校验下载来源、版本并支持已安装路径，不修改系统全局 PATH；缺失条件明确失败。
- [x] 配置 Selenium 测试驱动实际 Tauri 可执行文件。文件选择对话难以跨驱动控制时，e2e feature 的环境变量只允许预置测试媒体/项目路径，再通过真实页面按钮编辑；该入口不编入发布构建。其余操作用可访问性标签和实际 pointer 事件，不直接改 store 来冒充 UI。
- [x] 实现 `npm.cmd run test:desktop`：新建/加载项目、真实音频、画区域、改类别与三层备注、轴变换、双文件、多通道、保存重启、JSON/ZIP 往返；对桌面窗口截图并将日志留在 `.test-output/`。对原生保存对话和真实听感无法自动断言的部分单独记录人工检查项。
- [x] 实现 `npm.cmd run perf` 与 `cargo run -p annotator-core --release --example benchmark -- <fixture-path>`；生成长音频和第二对比文件，测冷首屏、峰值内存、暖缓存反馈 P95、取消反馈、队列/缓存上限及欠载计数。测量渲染完成而非只测事件处理时间。
- [x] 对超标性能定位瓶颈并通过 implementer 修复；不得替换小文件得出通过结论。清缓存重跑只在变化影响结果时执行。
- [x] 原创简单应用图标并生成 Tauri 所需图标资源；配置 NSIS x64 安装器和 WebView2 offlineInstaller 分发方式，验证用户不需要为标注工作联网。不伪造签名；没有代码签名证书时文档明确安装包未签名。
- [x] 核验运行时依赖许可证，生成 `docs/third-party.md`，说明 FFmpeg 仅开发 fixture 生成、不随应用分发。文档包含快捷键、数据格式、恢复、缺失媒体关联、频段滤波限制、构建和测试方式。
- [x] 执行最终完整命令（下一节），真实启动打包产物并完成至少一次媒体导入→标注→试听→保存→分享。记录实际环境、命令、退出码、截图/文件和未验证项。
- [x] 提交 `tmp/sdd: release verification and documentation`；请求本任务双审查及全实现范围最终质量审查，按证据裁定反馈。

## 3. 最终检查、需求追踪与集成

在 worktree 根目录依次运行，前一步失败则修复后重跑受影响范围；新构建产物不得沿用旧结果：

```powershell
npm.cmd ci
npm.cmd run fixtures
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm.cmd run test:desktop
npm.cmd run perf
npm.cmd run tauri -- build --bundles nsis
```

期望：自动检查 exit 0；测试通过数量与日志真实记录；性能达到规格 §10 指标或明确列为未达标；安装器生成于 `target/release/bundle/nsis/`，启动真实应用并核对版本。`npm.cmd run test:desktop` 的编译脚本先生成 `--features e2e` 的专用构建，最终 NSIS 使用无 e2e feature 的干净发布编译，不能把测试入口带进包。

| 规格范围 | 主要任务 | 证据 |
|---|---|---|
| Windows、布局、空态、可达性 | 1,6,11 | 桌面启动、1280×800 截图、键盘检查 |
| 1–6 通道、WAV/FLAC/MP3、指纹 | 4 | 真实 fixture 解码及通道频率测试 |
| STFT/梅尔、参数、色阶 | 5,6 | 数值测试与真实频谱截图 |
| 频率轴混合/缩放、时间缩放 | 6 | 往返精度及桌面 pointer 流程 |
| 双文件、多通道与联动 | 6 | workspace 测试及桌面比较流程 |
| 区域、类别、三层备注和历史 | 2,7 | 事务/交互测试、重开一致性 |
| 原音/选区/屏蔽/混合/设备 | 8,9 | DSP 指标、engine 测试、设备运行记录 |
| 原子保存、恢复、锁与关闭 | 3 | 故障注入和桌面重启 |
| 分享、身份校验与异常包 | 10 | JSON/ZIP 语义往返与拒绝用例 |
| 缓存、取消、性能 | 4,5,6,11 | 长文件 perf、内存和旧任务回归 |
| 可安装交付、许可和文档 | 11 | NSIS、发布启动、第三方声明 |

最终 orchestration：

- [x] 依据 `verification-before-completion` 阅读新鲜验证输出，未验证项目在 `docs/verification.md` 和用户交付说明中明确，不声明“全部完成”。
- [x] 使用 `code-review` 对 MAIN_BASE..最终 worktree HEAD 做全量审查，核对范围覆盖及未解决高优先级问题。
- [x] 使用 `finishing-a-development-branch` 完成集成决策；遵循用户已授权的范围，不推送远端或创建未经请求的公开发布。
- [x] 检查主工作区相对 MAIN_BASE 的变化与未提交用户文件；无冲突时 squash 保留最终文件，禁止普通 merge 临时提交。存在用户新改动时先保留并处理冲突。
- [x] 集成后执行受集成影响的必要检查，给出可点击的应用/安装包与文档路径、实际验证摘要及限制。

## 4. 技术参考与计划审查

这些是实现选型核验的官方资料；不替代本计划的行为规格：

- Tauri 支持命令返回 `ArrayBuffer` 的二进制响应，适合 tile 传输：[Core API](https://v2.tauri.app/reference/javascript/api/namespacecore/)。
- Windows 构建与 WebView2 分发：[Prerequisites](https://v2.tauri.app/start/prerequisites/)、[Windows Installer](https://v2.tauri.app/distribute/windows-installer/)。
- 真实应用 WebDriver 路线：[Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/)、[tauri-driver](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-driver/README.md)。
- 音频依赖：[Symphonia](https://docs.rs/symphonia/latest/symphonia/)、[CPAL](https://docs.rs/cpal/latest/cpal/)、[Rubato](https://docs.rs/rubato/latest/rubato/)。实现需核对锁定版本 API，不照搬其他版本示例。

审查状态：plan-document-reviewer 完整计划复审 PASS（2026-10-22），可进入实施。

审查修订：首轮指出混合选择持久化和选区原始/处理后来源契约不够明确，已补充 playbackMix/UpdatePlaybackMix、selectionSource、保存重开/交换往返及两来源循环测试。复审确认计划覆盖已批准规格，无阻塞执行的遗漏或矛盾。

执行接口补充（Task2 双审查通过）：关闭/保存前先提交草稿并 await queue.flush()；unresolvedFailures 返回稳定失败 ID；retry(id, correctedChange?) 只重试同类型同目标操作，discardFailure(id) 仅供用户明确放弃。无关成功不能清除失败，refresh() 不确认放弃；新的草稿始终保留并需要再次提交。

执行接口补充（Task3 双审查通过）：编辑器注册 lifecycle.registerDraft(key, submit)，以 store.setDraft / queue.enqueue 提交；观察 project/store.editingDisabled 绑定只读/禁用。另存和关闭会提交草稿、冻结新编辑、排空已接受命令，成功停用旧运行态，失败恢复编辑。queue.needsRefresh 表示冲突刷新仍阻塞，用户明确 Retry/Discard 流程先刷新。Task3原生IPC10项通过于d235866；后续屏障和刷新修复由针对性自动测试验证，最终桌面验收仍需覆盖。

执行接口补充（Task4 双审查通过）：分析/试听使用 MediaRegistry::get_checked 或重新核验原始媒体后再读取 PCM；重开后无原生缓存应按所选媒体进行后台重建并核验，而非复用未经核验缓存。WAV未知声道布局为None，中性通道编号；明确布局才展示位置。若后续新增独立失败操作放弃入口（不关闭项目），必须同时释放该失败import/relink关联的native prepared PCM；现有关闭路径已重置资源。Task4原生10项及10分钟6通道取消/另存5项通过；布局修复另有直接回归测试。

执行接口补充（Task5 双审查通过）：TileClient 独立视图持有 generation，参数/视口改变调用 nextGeneration，运行态替换 dispose；频率分片使用 splitFrequencyRequests。AT01 envelope 含对齐元数据与原始Float32，完整响应≤4MiB，客户端验证。Task6须实现全前端96MiB有界保留及请求并发限制，不能让多个通道的独立client相互取消。颜色/轴变换不重新FFT，频率窗口改变可复用缓存。Task5原生8项通过，数值/作业12+TS客户端5通过。

执行接口补充（Task6 双审查通过，475bd538）：物理坐标与Canvas工作区已接入。每通道数值依赖≤5MiB、最多12通道≤60MiB，64MiB全局数值LRU+32MiB图像预算；当前依赖固定、卸载释放，缺失进入恢复。频率稳定分块及覆盖缓存复用；时间LOD按预算调整，时间放大恢复细节。更换联动文件按当前两文件最长时长约束。原生20项工作流+6项频率/换文件+6项十二通道压力通过（不同阶段证据），最终质量复审32项前端检查通过。Task7须处理标注拖动与视图平移事件隔离、备注草稿切换及undo媒体后视图引用同步；不能隐藏未提交草稿的submitter而让保存无法继续。

执行接口补充（Task7 双审查通过，576416bc）：标注/类别/三层备注与列表、历史已接入，备注草稿由项目级AnnotationDrafts持有。任何先等待草稿、再提交命令的UI编辑，使用lifecycle.enqueueEdit登记并串行执行；保存/关闭/另存会等待已接受操作，切换开始拒绝新登记。不要在hook私有Promise tail中隐藏待提交编辑。UpdateAnnotation读取已排空草稿后的最新对象，避免覆盖备注/类别。队列失败有owner元数据，独立放弃只用于明确annotations所有者；media导入失败保留retry/close流程，不能丢弃其ledger而遗留prepared PCM。原生29项通过，完整前端98、Rust document10及build通过；root9项新回归复验通过。Task9屏蔽编辑应复用上述生命周期和物理坐标边界，并按需要扩展明确owner。

执行接口补充（Task8 双审查通过，24c6d64f）：DspProcessor::read_frames有界随机访问，以PcmCache::read_frames为读取闭包，之后mix_stereo，再BlockResampler::push/finish。选区输出单通道，source_start_frame保留原音频起点；seek后重建resampler。固定DSP2048/512与显示参数独立，任意分块和跳转保持全局窗相位。Rubato0.16.2采用偶数FFT块避免半采样延迟；内部FFT每通道≤32768帧，病态采样率比例提前ResourceLimit。12项DSP数值测试/59core/checkworkspace/fmt通过，root重跑12项通过。Task9应以播放设备消费帧数计时，不在callback运行DSP/IO/分配；备注或保存revision变化不能无故重启播放，按媒体/编辑/混合/播放模式实际变化重建generation。

执行接口补充（Task9 双审查通过，72c19a3f）：CPAL原生播放与屏蔽编辑已接入。pending播放意图与响应generation关联，旧ended/error不能覆盖新请求，早于确认的新流终态仍保留。Escape共享取消使用稳定窗口监听器。自然结束必须等待callback时间戳和WASAPI队列退空证据，不能按应用ring为空立即drop；consumedFrames只表示callback提交计数，presentation字段单独给排空证据。排空依赖已锁定CPAL0.15.3/WASAPI首回调容量契约，升级依赖或新增后端需重新核验。实际Headphones48kHz双声道39项通过、各模式测试零欠载，含非零48帧短音频；主观听感未验证。Task11仍须十分钟双文件性能与正式安装包验证。任务验证core18+DSP12/native5/frontend118/build/check/fmt，root复验18项，最终质量复审亦复验相关检查。

执行接口补充（Task10 双审查通过，a0383140）：JSON/ZIP交换与UI已完成，完整语义往返、新项目身份、源字节/元数据核验、ZIP索引预检/路径/实际字节限制及owned staging发布均有回归。交换使用transitionAfterSave经过lifecycle.persistSnapshot确认保存，成功同owner导出重试清除相关保存错误，未决编辑失败仍阻止交换。Windows导出以同目录MoveFileExW WRITE_THROUGH无REPLACE/COPY发布，拒绝既有目标且不要求硬链接；未实测exFAT设备。Vite排除.test-output监听以免Windows开发监听器持有暂存目录。native32项+独立重启4项通过，frontend125、Rust exchange11+unit3，root7项UI复验。Task11必须清除已记录的4项audio clippy警告，并核验分析/播放组合PCM缓存总预算；现有独立PcmCache默认值不能自动视为全局总预算。

Task11 交接（2026-10-23）：最终 frontend125 / Rust workspace99 / Selenium5组 / 长文件perf通过；NSIS首次因自有release进程占用失败，关闭后重试exit0。正式打包后exe真实native picker→导入→pointer标注→实际输出→保存→分享再次完成。完整数据、SHA、打包限制见 docs/verification.md；主观听感、全新机器安装UI、实体exFAT未验证。已修复组合PCM预算（96+32MiB）与严格clippy警告，无callback改变；本任务双审查及全范围质量审查由root在检查点SHA上继续。

Task11 最终全范围审查修复（2026-10-23）：分析所有者改为 active-only native lease 注册/释放，跨 reset 不复用 token，不保留 retired UUID tombstone。旧代码 300 顺序视图回归实际 ResourceLimit RED；修复后 frontend128 / Rust102 / desktop6组（300切换、450通道挂载）/ 长文件perf / 正常NSIS全部通过。正式打包后再次真实native picker→导入→标注→试听→保存→分享，新的产物SHA与稳定副本见 docs/verification.md；旧根目录 releases/0.1.0 未改动。交由 root 固定新SHA后再做修复双审查与全范围质量审查。
