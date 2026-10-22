# 开发与验证

## 当前阶段

0.1.0 已接入音频导入、项目保存与恢复、STFT/梅尔频谱、多通道和双文件对比、区域标注、备注、原生播放、频段试听与屏蔽、JSON/ZIP 分享。两个侧栏可分别折叠和展开。本文后续 Task 1–10 记录保留各阶段的历史验证结果；当前交付结果及未验证项以 [验收记录](verification.md) 为准。

## 环境

初始验证机器：Windows 11 Enterprise x64（10.0.26200），AMD Ryzen 5 5600GT，约 31.3 GiB RAM。Node 22.23.3、npm 10.9.9、Rust/Cargo 1.91.0，目标 `x86_64-pc-windows-msvc`。系统已安装 Visual Studio C++ Build Tools 和 WebView2 155.0.4283.62。

需要 Node >=22.12、Rust 1.91 或更新版本、MSVC C++ 工具链及 Windows SDK、WebView2 Runtime。首次安装 npm/Cargo 依赖及准备 WebView2 分发资源需要网络，应用运行没有远程字体、CDN 或在线服务依赖。Windows NSIS 安装包内嵌 WebView2 离线安装程序；全新离线机器上的安装与卸载流程尚未实测。

前端使用 React 19.3.1、TypeScript 5.9.3、Vite 7.3.7、Vitest 4.1.12。Tauri CLI/API 2.12.4、Rust Tauri 2.12.5、dialog 插件 2.8.3。精确解析结果分别固定在 `package-lock.json` 和 `Cargo.lock`，使用项目本地 CLI，不需要全局安装 Tauri。

## 命令

在仓库根目录使用 PowerShell：

```powershell
npm.cmd ci
npm.cmd run tauri -- dev
```

