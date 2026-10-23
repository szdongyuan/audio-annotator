# 0.3.0 Windows / NAS 协作验收记录

日期：2026-10-23。TaskBase：`796acbc91158b6ec1fe9c35737ae396b7c9e6bd1`；MAIN_BASE：`bb9ff6a5428fad531507738a99eb6a3f82f76fdd`。本记录对应独立工作树 `feature/nas-collaboration-v030` 的 Task 6；根代理后续双审查、整轮审查和主目录整合不由本记录预先宣称完成。

普通项目/分享格式仍为 2，协作清单为独立格式 1，无自动迁移或服务器。共享内容只有每个作者自己的标注、类别及三层备注；私人屏蔽、播放与视图保存在本机，媒体目录固定。账号提供可信目录内的应用级隔离，实际文件权限由 NAS ACL 管理。

## 命令与证据

原始日志：`.test-output/nas-release/`；稳定报告和截图：`docs/evidence/2026-10-23-v0.3.0/`。所有命令实际执行；下表列出最终观察结果。

| 命令 | 结果 | 原始日志 |
|---|---|---|
| `npm.cmd ci` | exit 0，191 packages，audit 0 | `npm-ci.log` |
| `npm.cmd run fixtures` | exit 0，18 个确定性 fixture | `fixtures.log` |
| `npm.cmd run typecheck` | exit 0 | `typecheck-final.log` |
| `npm.cmd test` | exit 0，46 文件 / 355 项 | `frontend-tests-030.log` |
| `npm.cmd run build` | exit 0 | `frontend-build-030.log` |
| `cargo fmt --all -- --check` | exit 0 | `cargo-fmt-final.log` |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 | `cargo-clippy-030.log` |
| `cargo test --workspace` | exit 0，182 项；子进程 worker 测试入口由父测试实际调用 | `rust-tests-030.log` |
| `cargo test -p annotator-desktop --features e2e e2e::tests` | exit 0，1 项 | `e2e-tests-030.log` |
| `cargo clippy -p annotator-desktop --features e2e --all-targets -- -D warnings` | exit 0 | `e2e-clippy-030.log` |
| `npm.cmd run test:desktop` | exit 0，21/21 阶段，先新构建 debug + e2e | `desktop-final2.log` |
| `node --test tests/desktop/harness-lifecycle.test.mjs tests/desktop/harness-output-init.test.mjs tests/desktop/release-suite-registration.test.mjs` | exit 0，11 项 | `harness-final.log` 及最终 desktop 日志 |
| `npm.cmd run perf` | exit 0，新构建 release + e2e 后测量 | `performance.log` |
| `npm.cmd run notices` | exit 0，299 项，无缺失许可 | `notices.log`、`green-notice-version.log` |
| 新构建 0.3.0 debug + e2e 后 `node tests/desktop/compact-layout.test.mjs` | exit 0，15 项，含最终帮助与 0.3.0 版本 | `debug-build-030.log`、`compact-030.log` |
| `npm.cmd run tauri -- build --bundles nsis` | exit 0，正常配置，无 e2e / 额外 config | `nsis-build.log` |

普通 npm ci 保留全部 hooks，进程内 FFMPEG_BIN 指向已验证的相同 ffmpeg-static 5.3.0 缓存，随后恢复环境变量。精确复制 ffmpeg.exe、LICENSE、README 并逐个比较 SHA；EXE SHA256 为 `04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00`。fixture 清单仅换行变化，验证 JSON 语义相等后恢复；无依赖升级。Task 6 Cargo.lock 只改变两个本项目包的版本。第三方声明的大块体积提示保留，未通过放宽阈值隐藏。

## 完整桌面与故障覆盖

完整报告：`.test-output/fidelity-release/desktop-ellAHV/report.json`。原有 project、300 次 view-churn、spectral、restart、sharing、recovery、selection、rulers、compact、classification、folder-scan、folder-flow、feedback、format、fidelity、processed、interaction、独立 sharing 全部保留并通过；追加 native / controls / layers 三个协作阶段。没有删除或降低旧断言。

