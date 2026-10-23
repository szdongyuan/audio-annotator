# Compact Selection Workspace 0.2.0 Implementation Plan

> **For agentic workers:** REQUIRED: Use the `subagent-driven-development` skill to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付紧凑菜单式 Windows 频谱工作区，统一随时框选与右键操作，补齐局部刻度缩放、整段/通道分类和可靠的文件夹导入。

**Architecture:** 保留 Rust 权威文档、DSP、播放与分析缓存；先建立严格 v2 格式及写前迁移备份，再以项目运行态拥有的 SelectionState 和共享动作层连接右键、主菜单及快捷键。菜单、布局、类别编辑和文件夹任务分模块实现，继续经过现有命令队列、保存屏障与原生任务所有权。

**Tech Stack:** 现有 React 19 / TypeScript / Canvas、Tauri 2、Rust、Vitest、Selenium + tauri-driver + Microsoft EdgeDriver、NSIS；默认不增加 UI/状态/音频依赖。

---

## 0. 输入、工作树和执行约定

规格：`docs/double-sdd/specs/2026-10-23-compact-selection-workspace-design.md`，用户已确认。当前代码基准为 `57ae424`，规格提交为 `c6630e2`；实际 MAIN_BASE 在本计划审查并提交后重新记录，不用上述短 SHA 猜测。

所有下面的相对路径均指实施工作树根目录。顺序执行 Task 1–8，每任务使用新 implementer、同一 TaskBase..Head 的并行规格/质量双审查；规格通过后才采纳质量结果。根代理不写实现代码。必要修复回原 implementer；按 `code-review` 核实反馈，不因偏好增加范围。出现问题先用 `systematic-debugging`；完成前按 `verification-before-completion` 读取新鲜日志。

- [ ] 只提交已审查计划文档；保留用户未跟踪的 `.agents/`、`.codex/`、`.double-sdd/`。
- [ ] 记录当前主分支和完整 MAIN_BASE；检查 `.worktrees/` 已忽略，建立 `feature/compact-workspace-v2` 和 `.worktrees/compact-workspace-v2`，将元数据写入 `.worktrees/compact-workspace-v2.meta`。保留 `releases/0.1.0`。
- [ ] 工作树运行 `npm.cmd ci`、`npm.cmd test`、`cargo test --workspace`，记录基线与磁盘余量；当前预期前端128、Rust102，但以实际结果为准。官方工具可由 `scripts/setup-webdriver.ps1` 在工作树 `.tools/` 重建，不改全局 PATH。
- [ ] 每任务开始记录完整 TaskBase；临时提交均为 `tmp/sdd: ...`。GUI测试仅一组运行；遇端口占用不终止未知进程、不接入用户现有应用。等待 native bundler 完全退出后再启动同一 release exe。
- [ ] 最终按已确认规格本地 squash 到记录的 MAIN_BASE，保留一个正式实现提交；不普通 merge 临时历史、不推送远端。先保存新交付包与证据再清理工作树。

## 1. 文件责任与贯穿接口

| 单元 | 新建/主要修改路径 | 责任 |
|---|---|---|
| 严格版本读取 | `crates/annotator-core/src/model/legacy_v1.rs`, `model/project.rs`, `model/validation.rs`, `exchange/legacy_v1.rs`, `exchange/manifest.rs` | v1原结构验证、v2转换；本地/portable分离 |
| 迁移写前保护 | `crates/annotator-core/src/project/migration.rs`, `project/store.rs`, `project/local.rs`, `project/recovery.rs` | 原始字节保全，所有写路径的统一备份门槛 |
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

所有读回 native 的文档均为 v2；frontend parser 仍严格拒绝缺失/未知字段。原始 v1 文件保留为独立 golden fixture，不能通过直接改写 golden fixture 来冒充兼容通过。

## Task 1: v2 模型、分类事务和完整安全迁移

**规格范围：** §5数据契约、§7、§8。该任务作为一个完整兼容边界交付，不留下能写v2但尚无迁移保护的中间产品。

