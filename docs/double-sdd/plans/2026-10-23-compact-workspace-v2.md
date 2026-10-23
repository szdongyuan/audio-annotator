# Compact Selection Workspace 0.2.0 Implementation Plan

**最终状态（2026-10-23）：全部8项任务及规格/质量审查完成；整轮质量审查PASS。本地squash已整合，主目录232项前端、117项Rust及生产构建复验通过。0.2.0交付和全部原始证据已保存，临时工作树/分支已清理；无远端推送。下方追加交接段为执行历史，以本段和已勾选清单为最终状态。**

> **For agentic workers:** REQUIRED: Use the `subagent-driven-development` skill to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付紧凑菜单式 Windows 频谱工作区，统一随时框选与右键操作，补齐局部刻度缩放、整段/通道分类和可靠的文件夹导入。

**Architecture:** 保留 Rust 权威文档、DSP、播放与分析缓存；先建立严格 v2 格式和分类数据合同，再以项目运行态拥有的 SelectionState 和共享动作层连接右键、主菜单及快捷键。菜单、布局、类别编辑和文件夹任务分模块实现，继续经过现有命令队列、保存屏障与原生任务所有权。

**Tech Stack:** 现有 React 19 / TypeScript / Canvas、Tauri 2、Rust、Vitest、Selenium + tauri-driver + Microsoft EdgeDriver、NSIS；默认不增加 UI/状态/音频依赖。

---

## 0. 输入、工作树和执行约定

规格：`docs/double-sdd/specs/2026-10-23-compact-selection-workspace-design.md`，用户已确认。当前代码基准为 `57ae424`，规格提交为 `c6630e2`；实际 MAIN_BASE 在本计划审查并提交后重新记录，不用上述短 SHA 猜测。

所有下面的相对路径均指实施工作树根目录。顺序执行 Task 1–8，每任务使用新 implementer、同一 TaskBase..Head 的并行规格/质量双审查；规格通过后才采纳质量结果。根代理不写实现代码。必要修复回原 implementer；按 `code-review` 核实反馈，不因偏好增加范围。出现问题先用 `systematic-debugging`；完成前按 `verification-before-completion` 读取新鲜日志。

- [x] 只提交已审查计划文档；保留用户未跟踪的 `.agents/`、`.codex/`、`.double-sdd/`。
- [x] 记录当前主分支和完整 MAIN_BASE；检查 `.worktrees/` 已忽略，建立 `feature/compact-workspace-v2` 和 `.worktrees/compact-workspace-v2`，将元数据写入 `.worktrees/compact-workspace-v2.meta`。保留 `releases/0.1.0`。
- [x] 工作树运行 `npm.cmd ci`、`npm.cmd test`、`cargo test --workspace`，记录基线与磁盘余量；当前预期前端128、Rust102，但以实际结果为准。官方工具可由 `scripts/setup-webdriver.ps1` 在工作树 `.tools/` 重建，不改全局 PATH。
- [x] 每任务开始记录完整 TaskBase；临时提交均为 `tmp/sdd: ...`。GUI测试仅一组运行；遇端口占用不终止未知进程、不接入用户现有应用。等待 native bundler 完全退出后再启动同一 release exe。
- [x] 最终按已确认规格本地 squash 到记录的 MAIN_BASE，保留一个正式实现提交；不普通 merge 临时历史、不推送远端。先保存新交付包与证据再清理工作树。

## 1. 文件责任与贯穿接口

| 单元 | 新建/主要修改路径 | 责任 |
|---|---|---|
| 严格版本读取 | `crates/annotator-core/src/model/project.rs`, `model/validation.rs`, `exchange/manifest.rs` | 仅v2合同，旧/未来版本拒绝；本地/portable分离 |
| 模型/事务/桥 | `model/media.rs`, `project/session.rs`, `src/bridge/types.ts`, `src/bridge/validation.ts` | 分类、比较布局字段及原子变更 |
| 统一选区 | `src/features/selection/state.ts`, `gestures.ts`, `useSelection.ts`, `actions.ts` | 临时状态、手势判定、稳定目标动作 |
| 菜单组件 | `src/components/menu/Menu.tsx`, `menuModel.ts`, `menu.css` | 主/右键共用的键盘、焦点、子菜单定位 |
| 区域菜单与覆盖层 | `src/features/selection/RegionMenu.tsx`, `src/features/annotations/AnnotationOverlay.tsx` | 区域命中和选区呈现，透明框 |
| 轴交互 | `src/features/spectrogram/ticks.ts`, `wheel.ts`, `AxisRulers.tsx`, `SpectrogramCanvas.tsx` | 主次刻度、轴拖选、Ctrl滚轮 |
| 工作区菜单/布局 | `src/app/AppMenu.tsx`, `WorkspaceActions.ts`, `HelpDialog.tsx`, `src/features/spectrogram/CompareSplitter.tsx` | 真实菜单绑定、可恢复焦点、紧凑布局 |
| 分类入口 | `src/features/annotations/ClassificationControl.tsx`, `classification.ts` | 文件/通道分类目标与筛选结果 |
| 文件夹扫描 | `crates/annotator-core/src/media/folder_scan.rs`, `src-tauri/src/commands/folders.rs`, `src/bridge/folders.ts` | 有界扫描、规范路径与任务取消 |
| 文件夹控制器 | `src/features/media/folderImport.ts`, `FolderImportDialog.tsx`, `FolderImportProgress.tsx` | 扫描→串行批次、结果分页、项目生命周期 |

