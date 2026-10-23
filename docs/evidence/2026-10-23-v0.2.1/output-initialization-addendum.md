# Task8 审查补充：首次运行输出目录

2026-10-23，针对提交 `8255664680689a85d8a26803e2be56c96f8268ff` 的质量审查修正。此前完整桌面/性能运行所在工作树已有 `.test-output/fidelity-release`，没有覆盖全新检出时父目录不存在的条件。

`run-desktop-tests.mjs` 和 `measure-performance.mjs` 现在在原有 `mkdtemp` 前显式递归创建输出父目录。没有产品、native、构建配置或依赖变更。

回归测试读取两个脚本的实际输出/项目初始化语句，在各自独立的临时工作目录用真实 Node/fs 执行；先确认 `.test-output` 不存在，再验证输出路径和项目目录。重复执行须产生不同目录并保留前次证据文件。测试不运行前置构建/fixtures 或 GUI，也不使用虚拟文件系统。临时目录清理前核对绝对父路径和专属前缀。desktop runner 的启动检查已纳入这两项回归。

- RED：`node --test tests/desktop/harness-output-init.test.mjs`，exit1，两项均因真实 `mkdtemp ENOENT` 失败。见 `output-init-red.log`。
- GREEN：`node --test tests/desktop/harness-lifecycle.test.mjs tests/desktop/harness-output-init.test.mjs`，exit0，4项全部通过。见 `output-init-green.log`。
- 两个 runner 与两个测试文件分别 `node --check`，全部 exit0；源码及补充文档的diff空白检查通过。RED原始日志包含Node错误输出的空白缩进，按原样保留，未将日志空白作为源码格式问题修剪。
- 再核对257份生产输入SHA，全部与冻结清单一致；这两个harness脚本不属于生产输入。冻结发布42条SHA256SUMS逐项匹配，清单自身SHA仍为 `38f1de133e0e4316669d488d605bd0681e7f9f8e61e592e95637de672f54c939`。见 `output-init-integrity.json`。

原始记录保存在 `.test-output/fidelity-release/output-init-*`，本目录保存稳定副本。没有重跑完整桌面/性能/正式UI或重建二进制；原有18阶段、性能和13项正式检查记录的验证范围不变。冻结发布、原始验证文档与旧证据未改写。
