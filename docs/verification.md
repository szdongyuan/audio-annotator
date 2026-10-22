# 验收记录（2026-10-23）

## 环境与状态

Windows 11 Enterprise x64，AMD Ryzen 5 5600GT，31.29 GiB RAM；Node 22.23.3，Rust 1.91.0 MSVC，WebView2 155.0.4283.62。应用 0.1.0。开发过程从 2026-10-22 延续到 2026-10-23，历史 Task1–10 记录保留原日期。

以下是已执行结果，不把未执行的人工听感或全新机器安装算作通过。小型持久证据已存入 [evidence/2026-10-23-owner-fix](evidence/2026-10-23-owner-fix/)，原始日志和项目在工作区 `.test-output/`。

## 最终审查与本地整合

11 个实施任务均通过规格与质量双审查。全实现审查发现并修复下述分析视图生命周期问题，修复双审查及最终全量质量复审均 PASS；最终审查范围为 `819c224b9ed1bef9de0687aff6bc487412f95ee4..b28e75aff07508fe1b467ea7ef43e51156417ee9`。

按照已批准计划，本地 squash 应用到 `main`，未推送远端。整合时暂存树与已审查 worktree 文件树完全一致（`9bec7ac8ada0846b6d9ec840018393330a1fa259`）；之后仅补充本节、验收日志及计划完成状态。主目录重新执行 `npm.cmd ci`、`npm.cmd test`（128 项）、`npm.cmd run build`（含类型检查）、`cargo test --workspace`（102 项），均 exit 0。Rust 复验使用原工作树 target 缓存，但从主目录源码重新编译本地 crates；不是重复引用旧测试报告。日志保存在 [integration](evidence/2026-10-23-integration/)。

本机交付副本位于 `D:/Work/annotator/releases/0.1.0/`，含正式 EXE、NSIS 安装包、使用说明、第三方许可及 `SHA256.json`。副本已逐项核对下文记录的最新 SHA-256。原始 `.test-output/` 与本机开发工具、构建缓存迁回主目录保留；历史记录中的工作树绝对路径表示当时执行位置。用户原有 `.agents/`、`.codex/`、`.double-sdd/` 未纳入提交或改动。

## 最终审查修复：视图退出后释放分析所有者

旧调度器把每个历史 view UUID 保留到项目 reset；超过 256 次挂载后，即使队列为空也会 ResourceLimit。新增 300 个顺序所有者的测试首先在旧代码真实失败，再改为显式 native 注册/释放契约并通过。

现在只有已注册的 lease 能 submit/cancel；retire 取消队列与运行任务后移除记录。活动 lease 上限仍为 256；单调 token 计数跨 reset 保留，旧 token 不复用，也不保存退休 UUID tombstone。迟到请求、取消和结果不能重建 scope。前端等待注册确认才发送请求；dispose 同步失效，并释放任何迟到的注册结果；失败注册可以重试。

新增 Rust 3 项、前端 3 项回归及扩展 native service 回归覆盖 300 次真实 native tile 往返/释放、活动上限、未知取消不分配、迟到结果、独立视图、同 projectId 关闭重开和注册/dispose 乱序。队列/缓存、DSP 与 callback 契约保持不变。

## 最终命令

本次最终审查修复的顺序运行记录：[final-commands.json](evidence/2026-10-23-owner-fix/final-commands.json)，原始日志 `.test-output/owner-fix-20261023-004338/0.log` 至 `8.log`。依赖和 fixtures 未改变；此前包含 ci/fixtures 的 Task11 完整命令记录另保留于 [历史记录](evidence/2026-10-23/final-commands.json)。

| 命令 | 结果 |
|---|---|
| `npm.cmd ci` | Task11 先前 exit 0，191 packages；本次未改依赖 |
| `npm.cmd run fixtures` | Task11 先前 exit 0；本次使用未改变的真实 WAV/FLAC/MP3 fixtures |
| `npm.cmd run typecheck` | exit 0 |
| `npm.cmd test` | exit 0，23 files / 128 tests |
| `npm.cmd run build` | exit 0，生产前端构建 |
| `cargo fmt --all -- --check` | exit 0 |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0，无命令级或源码 lint 豁免 |
| `cargo test --workspace` | exit 0，102 tests（core 95，desktop 7）；doc tests 0 |
| `npm.cmd run test:desktop` | exit 0，6 个实际桌面流程组 |
| `npm.cmd run perf` | exit 0，长文件指标如下 |
| `npm.cmd run tauri -- build --bundles nsis` | 本次 exit 0，一次成功 |