沿用 `Region` 秒/Hz、`ActiveProject` 对象身份、`lifecycle.enqueueEdit`、`AnnotationDrafts`、`CommandQueue` 和 native revision。禁止把新增草稿/异步UI操作放在不可见 Promise tail 中绕过保存屏障。菜单动作必须捕获目标、执行前重读当前文档；不能只依赖当前选中变量。临时选区不创建文档变更或保存草稿。

新状态/字段合同（实现可合理调整内部文件拆分，不能改变行为）：

```ts
type CompareLayout = 'horizontal' | 'vertical'; // horizontal = 左右
type Selection = { region: Region; object: { kind: 'annotation' | 'mask'; id: string } | null } | null;
type ClassificationTarget = { mediaId: Id; channelIndex: number | null };
// MediaDescriptor / PortableMedia: categoryId: Id | null; channelCategoryIds: (Id | null)[]
// ViewState: compareLayout: CompareLayout; compareSplit: number (0.25..0.75)
// Change: { type:'setMediaCategory'; mediaId:Id; categoryId:Id|null }
//       | { type:'setChannelCategory'; mediaId:Id; channelIndex:number; categoryId:Id|null }
```

所有读回 native 的文档均为 v2；frontend parser 严格拒绝缺失/未知字段。按用户最新指示不实现旧数据迁移或兼容层，旧格式只做拒绝与不修改源文件的回归。

## Task 1: v2 模型、分类事务和新格式持久化

**规格范围：** §5数据合同、§7（用户明确不需要迁移）、§8。当前任务按用户追加要求重新收缩，不实现旧格式兼容或迁移。

**Create/retain:** `tests/fixtures/document-v2.json` 及新格式的有意义回归。

**Modify:** `crates/annotator-core/src/model/{mod,project,media,edit,validation}.rs`, `project/session.rs`, `exchange/manifest.rs`, `media/decode.rs`；`src/bridge/{types,validation}.ts`, `src/features/spectrogram/useWorkspace.ts`；对应 document/persistence/exchange、桥与当前模型测试构造。

- [x] 先新增/调整旧formatVersion1与未来版本明确UnsupportedVersion的回归，验证拒绝不修改目标文件；交换导入失败继续保留其当前项目会话。普通“打开项目”沿用既有保存并关闭当前项目、再打开目标的流程，本轮不新增事务式替换/打开失败回滚会话。v2缺字段、未知类别、通道类别数组错长、比较比例非法仍拒绝。运行 `cargo test -p annotator-core --test document --test exchange`、`npm.cmd test -- src/bridge/contracts.test.ts` 确认收缩范围对应红灯。
- [x] 保留文件/通道分类命令与严格nullable字段、v2创建/读取、compareLayout左右/compareSplit0.5默认、decode默认未分类、relink保留备注/类别、原子removeCategory清三层并一次undo恢复。更新当前测试fixture为v2；旧golden若保留只能用于拒绝旧格式，不再用于兼容测试。
- [x] 删除本任务此前新增的 model/legacy_v1.rs、exchange/legacy_v1.rs、project/migration.rs 及其模块声明/调用、迁移专用FaultPoint、pre-v2备份流程、迁移专用fixtures/测试和RecoveryDialog另存迁移救援状态。仅删除仓库中本次添加且已核验的代码/测试文件，不清理用户项目文件。
- [x] 保留普通v2自动保存、recovery envelope校验、project.json.bak、恢复选择、锁、保存/另存屏障及原有故障保护。评估并保留已经验证的通用“卸载后不触发延迟关闭”修复及对应回归，不为去迁移而盲目整文件回退。v2数据往返/普通保存测试从迁移测试文件迁入对应测试模块。
- [x] Portable Manifest仅处理v2；本地/JSON/ZIP完整保留三层分类与layout/split，源绝对路径不导出，全部既有恶意ZIP验证继续保留。版本1明确拒绝，不能静默补字段转版本。
- [x] 运行 `cargo test --workspace`、`npm.cmd test`、`npm.cmd run typecheck`、`npm.cmd run build`、`cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings`；记录删去迁移测试后的真实数量，提交 `tmp/sdd: simplify v2 contracts without legacy migration`。对原Task1Base..新Head重新双审查，之后才进入Task2。
## Task 2: 统一选区、共享动作和区域右键

**Create:** `src/features/selection/{state,gestures,useSelection,actions}.ts`, `RegionMenu.tsx`, `selection.test.tsx`, `actions.test.tsx`；`src/components/menu/{Menu.tsx,menuModel.ts,menu.css,menu.test.tsx}`。

**Modify:** `src/features/annotations/{AnnotationOverlay.tsx,AnnotationTools.tsx,useAnnotations.ts,AnnotationInspector.tsx}`, `src/features/playback/{useMasks,usePlayback}.ts`, `src/features/project/{shortcuts,shortcuts.test}.ts`, `src/features/spectrogram/SpectrogramCanvas.tsx`, `src/app/AppShell.tsx`, `src/styles/annotations.css`；相关交互回归。

