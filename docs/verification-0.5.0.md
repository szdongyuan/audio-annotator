# 0.5.0 Windows 可配置音频导入验收

验收日期：2026-10-26（Asia/Shanghai）。TaskBase：`9e412d2c539c617147bb254774fe52d9bf3e2988`。本次增加文件夹/多 ZIP 的规则扫描、预览、精成逻辑路数筛选和本机预设；保留格式 2、原始音频副本、直接导入、重新关联及项目包交换。无需迁移。

## 已执行检查

原始证据在 `D:/Work/annotator/.test-output/configurable-import`；生成的项目、ZIP、WebView 数据及临时文件均在本机独立目录。只读取指定 NAS 归档，不写入 NAS。

| 检查 | 结果 | 日志 |
|---|---|---|
| `npm.cmd test -- --maxWorkers=2` | 52 文件 / 420 项通过，断言/超时不变 | `release-frontend-delivery.log` |
| `npm.cmd run typecheck` | exit 0 | `release-typecheck-delivery.log` |
| `npm.cmd run build` | exit 0；已有 500 kB bundle 提示保留 | `release-delivery-build.log` |
| `cargo test --workspace` | 278 项通过、4 项默认忽略 | `release-workspace.log` |
| `cargo test -p annotator-desktop --features e2e --lib` | 60 项通过 | `release-native-e2e.log` |
| `cargo fmt --all -- --check` | exit 0 | `release-fmt.log` |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 | `release-clippy.log` |
| 原生桌面可配置来源专项 | 6 组通过，包含实际 NAS 代表音频导入 | `release-source-ready2.log` |
| 九个真实归档只读扫描/代表提取解码 | 1 项通过，15.16 s | `release-real-nine.log` |

专项测试使用真实 Tauri/WebView2、官方 tauri-driver 和匹配的 Microsoft EdgeDriver。用户变更经 WebDriver 控件操作，只有原生 picker 返回路径由 e2e hook 提供，不用前端 store mutation 替代操作。生成 ZIP 保留中文长记录名和重复 basename，覆盖两路/仅第一路实际导入、CH2 为第一路、文件夹 `*/CH1; */CH2`、规则改变后必须重扫、取消预览不发布、完整来源显示名、源 ZIP/目录移动后保存重开、原字节 SHA 和频谱解码。1000x680 外窗截图确认固定操作区可见，文件列表记录名截断时文件名仍可见。

截图发现预览原先以 RTL 实现截断，会把日期组件移到末尾。真实桌面断言 RED 为 `rtl !== ltr`，修复只将预览路径恢复 LTR；最终截图显示正常原始顺序。证据为 `release-ltr-red.log` 与 `release-source-green/native-cvtfaK/compact-first-route-preview.png`。

## 真实归档与范围

九个指定 ZIP 均只读扫描：6615 个条目、3294 个两路候选、1647 个第一路候选、问题 0。核心 opt-in 检查显式执行，不能把 workspace 的默认忽略项当作已经运行。代表 position 1/2 各 849644 bytes、48000 Hz、单嵌入声道，原 ZIP 字节 SHA 与提取字节一致。

另用真实桌面从 `运行记录导出20260909NG.zip` 预览 32 个音频，再按同一记录路径筛选 2 个，显式导入到本机项目；两条耐久副本分别与原 ZIP entry SHA 一致，并可实际解码显示。没有批量导入全部 3294 个真实音频，没有提交用户录音或完整敏感清单。

## 完整回归与正式产物

正常最终构建 `npm.cmd run tauri -- build --bundles nsis` 已成功（`release-delivery-build.log`），无 e2e feature 或配置覆盖。EXE 16974848 bytes，SHA256 `cb65bbe8980a145311bd5558028f3484efcc8f882fec8c4f620ad96a51a75708`；NSIS 221980190 bytes，SHA256 `5a5a289b5a2ea0b28e3edb4d4cdc5236875b18cc013d13cea9e41a03e4638ec8`。两者文件/产品版本 0.5.0，均 NotSigned。31 个许可证资源（含 13 个 MPL 源码归档）与源文件、交付副本和 NSIS 资源声明一致。

