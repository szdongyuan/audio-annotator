# Spectral Fidelity and Audition Workflow 0.2.1 Implementation Plan

> **For agentic workers:** REQUIRED: Use the `subagent-driven-development` skill to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付清晰且能显示暂存编辑结果的Windows频谱工作区，修正独立对比、浮窗、激活选区、定位试听和完整分享。

**Architecture:** 保留权威v2文档与Rust DSP，显示层按实际像素预算绘制并使用物理坐标插值。处理后分析复用随机访问DSP并使用独立缓存签名；选区、面板、播放意图和声音版本各自管理，共用生命周期与操作入口。

**Tech Stack:** 现有React/TypeScript/Canvas、Tauri/Rust、Vitest、Selenium/tauri-driver/EdgeDriver、NSIS；不升级依赖，不迁移数据。

**Spec:** `docs/double-sdd/specs/2026-10-23-spectral-fidelity-and-selection-workflow-design.md`。用户已明确批准实施整个累计范围；规格合并复审PASS。不再重复请求已批准范围的权限。

---

## 0. 执行约束与文件职责

执行顺序Task1→8，每任务新implementer、同TaskBase..Head的独立spec/quality双审查（spec gate），最后全范围quality。根代理只协调、写文档和操作Git；代码与测试交由implementer。遇实际失败使用systematic-debugging，声称成功前使用verification-before-completion。

| 单元 | 主要文件与职责 |
|---|---|
| 像素/数值绘制 | `src/features/spectrogram/{renderer.ts,rasterBudget.ts,sampling.ts,SpectrogramCanvas.tsx,workspace.ts,useTiles.ts,tileCoverage.ts}`：真实DPR、共享缓冲预算、物理取样、插值邻居与LOD |
| 暂存编辑分析 | `crates/annotator-core/src/analysis/{tiles.rs,source.rs}`、`src-tauri/src/commands/analysis.rs`、`src/features/spectrogram/{tileClient.ts,useTiles.ts}`：原始/处理签名、4096有界DSP读取、权威有效性 |
| 面板与浮窗 | `src/features/spectrogram/{useWorkspace,CompareWorkspace,FilePane,AnalysisSettings}.tsx/ts`、`src/components/popover/DismissibleLayer.tsx`、`src/app/{AppShell,WorkspaceActions,HelpDialog}`：稳定位置、重复解释、外部关闭 |
| 选区生命周期 | `src/features/selection/{state.ts,gestures.ts,useSelection.ts}`、`src/features/annotations/AnnotationOverlay.tsx`：激活/非激活、内部移动、取消和过期几何 |
| 声音与播放意图 | `src/features/playback/{usePlayback.ts,playbackIntent.ts,AuditionSource.tsx,PlaybackMode.tsx,TransportBar.tsx,CueLine.tsx}`：声音版本、自动范围、显式覆盖、定位线 |
| 就地操作 | `src/features/selection/{SelectionToolbar.tsx,RegionMenu.tsx,actions.ts}`：共享播放/分类动作、定位与事件隔离 |
| 分享与副本 | `src/features/exchange/{ExportDialog,ImportDialog}.tsx`、`src/features/project/ProjectActions.tsx`、用户说明：默认完整包、准确命名 |
| 验收 | `tests/desktop/{fidelity-flow,processed-flow,interaction-flow}.test.mjs`、既有suite、`scripts/measure-performance.mjs`、`docs/verification-0.2.1.md` |

表中新增文件可按实际职责合并到同目录已有小文件，不能凭借文件名制造框架；若新模块避免明显耦合则按上述分开。不得顺带重构DSP公式、存储、导入恢复队列或升级包。

- [x] 根代理记录main当前HEAD为MAIN_BASE，创建`.worktrees/spectral-fidelity-v021`和`feature/spectral-fidelity-v021`；main用户未跟踪`.agents/.codex/.double-sdd`保留不入提交。
- [x] 复用并移交已归属本任务的`target/`缓存，避免复制20+GB；验证绝对路径及没有使用其可执行文件的进程。保留旧`releases/0.1.0`、`0.2.0`和历史证据。
- [x] 隔离工作树运行`npm.cmd ci`、`npm.cmd test`、`cargo test --workspace`并保存基线日志；通过后再实现。复制已有官方`.tools`驱动，在新工作树运行`pwsh -NoProfile -File scripts/setup-webdriver.ps1`修正路径，不用旧配置绝对路径。
- [x] 每任务开始记录TaskBase，授权的临时提交用`tmp/sdd:`；GUI仅一个suite占用4445/4446/9235，遇未知占用不得杀进程或接入用户会话。