- [x] 写手势/状态与动作红灯：4px阈值、反向拖选、已有框内部新建、单击对象、边框移动/控制点resize、Alt/中键优先平移、Escape恢复拖前状态、project/file切换清理、同对象在undo/remove后同步。运行 `npm.cmd test -- src/features/selection`，确认失败。
- [x] 明确当前交互上下文来自指针所在文件+通道；为整体分类保留当前通道定位，即使没有矩形选区。状态由ActiveProject拥有，物理region共用坐标映射；无对象临时框不调用enqueue、不产生未保存状态。中键阻止系统自动滚屏，pointercancel/lostcapture正确撤销预览。
- [x] 删除 `Tool`/V/A/M模式状态和旧的两个Delete监听器；覆盖层采用边框/handle实际命中，框内部拖动可新建。所有矩形background透明，选中/预览不使用整面阴影；标签低矮时隐藏，hover/属性可查全名。暂时保留历史按钮，紧凑顶部在Task4完成。
- [x] 共享动作接入 `lifecycle.enqueueEdit` 后排空草稿，重读稳定目标：分类/备注创建一次标注再绑定ID；mask通过完全相同媒体/通道/秒/Hz范围查重并启用；对象删除走明确菜单、Delete只屏蔽。标注与屏蔽不隐含绑定移动；旧失败归属仍区分annotation/media/masks。
- [x] Menu原语实现受控打开、子菜单、窗口内定位/翻转、禁用项、方向键/Enter/Escape、focus restore/outside dismiss；用overlay/捕获层阻断菜单打开时的画布拖动和全局快捷键。区域右键提供类型子菜单、备注、屏蔽、选区原始/处理后播放、删除、屏蔽开关和重叠对象列表。放大动作调用共享workspace精确range入口，不额外添加标注。
- [x] `usePlayback` 接受当前临时或对象region（现有接口已接受Region），提供稳定的播放选区动作捕获mediaId/region/source，避免连续setState后播放旧源；切源停止旧音频、generation/EOF契约不变。缺失音频禁用播放，但允许合法标签/备注编辑。
- [x] 运行 `npm.cmd test -- src/features/selection src/components/menu src/features/annotations src/features/playback src/features/project/shortcuts.test.ts`、`npm.cmd run build`；更新受影响桌面脚本定位方式，实际框选→菜单分类→Delete→undo→选区播放。提交 `tmp/sdd: unified selections and region context actions`。

Task2 实施验证：前端完整175项、受影响85项与生产/原生构建通过；真实Tauri统一选区和对比面板流程、受影响旧project/spectral流程通过。证据见 `docs/double-sdd/task2-selection-evidence.md`；等待本Task双审查，不代表后续任务完成。 Task2首轮规格审查指出菜单播放/缩放可能使用异步移动前的范围；已统一执行时目标重读并清理失效菜单，补齐pending move/delete回归和原生重验，待从原TaskBase对新Head重新双审查。 后续spec02b通过，quality02b指出取消拖动可能恢复过期prior；已同步校验当前/拖前选区并覆盖更新、删除和临时身份回归，163/73项与构建通过，等待新Head双审查。 spec02c通过后quality02c发现静止pointer-up恢复旧target；已修复并完成限定手势结束分支检查，同时阻止过期move/resize覆盖已接受的范围更新。175/85项和构建通过，待新Head重新双审查。

## Task 3: Ctrl滚轮、可操作刻度与局部放大

**Create:** `src/features/spectrogram/{ticks,wheel}.ts`, `ticks.test.ts`, `rulers.test.tsx`。

**Modify:** `src/features/spectrogram/{AxisRulers,ChannelPane,SpectrogramCanvas}.tsx`, `viewport.ts`, `useWorkspace.ts`；菜单模型/区域动作入口与刻度样式。

- [x] 红灯覆盖deltaMode pixel/line/page、Ctrl优先Shift、方向与[0,1]夹取、梅尔无变化，轴拖选6px阈值、反向/越界、缩放后有效范围、主次刻度像素间距和极小/大跨度格式。运行 `npm.cmd test -- src/features/spectrogram/ticks.test.ts src/features/spectrogram/rulers.test.tsx`。
- [x] 归一化wheel：line按16 CSS px、page按目标绘制区高度换算；Ctrl STFT混合以 `clamp(mix - normalizedDeltaY * 0.0005, 0, 1)` 为初始响应，触摸板保持连续，任何调优必须保留方向/边界回归。Ctrl梅尔preventDefault后不改视图；原普通/Shift滚轮缩放保留。
- [x] 用ResizeObserver取得刻度尺寸，生成物理“nice”候选并用现有coordinates映射；按60px时间/22px频率主标签与4px次刻度做像素去重，处理DC/Nyquist/端点截断及科学计数/小数，避免固定5标签和仅改变文字的假刻度。
- [x] 刻度拖选使用开始时的坐标映射和pointer capture，仅改对应轴；右键缩放以鼠标为锚点，重置仅对应轴。区域放大同时改两轴，保留同文件同步、双文件linkedTime和短文件尾部语义；不能把视图范围误写为annotation范围。
- [x] 运行 `npm.cmd test -- src/features/spectrogram`、`npm.cmd run build`；真实桌面Ctrl/Shift滚轮与刻度拖选，记录标签物理坐标不变、0.5px往返误差及暖cache混合无新FFT请求。提交 `tmp/sdd: interactive rulers and continuous frequency scaling`。

