# 0.7.4 回收站协作任务竞争修复验证

后台协作刷新每两秒尝试占用原生协作任务许可。0.7.3 回收站写入直接调用原生命令，未暂停刷新或处理 admission 竞争，导致慢共享目录下反复返回 Collaboration job already running。

修复把删除和恢复登记进当前项目生命周期，先暂停并等待自动刷新，再使用现有 admitted 机制处理短暂任务竞争。复制用户确认的 revision 和 operationId 后才等待；真正的 RevisionConflict 不自动重放。项目切换/控制器退休会阻止尚未提交的旧操作。无 Rust 业务逻辑或数据格式变更。

## 验证

- 新增 4 项回归测试：原实现全部失败，修复后全部通过。覆盖等待同步、319 项单次提交、短暂竞争使用相同操作重试、退休取消、真实版本冲突保留人工重试。
- 前端全量 72 文件 / 601 项通过；TypeScript 与生产前端构建通过。
- 实际 Windows Tauri 程序导入 319 个 WAV，真实点击全选、删除、恢复。传输层显式延迟一次后台刷新响应，并注入一次与原生一致的 operationBusy 拒绝：等待期间没有提交删除或发起新刷新；释放后自动重试一次、共享回收站仅产生一个版本，随后自动刷新恢复。319 个媒体描述与目录记录在恢复后保持一致。
- 测试数据与 WebView/身份目录均独立；未操作用户项目。模拟的是响应延迟及任务竞争，并非物理 NAS 断网实测。

证据：.test-output/recycle-busy-fix/red.log、green.log、frontend.log、e2e-build.log、desktop-CHu1O1/report.json。
