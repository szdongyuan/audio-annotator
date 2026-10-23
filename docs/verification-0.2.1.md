# 0.2.1 Windows 验收记录

日期：2026-10-23。工作树：`feature/spectral-fidelity-v021`。MAIN_BASE：`be1edfee3023416d1d0521f4186de1493bff5395`；Task8 基线：`b3e63d90a1a2035f3e6536e1915111aac11332c2`。当前仅支持严格格式2，无数据迁移。源音频、物理区域、三层类别/备注、屏蔽、保存恢复与独立分享合同保留。

最终18阶段桌面、高清性能和正常EXE真实系统选择器流程已完成。根代理的Task8双审查、整轮审查、主目录squash及整合复验尚未由本记录宣称完成。

## 命令与原始证据

日志根目录：`.test-output/fidelity-release/`；稳定副本：`docs/evidence/2026-10-23-v0.2.1/`。无依赖升级。

| 命令 | 实际结果 | 日志 |
|---|---|---|
| `npm.cmd ci` | exit0；191 packages；audit0 | `npm-ci.log` |
| `npm.cmd run fixtures` | exit0；原有确定性fixture | `fixtures.log` |
| `npm.cmd run typecheck` | exit0 | `typecheck.log` |
| `npm.cmd test` | exit0；40文件/309项 | `frontend-tests.log`、最终帮助文案后`frontend-tests-final-copy.log` |
| `npm.cmd run build` | exit0；最终正常打包再次执行build/typecheck | `frontend-build.log`、`nsis-build.log` |
| `cargo fmt --all -- --check` | exit0 | `cargo-fmt.log` |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit0；无allow豁免 | `cargo-clippy.log` |
| `cargo test --workspace` | exit0；121项 | `rust-tests.log` |
| `npm.cmd run test:desktop` | exit0；18阶段；额外端口生命周期2项 | `desktop-hd-final2.log` |
| `npm.cmd run perf` | exit0；最终实际高清分辨率 | `performance-final.log` |
| `npm.cmd run tauri -- build --bundles nsis` | exit0；正常配置、无e2e/额外config | `nsis-build.log` |

正常npm ci使用包支持的进程内`FFMPEG_BIN`指向既有匹配5.3.0的ffmpeg二进制，执行全部安装hook并恢复环境变量；之后复制并验证`ffmpeg.exe`、`ffmpeg.exe.LICENSE`、`ffmpeg.exe.README`三份已缓存文件，见`ffmpeg-binary-reuse-verified.json`。最终没有使用ignore-scripts或升级下载。基线下载停滞的历史记录仍保留于fidelity-baseline。

Task2历史说明中的131项是计数错误：原`workspace-test.log`和本轮Rust日志各自16条结果合计均为121项，未丢失测试。已更正历史文字。生产构建第三方许可独立资源块体积提示仍保留。

## 回归范围与真实像素

最终完整报告：`.test-output/fidelity-release/desktop-yDlyyg/report.json`。18阶段全部通过：project、view-churn（300次）、spectral、restart、sharing、recovery、selection、rulers、compact、classification、folder-scan、folder-flow、feedback、format、fidelity、processed、interaction、独立sharing。

保留实际WAV/FLAC/MP3导入、保存重启、恢复、v2/未知版本拒绝、三层分类/备注、257+文件批次、失败ledger重试/取消/重新关联、独立副本与音频包接收。新流程覆盖激活框内移动、框外首次取消、工具条分类/播放/边缘/滚动/持续按住时隐藏、自动范围与显式整段/cue覆盖、右键白线、源切换、实际处理tile及原始字节不变。持续手势使用同一个WebDriver Actions序列；DOM scrollTop测试只声称滚动状态，不冒充物理滚轮。

fidelity最终23组检查覆盖真实1280/1920外窗、单文件双通道、双文件四图和6+6滚动；DPR1/1.25/2为隔离WebView模拟，未改变Windows缩放。实际CSS×DPR backing，最大画布+单个scratch预算估算23,177,792 bytes，小于32MiB；20个物理取样点RGBA误差0，框/刻度最大误差0.000485 CSS px。64MiB数值缓存、64列scratch、实际LOD尾组/halo与功率插值均保留。