325 个最终生产输入精确字节清单 SHA256 为 `b5e105a39c0e8c962bb4ff5ff5272332d2271c8a5739b292fe1d99a92bb03f4a`；原字节保存在 `D:/Work/annotator/.test-output/configurable-import/release-delivery-asbuilt-inputs`。之前候选及 324 输入也单独保留。发行目录 `.gitattributes` 禁止文本换行转换，防止检出破坏交付 SHA。

23 个桌面阶段均有通过证据，汇总为 `release-desktop-aggregate.json`。这不是一次连续全绿的 runner：长跑通过 18 阶段后，在分享测试中错误编辑了 Save As 后默认显示的另一音频；改为按完整文件名明确选择目标，独立分享用例通过，随后四个协作阶段全部通过。原断言、原始字节/语义、播放、作者及故障覆盖均保留。此前 picker 就绪、重开 runtime 代次、菜单重渲染及同名无障碍标签定位问题也只修正测试等待/定位；详见 Task 4 原始证据。

最终边界回归确认：合法大预设曾可写入超过读取上限的 JSON，导致重开丢弃。现写入前使用同一 2000000 字符限额，超限明确提示、保留此前持久化字节，当前规则仍可用；删除超额项后可继续保存。`release-preset-capacity-red.log` / `release-preset-capacity-green.log` 记录实测 RED/GREEN。容量修复后重新运行全部 420 个前端测试并重建正式产物。

最终容量修复后的 debug/e2e 构建通过 `release-delivery-compact.log` 全部 15 项检查，包含实际内嵌帮助的新 ZIP/预览/逻辑路数说明及 6+6 通道布局。正常生产 EXE（启动 SHA 与交付 EXE 相同）真实启动、版本 0.5.0、进程树无调试参数，并通过实际 Windows 文件夹 picker 建立本机格式 2 项目。

生产 ZIP 冒烟未完成：原生辅助脚本首次未找到 picker；确认精确拥有的窗口、调整其位置后可创建项目，但 ZIP 菜单操作未打开选择器，最后的受控 UIAutomation 尝试发现菜单没有 InvokePattern。三次有证据的尝试后停止，未据此诊断产品代码。精确 PID 40428 已正常关闭。真实生产 ZIP 选择/预览/导入仍未验证，不能以 e2e 成功替代该项；证据在 `release-production/ui-th066j/`、`release-production-smoke.log` 和 `release-production-smoke-resume.log`。根代理的双审查、主分支整合与清理独立执行，本文件不提前宣称完成。

未验证：新机器离线安装/卸载、人工听感、第二真实 Windows 用户、跨主机网络故障或物理 DPI 改变。本次不写 NAS、不修改旧发布目录。

## 主目录整合确认

Task 4 需求/质量双审查及完整范围质量审查均通过，审查终点为 `7229033e5c3c8c736bee0cee2888d772e59d1d81`。在原始主分支基点 `fe346a3676cce4953d72d6facf20905eb9dcfbeb` 上压缩整合，未保留临时提交历史、未推送。主目录独立运行前端 420 项、Rust workspace 278 项（4 项默认忽略）、e2e lib 60 项全部通过；构建含 typecheck、fmt 和严格 clippy 均 exit 0。日志为 `.test-output/configurable-import/root-main-*.log`。

主目录的 325 个构建输入与最终交付清单一致；整合时仅恢复 Git 转换的换行字节，并验证暂存树与审查树完全一致。独立检查 41 条发行 inventory 和 42 条 SHA256SUMS 均匹配，旧发行 207 个文件保持原哈希。安装包与原始证据仍位于主目录；临时工作目录、临时分支已清理，仅解除其 node_modules/target junction，未删除共享依赖和构建缓存。发行包内验收文件保留打包时记录，本节为随后完成的主目录整合结果；上述生产 ZIP 交互和安装器验证限制仍然有效。
