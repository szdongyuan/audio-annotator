# 0.4.0 Windows 默认协作验收记录

任务日期 2026-10-25；最终修复和验收跨至 2026-10-26（Asia/Shanghai）。TaskBase：`26c33585e9d2a407c31e4ff24409dd7e91d02ffd`；MAIN_BASE：`ab4c885b072420636d012c6235087f2836c87be0`。本记录对应修复未保存版本另存救援缺陷后的最终候选；根代理的双审查、主分支整合及清理仍独立执行，不预先宣称完成。

默认新建、个人副本和分享导入使用协作格式 2，自动本机作者无需注册。所有可写作者可追加音频，外部新增必须显式更新；他人内容只读，私人屏蔽/音量/视图/隐藏独立。旧普通格式 2 和协作格式 1 明确兼容，不自动迁移。

## 最终命令与结果

最终 raw root：`.test-output/default-collaboration-v040/task5/saveas-rescue/`。GUI 原始数据在父级 `desktop-evidence` 的专用 C 盘目录；项目操作采用实际路径，不放松 reparse 安全规则。构建与 GUI 流程串行，只有明确拥有的进程和 fixture 被操作。

| 命令 | 实际结果 | 最终日志 |
|---|---|---|
| `npm.cmd run typecheck` | exit 0 | typecheck-final.log |
| `npm.cmd test` | 48 文件 / 393 项通过 | frontend-final.log |
| `npm.cmd run build`（Tauri beforeBuildCommand） | exit 0；保留已有声明大块提示 | e2e-build-final.log、nsis-build.log |
| `cargo fmt --all -- --check` | exit 0 | fmt-final.log |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 | clippy-final.log |
| `cargo test --workspace` | 249 项通过，含完整目录容量用例 | workspace-final.log |
| `cargo test -p annotator-desktop --features e2e` | 47 项通过 | e2e-native-final.log |
| `cargo clippy --workspace --all-targets --features annotator-desktop/e2e -- -D warnings` | exit 0 | e2e-clippy-final.log |
| `npm.cmd run test:desktop` | exit 0，全部 22 阶段 | desktop-final2.log / desktop-fIzupN/report.json |
| `npm.cmd run tauri -- build --bundles nsis` | exit 0，正常优化 EXE 和 NSIS，无 e2e/config override | nsis-build.log |

版本统一为 0.4.0；正常 notices 生成器在父级 `notices.log` 记录 299 包、无缺失声明。之后未改变依赖或许可证，未升级依赖。

完整桌面保留原 21 个阶段并加入默认双实例，包含 300 次视图变化、播放真实输出帧、选择/标尺、1280/1920 与最小窗口、DPR1/1.25/2 物理像素参考、6+6 通道、屏蔽/处理后音频、JSON/ZIP、旧格式、作者图层及原生故障。文件夹全部 10 组通过：257 有效文件加坏文件/跳过、递归同名独立 UUID、258 已复制源路径、失败暂停时 513 与显式重试后 515、取消/晚到事件/重新关联。最终 debug 首批等待 126,673 ms，取消可见 74 ms；它不是优化构建吞吐基准。分类按实际作用域/文件名定位，两种 UUID 排序均有独立完整通过证据。

处理后图像重开检查曾在 requestAnimationFrame 提交前读到三个纯黑画布；聚焦重跑实测 242.30 ms 时为纯黑、540.99 ms 时精确恢复全部原位图。测试改为有界等待四个原始哈希完全一致，保留样本与像素断言，未修改产品渲染代码。该测试就绪修正及新的完整回归与保存救援缺陷分别记录。

## 保存失败后的另存救援

全范围审查发现：前端明确允许 Save As 在源保存失败后提交当前草稿，但 native 的前后校验错误要求当前 revision 已落盘。`native-red2.log` 中，尚未保存的当前版本以及实际恢复文件写入失败后的版本均被拒绝为“Save the current project first”。旧 fda 调试程序的真实桌面 RED（`desktop-red.log`）同样保留源项目并显示该错误。

修复只将 Save As 两处校验改为允许捕获的当前未落盘版本；复制前后仍精确校验 runtime nonce、项目 ID、revision，保留取消和只清理自有目标。没有强制先保存源项目。5 项原生聚焦检查验证当前备注/屏蔽/私人设置/隐藏列表、源字节不变、真实源写失败救援、未保存状态取消、初始陈旧参数和复制中 revision/runtime 改变拒绝，并验证回滚不删除其他文件。前端 28 项相关测试包含保存失败后新草稿被提交并以新 revision 另存，未再要求源持久化；它与真实 native/UI 证据共同覆盖跨层合同。

最终本地与实际 SMB 的默认 UI 流程都执行了真实文件系统故障：只把本次 actor 的恢复文件换为空目录，Selenium 编辑并点击保存得到实际拒写，再输入新的未失焦备注并选择另存。独立副本包含新草稿、屏蔽、0.09 音量和隐藏列表；原主文档/清单不变，恢复文件在 finally 精确恢复。用户修改均为 Selenium 控件操作；故障文件操作单独标识，未注入 IPC/store/假返回模拟保存失败。

## 真实 SMB 与故障范围

`N:` 实测为 DriveType4，映射 `\\192.168.2.100\项目文件`；报告 NTFS 不用于推断服务器底层文件系统。仅创建拥有标记的 `N:/AudioAnnotator-verification-408919e9-d667-48c1-a8d6-cd642e27b17d` 及自己的子目录，没有枚举/修改用户项目或 share-root ACL。最终成功项目为 `ui-saveas-rescue-e505069f-f4e9-488c-abc8-faa873a4c858`，报告 `nas-final.log` / `nas-saveas-rescue/two-default-8TrAQJ/report.json`。