同一多音/扫频/脉冲fixture的旧/新截图在稳定证据目录：`fidelity-before-1280.png`、`fidelity-after-1280.png`以及对应1920图。旧图来自Task1实施前记录，新图来自最终重新构建的桌面suite；各图分析参数与真实backing见fidelity-report.json。

## 高清性能与失败修复

Windows11 Enterprise x64，Ryzen5 5600GT，31.3GiB RAM；Node22.23.3、Rust1.91 MSVC。两个独立源均600秒/48kHz，分别6通道和2通道。最终性能报告：`.test-output/fidelity-release/perf-ayzN47/report.json`。实际外窗1920×1080、CSS viewport1904×1041、DPR1，性能运行未使用CDP密度模拟。

计时从真实wheel/Alt pointer事件到最后一条64列dirty strip完成、所有tile状态结束，再等待两次requestAnimationFrame的绘制机会；后续完整绘制会使旧回调失效。不是第一strip、低清预览或显示器光子延迟。原音首次就绪包含冷应用导入和双文件排列；暂存首次就绪从已接受真实屏蔽后的声音版本切换开始。操作系统文件缓存没有清空。

| 指标 | 最终实测 |
|---|---:|
| 原音导入至八通道首次就绪 | 3525.85ms |
| 含已接受屏蔽的暂存编辑首次就绪 | 340.26ms |
| 40次zoom P95 | 82.9ms |
| 20次Alt-pan P95 | 81.3ms |
| 20次Ctrl-mix P95 | 66.0ms |
| 80次合并P95 | 82.7ms（逐项及合并目标≤100） |
| 可见取消 | 21.9ms（目标≤500） |
| 实际300Hz原音/处理后能量 | -11.449/-158.109dB |
| 当前画布+最大单scratch预算估算 | 3,469,024 / 33,554,432 bytes |
| 后端benchmark PCM保留/总额度 | 133,840,896 / 134,217,728 bytes |
| native / native+WebView sampled peak | 134,496,256 / 809,009,152 bytes |

Headphones (High Definition Audio Device)实际输出原音与暂存编辑各30秒以上（30,582.66/30,592.20ms），使用显式“播放整段”避开活动屏蔽范围；每秒读取原生帧计数，全部60次观测播放中、帧数递增、欠载0、完整600秒范围。应用音量0.05，系统音量未改。内存75次采样，每次进程查询后等待1000ms，实际间隔1210–1433ms、中位1241ms；报告采样峰值，不声称瞬时峰值。PCM数值来自单独后端饱和benchmark，不冒充UI进程实时遥测。每job九个4096帧单声道块仍从96MiB分析PCM预算扣除，播放32MiB、前端数值64MiB额度均未扩大。

首次高清实测失败保留于`perf-dgxLaO`：zoom115.6、pan144.6、mix99.2、合并139.2ms。诊断`profile-XP940c`发现温热输入没有新增native tile/status IPC，却绘制了未变化的另一文件画布，pan确认还重复绘制它们。原因是native快照重建等值view/settings对象，Canvas effect依赖对象身份。12画布回归先RED（不应绘制却绘制12张），再改为完整可视字段依赖而GREEN；没有改45ms debounce、DSP、缓存预算或像素密度。修复后完整前端/Rust/18阶段和最终性能重跑通过。

另外保留两项测试适配失败：右键不再激活对象，因此selection旧脚本在移动前改用真实左键选择；folder-scan补建缺失输出父目录。一次suite退出后9235短暂未释放被安全拒绝，未接入或杀死未知进程；owned quit改为有界只读等待端口释放，启动仍拒绝已有占用，2项生命周期RED/GREEN证明等待成功/超时均不关闭其他监听器。

## 正式程序与真实系统选择器