**Create:** `crates/annotator-core/src/model/legacy_v1.rs`, `crates/annotator-core/src/exchange/legacy_v1.rs`, `crates/annotator-core/src/project/migration.rs`；`crates/annotator-core/tests/migration.rs`；`tests/fixtures/document-v2.json`, `tests/fixtures/project-v1/`（有效主文件、恢复、备份、JSON/ZIP）。

**Modify:** `crates/annotator-core/src/model/{mod,project,media,validation}.rs`, `project/{session,store,local,recovery}.rs`, `exchange/{manifest,import}.rs`, `media/{decode,registry}.rs`；`src/bridge/{types,validation}.ts`, `src/features/spectrogram/{workspace,useWorkspace}.ts`；相应现有测试fixture构造。现有 `formatVersion:1` fixture 继续用于兼容测试，当前模型测试切到明确的v2 fixture。

- [ ] 写红灯测试：v1→v2保留身份/revision/全部既有语义；新类别全null、比较左右/0.5；v2缺字段、未知类别、通道类别数组错长、比例非法、未来版本拒绝。新增两个分类命令测试独立性、重关联保留、删除类别一次清空三层引用及一次undo恢复。
- [ ] 运行 `cargo test -p annotator-core --test migration --test document` 和 `npm.cmd test -- src/bridge/contracts.test.ts`，确认失败来自未实现合同。
- [ ] 以原v1 `deny_unknown_fields` DTO验证后再转换；nullable字段继续要求键存在。原JSON不带checksum，按结构/语义验证；recovery envelope先核验原payload字节的SHA，再解析v1，不能先转v2再核验旧checksum。Envelope版本保持1，payload文档版本升2；analysis/dsp仍1。
- [ ] 接入v2模型/commands、decode默认字段、relink保留新旧备注/分类、view默认字段、frontend验证和所有构造点，保证 workspace 完整编译。所有新增类别ID必须存在于当前项目，channelIndex不得越界。
- [ ] 在 `migration.rs` 实现写前不可覆盖备份：锁内保留已验证源的原始字节与来源；首次任何v2发布前写 `backups/pre-v2-<kind>-<sha256>.json`，新文件create-new+sync，既有同名必须验证内容相同才能复用。备份失败不写任何v2文件；普通备份轮换不能删除pre-v2文件。
- [ ] 审计 `save`、autosave/recovery、`keep_primary`、恢复选择、`save_as` 路径的首次写入。仅open不改字节；选用v1恢复时保全它和有效v1正式文件。另存到新目录保留源项目原文件，并将所需迁移备份携带到新项目写前保护中；不得因源目录不可写阻止已授权的另存恢复。注入备份write/sync/publication失败并验证原件、恢复内容、重试及另存。
- [ ] Portable v1独立严格DTO→v2 Manifest；新导出v2同时保留三层类别和layout/split。v1JSON/ZIP只迁移新项目，绝对源路径仍不导出；现有恶意ZIP边界测试全部保留。恢复既有主/备份机制的选择与identity语义。
- [ ] 运行 `cargo test --workspace`、`npm.cmd test`、`npm.cmd run typecheck`、`npm.cmd run build`、`cargo fmt --all -- --check`；全部exit0后提交 `tmp/sdd: v2 contracts and safe project migration`，交接完整范围及故障测试证据。

## Task 2: 统一选区、共享动作和区域右键

**Create:** `src/features/selection/{state,gestures,useSelection,actions}.ts`, `RegionMenu.tsx`, `selection.test.tsx`, `actions.test.tsx`；`src/components/menu/{Menu.tsx,menuModel.ts,menu.css,menu.test.tsx}`。

**Modify:** `src/features/annotations/{AnnotationOverlay.tsx,AnnotationTools.tsx,useAnnotations.ts,AnnotationInspector.tsx}`, `src/features/playback/{useMasks,usePlayback}.ts`, `src/features/project/{shortcuts,shortcuts.test}.ts`, `src/features/spectrogram/SpectrogramCanvas.tsx`, `src/app/AppShell.tsx`, `src/styles/annotations.css`；相关交互回归。