每次涉及产品代码的原生验证，先完整执行`npm.cmd run tauri -- build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json`并等待exit 0，再运行本任务列出的`node tests/desktop/…test.mjs`。单独`npm.cmd run build`不会更新native EXE；不能用旧二进制作为本任务证据。setup-webdriver在准备阶段执行，harness只启动/关闭自有进程。

## Task 1: 真实像素分辨率、功率域插值和有界绘制

**Modify:** `src/features/spectrogram/{SpectrogramCanvas.tsx,renderer.ts,workspace.ts,useTiles.ts,tileCoverage.ts,tileScheduler.ts}`。**Create:** `sampling.ts`, `rasterBudget.ts`及对应`.test.ts`，`tests/desktop/fidelity-flow.test.mjs`。**Affected tests:** `renderer.test.ts`, `workspace.test.tsx`, `useTiles.test.tsx`, `cachePressure.test.tsx`。

- [x] 写红灯证明800×600/DPR1不应只有341×256；DPR2应1600×1200。覆盖resize/DPR变化、RGBA预算计入已挂载backing和scratch、释放重入、12通道滚动不黑图。运行`npm.cmd test -- src/features/spectrogram/renderer.test.ts src/features/spectrogram/cachePressure.test.tsx`观察旧限制导致失败。
- [x] 写数值红灯：时间锚点为window-start，LOD部分尾组用实际个数；STFT/Mel中心按spec§4.2；功率插值例如-20dB与-40dB中点应为`10*log10((10**(-2)+10**(-4))/2)`而非-30dB。覆盖tile接缝、非线性轴、frequency partition邻居、短文件尾部、真实端点与未就绪邻居区别。
- [x] 实现物理取样索引与插值，频率坐标每行预计算、时间索引每列预计算；把频点dB→功率转换限制在所需数据中，避免像素内重复昂贵查找。保持原始FFT数值与dB参考，不用CSS模糊/锐化补偿。
- [x] 去除256高/1024宽固定缩小，按CSS×DPR分配；全局32MiB raster预算包含自有保留RGBA/backing与scratch，复用scratch、优先可见通道，释放视口外高分辨率表面。数值LRU仍64MiB，极端超限明确失败，普通验收尺寸不得低清降级。
- [x] tilePlan按实际绘制宽度和预算计算时间LOD，加入必要相邻真实样本，不能将缺失缓存邻居当作数据端点；已有细数据复用、取消/lease/owner及原有cache-pressure保证保留。大FFT/12通道资源测试覆盖上限，不通过放大缓存掩盖问题。
- [x] 运行`npm.cmd test -- src/features/spectrogram`、`npm.cmd run build`、上文完整native debug/e2e构建命令后执行`node tests/desktop/fidelity-flow.test.mjs`，记录1280/1920真实外窗、DPR1/1.25/2模拟、CSS/backing比、6+6滚动、合成多音/脉冲旧新图和≤0.5px对齐；不冒充真实系统DPI。
- [x] 提交`tmp/sdd: pixel-accurate bounded spectrum rendering`，报告红绿、原生截图与预算证据。此任务不做处理后分析、面板行为或新播放功能。

## Task 2: 处理后频谱数据源与严格缓存身份

**Modify:** `crates/annotator-core/src/analysis/{mod.rs,tiles.rs}`，`src-tauri/src/commands/analysis.rs`及必要`state.rs`，`src/features/spectrogram/{tileClient.ts,useTiles.ts,SpectrogramCanvas.tsx}`。**Create:** `crates/annotator-core/src/analysis/source.rs`, `crates/annotator-core/tests/processed_analysis.rs`, `tests/desktop/processed-flow.test.mjs`（数据源阶段）。