最终NSIS退出0后才启动同一`target/release/annotator-desktop.exe`，使用独立WebView目录并移除测试picker/调试参数环境变量。原有`scripts/release-ui.ps1`始终核对PID对应本工作树release路径、前台窗口与鼠标目标归属；UIAutomation定位和Win32真实输入，native picker真实edit控件填入路径后点击真实按钮，无测试IPC、预设picker返回或store修改。额外负向检查证明helper拒绝本次shell PID。

`formal-flow/report.json`为13项通过：10项实际UI场景加3项源/像素/产物核验。真实新建/导入文件夹、设置外部关闭与直接切换、A/B→C/B及A/C、双向重复高亮、悬浮分类/区域备注、框内持久移动/框外首次取消、空格自动范围、悬浮播放、右键不中断现有播放、白线cue、暂停继续/停止后自动范围恢复、Delete真实屏蔽、真实open选择器保存重开、默认完整包真实save及独立接收方open/目录选择均完成。正式帮助与文件版本均0.2.1；最终帮助文案清理后再次前端309项与正常NSIS构建，正式UI也核对了更新文本。

正式区域为2.5–6.5秒、约4.75–1536.53Hz。实际截图3–6秒/300Hz ROI的RGB均值156.9048→0，6000Hz ROI不变；接收方原音和暂存ROI各自与发送方完全一致。这是像素对照，不把颜色反推为dB；真实数值能量来自上面的性能与processed suites。

默认ZIP为6,916,837 bytes，含manifest及三份各2,304,044-byte原始WAV。将本次自有原始目录暂时移走后，真实导入产生新projectId/独立目录；所有持久语义和三份接收音频SHA均一致，实际处理后输出253,056帧、欠载0。第三个未显示文件沿用既有延迟校验策略；其接收原件已独立哈希校验。原目录在finally恢复，三份原音哈希前后一致。项目重开文档与保存副本全等。正式进程已正常关闭。

EXE/NSIS均NotSigned，文件/产品版本0.2.1；ASCII/UTF-16扫描均无`ANNOTATOR_E2E_PATHS`、`No preselected e2e picker path`、`--remote-debugging-port=9235`。正常配置无additionalBrowserArgs，实际owned native/WebView进程树无remote-debugging-port参数。

| 正式产物 | bytes | SHA256 |
|---|---:|---|
| annotator-desktop.exe | 14415360 | `8e49f90e8fcd0adac0a66dd0cbb73512c4747e15f6f8b172583857c41ba79b10` |
| Audio Annotator_0.2.1_x64-setup.exe | 221434863 | `31df3d94ed173e7cef21e4b175ff1ba5fe96ba8b037c4eb525716c36e383890b` |

交付目录`releases/0.2.1/`包含程序、NSIS、使用说明、第三方声明、31份许可（含13份MPL源码归档）、本记录、正式报告、BUILD-PROVENANCE、FILE-INVENTORY和SHA256SUMS。冻结脚本核对许可与打包staging/NSIS清单逐字节一致；既有许可未重新抓取。257个生产输入文件的SHA清单和总摘要记录来源，避免用未来提交号反填二进制来源。旧0.1.0/0.2.0交付未覆盖，主目录0.2.0两份程序的既定SHA再次验证不变。

## 验证边界与交接

尚未进行人工听感、物理Windows125%缩放、新机器离线安装/卸载及物理exFAT测试。NSIS配置包含WebView2 offlineInstaller，不能据此声称已完成新机安装。没有改系统DPI/音量，没有推送、合并、移动target缓存或清理主目录用户文件。

原始证据需整体保留：工作树`.test-output/`（含fidelity-baseline、fidelity-task1…7、fidelity-release、各旧suite输出和performance-fixtures）；`.tools/`为本地驱动配置；`target/`为根代理移交的共享构建缓存，必须由根代理恢复，不能删除。发布与稳定证据已独立冻结。Task8提交之后由根代理完成双审查、整轮审查、本地squash、主目录复验与受控清理。