实际 IPC 合同套件 `.test-output/nas-task3/ipc-RJdUOx/` 通过 8 组：创建并校验复制原音频、账号/访客复制、过期身份拒绝、真实 Windows DACL 拒写、断线本机保存和重连、私有重新关联与个人导出、完整私有恢复、未知共享 JSON 拒绝。DACL 仅作用于本次 fixture 作者目录，finally 恢复并核对原 SDDL；拒写时 pending 保留，恢复后提交成功。这些原生命令测试明确不冒充 UI 操作。

实际 UI controls `.test-output/nas-task4/ui-rk7een/` 通过 9 组。实际双实例 UI `.test-output/nas-task5/two-ui-MgJ3cx/` 通过 16 组：独立进程、WebView 与本机数据根；默认 4445/4446/9235 和第二组 4455/4456/9245。Alice/Bob 在同一区域分别创建框、互见更新，自己的修改/删除/撤销保持另一作者内容；文件/通道/区域只读检查、作者筛选、播放、自己的选区/备注/播放代次保持、各自屏蔽/音量/视图、双方重启登录恢复、当前作者 JSON/ZIP 导出、同账号第二写会话拒绝均通过。改变数据全部通过真实 WebDriver 控件，IPC 只用于读断言。

双实例 UI 断线只暂时改名自有 collaboration.json 并 finally 恢复；Alice 实际编辑、保存后出现“已存本机 / 同步异常”，原生状态 pending 保留，Bob 私有内容不变；恢复后手动同步，Bob 看到 Alice 的新备注。原音及共享音频 SHA256 均保持 `25a6a386be6423ee3958eae4897bcb682248fcf92f128652bd928fdf7e51f9c2`。

以下故障由本轮完整 Rust 测试重新验证，证据层次为真实文件系统/原生受控 worker：真实独立进程的同账号锁竞争与 abrupt-exit 释放、注册与无覆盖并发发布；A 在途 → 保存 B → 确认 A → 重启发布 B、丢失确认和最新未保存 C；分歧基线显式加载、最高损坏作者层保留最后可用数据且隔离其他作者、部分写/rename/同步错误及取消清理。对应 collaboration_repository 19 项、collaboration_workspace 25 项及 native collaboration 17 项包含在 182 项中。没有用直接写 JSON 冒充协作者交互。

五次实际菜单同步加一次轮询，原生 IPC 完成耗时 2.2–13.6ms；总观测 3082ms 包含规定等待，不能当作单次响应时间。通过 fetch 观察真实 IPC 并以只读状态调用正向验证探针有效：频谱 putImageData 0 次、分析请求/注册 0 次、播放配置/控制 0 次；自己的文档与播放代次不变。这是三秒双作者 fixture 的无变化刷新检查，不能当成八通道网络性能测试。

## 高清性能

报告：`.test-output/fidelity-release/perf-y6YQ7M/report.json`。Windows 11 Enterprise x64，Ryzen 5 5600GT，31.3GiB RAM，Node 22.23.3，Rust 1.91 MSVC。两个 600 秒 / 48kHz 源分别为六通道和双通道。实际 Win32 外窗 1920×1080、viewport 1904×1041、DPR 1；性能运行没有 CDP 密度模拟，未改变系统 DPI。

| 指标 | 实测 |
|---|---:|
| 原音导入至八通道首屏 | 3398.19ms |
| 含真实接受屏蔽的暂存编辑首屏 | 404.94ms |
| 40 次 zoom P95 | 90.5ms |
| 20 次 Alt-pan P95 | 84.0ms |
| 20 次 Ctrl-mix P95 | 74.6ms |
| 80 次合并 P95 | 84.0ms，逐项及合并均 ≤100ms |
| 取消可见反馈 | 24.0ms，目标 ≤500ms |
| 原音 / 处理后 300Hz 能量 | -11.449 / -158.109dB |
| 画布加最大单 scratch 估算 | 3,469,024 / 33,554,432 bytes |
| backend benchmark PCM 保留 / 额度 | 133,840,896 / 134,217,728 bytes |
| native / native+WebView sampled peak | 134,873,088 / 795,848,704 bytes |

