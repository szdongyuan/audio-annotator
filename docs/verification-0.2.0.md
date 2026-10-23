# 0.2.0 Windows 验收记录

日期：2026-10-23。工作树：`feature/compact-workspace-v2`。Task8 基线：`a12d3221031245f3d0a0b4aebf57748997bc3dbe`；整轮基线：`14b8d5649e19a29c2f34dc2a73fb7eac3fada7e9`。

本轮只支持 formatVersion 2，无旧数据迁移。保留正常保存、恢复、备份、另存及源文件保护。原始日志位于 `.test-output/task8-release/`，各原生 suite 的报告包含独立运行目录；选取的稳定证据位于 `docs/evidence/2026-10-23-v0.2.0/`。历史 Task2–7 记录用于说明针对性回归与先前审查，下面最终结果以本轮重新执行为准。

## 检查命令

所有命令在工作树根目录运行，GUI suite 顺序拥有/关闭自有进程。npm/Cargo 锁定依赖未升级，无新第三方依赖。

| 命令 | 本轮结果 | 原始日志 |
|---|---|---|
| `npm.cmd ci` | exit 0；191 packages，audit 0 vulnerabilities | `npm-ci.log` |
| `npm.cmd run fixtures` | exit 0 | `fixtures.log` |
| `npm.cmd run typecheck` | exit 0 | `typecheck.log` |
| `npm.cmd test` | exit 0；33 files / 232 tests | `frontend-tests.log` |
| `npm.cmd run build` | exit 0；第三方许可独立资源块的体积提示保留 | `frontend-build.log` |
| `cargo fmt --all -- --check` | exit 0 | `cargo-fmt.log` |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0，无 allow 豁免 | `cargo-clippy.log` |
| `cargo test --workspace` | exit 0；117 tests | `rust-tests.log` |
| `npm.cmd run test:desktop` | exit 0；14 phases，全量重跑通过 | `desktop.log` |
| `npm.cmd run perf` | exit 0；暖反馈、取消、实际设备欠载目标通过 | `performance.log` |
| `npm.cmd run tauri -- build --bundles nsis` | exit 0；正常配置，无e2e feature；211.16MiB NSIS | `nsis-build.log` |

## 规格 §9 追踪

| 要求 | 证据来源与边界 |
|---|---|
| 统一框选、右键、Delete、试听、移动/resize、重叠对象、菜单键盘和边缘定位 | selection-flow、compact-layout，真实 WebDriver pointer/keyboard；unit 覆盖过期 owner/几何与保存屏障 |
| 透明框、去常驻教学、六菜单真实功能 | selection-flow 的样式断言、compact-layout 截图；classification/folder-flow 验证最终分类及文件夹入口；inline guide 与版本同步 |
| 1280/1920/1000、四图与6+6、左右/上下、分隔线 | compact-layout/classification-flow 用 Win32 对 owned PID 测外窗，并记录 CSS viewport、DPR、plot 高度与可见性；CDP 1.25 仅模拟，真实 Windows 125% 未验证 |
| Ctrl 滚轮、轴拖选、刻度、≤0.5px、暖缓存不重算 | rulers-flow 的 trusted wheel/pointer、deltaMode 合成边界用例和 native request 计数；单元坐标往返断言 |
| 三层分类与 v2 JSON/ZIP 全语义 | classification-flow 保存重启、重关联、删除类别撤销与两种分享；format-flow 实际 v2 保存及1/999拒绝源 bytes 不变；普通打开不承诺旧会话回滚 |
| 文件夹可靠批次与限制 | folder-scan + folder-flow（257+候选、大小写/子目录/损坏/重复、取消与项目切换、失败ledger暂停/恢复）；Rust core 覆盖reparse/权限/限额 |
| 原有可靠性与300次churn | project/view-churn/spectral/restart/sharing/recovery 六阶段保留；feedback-flow 验证并发错误/进度不重叠及可恢复 |
| 长音频、内存、真实设备性能 | performance 报告：600秒48k6ch + 独立600秒2ch；40zoom/20pan/20mix；事件→Canvas→两帧机会；采样进程树峰值 |
| 正式0.2.0交付与真实选择框 | 正常无e2e的 NSIS/EXE，打包完全结束后再实际启动；正式UI流和产物bytes/SHA记录见下文 |
| 未签名与实际限制 | 无证书；人工听感、新机离线安装/卸载、物理exFAT、真实Windows125%未验证 |