该命令启动 Vite 和原生 Tauri 窗口。Vite 仅绑定 `127.0.0.1:1420`，端口被占用时退出，不会静默换端口。`npm.cmd run dev` 仅启动前端网页，不能代替桌面验证。

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
cargo check --workspace --locked
cargo fmt --all -- --check
npm.cmd run tauri -- build
```

`build` 先检查前端与构建配置类型，再生成 `dist/`。Rust workspace 包含纯 Rust 库 `annotator-core` 和宿主 `annotator-desktop`。`tauri build` 生成 Windows NSIS 安装包；正式安装包验收在交付任务执行。

测试使用 jsdom 和 Testing Library。基础阶段仅测试两个侧栏独立折叠/恢复及可访问状态，不对静态样式或文件存在性添加机械测试。后续领域行为应增加相应 Rust/前端测试。

## 边界和资源

- 原生窗口标题为“音频标注 · Audio Annotator”，初始 1440×900，最小 1000×680。
- 界面包含项目操作、音频列表、中央分析区、属性区及底部播放条；中央和属性内容可滚动，侧栏折叠入口始终可达。
- 主窗口授权原生文件选择、项目关闭事件监听及成功关闭后的窗口销毁；没有 shell 或任意文件系统读写/删除权限。项目 IPC 使用 Rust 校验和 session 写锁。
- 生产 CSP 限制本地资源和 IPC；开发 CSP 额外允许固定本地 Vite/WebSocket 地址。无远程资源白名单。
- `src-tauri/icons/source.svg` 为本项目原创向量图标，`icon.ico`/`icon.png` 由本地 Tauri CLI 生成。重新生成时先输出到临时目录，仅复制 Windows 所需资源。
- 构建产物、Cargo target、生成的 Tauri schemas、测试输出均忽略，不提交工作流代理配置。

## Task 1 初始验证记录（2026-10-22）

| 检查 | 结果 |
|---|---|
| `npm.cmd ci` | 成功，从提交的 lockfile 干净安装；审计 0 个漏洞 |
| `npm.cmd run build` | 类型检查与 Vite 生产前端构建成功 |
| `npm.cmd test` | 1 个侧栏行为测试通过 |
| `cargo check --workspace --locked` | 两个 workspace 包检查成功 |
| `cargo fmt --all -- --check` | 通过 |
| `npm.cmd run tauri -- dev` | 成功编译并启动真实 `annotator-desktop.exe`，中文窗口标题及非零窗口句柄已确认 |
| 原生 WebView2 渲染 | 通过；页面包含 Tauri runtime，正确显示空项目与 0 个文件，侧栏四次收起/恢复均通过 |
| 窗口布局 | 初始客户端 1440×900、外部窗口 1280×800（客户端 1264×761）、最小客户端 1000×680 均无根页面横向溢出；播放条保持可见，属性内容可滚动 |
| WebView2 错误 | 最终检查无运行时异常或网络错误；首次发现的 favicon 404 已由本地 SVG 修复 |

侧栏测试先在无折叠处理的骨架上实际失败（点击后侧栏仍在），实现状态切换后转绿。纯布局和工程配置使用构建与真实窗口验证。

原生渲染验证在默认启动成功之后，用忽略目录中的临时 Tauri config 添加本地调试参数 `--remote-debugging-port=9223`，经 WebView2 DevTools Protocol 读取页面、切换侧栏并截图；确认 `window.__TAURI_INTERNALS__` 存在，未使用独立浏览器预览代替宿主。使用 Win32 `MoveWindow` 调整实际窗口尺寸。开发配置没有提交，生产配置没有调试端口。截图与 JSON 记录位于本机忽略目录 `.test-output/native-1280x800.{png,json}`、`.test-output/native-minimum.{png,json}`，不是交付依赖。启动器用 `Start-Process -WindowStyle Hidden` 创建并记录 PID，验证后只终止该 PID 的子进程树。

环境处理：首次 Rust 检查因尚未生成 Windows 图标失败，生成图标后通过。初选 Vitest 3 的依赖审计存在漏洞，改用兼容 Node 22 的 4.1.12。升级时 npm 10 的可选 peer 解析触发 `edgesOut` 错误；临时使用 `--legacy-peer-deps` 完成升级后，以正常 `npm install --package-lock-only` 重建解析，并通过正常 `npm ci` 验证，不需要在项目中启用 legacy peer 选项。运行 Vite 时 Windows 锁住 esbuild 可执行文件，停止本次开发进程树后干净安装成功。

本阶段没有声称验证尚未实现的业务功能、音频设备播放、正式安装包安装或性能目标；这些属于后续任务。

## Task 3 项目持久化验证（2026-10-22）

项目目录包含 `project.json`、带 SHA-256/revision 的 `recovery.json`/`project.json.bak`、`.project.lock`。Windows 使用同目录临时文件、完整写入、flush/sync、`MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` 发布，未删除正式文件制造替换空窗。Rust 标准库 OS 文件锁句柄由 `LocalProject` 持有；遗留锁文件不会阻止重开。读取上限为每文件 32 MiB；全部编码（包括 JSON 转义后的 recovery/backup）在写入前检查，超限保留原文件及内存。

项目菜单接入真实 Tauri 新建、打开、保存、另存、关闭及恢复命令。新建/另存使用原生空文件夹选择，打开选择 `project.json`；已有文件不静默覆盖。另存保留历史，并把当前与历史中的相对媒体引用转换为原目录的绝对引用。恢复选项需要用户明确选择；失败保留当前 session。

后续编辑器集成：通过 `active.lifecycle.registerDraft(key, submit)` 注册草稿提交函数，并用 `store.setDraft` 保存本地草稿、`queue.enqueue(change, { draftKey: key })` 提交。保存、切换和退出先提交草稿并等待 `queue.flush()`；未注册草稿、更新中的草稿及未确认失败均阻止安全关闭。失败操作仅通过明确的重试/放弃处理。自动保存 1 秒防抖、5 秒最大尝试间隔，单保存队列，返回 revision 后才更新磁盘状态。原生 `CloseRequested` 阻止活动项目被直接销毁；前端只注册一个监听器，手动保存期间的关闭请求会等待当前操作。

| 检查 | 实际结果 |
|---|---|
| `cargo test -p annotator-core --test persistence` | 14 通过；真实临时目录、9 个 write/sync/replace 故障点、checksum/异项目拒绝、主文件损坏备份、显式恢复、OS 锁竞争/释放、另存历史、编码大小边界、持续磁盘失败时显式放弃 |
| `npm.cmd test -- src/features/project/lifecycle.test.tsx` | 18 通过；debounce/max-delay、草稿/冲突、保存版本、native-close 回调、重试/取消、Ctrl+S、切换、恢复、无草稿操作失败状态、转换期间编辑准入及冲突刷新失败后的恢复 |
| `npm.cmd test` | 全部 35 测试通过 |
| `cargo test --workspace` | 21 Rust 测试通过；doc tests 通过 |
| `cargo check --workspace` | 通过 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通过 |
| `cargo fmt --all -- --check` | 通过 |
| `npm.cmd run build` | TypeScript 与 Vite 生产构建通过 |

TDD 记录：持久化测试先因缺失 FileStore/LocalProject 失败，生命周期测试先因缺失 lifecycle 模块失败；实现后转绿。补充回归实际捕获并修复了超限编码仍被保存、另存丢失历史、手动保存期间关闭请求丢失。前端测试仅在原生边界注入测试替身；产品没有浏览器模拟项目。此阶段未进行原生文件选择对话框人工操作或 Windows 强制断电测试；桌面完整交互验收由 Task 11 执行。

Task 3 规格复审修复：干净项目中无草稿命令被拒绝时，原有 revision/drafts 订阅签名不变，导致界面错误显示“已保存”。两个 RED 回归复现后，生命周期现在订阅失败账本和 store error，立即显示失败及恢复操作；显式放弃/重试后恢复准确状态。待用户处理的命令失败不会触发自动保存重试风暴，磁盘保存错误独立保留。`npm.cmd test -- src/features/project/lifecycle.test.tsx src/app/commands.test.ts` 的 24 个测试及前端 build/typecheck 均通过。

Task 3 放弃关闭复审修复：两个 RED 回归确认，在持续 RecoveryWrite/Sync/Replace 故障或正式文件损坏时，“放弃更改”原本也会失败。显式放弃现在保留身份/版本检查，但不依赖磁盘成功写入；恢复副本抑制仅尽力执行。正常保存、恢复发布与未保存内容的安全关闭仍严格返回失败。真实文件测试确认正式文件不变、锁释放后可重新打开，遗留恢复副本只进入用户选择流程，不自动恢复已放弃内容。关闭对话框说明当前内存内容会被丢弃，磁盘故障可能导致下次仍提示恢复。该轮 `cargo test -p annotator-core --test persistence` 14 通过、生命周期 12 通过、workspace check、格式检查及 build/typecheck 通过；不声称在无法写入介质时能永久记录“已放弃”。

Task 3 原生 smoke（提交 `d235866`）：复用忽略目录中的临时 WebView2 debug config，启动真实 Tauri host，实际 IPC 与菜单执行 create/get_snapshot/apply/save/close/open。10 项检查通过，包括磁盘类别持久化、重开、菜单关闭释放 session、原生 revision 冲突呈现重试/另存操作，未捕获运行时异常。仅在测试运行时给原生 picker 的选择结果注入新临时目录，未人工操作原生选择对话框。记录与截图位于 `.test-output/task3-native-report.json`、`task3-native-conflict.png`、`task3-native-reopened.png`；已停止所启动 PID 及其子进程。首次 smoke 脚本遇到 Vite 依赖优化重载与 CDP 序列化 DOM 的测试脚本问题，修正忽略脚本后通过，没有修改产品配置。

Task 3 转换竞态修复：Save As/关闭现在共同使用 `lifecycle.transition(action)`：先允许已注册草稿提交，再通过 `store.beginTransition()` 阻止新编辑，等待已接受的命令及串行 refresh 完成，随后执行原生操作；失败恢复编辑权限，成功停用旧 store。三个 RED 回归捕获原有缺失的准入屏障，修复后生命周期与队列 29 测试通过，全前端 33 测试、build/typecheck 和 workspace check 通过。正常保存继续允许编辑，较新 revision 不会被旧保存标为已保存。

后续 NotesEditor 必须读取 `project.editingDisabled` 或 `store.editingDisabled` 来禁用输入，并继续通过 `store.setDraft`/`queue.enqueue` 写入；转换期间或旧 store 的延迟回调会明确抛出可重试 `InvalidInput`，不能当作成功提交。`store.drafts` 现在是只读视图；`clearDraftIfUnchanged` 用于完成既有提交后的确认。不要从编辑器调用 `beginTransition`，由生命周期统一协调。此次竞态修复只有自动化边界测试证据，未重复原生 smoke，不把此前原生结果算作新竞态的原生验证。

Task 3 冲突刷新重试修复：两个 RED 回归复现 RevisionConflict 后自动刷新暂时失败，使 UI 的“重试”无法再次调用后台的问题。队列新增只读 `needsRefresh`，用户明确点击重试时先刷新被阻塞的 authority，再重试账本中的操作；刷新再次失败会保留草稿与稳定失败 ID。明确放弃关闭也先取得当前 authority revision，不重放编辑；无法刷新则保留当前状态并显示错误。生命周期/队列 31 测试、全前端 35 测试和 build/typecheck 通过；未重新执行原生 smoke。

## Task 4 媒体导入验证（2026-10-22）

`npm.cmd run fixtures` 生成并提交 18 个小音频样本及原字节 SHA-256 清单：WAV PCM16/24/32、float32，1/2/6 通道独立单音，FLAC、CBR/Xing MP3、无 Xing 的 VBR MP3、双音、静音、37 帧短文件，以及空帧、7 通道、非有限采样、损坏/截断反例。压缩文件只来自自生成信号；锁定的 `ffmpeg-static` 仅用于开发，不随应用运行或分发。`npm.cmd run fixtures -- --perf` 已实际运行，生成忽略目录中的十分钟 48 kHz 六通道和双通道 WAV。

Symphonia 0.5.5 仅启用 wav/pcm/flac/mp3。源 SHA-256 按 64 KiB 流式读取，前后核对字节数/mtime。解码以 packet 为单位写交错小端 f32 临时 PCM，已知帧数先检查可用磁盘空间；失败/取消仅删除本次临时文件。拒绝非有限采样和不完整 WAV/FLAC；MP3 额外检查帧边界，以区别最后一帧截断与正常 EOF，并仅应用明确的 encoder delay/padding，避免按比特率估计时长裁剪有效采样。真实解码帧数与 FFmpeg 独立生成的 fixture 参考一致。

PCM 按 4096 帧块读取，LRU 默认 128 MiB，单次读取上限 4 MiB；不通过 IPC 传递 PCM 数组。`MediaRegistry::get_checked` 校验 descriptor 身份及源 stat 后返回共享 PCM backing；Task 5/9 的分析/试听入口必须使用这个检查或重新校验原文件。重开后的已有文件显示“等待校验”，缺失或变化明确显示状态，重新关联会完整解码并核验 SHA-256/字节数/采样率/帧数/通道布局。文档中的音频、通道和区域文字仍可查看；文字编辑工作流属于 Task 7。

长任务不持有文档/AppState mutex。`import_media`/`relink_media` 返回 taskId，通过 Channel 发送节流进度、逐文件结果和完成/取消终态。成功解码只产生 native prepared descriptor，前端仍通过原有 `CommandQueue` 和 `apply_change` 提交最新 revision；未通过 native preparation 的 import/relink 描述不能直接写入。`RelinkMedia` 只改变 sourceRef，保留核验期间的新备注。成功新建/打开/另存/关闭重置 native media generation；旧结果不能发布，旧 controller 遵守 editingDisabled 并取消任务。释放 pending PCM 还校验 taskId，旧任务清理不能删除新任务结果。原有另存相对路径 rebase 合约保持有效。

TDD 证据：先运行缺少 media 模块、RelinkMedia/MediaTasks 和前端 controller 的 RED；实现后转绿。额外 RED 回归实际复现 StrictMode effect replay 使 controller 失效、native completion 先于 start response 的准入竞态、MP3 截断被视为 EOF；分别修复 effect 所有权、双终态屏障及 MP3 帧结构校验。最终前端 44 测试通过；Rust media 9、document 9、persistence 14 测试通过；`npm.cmd run build`（含 typecheck）、`cargo clippy --workspace --all-targets -- -D warnings` 通过。

真实 Tauri/WebView2 smoke 最终 10/10 通过：从 UI 批量导入 WAV/FLAC/MP3 并拒绝 NaN 文件、元数据/六通道、native revision/自动保存、重开后缺失媒体、移动后原文件关联、不同文件拒绝，无 uncaught runtime errors。另一个十分钟六通道 smoke 5/5 通过：导入期间 Save As 完成且不把旧结果写入原/新项目，手动取消显式结束且无 descriptor。原生文件对话框的选择返回值由忽略测试脚本注入，未人工操作 picker；其余为真实 native IPC、UI 和磁盘读写。报告为 `.test-output/task4-native-report.json`、`task4-race-report.json`，截图 `task4-native-imported.png`、`task4-native-missing.png`。测试后只终止记录的启动 PID 及子进程树。首次 smoke 中的非空测试目录、只读 Tauri invoke 属性以及 Windows canonical path 比较问题均为测试脚本问题，已按现场 DOM/IPC/路径证据修正，未将失败当作成功。

本阶段未实现或宣称频谱、试听、分享、性能指标/安装包验收；这些仍按后续任务执行。

Task 4 通道布局审查修复：Symphonia 为基本 PCM/IEEE WAV 和零掩码 extensible WAV 生成的内部 channel mask 只是解码占位，不能当作已知扬声器位置。新增实际 RIFF/WAVE 字节检查，最多扫描 4096 个块，每块最多读取 40 字节，跳过数据载荷并检查边界/取消；不依赖文件扩展名。基本 WAV 与零掩码 WAV 的 `channelLayout` 现在为 null，UI 沿用通道编号和“未指定布局”；只有显式且通道数量一致的标准 WAVEFORMATEXTENSIBLE 掩码保留布局。非零但数量不符/包含保留位的掩码以 DecodeFailed 拒绝，避免解码器自行修复位置。FLAC/MP3 格式定义的布局保持有效。

两个 RED 回归实际捕获基本六通道 WAV 的猜测标签和矛盾掩码被修复后接受；GREEN 覆盖基本 PCM/float、零掩码、有效显式掩码、矛盾/保留位掩码、无音频扩展名、奇数长度 JUNK 块、PCM 顺序不变及重新解码后身份一致。修复后 media 11、document 9 测试、workspace clippy 和 build/typecheck 全部通过。此次布局修复未重跑原生 smoke；上述 10/5 项原生报告属于此前导入/生命周期实现，不能作为修复后扬声器标签的原生验收证据。此前临时开发项目若已保存推断布局，不进行静默文档迁移；最终发布前测试数据应重新导入。

## Task 5 分析与二进制 tile（2026-10-22）

RustFFT 6.4.1 的计划按允许的 FFT 长度复用；分析 v1 使用 periodic Hann/Hamming/Blackman 或矩形窗。STFT 幅度为 `abs(FFT)/sum(window)`，内部单边 bin 幅度乘 2；梅尔输入功率只乘 2，三角滤波按离散权重和归一化。静音下限固定为 -160 dB。尾部补零不改变完整窗归一化，不延长可标注时间。时间和频率 LOD 均在线性功率域取实际有效样本均值，再转换 dB；STFT 显示幅度平方与梅尔带功率分别保持自己的尺度。

`request_tile` 返回单个 Tauri `Response` 原始 ArrayBuffer：`AT01` magic、little-endian u32 JSON 元数据长度、紧随其后的 UTF-8 元数据、补齐到 4 字节边界、row-major little-endian f32 dB 值。元数据包含完整请求（requestId/viewId/projectId/mediaId/generation/configHash/参数及范围）、实际行列/帧数、采样率、原样本数和秒范围。STFT 频率中心按原始 bin × sampleRate / FFT，边界取相邻中心中点并裁剪到 0/Nyquist；梅尔携带完整固定三角 points，频率 LOD 组范围由 start/count/stride 确定。metadata 和数据合计最多 4 MiB；预留 16 KiB metadata 后校验请求，最大 FFT 可通过 `splitFrequencyRequests` 按频率组边界拆分。没有 JSON/base64 频谱值数组。这个单 envelope 形式让请求头与数据原子关联，避免双通道到达顺序竞态。

前端 `TileClient` 每个文件面板/视图独立持有 generation；参数或视口变化调用 `nextGeneration()`，重开/关闭/Save As 时 `dispose()`。所有迟到响应均再次检查 generation 和完整请求字段、geometry、长度及有限值。Task 6 的 `useTiles` 应先按 helper 拆请求；频率轴、增益和颜色仅参与渲染，并由 Task 6 管理 96 MiB 前端图像/tile 保留上限。

原生后台最多 2 个分析 worker、32 个等待任务，优先可见请求；每个原始分析帧检查取消，进度约 100ms 节流。取消以 projectId + viewId 隔离；关闭/新开/另存重置整个运行态。128 MiB tile LRU 和 2 GiB 磁盘 LRU 使用源 SHA-256、采样率/帧数、通道、算法 v1、所有分析设置及 tile/LOD 范围为键。磁盘记录带 checksum，损坏或不可用时重算；只清理专用缓存目录的合法 SHA256 `.tile` 普通文件。Windows LRU 时间更新使用可写句柄，读缓存有硬字节上限。

PCM 原始文件在计算/暖缓存读取前和返回前重新检查。重开无 PCM 时按请求后台重新 hash/decode 并核对原身份，文档相对 `sourceRef` 由项目根解析，实际路径单独存在 `DecodedMedia.source_path`，查看不会改文档或 revision。导入的 prepared/commit 流程保持有效。项目/MediaTasks 锁只用于捕获、发布及复核 authority，decode、FFT、PCM/cache I/O 不持项目锁。

验证：`spectra` 3、`analysis_jobs` 9、原生服务 1 个测试通过；全 workspace 在最后两个附加边界测试前 45 项通过，新增频率 LOD/梅尔 geometry 与可见优先级测试随后通过（合计 47）。前端全 49 测试、build/typecheck、workspace check/clippy、Rust fmt 通过。RED 分别记录了缺失数值模块、缺失 tile/cache/scheduler、缺失 lazy rehydrate、缺失 TS client，另有 Windows 磁盘 LRU 只读句柄回归实际失败后修复转绿。

真实 Tauri + WebView2 的 CDP smoke 8/8 通过：ArrayBuffer 中单音峰值、progress 请求关联、暖缓存新 request ID、取消视图不影响另一视图、相对路径重开不改文档、梅尔三角边界、65536 点 FFT 超限拒绝后 9 片覆盖全部 32769 bins，以及外部修改源文件后暖缓存拒绝；无 runtime errors。记录为忽略目录 `.test-output/task5-native-report.json`，脚本 `task5-smoke.mjs`；测试仅调用真实 native commands/客户端，无浏览器假后端，调试端口未写入产品配置。已终止本次启动 PID 及其子进程。首次 smoke 的 CDP 顶层 await 语法错误属于临时脚本，修复后重跑通过。

此阶段未绘制频谱 UI，也未测量十分钟六通道的最终性能指标；这些仍属于 Task 6/11。

## Task 6 真实频谱工作区验证（2026-10-22）

工作区现在使用真实 native binary tiles 绘制 STFT/梅尔频谱。`coordinates.ts` 是绘制、ruler 和后续标注命中测试共用的秒/Hz 正反映射；包括 DC 的线性/对数混合采用规格中的 log1p 定义，梅尔采用独立映射。滚轮以指针为锚点缩放时间，Shift+滚轮缩放频率，拖动或左右方向键平移。单文件默认前两个通道，全部六通道可纵向浏览；双文件上下排列，可按秒联动，短文件尾部留黑，不同采样率分别限制 Nyquist。

Canvas2D 使用每屏幕行预计算的频率查找表、256 色 LUT 和 CSS/物理像素分离。缓存只持有数值 tile，React 只持有 key；全局 LRU 为 64 MiB，12 个最大 1 MiB 的画布以及临时栅格预算预留在总计 96 MiB 内，不保留离屏图像副本。全工作区最多 4 个 native 请求，低于后台 32 等待任务上限；频率切片经 `splitFrequencyRequests`，时间/频率 LOD 按窗口和分辨率选择，预取在内存压力下不驱逐可见数据。每通道独立 viewId/client/generation，运行态替换（即使相同 projectId）也销毁旧 client。更改颜色、增益、动态范围或轴混合不重新请求 FFT；视口变化先投影当前同源数据，再校验和补充新 tiles。

缓存命中前通过 native `media_status` 核对源状态，未校验源必须经过 native lazy rehydration。每 1.5 秒及窗口重新聚焦检查媒体状态；缺失或改变时禁用频谱，提供重新关联。后端对真正的 tile 请求仍在读取前和返回前检查原文件。视图采用 180ms 合并草稿，通过 `registerDraft` 与既有 CommandQueue 提交，保存/关闭会刷新最后一次操作，遵守 `editingDisabled`。每文件独立分析参数和显示设置；窗长/步长/FFT 同时显示 samples 与实际采样率换算的 ms。导入完成结果可收起和关闭，项目菜单在选择动作、外部点击或 Escape 时关闭。

验证命令：`npm.cmd test -- src/features/spectrogram/coordinates.test.ts src/features/spectrogram/viewport.test.ts src/features/spectrogram/workspace.test.tsx`、`npm.cmd test`、`npm.cmd run build`。最终全部 66 个前端测试和 TypeScript/Vite 生产构建通过。新增测试覆盖 0/0.17/0.5/0.83/1 混合、梅尔、DC/Nyquist/裁剪窗口的往返误差 <0.5px，锚点缩放/范围约束、联动与解除联动、参数非法组合、短尾栅格、显示增益只重绘、内存 LRU、并发上限、兄弟通道不相互取消、同 ID 运行态替换、源失效、草稿保存屏障、项目菜单关闭。RED 先记录缺失坐标/viewport/workspace 模块；后续回归实际捕获错误对象缺少契约字段导致提示退化、最大 FFT 请求没有适配显示分辨率、视口切换清空现有图像、菜单不关闭，分别实现后转绿。

真实 Windows Tauri/WebView2 原生窗口为 **1280×800**，AMD Ryzen 5 5600GT、约 31.3 GiB RAM、Rust debug build。固定源码并重启后运行 `.test-output/task6-smoke.mjs` 与 `task6-controls.mjs`，最终 **20/20** 检查通过、无 uncaught runtime errors。仅对原生文件选择器返回路径注入测试目录；媒体解码、SHA-256、FFT、binary IPC、画布、文档队列与磁盘保存均为真实产品路径。样本为 10 分钟/48kHz/六通道自生成 WAV，以及 1 秒/22.05kHz 单通道 WAV。

| 原生检查 | 实际结果 |
|---|---|
| STFT/梅尔、轴混合、指针缩放、真实 pointer 拖动 | 真实像素存在，秒/Hz 范围保存正确；轴混合无新增 FFT 请求 |
| 默认两个通道、全部六通道、双文件 | 默认两幅完整图可见；六通道滚动；双文件各有完整频谱且各自通道独立 |
| 联动、短尾、不同 Nyquist | 相同秒范围；短文件尾部像素全黑；22.05kHz 文件最高 11025Hz |
| 保存并重开 | 六通道、类型、频率窗口、时间联动等视图完全恢复；后台重新校验源并加载频谱 |
| 分析/显示参数 | 非法 hop 禁止应用；主文件 4096 FFT/1024 hop 实际提交及重算，对比文件保持 2048 FFT；增益/范围仅重绘 |
| 外部移走已缓存源 | 自动禁用对应频谱，移回原文件后恢复 |
| 暖视图反馈 | 20 次输入到第一次 canvas 提交，P95 **35.1ms**（并非所有新瓦片完成时长） |
| 取消反馈 | 冷视口分析取消后 **6ms** 显示取消状态 |
| 导入到首屏 | **32.937 秒**，包含 345.6MB 原文件完整指纹/解码和首屏；不是纯 FFT 时间，磁盘 tile 缓存未清空 |
| 进程内存 | 最终 host 峰值 working set 93,315,072 bytes（约89MiB）；host+WebView2 子进程各自峰值之和约726MiB，此值不是同步采样的整机峰值或前端 tile 缓存占用 |

截图与完整原始记录在忽略目录：`.test-output/task6-stft-1280x800.png`、`task6-mel-1280x800.png`、`task6-six-channels.png`、`task6-dual-1280x800.png`、`task6-settings-1280x800.png`、`task6-native-report.json`、`task6-memory.json`。早期调试中修改 custom hook 导致 Fast Refresh 的 hook 数量报错，另有 CDP 初始挂载/按钮文字选择器错误；这些运行未计为通过，最后固定源码、重启后的完整检查干净通过。播放设备/声音、标注操作以及完整发布构建性能仍由后续任务验证；本任务没有提前实现标注编辑或播放。

Task 6 规格复审修复：原先按精确 lowHz/highHz 裁剪请求，导致默认 2048 FFT 的完整 1025-bin 数据已缓存时，频率缩放/平移仍请求不同 tile 并重复 FFT；对应 hook 回归实际记录请求数从 1 增为 2。现在使用每片最多 1025 列的稳定频率分块，并查询当前运行态/源/分析配置/通道/时间下覆盖可见频带的同等或更细缓存；可组合多个细分块跨过粗 LOD 边界，不为不可见分块边缘重算。高 FFT 缺失所需分辨率时仍请求细化，源状态检查、全局并发及 64 MiB LRU 上限不变。另一 RED 回归确认，1 秒文件联动 600 秒文件浏览 100–110 秒后，把比较文件换成 2 秒文件仍保留全空白区间；现在更换 active/compare 后按当前显示两文件的最长时长约束再同步，结果为 0–2 秒，未显示的文件保留自己的视图。

该轮 `npm.cmd test -- src/features/spectrogram/useTiles.test.tsx src/features/spectrogram/ownership.test.tsx src/features/spectrogram/workspace.test.tsx src/features/spectrogram/tileCoverage.test.ts src/features/spectrogram/renderer.test.ts src/features/spectrogram/tileClient.test.ts` **24 项通过**，`npm.cmd run build` 通过。重启真实 Tauri 后执行 `.test-output/task6-review-smoke.mjs`，针对性 **6/6** 原生检查通过、无 runtime errors：默认频率缩放与真实指针垂直平移均保持 1 个请求；65536 FFT 从 LOD5 全频数据细化为缺失的 LOD0 1025-bin 分块，范围及响应上限合法；替换比较文件后持久秒范围为 0–2 且两个画布均含真实信号像素。使用自生成 1 秒/22.05kHz、2 秒/48kHz、600 秒/8kHz WAV；没有重复整套十分钟性能测试，不把前轮性能数值当作本次新测量。证据在 `.test-output/task6-review-report.json` 与 `task6-review-pair.png`。

Task 6 缓存压力复审修复：在 2×6 通道、600秒/48kHz、FFT4096/hop512、0–10秒、6100–17800Hz、1024px 宽度下，旧计划每通道约8.13MiB、共96个可见 tile，超过64MiB LRU；完成标志未感知其他通道驱逐其数据，显示参数重绘后变黑。新增实际 `SpectrogramCanvas`/binary envelope 压力回归先复现了预算超限、缺少依赖保留与重绘黑图三个 RED。

现在每通道保留最多 **5MiB** 数值依赖，12通道最多60MiB，64MiB LRU 的剩余空间用于历史/预取。时间 LOD 计算包含对齐分块和频率分块的最坏工作集，独立于频率视口，因此频率导航仍复用数据；时间放大后恢复更细时间分辨率。该压力场景使用 timeLOD1、frequencyLOD0，未减少通道或频率细节。覆盖缓存的完整 buffer 占用也必须符合该通道配额。当前绘图 key 由稳定 client 所有者固定，直到视口替换或卸载，历史/预取写入不能驱逐；卸载释放所有权。不能容纳的数据不会伪报完成。源失效仅删除该源的数据，不清空无关文件。若发生显式缓存清除等非正常依赖缺失，画布会进入明确恢复流程，不静默显示完成的黑图。数值64MiB与既有画布/临时栅格最多24MiB合计88MiB，低于96MiB缓存预算；进程总内存不是缓存占用。

`npm.cmd test -- src/features/spectrogram` **31项通过**，`npm.cmd run build` 通过。压力回归在12通道完成后再写入80MiB历史条目，连续改变 gain/palette/mix，检查所有画布的每个像素列完整且没有新增分析请求；还验证频率导航不改变时间LOD、时间放大恢复LOD0、显式清除后的恢复和卸载释放依赖。

固定源码启动原生 Tauri，使用两份真实600秒/48kHz/六通道 WAV（各通道分别7/9/11/13/15/17kHz）执行 `.test-output/task6-pressure-smoke.mjs`，**6/6通过**。以准确元数据生成项目测试夹具，原生打开仍实际重新校验SHA-256、解码和FFT。12个1024px画布在显示参数更改前后每个时间列都有真实信号，空列数均为0；请求计数 **80→80**，无反复加载；实际数值缓存 **51,142,656 bytes（48.77MiB）**，最大native并发4，无uncaught errors。报告为 `.test-output/task6-pressure-report.json`，两文件第六通道滚动截图为 `task6-pressure-twelve.png`。此轮没有重新测量前轮暖视图P95，不复用旧数值宣称新性能。

## Task 7：标注工作流（2026-10-22）

选择 / 标注 / 屏蔽工具使用明确的当前状态。标注拖动通过共享坐标把 CSS 像素转换为秒与 Hz，反向拖动归一化并按实际媒体长度、Nyquist 钳制，零面积不创建。选择工具采用文档最后绘制区域优先的命中规则；移动和八个边缘/角手柄只预览，释放指针提交一次事务，Escape 或取消指针捕获放弃预览。空白处拖动平移，Alt + 拖动也可在区域上平移；滚轮缩放保持原入口。屏蔽工具目前显示后续处理接入提示，未提前实现 Task 8/9 DSP 或播放。

右侧以区域、列表、备注、类别四个分区避免长表单堆叠。区域数值、类别、备注；媒体/通道独立备注；类别新建、改名、颜色、去首尾空格重名校验、受影响数量确认与未分类/撤销均接入原生事务。列表组合类别/通道/备注筛选，点击按 mediaId、channelIndex 定位相应面板和范围，不调用播放。Ctrl+Z/Y、Delete、Escape、V/A/M 保护 input/textarea/select/contenteditable。数值显示时间最多六位、Hz 最多两位小数；单纯渲染、聚焦和失焦不会把舍入结果写回文档。

备注和数值草稿由项目级 `AnnotationDrafts` 持有，控件/分区卸载仍保留生命周期提交器；旧提交完成只清除同值草稿，新输入保持待提交。显式修正失败草稿通过原失败 ID 和相同操作/对象重试；其他失败账目保留，可逐项重试或明确放弃。历史/删除先提交草稿并等待串行队列，失败时停止。修改类别/几何前在提交完备注后读取最新权威区域，避免整个 annotation 载荷覆盖新备注。数值草稿仅拥有几何字段。工作区监听权威快照，在撤销导入/删除媒体后清除已不存在的媒体/对比引用，同时保留有效媒体的待提交视图草稿。

测试证据：最初 selection、快捷键、草稿与 overlay 测试因对应实现缺失而 RED；坐标浮点断言改用合理容差，未改变坐标语义。工作区历史回归实际复现已删除媒体仍被 compareMediaId 引用；另一个回归复现两个失败共存时无法单独修正其中一个草稿，修复后均 GREEN。新增前端验证覆盖反向/越界/零面积、物理移动/缩放、CSS 偏移映射、一次释放提交、取消、隐藏草稿、提交期间继续输入、失败修正与历史门禁、备注后快速分类/移动、数值失焦精度、类别删除确认和组合筛选。Rust 增加现有文档模型边界/拒绝事务/类别删除后备注保留和连续撤销回归，不修改已通过的模型语义。

最终命令（退出码均为 0）：

- `npm.cmd test -- src/features/annotations src/features/project/shortcuts.test.ts`：**15 项通过**。
- `npm.cmd test`：**20 文件，92 项通过**（含既有项目、导入、频谱、缓存压力验证）。
- `cargo test -p annotator-core --test document`：**10 项通过**。
- `npm.cmd run build`：TypeScript 双配置检查和 Vite 构建通过。

最终固定前端源码、终止本次拥有的进程树并重新启动真实 Tauri debug 窗口后，执行忽略目录 `.test-output/task7-smoke.mjs`，**27/27 检查通过**，无未捕获 runtime error。WebView2 CDP 使用 9223，窗口 1280×800；仅注入原生选择器返回路径，区域创建/移动/手柄缩放使用 CDP 实际指针事件，其余通过 UI 控件，所有变更/历史/分析/保存仍走真实原生命令。使用新生成的 2 秒六通道、1 秒双通道 48kHz WAV，覆盖：创建一次事务、Escape 取消、轴变化坐标不变、类别重名/删除数量/撤销、三层备注及快速备注→分类、数值显示失焦不舍入、移动/缩放、Hz 编辑、第二文件归属和列表定位、文本快捷键保护、Delete/撤销、保存→关闭→重开语义完全一致。源文件 SHA-256 前后相同，无水平布局溢出。

完整报告 `.test-output/task7-native-report.json`；截图 `.test-output/task7-dual-1280x800.png` 和 `.test-output/task7-reopen-1280x800.png`。此前 helper 调试曾因错误工具按钮选择器、取消选区后未重新选择区域及未加引号的 UUID CSS 选择器失败；未计作通过。最终完整运行已修正并在重启后通过。此任务未重新测量 Task 6 性能，也不把 debug UI 检查替代后续安装包、播放设备或分享验收。

Task 7 第一轮规格复审修复：标注错误栏原先给所有失败显示直接放弃按钮，会清除媒体导入/重新关联的发布失败账目却不释放其原生准备资源。新增回归先确认错误按钮确实出现；现在命令队列记录明确的 `annotations` 操作所有者（包括无草稿的类别/区域创建删除以及历史），仅此类失败显示放弃。导入/关联仍保留原有失败重试及项目关闭时放弃的资源生命周期，未重写媒体服务。测试同时验证 import/relink 没有直接放弃入口、原操作可重试、放弃类别失败不会清除旁边的媒体失败。

同轮独立检查复现了另一个保存边界：备注的原生命令延迟时，组件私有 Promise 队列里的分类和几何动作尚未进入 CommandQueue，Save 可提前保存旧类别/旧几何，Close 可只保存类别后关闭，丢失后续几何。两个延迟回归均先 RED。现在 `ProjectLifecycle.enqueueEdit` 同步登记已接收的 UI 动作并串行执行；Save、Close、SaveAs 转换先等待这些动作，随后提交剩余草稿和原生命令，再建立禁写屏障。转换开始后拒绝新 UI 动作，转换前接收的动作仍完整落地；显式关闭放弃也先等待已接收动作结束。低层 `submitDrafts` 用于动作内部，不递归等待自身；需要完整编辑边界的调用方应使用生命周期 save/transition。

复审后的 `npm.cmd test -- src/features/annotations src/features/project/lifecycle.test.tsx src/app/commands.test.ts` **50 项通过**；完整 `npm.cmd test` **21 文件 / 98 项通过**；Rust document **10 项通过**；`npm.cmd run build` 通过。固定源码重新启动真实 Tauri 后，原有原生流程及新增快速关闭场景合计 **29/29 通过**，无 runtime errors：同一 JS 事件轮内通过实际控件修改备注、分类、删除区域并点击关闭，磁盘 revision **22→25**，重开后删除结果正确，三个已接收操作均未被关闭抢先。此次仍仅注入文件选择返回路径，没有替换原生命令、队列或项目存储。报告与 1280×800 截图沿用上述路径并已更新；本次拥有的进程树已终止。

## Task 8：稳定频段 DSP、混合与重采样（2026-10-22）

`audio::DspProcessor` 固定 DSP v1：FFT/window 2048、hop 512、periodic Hann 分析/合成、逐样本累计窗平方归一化。虚拟源在首尾各补至少一个窗的零，返回值仅包含原始帧或明确选区。所有 FFT 窗按原文件零点全局对齐；任意块大小与跳转位置得到相同样本。使用 f64 FFT/累加，最后输出 f32；不修改源 PCM。已有 `Region`/`SpectralEdit` 足以表达 DSP 语义，未改动模型或可视 STFT 模块，避免不必要的基础重构。

频率过渡在区域内部使用 raised-cosine，宽度为 `min(max(2*sampleRate/2048,20Hz),bandwidth/2)`；触及 DC/Nyquist 的一侧没有外部频谱，因此该物理边界 bin 保持完整权重。时间宽度为 `min(10ms,duration/2)`，屏蔽权重在分析窗中心时间采样。启用且媒体/通道匹配的区域取 max 并集；负频率用正频率的复共轭，DC/Nyquist 保持实数。选区先按 `selectionSource` 决定是否应用屏蔽，再乘频带保留权重并在重建后逐样本淡入/淡出。选区仅输出选定通道，帧区间为 `[ceil(startSeconds*rate),ceil(endSeconds*rate))`，不含任何实际样本的区间明确拒绝。原音路径返回原始有限样本；版本不支持、非法区域、非有限 PCM、错误源块长度均返回明确错误。

供 Task 9 后台 worker 使用的接口：

- 构造 `SourceInfo` 和 `DspProcessor::new(info, 1, mode, &edits)`；`frame_count()`、`channel_count()`、`source_start_frame()` 定义输出格式与原文件位置。
- 调用 `read_frames(outputOffset, count, |start,n| cache.read_frames(&pcm,start,n))`；单次输出最多 4096 帧。FFT 源读取最多 2048 帧，原音读取最多 4096 帧。通过少量重复 halo 窗支持任意 seek，无需从文件开头预处理，也无需完整十分钟六通道 PCM 内存。
- `mix_stereo` 接受 interleaved 1–6 通道，先 solo 后 mute；mono/单个 stereo solo/3–6 通道平均居中，普通 stereo 保留 L/R，仅 mute 一个 stereo 通道保留另一侧声像。输入校验有限，最终音量后钳制到 [-1,1]。
- 将混合后的块交给 `BlockResampler::push`，源结束调用一次 `finish` 排空滤波尾部。跳转/源变化需要新建 resampler，不能沿用旧滤波状态。worker 后续把结果放入有界输出队列；当前任务未创建 CPAL 回调、设备或 UI。

Rubato 锁定 `=0.16.2`（新增锁定 transitive `realfft 3.5.0`），使用实际 `FftFixedInOut<f64>`；API 依据 [Rubato 0.16.2 官方文档](https://docs.rs/rubato/0.16.2/rubato/struct.FftFixedInOut.html) 与 [Resampler 文档](https://docs.rs/rubato/0.16.2/rubato/trait.Resampler.html) 以及下载的依赖源码核对。首版测试发现奇数输出 FFT 块使 `output_delay()` 向下取整，遗留半个样本延迟（1kHz RMS 误差 0.01259054）。现在预先选择偶数输入/输出块，精确移除整数延迟。尾部补零排空，输出总帧数使用 u128 算术计算 `round(inputFrames*outRate/inRate)`（半帧向上），整数设备帧与目标时长最多相差半个输出样本。

重采样输入单次最多 4096 帧，保留不足一个内部块的状态。构造前按采样率最大公约数预检内部输入/输出 FFT 块均不超过 **32768 帧/通道**；如 48000→47999 或 1→384000 这种超出预算的比率返回 `ResourceLimit`，不会先进行巨大分配。常规 48k↔44.1k 两方向都已验证。处理和滤波输出均保证有限；重采样振铃可能超幅，输出边界再次钳制。

TDD 记录：第一轮 `cargo test -p annotator-core --test dsp` 因缺少 audio 模块 RED；补实现后 5 项 GREEN。混合/重采样测试随后因缺少模块 RED；实际 Rubato 测试再捕获半样本偏移，修正偶数块后 GREEN。资源预检测试先复现异常采样率对未拒绝，添加分配前检查后 GREEN。后续 disabled 测试最初错误要求 FFT 恒等输出逐 bit 等于原音（零交叉处约 1e-17 浮点残差）；改为与无编辑的同一恒等处理链逐 bit 比较，保持既定 RMS≤1e-4 的重建门槛。

最终数值结果（debug，Rust 1.91.0，Windows x64）：

| 验证 | 实测 |
|---|---|
| DC + Nyquist + 低频混合，长度 1/2/31/511/512/2047/2048/2049/12013 | 输出长度精确，该组 f32 输出相对 RMS 为 0（不是对任意信号承诺 bit-exact） |
| 48kHz 双音 1500/6000Hz，屏蔽 1000–2000Hz，测量中间 0.2–0.8秒 | 目标 −165.610dB；保留偏差 0.000000dB |
| 同源 1000–2000Hz 选区，避开淡变/窗边界 | 带外 −300.463dB；带内偏差 0.000000dB；processed 来源的重叠目标再被抑制 |
| 48000→44100，48037 输入帧 | 44134 输出帧；1kHz 幅度偏差约 0dB；时间相位 RMS 6.44883e-9 |
| 44100→48000，44137 输入帧 | 48040 输出帧；1kHz 幅度偏差约 0dB；时间相位 RMS 6.68659e-9 |
| 600秒/48kHz/6通道惰性源，跳到最后777帧 | 输出4662样本且通道正确；总源读取少于16384帧，无完整文件缓冲 |

`dsp` 的 12 项测试还覆盖 73/997/4096 等任意块边界等价、随机 seek、来源字节不变、窄频带/短时间、静音、重叠渐变 max、禁用、两种选区来源、视觉参数独立、mix 边界、两方向重采样的 1/17/1001 帧短尾、最终非零脉冲排空、重复 finish/超量输入拒绝、非有限值和有限超幅输出。

已执行：`cargo test -p annotator-core --test dsp -- --nocapture` **12/12通过**；`cargo test -p annotator-core` **59/59通过**（analysis_jobs 9、document 10、dsp 12、media 11、persistence 14、spectra 3）；`cargo check --workspace` 通过（含 Tauri 宿主）；`cargo fmt --all -- --check` 与 `git diff --check` 通过。没有用这些合成数值测试宣称真实设备试听或十分钟完整播放性能通过，相关验证属于 Task 9/最终验收。


## Task 9：原生播放、频段试听与屏蔽 UI（2026-10-22）

基线 `d1cdf1ba08b72dbca67c84f19f5553847c0266d7`。CPAL 锁定 0.15.3，支持枚举/选择设备及 F32/I16/U16 输出。callback 仅消费预分配的 131072 帧 stereo 原子环形缓冲、转换样本和更新计数，不持锁、不分配、不做 I/O/FFT。后台单 worker 从已校验来源的 PCM 按最多 4096 帧读取，经过固定 DSP、混合、Rubato；最多一个待执行请求，新请求取消旧 generation 并替换待执行项。seek/模式/设备/混合/屏蔽变化重建缓冲和重采样状态，不预处理整段十分钟音频。每块源读取前及运行中至少每 250ms 核验源；失败停止旧缓存输出。

生产宿主与计数测试共用 PlaybackState，停止返回本次起点，结束停在末尾。每个设备帧携带原始源帧位置；重采样末帧明确映射精确源末尾，选区保留原通道及 ceil 时间边界，mono 结果不误套原通道索引。小于一个输出设备帧的循环明确拒绝。约 30Hz 进度事件驱动 UI，绘制只从最近设备计数时间点做最多 100ms 的插值，不累加计时器。

底部真实 transport 包含播放/暂停/停止、定位、循环、音量、设备刷新/选择、三模式、两种选区来源与旁路，显示实际来源、通道/秒/Hz、消费与欠载计数。文件面板/播放源控件切换唯一源并停掉旧音频；Space 保护输入、选择框、按钮和可编辑区域。solo/mute 通过 UpdatePlaybackMix 持久保存，连续点击按最新权威状态合并意图，避免覆盖尚未完成的通道切换。独立 SpectralEdit 与选中状态/橙色斜纹层支持拖建、移动、八方向 resize、启用、删除、列表定位与撤销；拖屏蔽不同时平移。右栏增加屏蔽/混合页签，1280×800 五区布局无横向溢出。

mask/mix 的 UI 操作先进入 lifecycle.enqueueEdit，保存/关闭/另存等待已接受操作；失败分别属于 masks/playback owner，不误丢媒体导入 ledger。native create/open/Save As/close 在资源替换前取消播放；重开共享分析的 hydration 互斥和 registry generation，原路径校验后才访问 PCM。项目锁不会跨解码、DSP 或输出。备注、类别、显示参数、自动保存/revision 不重建音频。原生 library tests 引用事件路径后需 Common Controls v6；build.rs 为测试/DLL 嵌入依赖，应用 binary 使用 Tauri 既有 manifest，避免 TaskDialogIndirect loader 错误及重复资源。

TDD 证据：engine 首轮缺模块 RED→12 GREEN；真实 Renderer 回归捕获重采样末帧少一帧、过短循环未拒绝，修复后 15 GREEN。前端缺模块 RED→实现，再依次复现并修复暂停预缓冲 Play 误暂停、快速 solo/mute 丢变更、旧 generation 错误污染新播放、另存失败保留同一 owner 时 UI 播放意图未复位；11 项 GREEN。native 预缓冲 stopped/paused 状态测试先缺 ready 转换 RED，生产控制使用核心状态机后 GREEN。

最终检查：`cargo test -p annotator-core --test playback_state --test dsp` **15+12 通过**；`cargo test -p annotator-desktop --lib` **4 通过**（含既有重开分析测试）；`npm.cmd test -- src/features/playback/playback.test.tsx` **11 通过**；完整 `npm.cmd test` **22 文件/109 项通过**（含标注和生命周期）；`cargo check --workspace`、`cargo fmt --all -- --check`、`npm.cmd run build` 通过。

固定代码并重新启动真实 Tauri/WebView2（debug，1280×800），`tests/desktop/playback-smoke.mjs` 同内容脚本最终 **34/34 通过**，无 runtime errors。仅注入本次测试的文件/目录选择返回路径，编辑/解码/DSP/播放/保存/撤销均使用实际 native 服务。CDP 使用 Page.bringToFront 和 move/down/up 激活 WebView，避免未激活窗口首个模拟 pointer 丢失 capture。只创建 `.test-output/task9-project-*` / `task9-saveas-*` 自生成短样本，幅度约 0.092、应用音量 8%，未修改系统音量。

CPAL 实际枚举：扬声器 (ToDesk Virtual Audio)、Headphones (High Definition Audio Device，默认)、Digital Audio (S/PDIF) (High Definition Audio Device)、1 - monitor (AMD High Definition Audio Device)。实际输出使用 **Headphones，48000Hz，2 通道**：

| 检查 | 最终设备消费证据 |
|---|---|
| 原音、暂停、停止 | 原音 9696 帧 / 0.602s；暂停 10176 帧 / 0.612s 后不变；停止回到 0.400s，欠载 0 |
| 处理后、播放中备注 | 131136→148896 帧，generation 11 保持，欠载 0 |
| 原始/处理后选区循环 | 86496 / 86016 帧，仍在原始 0.920–2.282458s 范围，欠载 0 |
| 自然结束 | 从 3.8s 消费 9600 帧，精确停在 4.000s |
| 设备错误与恢复 | 无效 ID 返回可恢复 DeviceFailed；重选后消费 7296 帧，欠载 0 |
| 缺失源 | 临时改名本次测试源，MissingMedia 停止旧 PCM，消费冻结；恢复路径后重试成功 |
| 生命周期 | mix/masks 重开一致、惰性 PCM 可播；另存失败保留原项目且可重新播放，成功另存及关闭清空输出 |

验证还覆盖第二通道屏蔽的创建/移动/resize/启停/删除/撤销、两选区来源/循环/旁路、双文件唯一播放源、源文件哈希不变。日志 `.test-output/task9-native-report.json`，截图 `.test-output/task9-dual-1280x800.png`。可复用脚本连接 localhost:9223 的 Tauri dev WebView，需要 1280×800 和 additionalBrowserArgs=`--remote-debugging-port=9223`，从空工作区启动后运行 `node tests/desktop/playback-smoke.mjs`。输出断言依据设备消费计数，不用 sleep 推断帧数。**未观察人工主观听感，不能宣称耳听无伪影或感知声画同步通过；本任务不代替 Task 11 十分钟完整性能验收。**


### Task 9 双审查修复：控制意图与共享 Escape

质量审查发现：在新 configure 尚未确认 generation 时，旧 generation 的 ended/error 可以清除最新播放意图；新流实际播放而 UI 和后续 seek/options 发出 play=false。现按前端控制序号登记待确认意图，等待期间只暂存最新进度事件，不改播放意图；configure 确认后仅重放其 generation 或更新的事件，既丢弃旧流终止，又保留新短流在确认前已结束/失败的结果。过时命令的确认和拒绝不能影响新意图。明确 pause/stop 优先于旧响应，播放意图用独立 UI state 即时展示；失败清除待确认状态并报告本次错误，不持续屏蔽后续事件。

第二项为 Escape：标注监听器先 preventDefault，屏蔽监听器提前退出，导致选中屏蔽残留并被后续 Delete 删除。屏蔽现在允许同一 Escape 取消两个独立选择模型，仍通过 shortcutAction 保护文本/可编辑输入。真实 WebView 另复现 React 在两个原生监听器之间提交更新、每次 render 重建监听器导致后一个监听器被移除；两处监听器现在仅随 active/selectedId 改变注册。使用实际两个 hooks、app 注册顺序以及每个原生监听器后 flushSync 的回归先 RED 后 GREEN，覆盖清选区、Delete 无副作用、输入保护和拖建预览取消。

本次新增实际 hook 回归覆盖旧 ended/error × configure 成功/拒绝、当前新流在确认前终止、pending configure 期间立即 pause、共享 Escape 与 mid-dispatch commit。`npm.cmd test -- src/features/playback/playback.test.tsx src/features/annotations src/features/project/lifecycle.test.tsx` **57/57 通过**（playback 20 项）；完整 `npm.cmd test` **22 文件/118 项通过**；`npm.cmd run build`、`node --check tests/desktop/playback-smoke.mjs`、`git diff --check` 通过。Rust 输出与 DSP 本轮未修改。

固定源码、重启真实 Tauri 后，更新的 `node tests/desktop/playback-smoke.mjs` **37/37 通过**，无 runtime errors。普通 native 操作验证包含 Escape 后 Delete 不删除屏蔽、Escape 取消拖建及既有模式/设备/保存流程；为确定性验证消息次序，脚本在真实 3.8→4.0 秒播放中**仅延迟一次 playbackClient.configure 的真实 native 返回值交付 700ms**，不修改返回内容或事件、不替换命令/DSP/设备输出。实际消费 9600 帧、欠载 0，终止事件先到达，迟到的 buffering 确认后 UI 仍为 ended。这是有明确注入的受控竞态检查，与此前正常时序的 native 流程区别记录；文件/目录选择返回路径注入继续保留。脚本先在非编辑工作区标题做原生焦点点击，再操作频谱，避免未激活窗口首次 pointer 丢 capture。报告 method 字段同时记录两种注入；设备仍为 Headphones (High Definition Audio Device)，48000Hz stereo。人工主观听感的未验证限制保持不变。


### Task 9 第二轮质量修复：EOF 等待原生输出尾部

按 systematic-debugging 先检查锁定的 CPAL 0.15.3 源码。`host/wasapi/stream.rs::process_output` 在用户 callback 返回后才 `ReleaseBuffer`，而 `Stream::drop` 发送 Terminate 并退出，没有自动 drain。此前 `OutputBuffer::ended()` 只表示应用 ring 已空，worker 和状态服务据此结束，可能在最后一段仍未交给/排空设备时释放流。最小回归直接在最后一次 consume 后断言不得 ended，先复现 RED。

现在分开 `ring_exhausted()` 和真正允许结束的 `ended()`。三种 CPAL 样本格式都读取 OutputCallbackInfo；以首个 callback 的 StreamInstant 为纳秒原点，用有界、callback 私有的 PresentationTracker 记录最后实际源帧的位置（包含合法零样本）和最后转换后设备帧是否非零。无 callback 分配、锁、文件访问或 FFT。输出完成需要：EOF 且 ring 空、已发布排程帧数等于回调读取帧数、尾部排队帧已退休、后续 callback 时钟经过最后排程帧的结束边界；自然结束和 stream 释放共用该判据。最后一次 callback 尚未发布时间信息时，计数屏障也禁止提前结束。后续静音 callback 不移动尾部 deadline。显式 stop、源切换、错误/项目取消继续立即取消，不等待 drain。

没有用固定 sleep 估计尾部。CPAL 0.15.3 WASAPI 的 playback timestamp 是基于 writable frames 的预测值（源码有 TODO），不能单独当硬件呈现证明。本版本 output client 无预填充，首次 callback 的帧数等于 GetBufferSize；以后 callback 大小为 GetBufferSize−GetCurrentPadding。tracker 据此计算 padding，并取 `max(CPAL playback, callback+padding/rate)+lastFrameOffset/rate` 作为尾部时间边界（帧时长向上取整）。后续 writable-frame 观察同时扣减尾部排队距离，因此仅时钟越界但尾部尚未退休时仍不结束。这是锁定 Windows/WASAPI client queue 与 CPAL 调度边界的确认，不是对模拟音频端的测量；升级 CPAL 或切换后端须重新验证首次空队列与固定容量约定。无效/倒退时间或异常容量标记 DeviceFailed，不猜测完成。

诊断语义更正：`consumedFrames` 保持表示 callback 从应用 ring 读取/提交的帧数，UI 标签改为“已提交”；位置游标仍基于该提交时钟，并非逐帧硬件呈现位置。新增独立 `presentation` 字段记录 scheduledFrames、callbackNanos、tailNanos、ringExhaustedNanos、pendingTailFrames、tailNonSilent、drained。**最终 ended 状态必须有 drain 确认**，不能用 consumedFrames 代替。此前本节“设备消费”计数证据应按这一提交计数解释。

确定性 delayed-output sink 回归保留非零末帧，独立推进 callback/呈现时间，证明最后帧从 ring 消失后流仍存活，直到最后排程样本呈现后才允许释放；另覆盖 WASAPI padding 预测不足、时钟已过但尾部仍排队、callback 发布屏障。native 状态测试证明确认前仍 Playing，而显式 stop 不等待尾部。`cargo test -p annotator-core --test playback_state --test dsp` **18+12 通过**；`cargo test -p annotator-desktop --lib` **5 通过**；完整 `npm.cmd test` **22 文件/118 项通过**；`npm.cmd run build`、`cargo check --workspace`、`cargo fmt --all -- --check`、`node --check tests/desktop/playback-smoke.mjs`、`git diff --check` 通过。

固定代码后重启 native，更新 smoke **39/39 通过**，无 runtime errors。自生成 WAV 最后 16 帧为明确的非零小幅样本；Headphones (High Definition Audio Device)，48kHz stereo，音量 8%。本次原生边界证据（纳秒相对各自 stream 首 callback）：

| 真实输出片段 | 提交帧 | ring 耗尽时钟 | 尾部排程 deadline | 确认 callback 时钟 |
|---|---:|---:|---:|---:|
| 3.8→4.0 秒的非零尾部 | 9600 | 179986400 | 199986400 | 199990000 |
| 3.999→4.0 秒，1ms 短段 | 48 | 0 | 23000000 | 30009500 |

两例都记录 tailNonSilent=true、pendingTailFrames=0、drained=true、underrunFrames=0；1ms 段表明首次 callback 已取尽全部 48 帧后仍保持 stream，直到后续时钟过 23ms 的排程边界再结束。日志仍为 `.test-output/task9-native-report.json`。之前明确记录的 picker 路径注入和一次 700ms configure 确认延迟仍在 smoke 中（9600 帧场景属于该受控消息次序检查）；48 帧场景使用普通确认时序。它们都使用真实 native 命令、CPAL/DSP 和时钟，没有伪造音频/进度结果。未观察人工主观听感，不据此宣称耳听验收通过。

### Task 10：可移植分享与安全导入（2026-10-22）

项目菜单新增“分享项目…”与“导入分享文件…”。分享对话框提供仅标注 `.annotations.json` 和完整 `.audioproj.zip`，使用原生保存/打开/目录选择接口；任务具有进度、独立的完成/取消/失败状态和结果路径。所有输出只写本地，目标文件已存在时要求选择新名称，不覆盖文件。JSON 导入保留媒体描述并显示待关联音频；关联沿用现有真实解码/指纹/元数据校验与失败资源所有权，不另建绕过验证的绑定入口。

`exchange::Manifest` / `PortableMedia` 是独立、严格版本化 DTO。只捕获一个权威 revision，保留全部类别、标注及三层备注、屏蔽、analysis、playbackMix、viewState 和算法版本；DTO 没有本地 `sourceRef` 字段。JSON 的 `mediaPath=null`，ZIP 为 `media/<canonical UUID>`；不自动删除用户备注中自己填写的文本路径。导入生成新 projectId，内部媒体/类别/区域/屏蔽 ID 保持一致，因此所有引用继续成立；不会合并进当前项目。ZIP 媒体在导入后保留相对路径，重新分析/试听使用已有 rehydrate/source_path 机制；另存按既有 LocalProject 逻辑重基准到原包媒体。

完整包导出按 64 KiB 分块校验源文件 SHA-256，再复制原字节并计算复制过程指纹；前后 SourceStamp 和长度共同检查，缺失/改变均失败。ZIP 中只有清单和声明媒体，不含 caches、备份或 recovery。导出先在同目录写独占临时文件并 sync，Windows 使用 `MoveFileExW(MOVEFILE_WRITE_THROUGH)` 原子移动发布，不设置 REPLACE_EXISTING 或 COPY_ALLOWED，因此拒绝竞争目标且不会回退为跨盘部分复制。Windows 导出不依赖硬链接；目标卷自身的容量/文件大小限制仍由明确的 I/O 错误报告。

导入限制为清单 16 MiB、4096 entries、实际累计解压 20 GiB、每个媒体 8 GiB。先用有界 EOCD/ZIP64 和原始中央目录预检（中央目录额外上限 16 MiB），再创建 ZIP 索引，避免库的重名去重掩盖恶意条目。实际读取过程独立累计流字节并验证 CRC/SHA-256；支持 Stored / Deflate，拒绝加密/分卷、目录/链接/特殊文件、未声明条目、大小写重复、路径穿越、绝对/盘符/UNC、反斜线、ADS、Windows 设备名及尾点/尾空格。包内路径仅允许 ASCII 且最长 256 字节，合法输出使用固定 ID 路径。ZIP64 索引使用小文件构造测试，不创建巨型测试媒体。

新项目先写到所选目录下新建的随机暂存目录。所有引用/区域范围/未知字段/版本与媒体原字节校验通过后，以实际解码器再次检查采样率、帧数、通道及布局；验证用 PCM 随即释放。项目 JSON sync 后才发布独立目录。取消或失败仅清理规范化路径与随机所有权标记同时匹配的暂存目录，不能按前缀扫删其他文件。生产读取不将整个 archive 或 media 放入缓冲区；资源边界测试用可注入低 Limits。

前端 `performExchange` 使用已有 lifecycle.transition 排空已接受的 enqueueEdit、提交注册草稿、冻结新写入并保存；保存失败不调用交换命令。native import 核对项目 ID/revision/已保存状态，完整验证和发布后才打开新 session、reset playback/media/analysis 并退役旧 session。导入失败保留当前 session 和资源；交换错误属于对话框，不污染已保存项目的失败 ledger。任务完成事件早于 start 返回时，以终态屏障阻止迟到旧 taskId 污染后一次取消请求。

TDD 记录：首次 `cargo test -p annotator-core --test exchange` 因缺失 exchange 模块 RED，首次前端目标因缺失 ExportDialog RED；实现后目标转 GREEN。额外实际 RED→GREEN 回归覆盖交换错误不能变为项目保存错误、旧 start acknowledgement 导致取消错误 taskId、中央目录与结束记录之间的未验证空隙。native ZIP 初次发布出现 Windows ERROR_ACCESS_DENIED：Vite watcher 正在监听 `.test-output` 内新目录。排除生成目录后，同一原生流程通过；没有给生产发布增加重试掩盖该问题。修改 `vite.config.ts` 仅为隔离开发 watcher 与真实项目目录测试。

验证命令与实测结果：

| 命令/检查 | 结果 |
|---|---|
| `cargo test -p annotator-core --test exchange` | 11/11，通过 JSON/ZIP 全语义、双格式媒体、指纹/元数据、复制期间变化、路径/链接/重复、限额、取消、ZIP64、不覆盖和清理 |
| `cargo test -p annotator-core --lib` | 1/1，中央目录边界回归 |
| `npm.cmd test -- src/features/exchange/exchange.test.tsx` | 4/4，格式、终态、生命周期/save failure/成功退役与迟到任务响应 |
| `npm.cmd test` | 23 文件，122/122 |
| `cargo test --workspace` | core 89 + desktop 7 = 96/96；其余 main/doc tests 为 0 |
| `npm.cmd run build`、`cargo check --workspace`、`cargo fmt --all -- --check` | exit 0 |
| 两个 exchange desktop 脚本 `node --check`、`git diff --check` | exit 0 |
| 固定源码并重启后 `node tests/desktop/exchange-smoke.mjs` | 28/28，无 WebView runtime errors |
| 再次终止本次 PID 树、全新进程 `node tests/desktop/exchange-restart.mjs` | 4/4，恢复两个真实相对媒体及全部语义 |

Native 在 1280×800 实际 Tauri/WebView2 执行。准备源数据用真实 native create/import/apply_change/save 命令，源为 stereo WAV 与六通道 FLAC；分享/导入/错误重试/逐个关联/另存通过真实页面按钮。**只注入文件选择器返回路径**，不 mock exchange、文件写入、解码、分析或播放 runtime。断言覆盖未失焦备注草稿被分享、JSON 无绝对源路径、新 projectId、两种格式全部语义一致、错误指纹拒绝、ZIP 目录失败保留旧 playback generation、成功切换 reset、原始字节哈希不变、相对源重建、Save As 重基准、二次分享及整进程重启。目录 I/O 失败使用“普通文件作为目标目录”确定性复现；没有填满硬盘。原生选择器窗口本身未作人工操作验收，长文件性能、安装器及完整交付仍属于 Task 11。

报告：`.test-output/task10-native-report.json`、`task10-restart-report.json`；截图：`task10-import-result.png`、`task10-bundle-1280x800.png`、`task10-fresh-restart.png`。运行 smoke 需要本次真实 dev 窗口启用 9223 调试端口且前端 1420 已就绪；restart 脚本消费 smoke 生成的 `task10-restart-target.json`，必须先完整重启。后台 helper 均以 `Start-Process -WindowStyle Hidden` 启动，仅检查并终止自己记录的 PID 树。

依赖核验：锁定 **zip 6.0.0 / MIT / Rust ≥1.83**，兼容本机 Rust 1.91；`default-features=false`，仅 `deflate-flate2-zlib-rs`。输出采用 Stored 以按原字节封装音频，允许输入 Deflate。参考 [zip 6.0.0 官方文档](https://docs.rs/crate/zip/6.0.0)、[该版本 feature 列表](https://docs.rs/crate/zip/6.0.0/features)，并核验本机下载 crate Cargo.toml / `cargo tree -p zip`：crc32fast **1.5.3**、cfg-if **1.0.5**、flate2 **1.1.10**、indexmap **2.14.2**、equivalent **1.0.3**、hashbrown **0.17.1** 均 MIT OR Apache-2.0；zlib-rs **0.6.8** 为 Zlib；memchr **2.8.3** 为 Unlicense OR MIT。Cargo.lock 中 arbitrary/derive_arbitrary **1.5.0** 是上游条件依赖，此 Windows 默认运行树不启用。Task 11 仍需汇总整个产品的第三方许可。

补充检查发现既有 Task 8/9 代码的严格 clippy 告警：`audio/mixer.rs:45` nonminimal_bool、`audio/renderer.rs:27` too_many_arguments、`tests/dsp.rs:147` 与 `tests/playback_state.rs:368` cloned_ref_to_slice_refs；本任务未更改这些文件。`cargo clippy --workspace --all-targets -- -D warnings` 因这些既有项失败，不能声明全量 lint 通过。仅临时命令级允许这三类已有 lint 后，全 workspace clippy exit 0；没有在源码或配置中永久关闭 lint。Task 11 的最终严格检查仍须处理这些基线项。

### Task 10 双审查修复：导出重试状态与 Windows 发布

质量审查指出，同一 active owner 导出重试在原生保存成功后只调用 store.markPersisted，未清除 lifecycle 内上一次保存错误。新增 `transitionAfterSave`，在已有草稿/编辑屏障内复用正常 Save 的 persistSnapshot；保存版本确认、saveError、savedAt 与 status 由生命周期统一更新。hook 仅清除与本次已确认 lifecycle 错误同一对象的外层错误镜像，不能泛化清除其他错误或失败编辑 ledger。新增同一 owner 的 exchange SaveFailed、正常 Save SaveFailed、正常 Save RevisionConflict → 成功导出回归，实际先 RED 后 GREEN；每例也验证未处理编辑失败仍阻止导出并保留 ledger。

Windows 发布改用同目录 `MoveFileExW`，避免硬链接对 FAT32/exFAT 的兼容限制；同步后移动，关闭替换与跨卷复制选项。Microsoft [MoveFileExW 文档](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw) 与 [文件系统功能对比](https://learn.microsoft.com/en-us/windows/win32/fileio/filesystem-functionality-comparison) 已核验。新增直接 publication 测试先刻画既有不覆盖契约，再运行新后端：写入期间出现竞争目标时保留对方字节；部分写入错误和取消清理自身临时文件；成功只发布完整字节。非 Windows 保留不覆盖 hard-link 实现。本机测试卷为 NTFS；没有挂载/格式化其他卷，也不声称实际 exFAT 设备验收通过。

本轮 `npm.cmd test -- src/features/exchange/exchange.test.tsx src/features/project/lifecycle.test.tsx` **25/25**；完整前端 **125/125**；Rust exchange 集成 **11/11**、core unit **3/3**；build、workspace check、fmt 和 diff check 通过。真实 native smoke 增加实际 recovery 文件替换失败（将本次测试 recovery.json 暂时替换为空目录，随后恢复）：正常 Save 失败后导出、导出前保存失败后点击重试，都确认同一个 projectId 的状态回到已保存且旧提示消失；没有用 mock save 代替 native 磁盘错误。更新 smoke **32/32**，其余 JSON/ZIP 全语义、关联、另存及原字节校验继续通过。文件选择返回路径注入和未实际测试 exFAT 设备的限制保持明确。

## Task 11：可复现的交付检查

项目本地工具不改系统 PATH：`pwsh -File scripts/setup-webdriver.ps1` 安装官方 crates.io `tauri-driver 2.1.0` 到 `.tools/tauri-driver/`，下载与已安装 WebView2 完全匹配的 Microsoft EdgeDriver，验证 Microsoft Authenticode 签名并记录 SHA-256。也可传 `-TauriDriver`、`-EdgeDriver`、`-WebViewVersion` 使用已准备路径。此环境需要 PowerShell 7（pwsh），避免从 Node 继承模块路径后 Windows PowerShell 5 的模块装载冲突。

`npm.cmd run test:desktop` 先构建专用 `e2e` feature 与 `tauri.e2e.conf.json`。测试使用 Selenium → official tauri-driver → Microsoft EdgeDriver 附加到自有真实 Tauri/WebView2 窗口。该机器的 WebDriver 自动启动模式出现 DevToolsActivePort 缺失；采用 Microsoft 官方 attach 模式，没有改成浏览器页面模拟。9235 为测试 WebView 调试端口，4445/4446 为驱动端口。测试只在 Rust `cfg(feature="e2e")` 中替换 native dialog 插件返回预置路径，其余输入使用 WebDriver pointer/keyboard，读取真实 native snapshot 作断言。截图、日志、生成项目保存在 `.test-output/desktop-*`；失败退出非零。

`npm.cmd run perf` 构建优化版本的专用测试应用，生成 600 秒/48kHz/6 通道 WAV 和不同信号的 600 秒/48kHz/2 通道 WAV；运行后端 benchmark 后才开始 UI 计时。暖反馈测输入事件到 canvas `putImageData` 后两帧机会，分别执行平移和缩放；不把事件处理返回当渲染完成。取消反馈观察实际 DOM 状态再等待绘制。默认优先选 Headphones，也可用 `ANNOTATOR_PERF_DEVICE` 指定完整设备名；实际输出原音/处理后各观察 30 秒。内存按 1 秒间隔记录自有 native + WebView2 进程树，报告采样峰值而非声称瞬时精确峰值。完整报告在 `.test-output/perf-*`。

```powershell
cargo run -p annotator-core --release --example benchmark -- .test-output/performance-fixtures/ten-minute-six.wav
npm.cmd run notices
npm.cmd run tauri -- build --bundles nsis
```

最终 NSIS 命令不传 e2e feature 或测试配置，默认 release 没有路径预置入口或调试端口。`licenses/` 整目录作为资源打包，包括 MPL 源码归档。离线 WebView2 安装器由 Tauri 从 Microsoft 官方源下载；构建时需联网，安装包完成后不依赖用户联网下载 WebView2。应用本身的标注操作不需网络。没有签名证书，产物未签名。

缓存约束：全局 PCM 保留预算 128 MiB，唯一共享分析缓存 96 MiB + 串行音频工作线程 32 MiB；移除无消费者的 registry cache。tile backend 128 MiB，disk 2 GiB；frontend 数值 64 MiB，最多 12 个 1 MiB canvas 和对应临时 raster，总体低于 96 MiB。native 分析 2 工作者/32 等待项，frontend 全局 4 个在途请求。callback 保持无分配、无锁、无 I/O，EOF/WASAPI 排空契约保持 CPAL 0.15.3 已锁定版本。

最终检查按计划顺序运行：`npm.cmd ci`、`npm.cmd run fixtures`、`npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run build`、`cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace`、`npm.cmd run test:desktop`、`npm.cmd run perf`、`npm.cmd run tauri -- build --bundles nsis`。历史 Task10 clippy 暂时豁免已移除需要：本任务将 Renderer 参数组合成 RenderOptions，简化布尔式和 slice 引用，严格 clippy 不添加 allow。

### 最终审查修复：分析视图的显式注册与释放

最终全范围质量审查发现，历史 view UUID 在调度器中一直保留，反复切换文件/挂载通道超过 256 个所有者后，即使队列为空也会永久 ResourceLimit。新增回归先在旧代码实际复现该错误，再通过修复。

分析请求现在先调用 `register_analysis_view(projectId)` 获取 native lease，确认后才请求 tile。`cancel_generation` 只推进已注册 lease 的 generation，不创建 scope；`retire_analysis_view` 取消该 lease 的队列/运行任务并移除活动记录。调度器最多保存 256 个活动 lease，单调计数器跨 reset 保留，已释放或旧运行态的 token 永不复用；未知/已释放 token 的 request/cancel/retire 被拒绝，不维护历史 UUID tombstone。

TileClient 注册采用惰性单次 Promise，注册失败可重试；dispose 同步拒绝旧结果/进度，并在未完成的注册最终返回时释放该 token。dispose 不会为了释放一个从未请求的视图而额外注册。测试覆盖 300 个顺序注册/真实 native tile/释放、256 活动上限、迟到 generation 与结果、独立视图、同 projectId 关闭重开、注册确认前禁止请求，以及 dispose/注册乱序。`npm.cmd run test:desktop` 另包含 300 次实际 UI 文件切换和随后首次分析 MP3 的流程。
