# 0.3.0 主目录整合记录

2026-10-23，六项实施任务的规格/质量双审查及整轮质量审查均通过。整轮审查范围为 `bb9ff6a5428fad531507738a99eb6a3f82f76fdd..a4f79767b023acdb1fea4eede60c801b1ee2621b`。

主目录在整合前仍为记录的 MAIN_BASE，仅有原用户未跟踪的 `.agents/`、`.codex/`、`.double-sdd/`。40 份配置文件和 6 份旧版 EXE/安装包逐项哈希一致。使用本地 squash，未推送；暂存树与审查树同为 `08014b68c6c36e9ed2b135ed687faf91d264cf4a`，随后只补充本整合记录及计划状态。

主目录重新执行结果：

| 检查 | 结果 |
|---|---|
| `npm.cmd test` | 355 项 / 46 文件通过 |
| `npm.cmd run build` | 类型检查及生产前端构建通过 |
| `cargo test --workspace` | 182 项通过 |
| `cargo test -p annotator-core --test collaboration_workspace` | 25 项通过 |
| 暂存源码 `git diff --check` | 除已记录的生成上游许可原有尾空格外通过 |

完整桌面 21 阶段、高清性能与两个正常生产实例的六组真实 UI 验收见 [验证记录](../verification-0.3.0.md)。根代理另行复核全部 41 条发布校验项及 292 份实际构建输入和精确保留副本。

## 保存位置

原始报告里的历史绝对路径未改写。路径对应关系如下：

| 原位置（临时工作树内） | 主目录保存位置 |
|---|---|
| `.test-output/` | `D:/Work/annotator/.test-output/nas-collaboration-v030/` |
| `.tools/` | `D:/Work/annotator/.test-output/nas-collaboration-v030/tooling-as-built/` |
| `releases/0.3.0/` | `D:/Work/annotator/releases/0.3.0/` |
| `target/` | `D:/Work/annotator/target/`（原有缓存完整恢复） |

主目录使用其原有有效 `.tools/` 驱动配置。实际构建输入位于 `.test-output/nas-collaboration-v030/nas-release/as-built-inputs/`；整合后的 292 个生产输入中，246 个逐字节一致，46 个仅有 Git 的 CRLF/LF 转换，没有其他内容差异。发布二进制来源仍以归档字节及清单为准，不以主目录换行规范化后的哈希替代。详细复核记录位于同目录下的 `root-squash-tree.json`、`main-source-normalization.json`、`root-artifact-verification.json`、`root-protected-verification.json` 和 `main-*.log`。

发布文件保持冻结，旧版交付完整保留。物理 SMB/NAS 未实测；已完成同目录多进程、权限/断线故障模拟和真实桌面验证。

主目录提交及复验完成后，确认没有进程引用临时目录、跟踪文件干净、必需产物均已保存，再移除临时工作树和临时分支。只留下一个正式实现提交；未推送。原始编排记录和基线元数据也保存到 `.test-output/nas-collaboration-v030/`。主目录仅保留原用户未跟踪的三个配置目录。