> Task 3 implementation verification (2026-10-23): focused 11 / affected 57 / full frontend 186 tests passed; build/typecheck and current debug/e2e native build passed. Owned native wheel/ruler runner passed, warmed tile requests 2→2, maximum rendered-frame error 0.014047 CSS px, physical annotation unchanged, narrow-frequency labels retain 10px. Evidence: `docs/double-sdd/task3-rulers-evidence.md`. Paired review pending; only Task 3 checkboxes updated.

## Task 4: 紧凑主菜单、播放条和可调对比布局

**Create:** `src/app/{AppMenu.tsx,WorkspaceActions.ts,HelpDialog.tsx}`, `src/features/spectrogram/CompareSplitter.tsx`, `src/styles/menus.css`, `src/app/compactLayout.test.tsx`；`tests/desktop/compact-layout.test.mjs`。

**Modify:** `src/app/{AppShell,AppShell.test}.tsx`, `src/features/project/ProjectActions.tsx`, `src/features/playback/{TransportBar,PlaybackMode}.tsx`, `src/features/spectrogram/{CompareWorkspace,FilePane,ChannelPane,AnalysisSettings}.tsx`, `useWorkspace.ts`, `src/styles/{layout,controls}.css`。

- [x] 写菜单动作/禁用状态/焦点/快捷键屏障测试，及比较布局默认horizontal、split夹取、保存重开和切换orientation保留比例测试；运行 `npm.cmd test -- src/app/compactLayout.test.tsx` 确认红灯。
- [x] 将主菜单绑定已实现的真实动作：文件/编辑/视图/标注/音频/帮助；未实现的新增分类入口、文件夹入口分别在Task5/7接入，不放占位或假成功项。已有ProjectActions复用调用，不复制生命周期。帮助对话框包含当前快捷键、版本、内置使用说明及第三方声明可读入口，不打开依赖开发机器路径的文件。
- [x] 顶部菜单/状态/快捷区≤76px，播放条≤52px；设备、混音、计数移入按需面板。删除analysis-heading、tool-notice、workspace-status、spectrum-help、inspector-tip等常驻说明；空项目保留简洁真实新建/导入入口。失败/恢复/取消保留有效反馈，不因布局精简而隐藏。
- [x] 合并文件标题/控件≤56px；单声道隐藏通道组；分析参数、mix滑块等占宽控件移入菜单/弹层。侧栏可折叠，焦点/选中对象保持；属性区无选择时不留大段教学。
- [x] Splitter使用v2 compareLayout/compareSplit，经useWorkspace草稿保存而不进内容undo；左右每pane≥300px、每plot≥180px、上下空间不足时文件栈滚动。通道容器按绘制区最小高度而非百分比挤压；两文件各自内部可滚动，不裁掉下方标题。只修改与这些行为有关的CSS，删除冲突旧规则。
- [x] 实际Tauri外窗1280×800/1920×1080：两个立体声文件四张plot完整可见并测 `getBoundingClientRect().height >= 180`，检查同帧四图都在可见viewport内。1000×680/各六通道/上下模式与Windows125%缩放检查滚动及菜单边缘；用当前Windows真实DPI设置或隔离测试进程的WebView缩放验证并准确记录方法，不改用户全局显示设置。
- [x] 运行 `npm.cmd test`、`npm.cmd run build`，保存截图及尺寸JSON，更新既有desktop脚本的菜单/设备入口，提交 `tmp/sdd: compact menu workspace and comparison layout`。Task5/7负责补全其功能的菜单项，最终Task8不得遗漏任何规格菜单。

Task4 实施证据：`docs/double-sdd/task4-compact-evidence.md`。TaskBase `a5b69cba0aeefdcc3883d3913c1ba8b79f468471`；193项前端测试、构建、15项真实桌面紧凑布局检查、selection/rulers回归及完整桌面六阶段均通过。Win32外窗1280×800 → inner1264×761，四图各236.5px同帧完整；Windows125%仅隔离WebView模拟，未更改或验证系统DPI。规格/质量双审查待父代理执行。

## Task 5: 文件/通道分类入口、属性与范围筛选

**Create:** `src/features/annotations/{ClassificationControl.tsx,classification.ts,classification.test.tsx}`。

**Modify:** `src/features/annotations/{CategoryManager,AnnotationList,NotesEditor}.tsx`, `useAnnotations.ts`, `src/features/spectrogram/{FilePane,ChannelPane}.tsx`, `src/features/media/MediaList.tsx`, `src/app/{AppMenu,AppShell}.tsx`, `WorkspaceActions.ts`。