历史 Task11 检查点的首次 NSIS 构建时，验证者在 makensis 完成前提前启动了刚编译的 release exe，导致打包结束阶段文件占用。停止该次自有进程后重跑同一命令成功；没有修改测试期望或应用功能。保留 [packaging-retry.json](evidence/2026-10-23/packaging-retry.json) 和原始 `10-retry.log`，不称该次历史整串命令全部成功。本次修复已等待打包命令退出后才启动正式 exe，整串受影响命令均 exit 0。

## 实际桌面验证

[desktop.json](evidence/2026-10-23-owner-fix/desktop.json) 对应 `.test-output/desktop-tDCWAO`。Selenium 4.41.0、official tauri-driver 2.1.0、Microsoft EdgeDriver 155.0.4283.62；EdgeDriver Microsoft Authenticode `Valid`，SHA-256 `01CE0DAA683E5EA874E2E2439E4A162DB11B0D40228D37CCE1EFC990294464F6`。

自动启动模式报 DevToolsActivePort 缺失，改用 [Microsoft 官方 attach 模式](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webdriver)。驱动仍连接真正 Tauri exe 的 WebView2，未替换为浏览器 mock。专用 e2e feature 只在 native picker 边界返回预置路径；按钮、文本、选择、拖动均使用真实 WebDriver pointer/keyboard。生产构建没有该 feature 或端口配置。

六组流程覆盖新建/打开、WAV 1 通道/FLAC 6 通道/MP3 2 通道、绘制区域、类别、三层备注、轴变换、六通道和双文件、无通道状态、撤销重做、实际 native 输出、保存后销毁进程并重启、JSON/ZIP 往返与缺失媒体状态。另将本次自有项目副本的正式文档损坏，实际显示恢复选择、确认焦点在对话框、取消打开、再恢复成功。保存重开比较语义数据，不只检查页面文字。

另执行 300 次实际 UI 文件切换，累计挂载 450 个通道所有者，然后首次分析 MP3 成功；见 [churn 截图](evidence/2026-10-23-owner-fix/view-churn.png)。

- [1280×800 双文件](evidence/2026-10-23-owner-fix/dual.png)：主区域无页面横向溢出。
- [六通道](evidence/2026-10-23-owner-fix/six-channels.png)：通道区滚动，工具及播放栏保留。
- [恢复选择](evidence/2026-10-23-owner-fix/recovery.png)：真实磁盘故障输入及焦点。

Task1–10 的数值、失效、交换安全及设备回归记录见 development.md。Task9 已有真实 Headphones 48kHz 双声道 39 项检查，包括短音频 EOF/WASAPI 排空；不能据此声称人耳音质验收完成。

## 性能

[performance.json](evidence/2026-10-23-owner-fix/performance.json) 对应 `.test-output/perf-TAutYJ`。使用优化 release + e2e picker 构建；所有编译和后端 benchmark 完成后才开始 UI 测量。新项目、空应用分析缓存及新解码 PCM；未清除 OS 文件缓存。两份独立 600 秒 / 48kHz 原始 WAV：

| 文件 | 通道 | 字节 | SHA-256 |
|---|---:|---:|---|
| ten-minute-six.wav | 6 | 345600044 | `c1c63cc3788f47124314a251de43c9cc15071b98a9889242a58d2b7c7eb5f5e4` |
| comparison-stereo.wav | 2 | 115200044 | `722ff4d5ccb92119cf1421ed42349f272c793f4f8efb1fe23819b09ccc493375` |

| 指标 | 实测 | 规格 |
|---|---:|---|
| 冷导入至双文件 8 通道首屏绘制 | 3183.72 ms | 记录，无预设阈值 |
| 暖缓存可见反馈 P95（40 缩放 + 20 平移） | 33.20 ms | ≤100 ms |
| 取消可见反馈 | 21.70 ms | ≤500 ms |
| 取消任务完成（含 WebDriver 往返） | 138.87 ms | 另行记录 |
| Headphones 48kHz 原音 / 处理后各 30 秒 | 所有 60 次采样欠载 0 | 无可重复欠载 |
| native 工作集采样峰值 | 95481856 bytes（91.06 MiB） | 记录，无预设阈值 |
| native + WebView2 进程树工作集采样峰值 | 696045568 bytes（663.80 MiB） | 记录，无预设阈值 |

输入事件时间戳 → 实际 canvas `putImageData` → 两次 requestAnimationFrame，测量绘制后的呈现机会，不把 handler 返回当作画面完成；不声称测到了物理显示器扫描时刻。内存每秒采样一次，记录 61 个样本；进程树工作集求和可能重复计算共享页，采样峰值可能漏过瞬时峰值。应用音量 5%，系统音量未改变。播放采样共 60 秒，未播放整段 10 分钟；后端对整段 600 秒 PCM 分块扫过，并单独测量约 30 秒处理输出的生产速度。