## 最终桌面、性能与正式交付结果

全部14个桌面阶段通过；随后加强了嵌套菜单边缘断言，重新执行 selection-flow 与 compact-layout 通过。六个主菜单均由实际 UI 流程覆盖。真实 1280×800 外窗的 CSS viewport 为1264×761、DPR=1、scale=1，四张完整plot均236.5px；1920×1080外窗对应1904×1041，四图376.5px。1000×680与两文件各六通道的plot最低180px，支持独立滚动；顶部72px、底部48px、文件标题/控制54px。查看了四图、六通道末尾、窄频率刻度、透明框、边缘子菜单和帮助截图；未发现框内着色、文字被标签整片遮挡或菜单越出窗口。长文件名使用截断及完整title，分类按钮保留命名范围。

性能环境与原始样本见 `performance-report.json`，完整内存序列见 `performance-memory.json`。两源均600秒、48kHz，分别六通道与独立信号双通道；图形输入预热后40次zoom、20次Alt拖动pan、20次Ctrl滚轮mix，保持现有PCM/tiles/frontend预算。

| 性能指标 | 实测 |
|---|---|
| 冷导入两源至双文件八通道就绪（OS缓存未清空） | 4330.48ms |
| 80次暖反馈合并P95 | 67.2ms（目标≤100ms） |
| zoom / pan / mix 各自P95 | 65.9 / 98.2 / 65.3ms |
| 可见取消 / 任务完成 | 15.4 / 87.75ms（可见目标≤500ms） |
| 实际Headphones设备原音 / 处理后 | 各30秒；全部60次观测欠载0；处理后有真实Delete创建的屏蔽 |
| 应用音量 | 0.05，系统音量未改 |
| native / native+WebView2 sampled peak | 140972032 / 755871744 bytes（134.44 / 720.86MiB） |
| 内存采样 | 67次；每次查询后等待1000ms，实际间隔中位数1342.835ms、范围1309.093–2328.596ms |
| 后端PCM保留总量 / 上限 | 134135808 / 134217728 bytes |

上述性能目标通过，未更改DSP、采样比率或缓存预算。正式NSIS与系统选择框流程也已完成，结果如下。

## 正式程序与交付产物

正常命令完成NSIS后才启动该exe，使用独立WebView用户目录，移除测试 picker 和调试参数环境变量。真实 native 新建目录选择器→导入文件夹选择器→三个独立类别及备注→Win32左键矩形→右键区域分类→原始选区播放→Delete屏蔽→处理后选区播放→保存→真实native保存对话框导出JSON→关闭项目→真实native打开对话框重开。只向已核验属于此exe的窗口和鼠标位置发送输入；完成后正常关闭此进程。

`formal-release-report.json` 全部9项检查通过。原始/处理后选择输出分别观测71136/77376帧且欠载0（正式流程是短时确认；各30秒验证见性能运行）。本地文档revision11：1个媒体、1个区域、1个同范围启用屏蔽；文件类/通道类/区域类分别独立，第二通道未分类，文件/通道/区域备注独立。分享JSON2724 bytes完整保留语义并脱敏sourceRef；重开后文档全等。源WAV2304044 bytes的SHA256前后均为`0e671c8188c832cd36f45e87df34dcc4b60a77f669bd036f5f48bf0c49cd2ce0`。

正式exe的FileVersion/ProductVersion均0.2.0，exe与NSIS的Authenticode状态均NotSigned。扫描exe中ASCII与UTF-16的`ANNOTATOR_E2E_PATHS`、`No preselected e2e picker path`、`--remote-debugging-port=9235`均不存在；正常配置不设置additionalBrowserArgs，实际owned native/WebView进程树没有remote-debugging-port参数。配置和生成NSIS脚本确认offlineInstaller及完整licenses/guide资源；所有31份许可文件（含13份MPL源码归档）与打包资源逐字节核对。