- [x] 写红灯：文件类别与各channel类别独立、标题/右键/主菜单作用于正确对象、无矩形也可给当前通道分类、不同层级结果定位、三层引用删除统计、快速改备注→改分类→保存不丢字段。运行 `npm.cmd test -- src/features/annotations/classification.test.tsx`。
- [x] 复用Task1事务和Task2动作边界，标题紧凑“未分类/类别名”入口有可访问性标签；媒体/通道右键共用类别子菜单。通道上下文从最后焦点/指针所在通道获取，初次无明确上下文时选当前文件第一个可见通道；无可见通道时禁用通道动作。
- [x] 属性区明确文件或通道目标与对应备注；分类和备注不互相覆盖。列表用 discriminated union 表示文件/通道/区域结果，筛选命中三层类别，定位文件/通道不伪造region、不自动播放；现有区域精确范围定位保留。
- [x] CategoryManager确认显示三层数量，执行原子removeCategory并支持一次undo；删除区域仍有显式按钮但移除旧Delete文案。前端分类所有权/失败反馈沿用annotation命令机制。
- [x] 运行 `npm.cmd test -- src/features/annotations src/app`、`cargo test -p annotator-core --test document --test exchange --test persistence`、`npm.cmd run build`；实际分类三层→保存重启→JSON/ZIP导出导入完整比对。提交 `tmp/sdd: file and channel classification controls`。

Task5 实施验证：TaskBase `631229d93d9726c9f335a9001ecfb410a460e3cf`；16分类/55 annotations+app/209完整前端、42 targeted Rust、build与debug/e2e native构建通过。真实桌面17项：三层分类独立、比较上下文、备注快速保存、可见通道回退、三层删除及一次undo、fresh PID重开、JSON/ZIP全语义比对通过。Win32外窗1280×800四图236.5px，顶部72/播放48/文件54；1000×680两面板各300且图180，长文件名入口不溢出。证据见 `docs/double-sdd/task5-classification-evidence.md`；规格/质量双审查 pending，未开始Task6/7/8。

## Task 6: 原生有界文件夹扫描和取消边界

**Create:** `crates/annotator-core/src/media/folder_scan.rs`, `crates/annotator-core/tests/folder_scan.rs`, `src-tauri/src/commands/folders.rs`, `src/bridge/folders.ts`。

**Modify:** `crates/annotator-core/src/media/mod.rs`, `src-tauri/src/{state,lib}.rs`, `commands/{mod,project,exchange}.rs`（project create/open/save-as/close、成功exchange切换需取消旧扫描）；桥消息验证及 `src/bridge/contracts.test.ts`。

- [x] 红灯：仅本层/递归、扩展名大小写、同名不同目录、排序、规范路径去重、junction/reparsepoint不跟随、根目录不能访问、局部错误继续、10000候选/100000条目上限、主动取消、项目reset迟到结果。运行 `cargo test -p annotator-core --test folder_scan`。
- [x] 后台扫描合同包含taskId、owner generation、progress和终态（result/cancelled/failed），结果使用独立规范路径候选及issues/counts；进度合并限频，严格限制候选/issue保留规模，UI需要每项结果时分页读取，不传100000条庞大事件。达到扫描上限时整次失败，未启动音频导入。
- [x] 规范化选中root；子条目先检查Windows reparse属性再决定递归或接受，按路径稳定排序和不区分大小写规范路径去重。比较项目已存在sourceRef需按project root解析相对路径、处理缺失路径，不能把规范化失败当新文件静默替换。不可访问项记录错误；普通不支持格式计数跳过。
- [x] Native扫描在spawn_blocking运行，锁只用于开始/终态校验；不得持项目锁遍历目录。运行态重置取消，返回前核验owner generation。取消扫描和媒体解码是不同任务，不能误取消另一个新项目任务。注入文件系统错误覆盖权限分支；真实NTFS junction测试在自有temp目录运行并按原生PowerShell安全清理规则处理。
- [x] 桥类型严格验证消息；IPC大结果分批/分页，批次带扫描token并拒绝过期读取。扫描表只有当前项目的有限活动记录，完成被控制器接收/丢弃后释放，不能保留所有历史文件夹结果。
- [x] 运行 `cargo test --workspace`、`cargo clippy --workspace --all-targets -- -D warnings`、`npm.cmd test -- src/bridge/contracts.test.ts`、`npm.cmd run typecheck`；提交 `tmp/sdd: bounded cancellable folder discovery`。本任务无占位用户入口，Task7接通。

实施验证：TaskBase `1bcb152263266f46edbeb86bd08489c466f8cedf`；Rust117、前端211（桥7）、typecheck/fmt/clippy及真实native IPC五组通过。证据 `docs/double-sdd/task6-folders-evidence.md`；规格/质量双审查待进行。

## Task 7: 文件夹导入UI、串行批次及失败恢复

**Create:** `src/features/media/{folderImport.ts,FolderImportDialog.tsx,FolderImportProgress.tsx,folderImport.test.tsx}`；`tests/desktop/folder-flow.test.mjs`。

**Modify:** `src/features/media/{imports,useMedia}.ts`, `ImportProgress.tsx`, `src/bridge/media.ts`, `src/app/{AppMenu,AppShell}.tsx`；必要时 `src-tauri/src/commands/media.rs` 保持现有单批≤256合同。