修复了分析与播放各自默认 128 MiB 的组合保留问题。回归先 RED（缺少分区契约），再 GREEN；生产唯一分析缓存 96 MiB、串行播放工作线程 32 MiB。长文件实际饱和后分析 `100589568`、播放 `33546240`，合计 `134135808` bytes ≤ `134217728`。callback 仍无分配、锁、磁盘 I/O，EOF 排空契约未改。

其余限额由实现与既有边界/压力测试验证：backend tiles 128 MiB，磁盘 tiles 2 GiB，frontend 数值 64 MiB + 受限 canvas/raster，总体小于 96 MiB；native 分析 2 工作者、32 等待项；frontend 4 个在途请求。总进程内存还含 WebView2、代码、解码/处理临时缓冲等，不等于缓存预算。

## 正式发布产物

成功打包后，再启动正式 exe 完成新建 → native 文件选择导入 → 实际鼠标拖动标注 → Headphones 试听 → 保存 → native 保存对话框分享 JSON。此次没有 e2e feature、调试端口、store 修改或 native command 注入。Windows UIAutomation 定位控件，Win32 pointer 进行实际点击/拖动，路径通过真实文件对话框 Edit 控件输入（WM_SETTEXT），再点击真实确认按钮。

[release-workflow.json](evidence/2026-10-23-owner-fix/release-workflow.json) 记录正式 exe SHA 与下表一致；[试听截图](evidence/2026-10-23-owner-fix/release-audition.png)、[分享截图](evidence/2026-10-23-owner-fix/release-shared.png)。保存项目 revision 2、1 个物理区域；分享 JSON 1846 bytes，区域语义与保存项目相同、无 sourceRef；原始 six.flac 指纹保持不变。实际输出读到 184416 已提交帧、欠载 0，应用音量 6%。测试的是打包所用的正式 release exe，未执行 NSIS 安装 UI，也没有覆盖已有安装。

| 产物 | 字节 | SHA-256 |
|---|---:|---|
| `target/release/annotator-desktop.exe` | 13956096 | `C974F0C75B40DAFE279E9DE94DC2791D58A07C2864E2B7D8DE92C8C2DFB0D711` |
| `target/release/bundle/nsis/Audio Annotator_0.1.0_x64-setup.exe` | 220631950 | `CA138E085B0618E5022717BDA22A148F2900DCFFC6FAE07B039A4E75E2E14C35` |

两者 Authenticode 均 `NotSigned`。[artifacts.json](evidence/2026-10-23-owner-fix/artifacts.json) 含完整工作区路径。正式二进制未找到 `ANNOTATOR_E2E_PATHS` 或测试端口参数，正常 tauri.conf.json 不含调试配置。原创几何图标的 source.svg / PNG / ICO 沿用 Task1 已创建资源。

另保留同 SHA 的交付副本于 `.test-output/delivery-0.1.0-owner-fix-20261023/`，包含 exe、NSIS、用户说明与全部 licenses，避免后续运行 perf 的 e2e release 构建覆盖已验证 exe。见 [delivery-snapshot.json](evidence/2026-10-23-owner-fix/delivery-snapshot.json)。

NSIS x64 使用 `offlineInstaller`；生成的 installer.nsi 明确 `File` 内嵌 Microsoft 离线安装程序，并安装 user-guide.md、third-party.md、全部 `licenses/` 通知与 MPL 源码。下载来自 `https://go.microsoft.com/fwlink/?linkid=2124701`，214156024 bytes，Microsoft Corporation 签名 `Valid`，SHA-256 `0625FB5C1E75BE58A164E14F95AA58A3E5BADB859B3D17C952385F3E4A9FF3E8`。文件版本 `1.3.287.9` 是安装程序版本，不把它冒充所安装 WebView2 版本。见 [webview2-offline.json](evidence/2026-10-23-owner-fix/webview2-offline.json)。

[dumpbin /DEPENDENTS](evidence/2026-10-23-owner-fix/release-dependencies.txt) 检查正式 exe，只列出 Windows 系统 / UCRT DLL，未发现需另配的 VC runtime DLL；WebView2 本身仍是必须运行环境。本机实际启动验证不能替代全新机器安装验证。

## 明确保留的验证限制

- 未进行主观人耳听感、物理声压或跨声卡兼容性验收；计数与数值测试不能代替这些。
- 未在全新 Windows、无 WebView2 的离线机器运行安装器，也未验证 NSIS 安装/卸载 UI；已构建真实离线分发安装包并测试其对应 release exe。
- 未在真实 exFAT 设备验证原子发布/恢复；当前测试卷为 NTFS。
- Selenium 常规自动测试不操作系统 picker；正式 release 补充流程实际操作了本机 folder/open/save picker，但没有覆盖全部系统对话框边缘行为。