- [x] 写Rust红灯：双音信号中屏蔽一个频带后的tile与`DspProcessor::Processed`→同一STFT参考一致；未处理、禁用、重叠mask、不同channel、移动/undo输入快照、窗口32768但每次DSP读取≤4096、头尾/跨块随机访问、取消均覆盖。先运行`cargo test -p annotator-core --test processed_analysis`确认缺失路径失败。
- [x] 定义显式分析源合同（原始或带权威屏蔽签名的暂存编辑），稳定签名只含该文件有效音频处理输入；cache key和桥校验都带源版本/签名，不能只加前端key。原始和处理后不能互相命中，其他文件/备注更改不失效当前源。
- [x] 新增有界source reader复用既有DspProcessor，分析窗分块读取再取目标channel；不混音、不乘播放音量、不重采样、不按试听选区裁切。每个后台job有界缓存相邻处理块以免重复处理每个重叠窗，合计不突破现有PCM预算/并发上限；不加载完整长文件。
- [x] Native提交前、读缓存后、发布前复核runtime/source/signature；编辑或切换后迟到结果拒绝，不删除已保存编辑。原始tile可按新key自然复用/失效，缓存不迁移。
- [x] 前端tile协议严格解析并绑定source，useTiles支持明确数据源输入（此任务默认原始，Task5接通用户全局声音版本）。source变化取消旧generation并保留“更新中”语义，失败可重试，不伪装为最新完成。
- [x] `cargo test --workspace`、`cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`npm.cmd test -- src/features/spectrogram src/bridge`、`npm.cmd run build`通过；执行完整native debug/e2e构建后运行`node tests/desktop/processed-flow.test.mjs`验证处理幅度、签名/过期拒绝/原音不变。提交`tmp/sdd: processed audio analysis source and cache identity`。

## Task 3: 稳定比较面板和可关闭浮窗

**Modify:** `src/features/spectrogram/{useWorkspace.ts,CompareWorkspace.tsx,FilePane.tsx,AnalysisSettings.tsx}`, `src/app/{AppShell.tsx,WorkspaceActions.ts,HelpDialog.tsx}`, `src/features/media/MediaList.tsx`（必要接口），相关CSS。**Create:** `src/components/popover/DismissibleLayer.tsx`及测试，`src/features/spectrogram/paneSelection.test.tsx`，`tests/desktop/interaction-flow.test.mjs`（面板/浮窗阶段）。

- [x] 写组件红灯：A/B→C/B、A/C；左选B/右选A被拒绝且另一侧高亮；通过侧栏、每侧标题、顶部菜单都不交换。重复选择不改draft、播放源或选区；过期事件执行时重查。运行`npm.cmd test -- src/features/spectrogram/paneSelection.test.tsx`先RED。
- [x] 将面板位置与selected media来源明确化，增加共享`selectPane(primary|compare,id)`入口，主侧栏仍选择primary；各标题紧凑selector禁止占新行。重复时短提示+1.2s边框，不改频谱颜色；语义符合spec§6。
- [x] 更新selection可见pane reconciliation，仅替换对应pane时清理其目标；切换primary不得无条件丢掉仍在compare的有效选区。保留linkedTime实际秒数与文件身份独立、各文件视图、保存恢复、媒体移除与fallback。
- [x] 写实际事件红灯：外部pointer关闭AnalysisSettings，内部滑块拖出释放、原生select不误关，Escape关闭并恢复focus，同一trigger开关/另一trigger切换且不穿透创建选区。实现小型dismissible layer，阻断下层音频操作；确认/恢复/错误对话框不隐式放弃。
- [x] 纯查看HelpDialog也可外部关闭；保持分析未应用计算草稿关闭丢弃、已应用显示值保留。运行`npm.cmd test -- src/features/spectrogram src/components src/app`、`npm.cmd run build`；执行完整native debug/e2e构建和`node tests/desktop/interaction-flow.test.mjs`，验证真实点击、重复高亮截图、1280四图≥180/标题≤56保留。
- [x] 提交`tmp/sdd: independent comparison panes and dismissible settings`。

## Task 4: 激活选区状态与内部抓取

**Modify:** `src/features/selection/{state.ts,useSelection.ts,gestures.ts,actions.ts}`, `src/features/annotations/{AnnotationOverlay.tsx,useAnnotations.ts}`, `src/features/playback/useMasks.ts`及相关测试/CSS。

- [x] 红灯覆盖：新框自动激活；激活框内部拖动移动而非新建；外空白首次手势只取消激活，下一次拖动新建；inactive temporary保留轮廓但Delete不屏蔽，单击再激活；另一已保存框可直接激活。运行`npm.cmd test -- src/features/selection`确认旧规则失败。
- [x] SelectionState显式区分candidate与active，保留一个临时非激活框；getActiveSelection只向播放/快捷键/悬浮操作提供active有效目标。持久标注/屏蔽总从权威文档重读，inactive不是删除或禁用mask。
- [x] 手势优先级：Alt/middle pan > handle resize > active内/边move > active外blank deactivate-only > noactive draw；单击已有目标激活，4px阈值和零范围过滤保留。Esc菜单/手势/取消激活层次明确；非绘图区点击不隐式去激活。
- [x] 移动保存对象仍走lifecycle/queue，一次pointerup提交；过期geometry、对象删除、runtime切换、取消恢复等既有回归不得退化。Task3中另一面板选区保留规则继续成立。
- [x] 更新受影响old tests为新用户语义，不能删除stale-owner/undo故障覆盖。完整`npm.cmd test`和`npm.cmd run build`；完整native debug/e2e构建后运行`node tests/desktop/interaction-flow.test.mjs`及`node tests/desktop/selection-flow.test.mjs`，覆盖active/inactive/interiordrag/blankclick/handle/Altpan，已有selection suite同步不报假阳性。
- [x] 提交`tmp/sdd: explicit active selection and interior dragging`。

## Task 5: 统一声音版本、自动播放范围与右键定位

**Modify:** `src/features/playback/{usePlayback.ts,PlaybackMode.tsx,TransportBar.tsx,Playhead.tsx}`, `src/features/selection/{RegionMenu.tsx,useSelection.ts}`, `src/app/{AppShell.tsx,WorkspaceActions.ts}`, `src/features/spectrogram/{CompareWorkspace.tsx,FilePane.tsx,ChannelPane.tsx}`。**Create:** `src/features/playback/{playbackIntent.ts,AuditionSource.tsx,CueLine.tsx}`及测试。

- [x] 用真实请求边界fake native写RED：active selection默认空格/播放发selection+region对应media；inactive按file/cue；显式fromPoint/full覆盖active，pause/resume保持覆盖，stop/ended清覆盖；选区变更停止旧音而不自动开播，快速切换owner/source不能复活旧意图。运行`npm.cmd test -- src/features/playback`先RED。
- [x] 建立小型播放意图解析：`automatic | explicit-file | explicit-cue | explicit-selection`；工作区声音版本`workspaceSource: original | processed`独立且默认processed。每次显式试听意图可以携带`sourceOverride?: original | processed`，有效播放版本为`intent.sourceOverride ?? workspaceSource`；override随本次暂停/继续保留，在停止/自然结束/选区变化/owner变化清除。工作区版本与两侧图像不因试听override改变。选择/工作区版本变化先处理旧输出，新配置按sequence/generation接受；不要用effect立刻覆盖显式意图。
- [x] AppShell创建当前runtime声音版本context/状态，声音版本控制统一影响两侧频谱Task2source和普通播放；UI去掉互斥“原音/处理后/选区”混合概念，旁路并入original，保留音量设备循环。原音/暂存图切换、mask变化、undo/redo实际刷新，进度错误诚实可达。
- [x] 右键记录稳定media/time定位，不自动调用播放/停止；白色1px虚线在同文件可见通道，独立于进度线，跟随坐标但pointer-events none。RegionMenu提供“从此处播放”，有效位置调用明确playFrom；空白短尾无样本禁用，不夹回假位置，目标失效拒绝。
- [x] 顶部“播放整段”和明确“试听选区原音/试听选区（应用屏蔽）”命令复用意图解析。只在实际发起覆盖播放时改变播放文件`sourceId`，不修改`workspaceSource`；右键打开普通菜单不中断声音。无active时停止状态普通play可从cue开始，pause继续从当前进度；文件循环沿用原行为。测试两个相反试听override之后workspaceSource、两侧谱图请求版本均不变，pause/resume保留override，stop/ended恢复自动版本。
- [x] 前端完整tests/build；完整native debug/e2e构建后运行`node tests/desktop/processed-flow.test.mjs`及`node tests/desktop/interaction-flow.test.mjs`，接通真实UI验证mask谱能量变化/撤销/原始切换、默认选区/显式定位/白线、两种试听override不改图、实际输出计数和原件hash。共享source与未相关文件cache不失效测试。提交`tmp/sdd: coherent audition source and playback intents`。

## Task 6: 当前选区悬浮播放与分类

**Create:** `src/features/selection/SelectionToolbar.tsx`及`selectionToolbar.test.tsx`；**Modify:** `ChannelPane.tsx`、`AnnotationOverlay.tsx`、`RegionMenu.tsx`、必要selection/actions共享菜单helper和CSS。

- [x] RED：active可见框旁显示播放/标注，inactive无工具条；small/边缘/滚动不越所属plot，拖动期间隐藏，按钮不会创建框；类别创建一次后更新同ID，menu打开后staleowner/geometry禁用或重读，音频缺失仅禁用play。
- [x] 基于可见矩形与plot尺寸钳制位置，reuse坐标合同，ResizeObserver/scroll/viewport变化更新；候选完全离屏隐藏，不为每个annotation建立toolbar。动作指针事件不进入overlay，Tab/Enter/Escape正常，modal/menu不抢焦点。
- [x] 一键play通过Task5intent，分类与右键共用已捕获目标及lifecycle动作；原音/应用屏蔽显式子菜单仅设置本次intent.sourceOverride，命名清楚，不能改变workspaceSource或两侧图；不新增常驻模式/说明条。
- [x] 运行`npm.cmd test -- src/features/selection src/features/playback`、`npm.cmd run build`，完整native debug/e2e构建后运行`node tests/desktop/interaction-flow.test.mjs`，验证临时/保存/mask选区、边缘/滚动、右侧上下文、选择分类后可继续拖动与试听。
- [x] 提交`tmp/sdd: selection-local playback and annotation toolbar`。

## Task 7: 完整分享默认与另存副本文案

**Modify:** `src/features/exchange/{ExportDialog,ImportDialog,exchange.test}.tsx`, `src/features/project/ProjectActions.tsx`, `src/app/WorkspaceActions.ts`（有引用时）、既有desktop分享流程、`docs/user-guide.md`。

- [x] RED：首次打开分享默认bundle，直接保存发送bundle；仅标注需要主动选择，标签明确是否包含音频。另存菜单准确命名且调用原saveAs，无源文件复制承诺。
- [x] 默认及排列改为“完整项目包（含音频）”，次要“仅标注（不含音频）”；“另存项目副本…”保持原保存屏障、独立目录及切换行为；只调整必要文案和测试selector。
- [x] `npm.cmd test -- src/features/exchange src/features/project src/app`和build通过；完整native debug/e2e构建后运行`node tests/desktop/sharing-flow.test.mjs`（若现有仅export函数，补独立main runner入口），验证完整包导入到新目录后，在自有测试fixture原路径被临时移走的条件下仍能播放及恢复处理后频谱/三层语义。仅标注导入则明确需要关联。仅操作并恢复本次自有fixture，不动用户音频。
- [x] 提交`tmp/sdd: self-contained sharing default and project-copy wording`。

## Task 8: 完整回归、高清性能与0.2.1正式交付

**Modify:** `scripts/{run-desktop-tests,measure-performance}.mjs`, `tests/desktop/*.mjs`受影响流程, `README.md`, `docs/{user-guide,development}.md`, version manifests/locks及HelpDialog版本。**Create:** `docs/verification-0.2.1.md`, `docs/evidence/<actual-date>-v0.2.1/`。

- [x] 将新fidelity/processed/interaction suites纳入顺序desktop runner，保留旧300次view churn、重启、share/recovery、folder失败ledger与native output等有效回归；按新激活规则改动作，不简单删除旧断言。
- [x] 在真实尺寸/DPR backing确认通过后运行性能：600秒48k6ch+独立600秒2ch，40zoom/20pan/20mix，真实Canvas绘制→paint机会，逐项P95和合并P95，cancel可见、原始与暂存首次就绪、native/WebView采样峰值，各30秒真实device零可重复欠载。不能用预览帧或旧256px画布计为最终响应；如预算/性能失败先定位，保留证据再修复。
- [x] 顺序执行并记录退出码：`npm.cmd ci`、`npm.cmd run fixtures`、`npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run build`、`cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace`、`npm.cmd run test:desktop`、`npm.cmd run perf`、`npm.cmd run tauri -- build --bundles nsis`。
- [x] 版本统一0.2.1；最后正式构建不带e2e/config调试端口，bundler退出后才启动同一EXE。真实系统folder/open/save picker及pointer完成设置关闭、两侧切换/重复高亮、活动框内移动/外部取消、悬浮分类、默认选区/右键cue播放、屏蔽实际图像变化、保存重开、默认完整包分享。核对原音hash不变、接收方独立路径可用。
- [x] 保留完整许可与MPL源码资源，无新增依赖不重新抓取；将EXE/NSIS/说明/许可/验证记录/hash放工作树`releases/0.2.1/`，不要覆盖0.1.0/0.2.0。raw日志`.test-output/fidelity-release/`、稳定证据入docs；旧新图及真实尺寸都记录。无证书则NotSigned；人工听感/新机offline安装卸载/exFAT/实际系统125%未做时明确未验证。
- [x] 提交`tmp/sdd: verify and package spectral workflow 0.2.1`；Task8双审查及MAIN_BASE..最终Head全范围quality通过后交给根代理整合。


## 9. 根代理整合与完成

- [x] 应用finishing-a-development-branch，按已批准本地squash，无需再问用户合并选项；确认main仍为记录MAIN_BASE，用户文件原样保留。
- [x] 保存0.2.1正式交付、全部原始证据与必要fixture到main独立目录，逐文件校验发布hash；恢复owned target缓存，记录历史证据路径映射。
- [x] `git merge --squash feature/spectral-fidelity-v021`后与reviewed tree比对，main完整前端test/build与Rustworkspace测试通过，再保留一个正式实现提交；最终仅补文档状态。
- [x] 绝对路径/归属/无进程检查后清理临时工作树和分支，保留历史release，不推送远端。给出可点击程序/安装包/说明/验证记录及准确未验证项。

Task1最终交接：`d4d68408fc2b31a0d32ac713d45b9f3b368a6cf2`规格/质量双审查PASS。62项频谱、248项完整前端、生产/typecheck构建及23组原生清晰度检查通过；root复验23项采样/分块/预算/cachepressure。CSS×DPR backing、64列共享scratch、可见性释放、功率插值、真实halo和一致时间网格复用已完成。保留`sampling.ts`的window-start/partial-LOD/native-Mel中心合同，Task2只扩展数据源与缓存身份，不能回退到256px或改变这些坐标。原生最大保留画布+scratch23,177,792 bytes；20点RGBA参考误差0、框与刻度误差0.000485 CSS px。后续性能与正式交付仍由Task8完成。Task2开始前以本交接提交为新TaskBase；MAIN_BASE仍为be1edfee3023416d1d0521f4186de1493bff5395。

Task2最终交接：24570666979d1d2236976e2cf0692a74ae61e301 规格/质量双审查PASS。121 Rust、73前端/桥、fmt/clippy/build、原生处理数据源与23组高清回归通过；root独立18前端与3处理核心复验通过。原始/处理合同和IEEE754几何签名为必需字段，每job九个4096帧单通道块，已从分析PCM预算扣除。界面默认仍原音，Task5再接全局声音版本；Task3不要改此合同。Task3以本交接提交为TaskBase。

Task3最终交接：588f4f4d609ab0a368c0ad89580e7458cd74ef48 第二轮规格/质量双审查PASS。265前端、18原生交互及fresh native build通过；root独立19项原检查和6项草稿修复回归通过。先前质量审查发现计算草稿被等值原生快照重置，现按五个分析值同步，777步长在显示保存后保留，关闭重开回到已应用512；组件/原生RED及旧证据保留。1280四图各236.5px、标题54px；双向重复高亮、另一侧选区保留、上下布局设置切换/遮挡/焦点均验证。Task4保留selectPane权威校验和visible-pane reconciliation、浮窗事件屏障。Task4从本交接提交开始。

Task4最终交接：fb5f8b71f5e0cbf931f4d26bf3087b13db9b7923 规格/质量双审查PASS。55选区、277完整前端、fresh native build后interaction18与selection全流程通过；root独立55项复验通过。SelectionState.getActiveSelection/getSnapshot与SelectionUI.selection仅返回激活目标，getCandidate/SelectionUI.candidate用于轻量未激活轮廓和失效清理；Task5播放应只消费selection。异步bind不能重新激活，取消和权威更新恢复正确context，旧框删除不可复活。Task5仍需全局声音版本、播放意图与右键cue，Task6才做悬浮条。Task5从本交接提交开始。

Task5最终交接：1a6bf9ca289a131c3ac1c58c00ffb85a078fb4d7 质量审查PASS，澄清审查描述后新规格审查PASS（代码未变）。首次规格意见要求启用/禁用也激活目标，root核对规格后拒绝此额外要求：备注/分类/创建屏蔽需要执行时绑定与焦点，已有稳定ID的删除/启禁无需改变当前播放范围。290前端、fresh native build后处理7组与交互19组通过；root47项关联复验与原生图像/JSON核对通过。workspaceSource默认processed并统一两侧图与普通播放，intent的sourceOverride仅单次试听；选择改变停止、明确cue/file覆盖保留到停止或结束。右键只定位/菜单，执行编辑时才按需激活；无效短尾不能成为普通seek。Task6复用这些动作和白线坐标，不重建播放逻辑。Task8须更新selection-flow.test.mjs与playback-smoke.mjs旧模式/子菜单selector，原覆盖保留。Task6以本交接提交为TaskBase。

Task6最终交接：d45723433d1ff13113aa874185a41aa4cb5f9f85 规格/质量双审查PASS。16工具条、99关联、306完整前端及fresh native build后扩展interaction通过；root28项独立复验和靠边截图核对通过。shared targetCommands复用权威对象/试听/编辑屏障；gesture通知覆盖框选与平移；音源不可用但有效激活框仍在时保留分类和坐标、清零画布并显示关联入口。原生一次连续pointer序列验证隐藏/恢复，11×7小框与第六通道滚动均通过。旧测试Tab/hover/分段WebDriver拖动假设失败已保留并解释。Task7只处理默认完整分享与另存文案/独立导入验收，不改变已完成播放与工具条合同。Task7以本交接提交为TaskBase。

Task7最终交接：b679aa8ae9ea4db0db9067f95adf910121456d91 规格/质量双审查PASS。54前端、生产构建、fresh native build后完整独立分享流程通过；root54项复验与源/报告核对通过。两个不同8秒WAV原目录不可用时，接收包内源路径/哈希、三层类别备注、区域屏蔽与处理后图一致，原生播放2496帧检查点/停止5856帧；JSON明确缺失需关联。副本保持既有projectId但新目录会话与独立保存；菜单、picker、错误对话框、帮助说明统一文案。全部7个功能任务完成，Task8负责最终全量回归/真实像素性能/0.2.1交付，root随后整合，不得在Task8前声称正式交付完成。Task8从本交接提交开始。

Task8及整合最终交接：2e7d7e1277368bf0faa0f5a7778e4abe57780a0e 最终双审查及 MAIN_BASE..Head 整轮质量审查 PASS。首次质量审查的输出父目录缺失已修复，4项生命周期/初始化回归通过；正式冻结程序未变。root 本地 squash 后重新通过309前端、121 Rust、生产构建及4项脚本检查。交付/全部raw证据/257份as-built输入已保留，target恢复；临时工作树与分支已清理，用户配置和旧版交付哈希不变，无推送。完整路径映射与复验证据见 docs/integration-0.2.1.md。全部计划完成。
