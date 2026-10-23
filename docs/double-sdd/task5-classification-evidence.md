# Task 5 — 文件/通道分类验收证据

日期：2026-10-23。TaskBase：`631229d93d9726c9f335a9001ecfb410a460e3cf`。分支：`feature/compact-workspace-v2`。实现已完成，规格/质量双审查待 root 执行。

## 实现范围

- `classification.ts` 提供稳定 mediaId/channelIndex 目标、有效目标检查、可见上下文收敛、统一类别菜单及 file/channel/region discriminated union。分类动作同步登记 `lifecycle.enqueueEdit`，排空现有草稿后重新验证 runtime、媒体、通道和类别，再走共享 CommandQueue；失败归属 `annotations`，没有私有异步队列。
- 紧凑文件标题和通道标题具有类别入口，包含未分类；按钮左/右击及标题右击共用 Menu 和动作层。顶部标注菜单、图层右键菜单有当前文件/通道分类。无矩形亦能分类；无可见通道时禁用通道动作。
- context 支持明确的整个文件（channelIndex=null）及通道；初始采用第一个可见通道。隐藏通道、移除比较面板及切换主文件会收敛上下文；列表显式定位不会被主文件 effect 重置为通道0。
- 属性区显示实际文件/通道名称，独立编辑类别与备注，包括 sidebar 主选文件以外的比较面板。分类不覆盖备注、其他层级或区域。文件列表显示文件类别。
- 筛选覆盖三层并明确整个文件、整个通道、区域范围；定位文件/通道不生成 region、不自动播放；区域定位继续使用原物理范围。类别删除显示三层引用数量，仍由单一 removeCategory 原子清空并一次 undo 恢复。
- 保留 Task4 布局、物理频率刻度宽度和有界错误反馈栈。未改 Rust、版本、依赖、迁移、文件夹导入或发布逻辑。

## TDD 与自动验证

初始计划测试先运行，缺少 classification/ClassificationControl 模块时 RED。随后观察到明确行为 RED：显式整个文件定位在 primary 切换时被错误重置为 channel0；回归修复后 GREEN。新增异步回归还捕获可见通道的菜单被无关文档更新关闭，修复仅关闭已不可见的目标菜单。标题右键回归先因没有标题 trigger 失败，加入共享标题包装后通过。比较文件header控件指针回归先暴露仍指向主文件的问题，修复为指针/焦点进入另一文件header时采用其第一个可见通道。

- `npm.cmd test -- src/features/annotations/classification.test.tsx`：16 PASS。涵盖独立分类、快速备注→分类→保存、运行态替换、排空后删除媒体/通道/类别、错误 ledger/重试、标题/按钮右击、主菜单比较目标、可见上下文、三层筛选/删除数量。
- `npm.cmd test -- src/features/annotations src/app`：55 PASS / 9 files。
- `npm.cmd test`：209 PASS / 32 files。
- `cargo test -p annotator-core --test document --test exchange --test persistence`：42 PASS（13 document + 13 exchange + 16 persistence）。包含 Task1 已有三层分类独立性、原子删除/undo、严格v2、持久化及完整交换回归。
- `npm.cmd run build`：typecheck 与 Vite build PASS。保留既有第三方声明 bundle 体积提示，没有新增依赖。
- `npm.cmd run tauri -- build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json`：PASS，实际 Windows debug/e2e 程序。
- `git diff --check`：PASS。

日志：`.test-output/task5-classification/{unit-focused,unit-integration,frontend,rust,build,native-build}.log`。`red-title.log` 保存标题入口 RED；其他 RED 为执行工具输出中的实测结果。

## 真实桌面

`node tests/desktop/classification-flow.test.mjs`：17 个检查全部通过。使用 owned PID 的真实 Tauri/WebView2、tauri-driver + matching EdgeDriver，只有系统文件选择返回路径预设；操作为 WebDriver pointer/keyboard，文档更改、保存、类别删除和 undo、交换均执行原生代码。

- 文件分类后通道/区域保持未分类；文件备注立即分类并保存无丢失。
- sidebar 仍选择文件A时，用主菜单给比较文件B的通道2分类，属性与备注明确针对B/通道2，无新建矩形。
- 文件名、通道标题及类别按钮右击能打开类别子菜单；未分类和类别切换有效。
- 文件/通道/区域筛选得到3种范围；文件/通道定位不播放、不创建标注。
- 隐藏当前通道后使用第一个可见通道；全部隐藏时禁用；移除比较面板后回到主面板有效上下文。
- 删除类别确认显示1文件、1通道、1区域；一次删除清三层引用；一次undo完整恢复类别、引用和备注。
- 保存后关闭原生进程并启动新 PID，完整比较项目语义。
- 真正导出 JSON/ZIP 并经界面导入，逐字段比较全部语义（仅剔除新项目ID、本地sourceRef、revision、updatedAt）；类别、备注、区域、媒体元数据、分析、混音和视图一致。

证据：`.test-output/task5-classification/report.json`、`native-classification.log`、`scope-results.png`、`classification-{json,zip}-roundtrip.png`。最终成功轮的原生 PID：44472 → 40332，report 保留项目路径。

## 尺寸与截图

外窗由 harness 的 Win32 GetWindowRect/SetWindowPos 对 owned native PID 测量；没有把 WebDriver client 尺寸当作外窗。

| 外窗 | 顶部 | 播放栏 | 每文件标题/控制 | 4张纯绘制高度 | 文件面板宽度 |
| --- | --- | --- | --- | --- | --- |
| 1280×800 | 72 | 48 | 54 | 各236.5 | 各397 |
| 1920×1080 | 72 | 48 | 54 | 各376.5 | 各692 |
| 1000×680 | 72 | 48 | 54 | 各180（允许内部滚动） | 各300 |

单位均为CSS px。1280/1920四张图同时完整可见；最小300px面板测试长文件名，类别控件仍在文件/通道标题内，无页面溢出。已查看1280截图，未增加常驻说明行。

截图：`.test-output/task5-classification/classification-outer1280x800.png`、`classification-outer1920x1080.png`、`classification-min-pane-long-name.png`。

## 既有流程与限制

`node scripts/run-desktop-tests.mjs --skip-build` 执行 project、view-churn、spectral、restart、sharing、recovery 六阶段；实际完成300次视图切换、450个mounted channel owners，freshNativeAnalysis=true，保留超过256次后真实新tile请求回归。仅更新旧 spectral 流程中已更名属性tab与显式文件/通道目标的选择器，没有删除原备注、播放、区域或分享断言。最终六阶段全部PASS；结果见 `desktop-regression.log` 和 `.test-output/desktop-B19h00/report.json`。

本任务没有更改Windows全局DPI；实际Windows125%显示设置仍未验证。没有正式release/NSIS构建或Task8性能验收，不将debug/e2e当作正式交付。所有GUI实例均由harness自有创建和关闭，端口占用会拒绝启动，不连接/终止未知用户程序。
