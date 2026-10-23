# 0.2.0 代表性证据（2026-10-23）

这些文件来自本轮实际执行，完整命令与限制见 ../../verification-0.2.0.md。

- desktop-report.json：原六阶段及新增八套native测试全通过；原输出目录 desktop-8rX2lk。
- selection/compact报告：随后再次执行加强的嵌套菜单边界断言通过；其截图随报告保留。四图、小窗、12通道、透明框、窄刻度、inline guide和失败反馈均已查看。
- classification/folder/feedback/format报告：真实原生功能、明确注入的失败场景，以及v1/999拒绝与源字节哈希。
- performance-report.json / performance-memory.json：600秒48k6ch+独立2ch，80个暖反馈样本和实际设备60秒观察。intervalMs=1000是采样循环等待配置，实际查询间隔中位数1342.835ms；不是瞬时峰值。
- formal-release-report.json、formal-project.json、formal-share.json：正式无e2e程序的真实Windows对话框和pointer流程、三层语义、源哈希、产物哈希、版本及未签名状态。
- formal-native-dialog-controls.json：原始UIAutomation记录中仅保留本次系统选择器的相关窗口/输入/按钮；完整原始记录在 .test-output/task8-release/formal-flow。
- delivery-inventory.json：已冻结 releases/0.2.0 的逐文件bytes/SHA；不把EXE、NSIS、大音频或原始日志提交到Git。

实际Windows125%系统缩放、人工听感、新机离线安装/卸载、物理exFAT未验证；CDP1.25只作隔离模拟。截图中可能出现悬停提示；这不属于常驻教学条。

Task8规格/质量双审查及整轮质量审查均PASS，审查Head为`608f7bf64b21160992ddfbe077e1d745fe4f0db7`。原始证据完整保留到主目录`D:/Work/annotator/.test-output/compact-workspace-v2/`（14351个文件、1200321024 bytes）；报告内历史工作树的`.test-output/`绝对路径对应此目录中的同名相对路径。正式交付副本位于`D:/Work/annotator/releases/0.2.0/`，39项SHA256均已复核。主目录整合复验日志位于`D:/Work/annotator/.test-output/integration-v2/`；最终整合状态见`docs/verification-0.2.0.md`。