全部 11 组 UI 通过：无账号新建、双声道/六声道导入、两独立本机根产生不同作者、相同几何分别保留、只编辑本人、他人新增后显式采用且保留草稿/选区/历史/主面板、私人操作隔离、重启作者稳定、可选账号/退出、同身份第二写者拒绝及明确只读、救援副本、JSON 错源/取消/正确关联及 ZIP。另有 2 组明确标识的恢复文件拒写与 DPAPI 损坏/精确恢复故障检查。同机两进程不等于跨主机或第二真实 Windows 用户。

本轮早先在 SMB 发现复制 writer 的保留句柄延迟 last-write 时间落定：内容 SHA 不变但释放能力后 SourceStamp 失配。Windows ReOpenFile 现在保留原对象只读身份，准备结束前关闭所有 writer；严格指纹/SourceStamp、路径/授权和无覆盖检查不变。本地可写能力 RED/GREEN 与实际 SMB 时间戳 RED/GREEN 保留在父 raw root。显式命令 `cargo test -p annotator-core --test collaboration_catalog real_smb_published_stamp -- --ignored --nocapture` 配合精确拥有的 `ANNOTATOR_NAS_TEST_ROOT` 实际通过；该测试默认忽略，不能把 workspace 的 249 项当作执行了它。后续最终 NAS UI 再次通过。真实本地 DACL 拒写均在 finally 恢复并核对原 SDDL；未声称测试 NAS ACL 管理或网络断电。

## 性能与保持不变的边界

历史优化构建以 257 个 3,884-byte WAV（998,188 bytes）实际 Selenium 导入：296,118 → 116,909 → 89,006 ms，最终测得 3.33 倍/减少 69.9%。第一次 debug 超时与缓存搬移重叠，不作为基准。改动消除重复完整目录读取、返回锁内校验提交快照及精确原记录摘要；正常新 UUID 保留一次完整锁内扫描，之后外部追加仍须后续轮询和显式采用。Windows 属性原语只用于已 verbatim 绝对盘符/UNC，每个祖先仍检查；普通/相对/NUL/UNC根/API失败走原 metadata。真实 junction、父 junction、Unicode/长路径、拒写及 UNC root 均有一致性证据，未加祖先缓存或放松授权。

这些计时早于 SMB 句柄、导入反馈/主面板及本次 Save As 修复，明确不是新计时的最终发布包。临时 PROFILE_IMPORT 探针已移除。0.3.0 的十分钟六通道完整性能记录仅作为历史上下文，未冒充本轮结果。

最终双实例完成 5 次手动同步及轮询，elapsed 3477 ms（含等待），观测 refresh/sync 48.5–56.0 ms；像素写入/分析/播放配置控制均为 0/0/0，文档及播放代次不变。正向真实 UI 操作产生 33/2/3，证明探针有效。这不是跨主机网络延迟指标。

## 正常生产 EXE、交付及来源

正常 NSIS 构建成功后才启动同一正式 EXE，真实 Windows 文件/目录 picker、Win32/UIAutomation 操作全部 5 组通过：默认新建/导入/中文标注发布，重开恢复同一本机作者/备注/0.05 音量，同身份第二写者拒绝后明确只读，独立默认个人副本和 ZIP 分享，帮助 0.4.0。两次启动 SHA 均与下表 EXE 一致；两进程树无调试参数，均正常关闭。精确 PID/EXE/前台/鼠标归属守卫保持启用，只调整自有窗口到可见工作区；中文输入限定唯一拥有的 ValuePattern 控件并读回，不改全局 IME、系统 DPI 或音量。

| 产物 | bytes | SHA256 |
|---|---:|---|
| `annotator-desktop.exe` | 16,595,456 | `9f13130d9cc525244fc0c41530d1ac861c6eb688fccaa59e46c7a718d0be0695` |
| `Audio Annotator_0.4.0_x64-setup.exe` | 221,903,372 | `56dac820f3167d5e417825082183bd136cdaa4e7f53816bdd95667afb34e0606` |

两者文件/产品版本均 0.4.0，Authenticode 均 NotSigned。预冻结核验确认 31 个许可证资源（含 13 个精确 MPL 源码归档）与 source/staging 和 NSIS oname 清单相符，ASCII/UTF16 扫描无测试环境/picker/调试/临时计时标记及测试凭据。交付包含资源、指南、正式报告、BUILD-PROVENANCE、FILE-INVENTORY/SHA256SUMS。安装包包含 WebView2 offlineInstaller，但没有执行新机器安装/卸载。

最终完整桌面通过后、正常构建前捕获 307 个生产输入的精确字节，清单 SHA256 `de0f1d7d55a4e0bee75e84d883818a7900efa92f8f489cf1865be039217d5d36`；构建使用未提交修复后的字节，不把后续 checkpoint/main commit 冒充输入。旧 fda 候选连同原包/证据/输入完整保存在 `D:\Work\annotator\.worktrees\default-collaboration-v040\.test-output\default-collaboration-v040\task5\pre-fix-fda51b6-741689b6-30e3-4dc2-bb43-870bc81899ed`，逐文件 SHA 验证；旧版本 0.1–0.3 未覆盖。当前最终冻结目标仍为 `releases/0.4.0`，原始输入和旧日志保留以供根代理整合审计。

未验证范围：第二真实 Windows 用户的 DPAPI 隔离、跨主机网络故障、NAS root ACL、新机离线安装/卸载、人工听感、物理 DPI 变更及物理 exFAT。未创建 OS 账号、未操作未知进程、未推送或合并 main。