| 产物 | bytes | SHA256 |
|---|---:|---|
| `annotator-desktop.exe` | 14380544 | `0ad24b0d10989b9ad10031a8c0af3a24f548d5be4a9c0ebb5a8be8c6cb568afe` |
| `Audio Annotator_0.2.0_x64-setup.exe` | 221422008 | `3906e833dd2e4c28977ffe575e6bda244de830619f2114499bf3677dd61ef49d` |

交付副本保存在工作树 `releases/0.2.0/`，包含EXE、NSIS、使用说明、第三方说明、完整licenses与MPL源码、验收记录及SHA256SUMS。它们来自已测试的同一正式构建，不含测试fixture/原始日志；保留0.1.0副本。Task8双审查、整轮审查、本地主目录squash/复验与清理由根代理随后完成，本记录不冒充这些步骤已通过。

## 验证方法与限制

自动 desktop/perf 使用专用 `e2e` feature，仅预设系统选择器返回路径；其余输入通过 Selenium → tauri-driver → Microsoft EdgeDriver → 实际 Tauri/WebView2。通过 native snapshot 只读断言权威文档。用于错误恢复的 transport/Channel 注入在报告中明确列出，不冒充实际磁盘或网络故障。

正式程序使用 `scripts/release-ui.ps1`：PID 必须匹配本工作树 release exe；UIAutomation 定位、Win32 实际鼠标/键盘；native picker 的真实 edit 控件使用 WM_SETTEXT 后点击真实选择/保存按钮。无测试 IPC 或调试端口。鼠标目标与前台窗口核验属于本次进程，不操作用户其他窗口。

性能首屏不清理操作系统文件缓存；warm feedback 是输入事件时间→实际 Canvas putImageData→两次 requestAnimationFrame 的 paint opportunity，不是显示器端到端光学延迟。内存每次查询后等待1秒（进程查询本身另耗时），报告 sampled peak，不声称瞬时精确峰值。实际原音/处理后输出各30秒和欠载计数不能替代人工听感。

没有修改系统 DPI、音量或安装全局工具；测试设备音量仅在应用内设为较小值。打包配置包含 WebView2 offlineInstaller，但全新离线机器安装/卸载未实际执行。原0.1.0交付和用户文件保留。

## 主目录整合复验（2026-10-23）

Task8规格及质量双审查、整轮`14b8d5649e19a29c2f34dc2a73fb7eac3fada7e9..608f7bf64b21160992ddfbe077e1d745fe4f0db7`质量审查均PASS，无待修问题。主目录在记录的MAIN_BASE上执行本地squash，整合后的源文件树与审查Head完全一致；之后仅补充本节、证据索引及计划完成状态，不改产品代码。

在`D:/Work/annotator`重新执行`npm.cmd test`（33文件/232项）、`npm.cmd run build`（含typecheck）和`cargo test --workspace`（117项）全部exit 0。日志保存在`.test-output/integration-v2/`。生产构建的许可独立资源块体积提示仍如实保留。

正式交付已保存在主目录`releases/0.2.0/`，39项SHA256再次逐文件验证通过。完整原始证据保存在`.test-output/compact-workspace-v2/`（14351文件、1200321024 bytes）；历史报告中的工作树`.test-output/`路径映射到此目录。冻结交付包内的验收记录保留发布时快照，本节记录之后的主目录整合。构建缓存已移回主目录`target/`。原`releases/0.1.0/`的程序与安装包哈希未变；用户原有`.agents/`、`.codex/`、`.double-sdd/`未纳入提交或清理。

临时工作树 `D:/Work/annotator/.worktrees/compact-workspace-v2` 与临时分支 `feature/compact-workspace-v2` 已在保存全部交付、证据及缓存后清理；最终main仅保留一个正式实现提交，没有推送远端。