- [ ] 写手势/状态与动作红灯：4px阈值、反向拖选、已有框内部新建、单击对象、边框移动/控制点resize、Alt/中键优先平移、Escape恢复拖前状态、project/file切换清理、同对象在undo/remove后同步。运行 `npm.cmd test -- src/features/selection`，确认失败。
- [ ] 明确当前交互上下文来自指针所在文件+通道；为整体分类保留当前通道定位，即使没有矩形选区。状态由ActiveProject拥有，物理region共用坐标映射；无对象临时框不调用enqueue、不产生未保存状态。中键阻止系统自动滚屏，pointercancel/lostcapture正确撤销预览。
- [ ] 删除 `Tool`/V/A/M模式状态和旧的两个Delete监听器；覆盖层采用边框/handle实际命中，框内部拖动可新建。所有矩形background透明，选中/预览不使用整面阴影；标签低矮时隐藏，hover/属性可查全名。暂时保留历史按钮，紧凑顶部在Task4完成。
- [ ] 共享动作接入 `lifecycle.enqueueEdit` 后排空草稿，重读稳定目标：分类/备注创建一次标注再绑定ID；mask通过完全相同媒体/通道/秒/Hz范围查重并启用；对象删除走明确菜单、Delete只屏蔽。标注与屏蔽不隐含绑定移动；旧失败归属仍区分annotation/media/masks。
- [ ] Menu原语实现受控打开、子菜单、窗口内定位/翻转、禁用项、方向键/Enter/Escape、focus restore/outside dismiss；用overlay/捕获层阻断菜单打开时的画布拖动和全局快捷键。区域右键提供类型子菜单、备注、屏蔽、选区原始/处理后播放、删除、屏蔽开关和重叠对象列表。放大动作调用共享workspace精确range入口，不额外添加标注。
- [ ] `usePlayback` 接受当前临时或对象region（现有接口已接受Region），提供稳定的播放选区动作捕获mediaId/region/source，避免连续setState后播放旧源；切源停止旧音频、generation/EOF契约不变。缺失音频禁用播放，但允许合法标签/备注编辑。
- [ ] 运行 `npm.cmd test -- src/features/selection src/components/menu src/features/annotations src/features/playback src/features/project/shortcuts.test.ts`、`npm.cmd run build`；更新受影响桌面脚本定位方式，实际框选→菜单分类→Delete→undo→选区播放。提交 `tmp/sdd: unified selections and region context actions`。

## Task 3: Ctrl滚轮、可操作刻度与局部放大

**Create:** `src/features/spectrogram/{ticks,wheel}.ts`, `ticks.test.ts`, `rulers.test.tsx`。

**Modify:** `src/features/spectrogram/{AxisRulers,ChannelPane,SpectrogramCanvas}.tsx`, `viewport.ts`, `useWorkspace.ts`；菜单模型/区域动作入口与刻度样式。

- [ ] 红灯覆盖deltaMode pixel/line/page、Ctrl优先Shift、方向与[0,1]夹取、梅尔无变化，轴拖选6px阈值、反向/越界、缩放后有效范围、主次刻度像素间距和极小/大跨度格式。运行 `npm.cmd test -- src/features/spectrogram/ticks.test.ts src/features/spectrogram/rulers.test.tsx`。
- [ ] 归一化wheel：line按16 CSS px、page按目标绘制区高度换算；Ctrl STFT混合以 `clamp(mix - normalizedDeltaY * 0.0005, 0, 1)` 为初始响应，触摸板保持连续，任何调优必须保留方向/边界回归。Ctrl梅尔preventDefault后不改视图；原普通/Shift滚轮缩放保留。
- [ ] 用ResizeObserver取得刻度尺寸，生成物理“nice”候选并用现有coordinates映射；按60px时间/22px频率主标签与4px次刻度做像素去重，处理DC/Nyquist/端点截断及科学计数/小数，避免固定5标签和仅改变文字的假刻度。
- [ ] 刻度拖选使用开始时的坐标映射和pointer capture，仅改对应轴；右键缩放以鼠标为锚点，重置仅对应轴。区域放大同时改两轴，保留同文件同步、双文件linkedTime和短文件尾部语义；不能把视图范围误写为annotation范围。
- [ ] 运行 `npm.cmd test -- src/features/spectrogram`、`npm.cmd run build`；真实桌面Ctrl/Shift滚轮与刻度拖选，记录标签物理坐标不变、0.5px往返误差及暖cache混合无新FFT请求。提交 `tmp/sdd: interactive rulers and continuous frequency scaling`。