- [x] 写控制器红灯：扫描后自动导入、默认不递归、递归选项、257+候选跨批全覆盖、scan/import不同取消点、finished早于start返回、publishing尾队列未完不开始下一批、项目替换迟到ready释放PCM、重复已存在结果、失败ledger保留。运行 `npm.cmd test -- src/features/media/folderImport.test.tsx`。
- [x] “文件→导入文件夹”打开紧凑选项对话框，再调用真实native目录picker；捕获ActiveProject，返回后若失效不启动。文件导入和文件夹导入互斥，relink期间也不能并行创建MediaTasks。
- [x] 状态机为 choosing→scanning→importing→finished/cancelled/failed；扫描token结果按稳定顺序分页，控制器每批≤256调用现有MediaImportController，等待native finished、start确认、已接收ready的queue结果全部处理后才提交下一批。失败文档命令仍留owner ledger；若未决编辑失败，暂停后续批次，用户重试/明确结束后才继续或终止，不带着未决失败持续堆积prepared PCM。
- [x] 取消立即显示状态；保留已成功媒体，停止分页/下一批/当前解码；未入队ready通过release(taskId,mediaId)回收，已接受命令由生命周期排空。关闭/另存统一取消扫描及导入；失败恢复不清空其他owner错误。结果汇总保留跨批索引与路径、成功/失败/已存在/跳过数量，分页渲染并允许关闭完成结果。
- [x] 明确扫描超限不导入、项目切换无迟到数据、单个解码失败其余继续；原有直接多选导入和重新关联回归不退化。
- [x] 运行 `npm.cmd test -- src/features/media src/features/project`、`npm.cmd run build`；真实桌面生成257个短音频（各自路径明确）验证全部加入、递归选择、重复导入跳过、损坏项失败、取消及新项目隔离。提交 `tmp/sdd: folder import workflow and batch lifecycle`。

Task7 实施验证：TaskBase `7f20955aeb5a8541c305185e1211d059a963507b`；16 项文件夹测试、48 项 media+project、227 项完整前端与 build/typecheck、debug/e2e native 构建通过。真实桌面 10 组覆盖 257+ 批次、递归/重复/损坏、暂停重试/显式结束、取消/新项目隔离及直接导入/重关联；原失败反馈 4 组回归通过。外窗1280×800四图236.5px，顶部72/播放48/文件54，取消可见92ms。注入边界与失败测试脚本尝试均如实记录于 `docs/double-sdd/task7-folder-import-evidence.md`；规格/质量双审查 pending，Task8未开始。

Task7 审查修复：首轮规格 PASS；质量发现全局重试与文件夹结束并发时可能提前释放 PCM，已用实际恢复按钮双顺序红灯复现并修复。单项全局重试、项目级重试、folder Retry/End 统一经过 lifecycle edit admission，执行时重查 ledger，过期回调不复活失败；草稿感知与其他 owner 边界保留。修复后文件夹/恢复21项、相关108项、完整前端232项、含production build/typecheck的native构建、真实folder10组与feedback4组均通过。详见同一Task7证据文档追加段；修复Head等待新一轮规格/质量双审查，未开始Task8。

## Task 8: 全量桌面回归、性能、文档和0.2.0交付

**Create:** `tests/desktop/selection-flow.test.mjs`, `classification-flow.test.mjs`, `format-flow.test.mjs`；`docs/verification-0.2.0.md`, `docs/evidence/2026-10-23-v0.2.0/`（若实际验收跨日期，使用实际日期）。

