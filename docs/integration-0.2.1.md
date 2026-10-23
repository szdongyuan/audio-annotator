# 0.2.1 本地整合记录

2026-10-23，全部八项实施任务、每项最终规格/质量审查和整轮质量审查通过，已本地 squash 到 `main`。没有推送远端。临时工作树和临时分支已清理；主分支只保留一个正式实现提交。

## 来源与审查

- MAIN_BASE：`be1edfee3023416d1d0521f4186de1493bff5395`。
- 最终审查版本：`2e7d7e1277368bf0faa0f5a7778e4abe57780a0e`。
- 审查与 squash 暂存树均为 `29e4dd6e74c98589364516b8cd3a35c8ee4940f7`；整合后只补充计划状态、本记录和复验日志。
- Task8 最终双审查及 MAIN_BASE 到最终版本的整轮质量审查均 PASS。整轮审查额外独立运行 67 项关联前端测试，通过。
- Task8 首次质量审查发现两个验证入口没有创建输出父目录，已修复并以真实文件系统 RED/GREEN 检查首次初始化和重复运行保留旧证据。修复不改变发布程序，见[补充记录](evidence/2026-10-23-v0.2.1/output-initialization-addendum.md)。

## 主目录复验

以下命令在 `D:/Work/annotator` 的 squash 结果上重新执行，退出码均为 0：

| 命令 | 结果 |
|---|---|
| `npm.cmd test` | 40 文件，309 项通过 |
| `npm.cmd run build` | typecheck、Vite 生产构建通过 |
| `cargo test --workspace` | 121 项通过，0 失败 |
| `node --test tests/desktop/harness-lifecycle.test.mjs tests/desktop/harness-output-init.test.mjs` | 4 项通过 |
| `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/setup-webdriver.ps1` | 现有驱动校验通过，配置路径更新到主目录 |

原始日志位于 `.test-output/integration-v021/`，稳定副本位于 `docs/evidence/2026-10-23-v0.2.1/integration/`。构建保留既有第三方许可资源块体积提示。

本地整合没有重新运行 GUI 或重建正式 NSIS。正式程序的 18 阶段桌面回归、13 项正式检查和高清性能结果仍以[交付验收记录](verification-0.2.1.md)为准。

## 交付和证据保留

- 正式交付：`D:/Work/annotator/releases/0.2.1/`，43 个文件；移动后重新核对 SHA256SUMS 的全部 42 项，一致。冻结目录内的待整合说明是冻结当时状态，本记录补充其后完成的工作，不改写冻结校验值。
- 所有工作树原始输出原样移动到 `D:/Work/annotator/.test-output/spectral-fidelity-v021/`，包含失败尝试、正式截图、测试项目和长音频 fixture。
- 原工作树 `.tools/` 保存为上述目录内的 `preserved-worktree-tools/`；owned `target/` 已恢复到 `D:/Work/annotator/target/`。
- 原工作树 `D:/Work/annotator/.worktrees/spectral-fidelity-v021/.test-output/<相对路径>` 对应主目录 `.test-output/spectral-fidelity-v021/<相对路径>`。原始报告内的绝对路径不重写，测试项目需要重放时按此映射定位自有 fixture。
- 257 份正式构建输入逐字节保存到 `.test-output/spectral-fidelity-v021/as-built-inputs/`，全部匹配发布来源清单。主目录 Git 的 `core.autocrlf=true` 使其中 23 份检出文本仅换行字节不同，另外 234 份直接 SHA 相同；逐文件确认差异仅为 CRLF/LF，Git 文件树完全一致。见 `source-checkout-audit.json`。
- 用户 `.agents/`、`.codex/`、`.double-sdd/` 共 40 个文件逐项哈希不变，未提交或清理。0.1.0 和 0.2.0 的 EXE/NSIS 四份历史产物均与原哈希一致。

## 使用与验证边界

可直接运行 `releases/0.2.1/annotator-desktop.exe`，并保留同目录的许可及说明文件；也可运行 `Audio Annotator_0.2.1_x64-setup.exe` 安装。完整项目包包含音频，可在原音路径不可用时独立导入和播放；另存项目副本保留原音频引用。

程序和安装包未签名。未进行人工听感、新机器离线安装/卸载、物理 Windows 125% 缩放或物理 exFAT 测试。这些限制没有因本地整合而改变。