## Task 4: 紧凑主菜单、播放条和可调对比布局

**Create:** `src/app/{AppMenu.tsx,WorkspaceActions.ts,HelpDialog.tsx}`, `src/features/spectrogram/CompareSplitter.tsx`, `src/styles/menus.css`, `src/app/compactLayout.test.tsx`；`tests/desktop/compact-layout.test.mjs`。

**Modify:** `src/app/{AppShell,AppShell.test}.tsx`, `src/features/project/ProjectActions.tsx`, `src/features/playback/{TransportBar,PlaybackMode}.tsx`, `src/features/spectrogram/{CompareWorkspace,FilePane,ChannelPane,AnalysisSettings}.tsx`, `useWorkspace.ts`, `src/styles/{layout,controls}.css`。

- [ ] 写菜单动作/禁用状态/焦点/快捷键屏障测试，及比较布局默认horizontal、split夹取、保存重开和切换orientation保留比例测试；运行 `npm.cmd test -- src/app/compactLayout.test.tsx` 确认红灯。
- [ ] 将主菜单绑定已实现的真实动作：文件/编辑/视图/标注/音频/帮助；未实现的新增分类入口、文件夹入口分别在Task5/7接入，不放占位或假成功项。已有ProjectActions复用调用，不复制生命周期。帮助对话框包含当前快捷键、版本、内置使用说明及第三方声明可读入口，不打开依赖开发机器路径的文件。
- [ ] 顶部菜单/状态/快捷区≤76px，播放条≤52px；设备、混音、计数移入按需面板。删除analysis-heading、tool-notice、workspace-status、spectrum-help、inspector-tip等常驻说明；空项目保留简洁真实新建/导入入口。失败/恢复/取消保留有效反馈，不因布局精简而隐藏。
- [ ] 合并文件标题/控件≤56px；单声道隐藏通道组；分析参数、mix滑块等占宽控件移入菜单/弹层。侧栏可折叠，焦点/选中对象保持；属性区无选择时不留大段教学。
- [ ] Splitter使用v2 compareLayout/compareSplit，经useWorkspace草稿保存而不进内容undo；左右每pane≥300px、每plot≥180px、上下空间不足时文件栈滚动。通道容器按绘制区最小高度而非百分比挤压；两文件各自内部可滚动，不裁掉下方标题。只修改与这些行为有关的CSS，删除冲突旧规则。
- [ ] 实际Tauri外窗1280×800/1920×1080：两个立体声文件四张plot完整可见并测 `getBoundingClientRect().height >= 180`，检查同帧四图都在可见viewport内。1000×680/各六通道/上下模式与Windows125%缩放检查滚动及菜单边缘；用当前Windows真实DPI设置或隔离测试进程的WebView缩放验证并准确记录方法，不改用户全局显示设置。
- [ ] 运行 `npm.cmd test`、`npm.cmd run build`，保存截图及尺寸JSON，更新既有desktop脚本的菜单/设备入口，提交 `tmp/sdd: compact menu workspace and comparison layout`。Task5/7负责补全其功能的菜单项，最终Task8不得遗漏任何规格菜单。

## Task 5: 文件/通道分类入口、属性与范围筛选

**Create:** `src/features/annotations/{ClassificationControl.tsx,classification.ts,classification.test.tsx}`。

**Modify:** `src/features/annotations/{CategoryManager,AnnotationList,NotesEditor}.tsx`, `useAnnotations.ts`, `src/features/spectrogram/{FilePane,ChannelPane}.tsx`, `src/features/media/MediaList.tsx`, `src/app/{AppMenu,AppShell}.tsx`, `WorkspaceActions.ts`。