**Modify:** `tests/desktop/{project-flow,spectral-flow,sharing-flow,view-churn}.test.mjs`, `harness.mjs`；`scripts/{run-desktop-tests,measure-performance}.mjs`；`README.md`, `docs/{user-guide,development}.md`；`package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, `src-tauri/tauri.conf.json`（应用版本统一0.2.0）。

- [x] 将既有真实desktop流程更新为菜单/统一选区交互，保留300次文件切换后新tile请求、保存进程重启、分享、损坏恢复、真实播放和lateowner覆盖。新增右键嵌套/窗口边缘/键盘、透明框、Ctrl滚轮、刻度拖选、分类/文件夹/v2保存及旧格式拒绝流程；测试不能直接改store冒充用户操作。
- [x] 逐项执行规格§9追踪表；验证所有六个菜单最终均为真实功能，分类/导入文件夹不再遗漏；查看截图确认字体密度、标签遮挡和hover提示，而不是只检查DOM尺寸。记录外窗尺寸、实际CSS viewport、DPR/缩放及四图plot尺寸，125%测试方法明确，不修改用户全局DPI。
- [x] 更新性能脚本使用新菜单和Ctrl滚轮：10分钟48k6ch+独立第二文件；40次缩放、20次平移及轴混合，测事件→实际Canvas绘制→paint机会。确认暖P95≤100ms/取消≤500ms、native原音/处理后各30秒零可重复欠载；记录冷首屏与native/WebView2进程树峰值，不用小样本替代。若新布局导致cache/raster预算超标先定位修复，保留原预算。
- [x] 文档说明新菜单/手势/Delete、三层分类、文件夹边界、仅支持v2及旧格式拒绝、无需迁移；直接运行和NSIS均保留相应许可资源。无新依赖时无需重新抓取许可证；若新增必须核验并更新锁文件与清单。
- [x] 顺序运行下面完整命令，记录退出码/日志；失败用systematic-debugging修复并重跑受影响范围，不复用旧产物结论：

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

- [x] 测试构建包含e2e picker feature；最终NSIS使用无e2e feature的正式编译，保持WebView2 offlineInstaller。确认正常配置/二进制没有测试入口与调试端口，保留所有bundled notices及MPL源码。等待打包退出再启动正式exe。
- [x] 正式exe真实native folder/open/save对话框与pointer：导入文件夹→框选→右键分类→选区试听→Delete屏蔽→保存→分享；核对项目/分享三层语义、原音频哈希不变。记录exe/安装包版本、bytes、SHA256和截图；未实际执行的人工听感、新机安装/卸载、exFAT检查明确列出，不编造签名。
- [x] 完成使用说明及验证追踪，提交 `tmp/sdd: compact workspace release verification`；进行Task8双审查，再对MAIN_BASE..最终Head做一次全量质量审查，所有确认的当前重要问题修复后复审。

Task8 实施验收（2026-10-23）：完整232前端/117Rust、typecheck/build/fmt/严格clippy通过；14阶段真实桌面加加强嵌套边缘菜单复验通过。10分钟48k6ch+独立2ch暖P95 67.2ms、取消15.4ms、两种实际设备输出各30秒欠载0。正式无e2e NSIS已完成，真实native新建/文件夹导入/打开/保存选择器、pointer分类/试听/Delete/保存/分享/重开及源字节不变均通过。最终EXE/NSIS、许可与MPL源、指南和SHA清单冻结在本工作树releases/0.2.0；原始日志在.test-output/task8-release，代表证据及限制见docs/verification-0.2.0.md。实际Windows125%、人工听感、新机离线安装卸载、物理exFAT仍未验证；产物未签名。待Task8双审查与全范围审查，主目录整合/复验/清理仍由root执行，最后一项不提前勾选。

## 2. 最终整合与需求追踪

| 规格要求 | 任务 | 必须证据 |
|---|---|---|
| 菜单紧凑、无常驻教学 | 4,8 | 六菜单动作、截图、CSS高度预算、保存错误仍可达 |
| 随时框选/右键/Delete/透明框 | 2,8 | 真实pointer、菜单键盘、属性样式、undo与关闭屏障 |
| 局部刻度/Ctrl滚轮 | 3,8 | nice刻度、锚点、deltaMode/方向、0.5px坐标、无FFT重算 |
| 对比四图可读/多通道滚动 | 4,8 | 四图同时可见且plot≥180px、上下/左右、125%记录 |
| 三层分类和分享 | 1,5,8 | 事务/删除undo/relink、重启/JSON/ZIP全语义 |
| v2格式与普通恢复 | 1,8 | 旧版本拒绝且不改源文件、v2保存恢复/写失败/另存 |
| 文件夹扫描及批次 | 6,7,8 | reparse/权限/超限、257+导入、取消/切换/ledger |
| 稳定与交付 | 所有任务,8 | 全部检查、300视图churn、perf、正式产物流程/哈希 |

- [x] 全部任务审查通过后应用 `finishing-a-development-branch`；按已批准的本地squash范围处理，不推送远端。若主工作树相对MAIN_BASE有用户新改动，先保留并处理，不能重置其指针吞掉更改。
- [x] 将最新正式产物、必要许可/文档和SHA清单保存到主目录 `releases/0.2.0/`；路径已存在时先核验归属，不覆盖用户文件或0.1.0。保留验证日志和恢复所需fixture。
- [x] 整合文件树与已审查版本比对；主目录运行前端完整测试/生产构建与Rust完整测试，成功后创建单个正式实现提交。只补充本轮文档状态，不随手重构其他文件。
- [x] 确认原始证据/交付文件已保存、工作树没有用户更改和未跟踪工作，再清理临时工作树/分支。Windows递归移动/清理前核验绝对路径位于目标工作区，用一个PowerShell进程端到端处理。
- [x] 最终给出程序、安装包、使用说明、验证文档可点击路径，概括紧凑交互成果、实测结果和未验证项。

计划审查状态：完整 plan-document-reviewer 审查 PASS（2026-10-23），进入执行。

审查说明：隔离 WebView 缩放仅是界面缩放验证，不能记录为真实 Windows 125% 系统缩放已验证；若缺少对应系统环境，必须明确后者未验证。真实环境可用时仍按规格执行，不修改用户全局显示设置来冒充独立测试环境。

执行范围变更（2026-10-23）：Task1原实现45af5aa曾双审查通过；用户随后明确“尚未投入使用，不需要任何迁移”。该历史通过不代表收缩后的最终验收。Task1重新打开：删除v1兼容与迁移专用代码，保留v2合同、分类、普通可靠保存恢复及有价值的通用故障回归；原Task1Base仍为14b8d5649e19a29c2f34dc2a73fb7eac3fada7e9，待新Head重新双审查。Tasks2–8尚未开始。

用户范围修订：不要求旧项目/标注/数据库迁移，明确采用新格式。以上新要求直接来自用户，不再请求兼容性批准；其余已确认交互、布局和交付目标继续执行。

范围收缩复审：修订规格与完整计划均独立复审 PASS（2026-10-23），无需新增产品决策。继续完成 Task1 新范围验证与双审查，再顺序执行 Task2–8。

Task1 范围裁定：复审指出原计划“打开/导入失败不改变当前项目”扩大了规格§7“拒绝时不修改用户原文件”的要求。已核验普通打开的先保存/关闭流程在MAIN_BASE中存在，本次净代码未改变它；交换导入原本采用保留会话的发布流程，仍须保留。按用户减少旧数据处理的明确方向，修正计划这处过宽表述，不在本轮引入普通打开的事务替换重构；不声称普通打开失败会保留原内存会话。

最终 Task1 交接（新范围双审查 PASS，fbdf9eb）：只支持v2，无迁移/旧格式兼容/pre-v2备份/专用救援UI。保留setMediaCategory/setChannelCategory、三层引用原子删除undo、relink保留、新比较字段以及普通保存恢复。文档/portable/桥严格字段校验；旧格式1及未来版本拒绝，当前模型测试用document-v2。完整131前端/109Rust及build/typecheck/fmt/strictclippy通过，root额外42Rust+24前端复验。Task2应使用共享Selection/动作层替代工具模式与独立Delete监听，保留现有draft/queue/lifecycle合同；不得重新引入迁移。

Task2 最终交接：5280e13842e684cd7361978c361300bc807aabff 已通过新一轮规格/质量双审查。完整175项前端、build/typecheck通过，root复验23项overlay，质量审查另复验67项。临时SelectionState及reactive context、Menu原语、withTarget/resolveSelection、lifecycle共享actions已就绪；已保存目标执行前重读，手势结束和取消不恢复过期对象，过期move/resize不覆写新几何。实际Tauri选区、菜单、试听及受影响旧流程证据见task2-selection-evidence.md。Task3在这些接口上实现wheel/ticks/rulers；保持physical region、缓存及linkedTime合同，不重做Task4布局或引入迁移。
Task3 最终交接：7e55b0c020e28bf64a26450d768c003ec0b220b8 规格/质量双审查PASS；完整186项前端与构建通过，root及质量审查各复验11项，真实桌面11项检查通过。Ctrl/Shift/普通滚轮、轴拖选和菜单、自适应主次刻度已完成。Task4必须保留ChannelPane的 --frequency-ruler-width：只由lowHz/highHz决定，窄范围10px可读字体按需加宽，轴混合不改图宽/FFT请求。后续尺寸验收必须测外窗1280×800：既有harness默认补偿标题栏以达内部1280×800，不能误当外窗证据；新增精确外窗设置并记录outer/inner/DPR。开始Task4紧凑菜单布局，继续v2-only无迁移。
Task4 最终交接：cbe84e26747dd456750946e68eabc03710ae87f4 规格/质量双审查PASS。菜单/紧凑布局/对比分隔/帮助就绪；真实Win32外窗1280×800四图236.5px，顶部72/播放48/文件54px，小窗和6+6至少180px滚动。保留workspace-feedback有界非重叠反馈栈；原生故障回归证明取消/重试可达且失败ledger不丢。完整193前端/构建、compact15项、选择/刻度和六阶段旧桌面流程通过，root复验8项、质量复验26项。Task5接入文件/通道分类标题、右键/主菜单与范围筛选，不增加常驻行；保持Task4高度预算、物理刻度宽度及共享目标/草稿/queue合同。实际Windows125%仍未验证，CDP模拟不作替代结论。
Task5 最终交接：cff733b847117a4ee4bbfa5e276226b0c8d82206 规格/质量双审查PASS。文件/通道独立类别、标题和右键/主菜单、精确备注、三层筛选定位、删除引用统计已完成。完整209前端、42相关Rust、构建、分类原生17项和旧六阶段桌面通过；root复验16项。保持顶部72/播放48/文件54px及1280外窗四图236.5px。后续Task6实现有界原生文件夹扫描，Task7接通菜单与串行批次；继续保留共享草稿/队列/错误归属、可见上下文和v2-only，无迁移。
Task6 最终交接：e6dd361a3ddff711e183dc6a5bb69d1d74b11dd2 规格/质量双审查PASS。有界原生扫描、独立owner/cancel、分页与生命周期reset及严格桥就绪；完整117Rust/211前端、fmt/clippy/typecheck、真实IPC五组通过，root复验7core+7bridge。Task7使用folderClient.start/page/cancel/release，token={taskId,ownerId}，早事件可先于start确认；读取完所需候选/问题页后release，folder cancel与decoder cancel分开。数量为checked/candidates/existing/skipped/failed/issues，问题保留256条但总数完整。候选页<=256；等待native完成、start确认和已接受queue全部处理后再下一批；失败ledger未决暂停后续批次。完整合同见task6-folders-evidence.md。
Task7 最终交接：c7ef6290ce4f43fe8a36d63e00127ace86a360fb 规格/质量双审查PASS。真实文件夹菜单/选项、扫描串行批次、取消隔离、全ledger暂停、owned恢复和50项分页已完成。所有可见media重试/放弃入口通过lifecycle editTail，先重读ledger再动PCM，保留草稿重试；不得回退。完整232前端、构建、原生folder10组及feedback4组通过，root复验21项；实际取消183ms。Task8执行全量验收、长音频性能、更新0.2.0与文档、正式NSIS/无e2e程序和物理系统选择框流程。保留全部旧0.1交付和本次原始证据，主目录本地squash及清理仍由root在全审查通过后执行。