Headphones (High Definition Audio Device) 实际输出原音 30,595.74ms、暂存编辑 30,553.40ms，全部 60 次采样播放中、帧数递增、600 秒完整范围、欠载 0；应用音量 0.05，系统音量未改。内存 76 次采样，查询后等待 1000ms，实际间隔 1201–1352ms，中位 1231ms；这是采样峰值。PCM 是单独 backend 饱和 benchmark，不冒充 UI 进程实时遥测。

交互计时保持既有终端 dirty strip → tile 完成 → 两次 requestAnimationFrame 的完整分辨率绘制机会合同，不是第一块低清预览或显示器光子延迟。应用缓存新建，OS 文件缓存未清空。前端数值缓存 64MiB、分析 PCM 96MiB、播放 PCM 32MiB 均未放宽，DSP 未改变。桌面 fidelity 中 DPR 1.25/2 是隔离 WebView 模拟，与本性能实际密度分别记录。

## 发现与修复

- 初次完整回归发现 Task 5 把全局激活选区判断变成当前通道判断，导致另一对比面板的首次空白手势错误创建新框。普通/协作两项跨通道回归先 RED（2 失败 / 31 通过），恢复全局可见激活选区判断，同时保留隐藏本人标注的规则；相关 100 项、完整 355 项及完整桌面重新通过。日志 `red-cross-pane.log` / `green-cross-pane.log`。初始失败截图完整保存在 `selection-cross-pane-failure/`。
- 顺序注册先 RED 缺少协作阶段后 GREEN。旧 rulers/compact/classification/feedback 固定输出被发现会更新顶层报告，增加按运行隔离及独立运行唯一目录；两次 RED 各 4 失败，最终 harness 11 通过。首次本轮运行已更新过这些旧顶层文件；fixture 子目录、Task 5 单独报告副本及主目录旧证据未删除，不虚构旧截图恢复。
- 新 DACL 测试初次因 WinPS 继承 Core 模块路径无法载入 Get-Acl，失败发生在 ACL 修改前；独立诊断复现后使用 pwsh，实际拒写、恢复及重开通过。新增断线步骤最初点中同几何屏蔽，截图确认后改为明确从标注列表选择区域，保留原断言。刷新探针最初试图替换不可写的 Tauri invoke，正向调用计数断言发现无效；改用已有测试验证过的 fetch 观察方法后通过。所有失败日志/fixture 保留。
- 许可声明固定旧 0.1.0 标题的检查先失败，生成器改用锁文件版本，最终 0.3.0 检查通过；不是升级依赖。

## 正式程序与冻结交付

正常 NSIS 构建退出 0 后，才启动同一 `target/release/annotator-desktop.exe`。正式主进程 24972、第二进程 37088 使用独立 WebView 数据目录；没有 e2e 环境或预选 picker。`scripts/release-ui.ps1` 始终检查确切 release 路径、前台 PID 与鼠标目标归属，真实文件/目录选择器由原生 edit 控件填入路径并点击真实按钮。额外负向测试证明它拒绝本次 shell PID。

正式报告 `.test-output/nas-release/formal-flow/report.json` 有 6 组通过：普通项目真实新建/导入选择器、创建协作副本和 Alice 标注发布；退出访客查看 Alice；注册 Bob、创建自己的标注，再登录 Alice 查看及筛选；第二个正常 EXE 用真实选择器打开并登录 Bob、更新备注，仍运行的 Alice 看到更新；真实 Delete 创建私人屏蔽，关闭/真实打开选择器/登录恢复，再用真实另存目录选择器生成普通个人 v2，验证仅一条自己的标注及一条屏蔽、没有 Bob 内容；最终帮助及文件版本 0.3.0。原项目文档与共享/源音频哈希保持不变。应用音量为约 0.05（UIAutomation 返回 float32 数值），系统音量未改。两个正式测试进程均正常关闭。