- [ ] 写红灯：文件类别与各channel类别独立、标题/右键/主菜单作用于正确对象、无矩形也可给当前通道分类、不同层级结果定位、三层引用删除统计、快速改备注→改分类→保存不丢字段。运行 `npm.cmd test -- src/features/annotations/classification.test.tsx`。
- [ ] 复用Task1事务和Task2动作边界，标题紧凑“未分类/类别名”入口有可访问性标签；媒体/通道右键共用类别子菜单。通道上下文从最后焦点/指针所在通道获取，初次无明确上下文时选当前文件第一个可见通道；无可见通道时禁用通道动作。
- [ ] 属性区明确文件或通道目标与对应备注；分类和备注不互相覆盖。列表用 discriminated union 表示文件/通道/区域结果，筛选命中三层类别，定位文件/通道不伪造region、不自动播放；现有区域精确范围定位保留。
- [ ] CategoryManager确认显示三层数量，执行原子removeCategory并支持一次undo；删除区域仍有显式按钮但移除旧Delete文案。前端分类所有权/失败反馈沿用annotation命令机制。
- [ ] 运行 `npm.cmd test -- src/features/annotations src/app`、`cargo test -p annotator-core --test document --test exchange --test migration`、`npm.cmd run build`；实际分类三层→保存重启→JSON/ZIP导出导入完整比对。提交 `tmp/sdd: file and channel classification controls`。

## Task 6: 原生有界文件夹扫描和取消边界

**Create:** `crates/annotator-core/src/media/folder_scan.rs`, `crates/annotator-core/tests/folder_scan.rs`, `src-tauri/src/commands/folders.rs`, `src/bridge/folders.ts`。

**Modify:** `crates/annotator-core/src/media/mod.rs`, `src-tauri/src/{state,lib}.rs`, `commands/{mod,project,exchange}.rs`（project create/open/save-as/close、成功exchange切换需取消旧扫描）；桥消息验证及 `src/bridge/contracts.test.ts`。

- [ ] 红灯：仅本层/递归、扩展名大小写、同名不同目录、排序、规范路径去重、junction/reparsepoint不跟随、根目录不能访问、局部错误继续、10000候选/100000条目上限、主动取消、项目reset迟到结果。运行 `cargo test -p annotator-core --test folder_scan`。
- [ ] 后台扫描合同包含taskId、owner generation、progress和终态（result/cancelled/failed），结果使用独立规范路径候选及issues/counts；进度合并限频，严格限制候选/issue保留规模，UI需要每项结果时分页读取，不传100000条庞大事件。达到扫描上限时整次失败，未启动音频导入。
- [ ] 规范化选中root；子条目先检查Windows reparse属性再决定递归或接受，按路径稳定排序和不区分大小写规范路径去重。比较项目已存在sourceRef需按project root解析相对路径、处理缺失路径，不能把规范化失败当新文件静默替换。不可访问项记录错误；普通不支持格式计数跳过。
- [ ] Native扫描在spawn_blocking运行，锁只用于开始/终态校验；不得持项目锁遍历目录。运行态重置取消，返回前核验owner generation。取消扫描和媒体解码是不同任务，不能误取消另一个新项目任务。注入文件系统错误覆盖权限分支；真实NTFS junction测试在自有temp目录运行并按原生PowerShell安全清理规则处理。
- [ ] 桥类型严格验证消息；IPC大结果分批/分页，批次带扫描token并拒绝过期读取。扫描表只有当前项目的有限活动记录，完成被控制器接收/丢弃后释放，不能保留所有历史文件夹结果。
- [ ] 运行 `cargo test --workspace`、`cargo clippy --workspace --all-targets -- -D warnings`、`npm.cmd test -- src/bridge/contracts.test.ts`、`npm.cmd run typecheck`；提交 `tmp/sdd: bounded cancellable folder discovery`。本任务无占位用户入口，Task7接通。

## Task 7: 文件夹导入UI、串行批次及失败恢复

**Create:** `src/features/media/{folderImport.ts,FolderImportDialog.tsx,FolderImportProgress.tsx,folderImport.test.tsx}`；`tests/desktop/folder-flow.test.mjs`。

**Modify:** `src/features/media/{imports,useMedia}.ts`, `ImportProgress.tsx`, `src/bridge/media.ts`, `src/app/{AppMenu,AppShell}.tsx`；必要时 `src-tauri/src/commands/media.rs` 保持现有单批≤256合同。

- [ ] 写控制器红灯：扫描后自动导入、默认不递归、递归选项、257+候选跨批全覆盖、scan/import不同取消点、finished早于start返回、publishing尾队列未完不开始下一批、项目替换迟到ready释放PCM、重复已存在结果、失败ledger保留。运行 `npm.cmd test -- src/features/media/folderImport.test.tsx`。
- [ ] “文件→导入文件夹”打开紧凑选项对话框，再调用真实native目录picker；捕获ActiveProject，返回后若失效不启动。文件导入和文件夹导入互斥，relink期间也不能并行创建MediaTasks。
- [ ] 状态机为 choosing→scanning→importing→finished/cancelled/failed；扫描token结果按稳定顺序分页，控制器每批≤256调用现有MediaImportController，等待native finished、start确认、已接收ready的queue结果全部处理后才提交下一批。失败文档命令仍留owner ledger；若未决编辑失败，暂停后续批次，用户重试/明确结束后才继续或终止，不带着未决失败持续堆积prepared PCM。
- [ ] 取消立即显示状态；保留已成功媒体，停止分页/下一批/当前解码；未入队ready通过release(taskId,mediaId)回收，已接受命令由生命周期排空。关闭/另存统一取消扫描及导入；失败恢复不清空其他owner错误。结果汇总保留跨批索引与路径、成功/失败/已存在/跳过数量，分页渲染并允许关闭完成结果。
- [ ] 明确扫描超限不导入、项目切换无迟到数据、单个解码失败其余继续；原有直接多选导入和重新关联回归不退化。
- [ ] 运行 `npm.cmd test -- src/features/media src/features/project`、`npm.cmd run build`；真实桌面生成257个短音频（各自路径明确）验证全部加入、递归选择、重复导入跳过、损坏项失败、取消及新项目隔离。提交 `tmp/sdd: folder import workflow and batch lifecycle`。

## Task 8: 全量桌面回归、性能、文档和0.2.0交付

**Create:** `tests/desktop/selection-flow.test.mjs`, `classification-flow.test.mjs`, `migration-flow.test.mjs`；`docs/verification-0.2.0.md`, `docs/evidence/2026-10-23-v0.2.0/`（若实际验收跨日期，使用实际日期）。