输入法候选窗曾消费 SendKeys 中的空格并遮住按钮，归属检查拒绝了点击其他 PID。未操作该候选窗或改系统输入法设置；关闭当前应用内组合后，文字字段使用原生 UIAutomation ValuePattern，检查确切 release 路径、前台、所属窗口和 native/WebView 子进程归属，并有界等待非密码字段精确保留输入，再由原生登录/共享文件验证接受的值。鼠标、快捷键与真实选择器仍走原 helper，无 DOM/IPC/store 注入。初次断言还发现状态按钮的可访问名称使用 aria-label，最终从真实状态对话框读取同步文字；音量断言按浮点精度校验 5% 且小于 10%。失败日志和拒绝记录保留；早期相同阶段的失败图片名曾复用，后续改为唯一命名，不声称所有早期图片都仍在。

正式 EXE 的 ASCII/UTF-16 扫描没有 ANNOTATOR_E2E_PATHS、ANNOTATOR_E2E_LOCAL_DATA、ANNOTATOR_E2E_DEBUG_PORT、测试选择器错误文字或固定调试端口标记；实际两个 native/WebView 进程树均无 remote-debugging-port 参数。EXE 与 NSIS 文件/产品版本均 0.3.0，签名状态均 NotSigned。

| 正式产物 | bytes | SHA256 |
|---|---:|---|
| annotator-desktop.exe | 15,840,768 | `ac4b4d84a46360af7c43a49774969160418ac89310e763ffc7fafdd7fd881f24` |
| Audio Annotator_0.3.0_x64-setup.exe | 221,767,821 | `aac18ad0667a00906147f6c06a4c234222698abe528b0256f6090f3c51608cd1` |

冻结位置为 ignored `releases/0.3.0/`：程序、NSIS、中文指南、完整 licenses（含精确 MPL 源码归档）、本记录、正式报告、BUILD-PROVENANCE、生产输入清单、FILE-INVENTORY 与 SHA256SUMS。许可资源逐文件与 source/staging 比较 SHA，并核对 NSIS 清单包含每个文件；旧版交付保持不变。交付不包含私人缓存、账号文件或测试密码。

292 个保守生产输入在正常构建前逐字节复制到 `.test-output/nas-release/as-built-inputs/`；`product-source-manifest.json` SHA256 为 `a142be00f89337068cdc9293cb1537bb8d42850e855741cbaf2162dbe9a29052`。冻结时重新核对源文件、保留副本及清单一致。这些字节描述实际构建输入，不能用后续 Task 6 / main 提交号或主目录 CRLF 规范化后的字节反填二进制来源。原始 `.test-output/`、`.tools/`、owned `target/` 由根代理保留和恢复，不能在清理工作树时删除。

## 验证限制

同目录多进程、实际原生 UI 与自有目录故障模拟已测；物理 SMB/NAS 尚未实测。未进行人工听感、实际 Windows 125% 缩放、新机器离线安装/卸载或物理 exFAT 测试。NSIS 包含 WebView2 offlineInstaller 不等于已完成新机安装。程序与安装包未签名。没有改系统 DPI/音量、清理旧发布、移动 target 缓存、操作未知应用或推送；后续根代理保留原始数据后再进行整合。

## 主目录整合补记

整轮审查与主目录重新验证已通过，发布包和原始证据已保留到主目录。测试结果、路径对应和构建输入换行差异见 [主目录整合记录](double-sdd/nas-integration.md)。本补记不修改已冻结交付包中的验证快照或构建来源。