**Modify:** `tests/desktop/{project-flow,spectral-flow,sharing-flow,view-churn}.test.mjs`, `harness.mjs`；`scripts/{run-desktop-tests,measure-performance}.mjs`；`README.md`, `docs/{user-guide,development}.md`；`package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, `src-tauri/tauri.conf.json`（应用版本统一0.2.0）。

- [ ] 将既有真实desktop流程更新为菜单/统一选区交互，保留300次文件切换后新tile请求、保存进程重启、分享、损坏恢复、真实播放和lateowner覆盖。新增右键嵌套/窗口边缘/键盘、透明框、Ctrl滚轮、刻度拖选、分类/文件夹/v1迁移流程；测试不能直接改store冒充用户操作。
- [ ] 逐项执行规格§9追踪表；验证所有六个菜单最终均为真实功能，分类/导入文件夹不再遗漏；查看截图确认字体密度、标签遮挡和hover提示，而不是只检查DOM尺寸。记录外窗尺寸、实际CSS viewport、DPR/缩放及四图plot尺寸，125%测试方法明确，不修改用户全局DPI。
- [ ] 更新性能脚本使用新菜单和Ctrl滚轮：10分钟48k6ch+独立第二文件；40次缩放、20次平移及轴混合，测事件→实际Canvas绘制→paint机会。确认暖P95≤100ms/取消≤500ms、native原音/处理后各30秒零可重复欠载；记录冷首屏与native/WebView2进程树峰值，不用小样本替代。若新布局导致cache/raster预算超标先定位修复，保留原预算。
- [ ] 文档说明新菜单/手势/Delete、三层分类、文件夹边界、v1只读打开及写前备份、v2旧软件不兼容；直接运行和NSIS均保留相应许可资源。无新依赖时无需重新抓取许可证；若新增必须核验并更新锁文件与清单。
- [ ] 顺序运行下面完整命令，记录退出码/日志；失败用systematic-debugging修复并重跑受影响范围，不复用旧产物结论：

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

- [ ] 测试构建包含e2e picker feature；最终NSIS使用无e2e feature的正式编译，保持WebView2 offlineInstaller。确认正常配置/二进制没有测试入口与调试端口，保留所有bundled notices及MPL源码。等待打包退出再启动正式exe。
- [ ] 正式exe真实native folder/open/save对话框与pointer：导入文件夹→框选→右键分类→选区试听→Delete屏蔽→保存→分享；核对项目/分享三层语义、原音频哈希不变。记录exe/安装包版本、bytes、SHA256和截图；未实际执行的人工听感、新机安装/卸载、exFAT检查明确列出，不编造签名。
- [ ] 完成使用说明及验证追踪，提交 `tmp/sdd: compact workspace release verification`；进行Task8双审查，再对MAIN_BASE..最终Head做一次全量质量审查，所有确认的当前重要问题修复后复审。

## 2. 最终整合与需求追踪

| 规格要求 | 任务 | 必须证据 |
|---|---|---|
| 菜单紧凑、无常驻教学 | 4,8 | 六菜单动作、截图、CSS高度预算、保存错误仍可达 |
| 随时框选/右键/Delete/透明框 | 2,8 | 真实pointer、菜单键盘、属性样式、undo与关闭屏障 |
| 局部刻度/Ctrl滚轮 | 3,8 | nice刻度、锚点、deltaMode/方向、0.5px坐标、无FFT重算 |
| 对比四图可读/多通道滚动 | 4,8 | 四图同时可见且plot≥180px、上下/左右、125%记录 |
| 三层分类和分享 | 1,5,8 | 事务/删除undo/relink、重启/JSON/ZIP全语义 |
| v1兼容与备份 | 1,8 | 原始golden、checksum顺序、所有写路径、失败/另存 |
| 文件夹扫描及批次 | 6,7,8 | reparse/权限/超限、257+导入、取消/切换/ledger |
| 稳定与交付 | 所有任务,8 | 全部检查、300视图churn、perf、正式产物流程/哈希 |

- [ ] 全部任务审查通过后应用 `finishing-a-development-branch`；按已批准的本地squash范围处理，不推送远端。若主工作树相对MAIN_BASE有用户新改动，先保留并处理，不能重置其指针吞掉更改。
- [ ] 将最新正式产物、必要许可/文档和SHA清单保存到主目录 `releases/0.2.0/`；路径已存在时先核验归属，不覆盖用户文件或0.1.0。保留验证日志和恢复所需fixture。
- [ ] 整合文件树与已审查版本比对；主目录运行前端完整测试/生产构建与Rust完整测试，成功后创建单个正式实现提交。只补充本轮文档状态，不随手重构其他文件。
- [ ] 确认原始证据/交付文件已保存、工作树没有用户更改和未跟踪工作，再清理临时工作树/分支。Windows递归移动/清理前核验绝对路径位于目标工作区，用一个PowerShell进程端到端处理。
- [ ] 最终给出程序、安装包、使用说明、验证文档可点击路径，概括紧凑交互成果、实测结果和未验证项。

计划审查状态：完整 plan-document-reviewer 审查 PASS（2026-10-23），进入执行。

审查说明：隔离 WebView 缩放仅是界面缩放验证，不能记录为真实 Windows 125% 系统缩放已验证；若缺少对应系统环境，必须明确后者未验证。真实环境可用时仍按规格执行，不修改用户全局显示设置来冒充独立测试环境。
