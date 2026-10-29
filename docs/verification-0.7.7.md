# 0.7.7 文件夹子树删除验证

## 行为与格式

移除空子树或全部关联音频已在共享回收站的子树。回收站音频的目录归属移到被删子树的上级，顶层子树则移到项目根目录；原始文件名不变。普通、个人隐藏、筛选掉及未加载的非回收站音频会阻止删除。原生提交在目录提交锁内重新检查当前目录版本与回收站状态，保留取消和运行实例保护。

继续使用既有 `removeFolder` 操作和 organization/recycle/作者文件格式，无迁移。删除目录不会删除音频或修改作者标注，也不会自动编辑用户的真实项目。

## 自动回归

- 原生目录测试 22 项和命令保护测试 6 项通过；覆盖空/回收站子树、父目录及根目录归属、隐藏/未知成员、恢复竞态、版本和运行实例保护。
- 前端完整回归：87 个文件、786 项测试通过，单 worker。该轮启动时版本为 0.7.6，功能代码与 0.7.7 一致，随后仅变更版本标识。日志 `.test-output/folder-removal/frontend-full.log`。
- Rust 工作区完整回归：29 组测试结果、406 项通过、9 项忽略、0 项失败，包含 100 项桌面原生单元测试。日志 `.test-output/folder-removal/workspace-full.log`。
- 桌面 harness、阶段注册及离线文档资源检查 20 项通过，新增 `folder-removal` 组合阶段加入顺序桌面入口。

## 真实 Windows 组合与兼容性

测试脚本 `tests/desktop/folder-removal.test.mjs` 使用独立本地项目、应用身份目录、WebView 和端口，三个合成的两秒单通道 WAV。普通 `organization_apply` 和 `recycle_apply` 仅用于创建测试树与初始回收状态，并逐项记入报告；被验证的删除、取消、隐藏、恢复、列表筛选及键盘行为通过真实 WebDriver 菜单和按钮操作。没有修改前端 store 或增加测试数据注入入口。

本地真实窗口组合 6 项检查通过，记录 `.test-output/folder-removal/desktop-8z90LS/report.json`，完整日志 `desktop-combo-retry4.log`：

- 隐藏的普通后代音频使零可见数量的父目录保持禁止删除，标注筛选同样无法绕过。
- 空的两级子树取消后不变，确认后整树移除，选中目录回到根目录，焦点落在仍连接的根目录按钮。
- 回收站视图显示两条，正常视图显示零条；确认框说明两级目录、两条回收站音频和新的上级 P。取消保留归属，确认后两条归属移至 P，原始文件名不变。
- 删除前后检查全部音频、catalog、作者记录、作者 head/标注层及 recycle 文件 SHA-256 不变（运行锁文件不属于数据，未纳入哈希）。文档音频、区域标注、类别、编辑及个人隐藏设置保持。
- 真实多选恢复后两条音频直接显示在 P；取消隐藏后，上下方向键更新主音频、焦点和滚动，搜索输入保持方向键处理。合成文件的并行导入顺序可能不同，测试依据实际行顺序验证相邻切换。
- 1000×680 外框（984×641 内容区）显示三层目录及音频，无横向页面溢出；截图 `desktop-8z90LS/reopen/depth-three-narrow.png`，已人工查看。随后关闭候选测试进程，用保留的 0.7.5 E2E 程序、相同应用身份与同一专用项目重新打开；全部音频、标注、类别、编辑及结果目录归属一致。

原有目录导航回归 5 项检查也通过，包括六轮禁用增益点击、菜单关闭、监听目标、选区创建/清除和指针/键盘/动画帧心跳。报告 `.test-output/folder-removal/navigation/desktop-3lJuuJ/report.json`，日志 `navigation-regression.log`。已把旧的“回收站目录禁止删除”断言更新为说明、确认和取消后数据不变。

E2E 文件版本 0.7.7，SHA-256 `e44b26b9fc8f87fb61e859a7d6c89805ee514f10ee22f08a9214ba40cc7bef73`，保存在 `.test-output/folder-removal/e2e-executable/`。旧读取程序文件版本 0.7.5。

初始脚本失败记录均保留：原生夹具写入后尚未完整刷新渲染器、复用 WebView 目录导致重启阶段停滞、将原生锁文件纳入哈希、假设并行导入固定顺序。修正分别是重新打开已保存夹具、每次启动使用新 WebView 目录并给启动端点增加超时及早期退出日志、仅排除运行锁文件、依据真实行顺序验证键盘操作。失败目录为 `desktop-NGN00t`、`desktop-rRv3fd`（启动被终止，未产生最终报告）、`desktop-iMixJ7`、`desktop-Lq5Xcg`。以上修改均为测试夹具及 harness 修正，没有改动产品行为。

独立 NAS 新建测试项目的同一组合 6 项检查通过，包括 0.7.5 重新读取、全部删除前后数据哈希、实际多选恢复和上下键导航。报告 `.test-output/folder-removal/nas/desktop-1r4wkA/report.json`，日志 `nas-combo-retry4.log`。每次尝试在明确指定的 NAS 测试父目录创建新的 `.codex-folder-removal-owned-UUID` 子目录，保留项目和证据，不复用或编辑真实用户项目。

NAS 初始化还暴露了测试夹具和后台协作任务竞争：前两轮在原生夹具操作收到 `operationBusy` 后退出，第三轮在目录写入尚被界面逐步读取时尝试选择旧位置的行，第四轮已通过候选程序的 5 项检查，但旧版首次菜单查询早于界面稳定。最终将真实标注/保存放在夹具目录写入前，仅对初始化 IPC 的明确 `operationBusy` 做最长 30 秒等待（每次重新读取绑定和版本，重试次数记入报告），并通过实际首页“打开项目…”按钮等待后重新打开。被验证的删除、取消、恢复等动作没有自动重试。失败报告依次保存在 `nas/desktop-tsayW1`、`desktop-Lf5dKf`、`desktop-Uia4L2`、`desktop-JuiCNJ`；未把这些失败尝试记为通过。

未复跑全部历史桌面阶段、多台真实电脑并发或大规模导入压力测试。旧 `media-folders` 脚本仅更新删除标签及隐藏音频禁用选择器，其他历史断言未在本轮扩展。

## 正常构建与交付

正常 `tauri build --bundles nsis` 成功；随后单独重新打包 NSIS，把更新后的使用指南纳入安装包。正常构建前记录 419 个已跟踪输入，构建后代码与配置输入均一致，唯一预期差异为这份指南资源；最终安装与更新资源和源文件哈希一致。日志为 `.test-output/folder-removal/production-build.log` 与 `production-bundle-final.log`。

正常程序文件版本为 0.7.7，SHA-256 `1ecd3bf770ec0ec85967b22fc1fdcfc90995408b246f91b48c9b2e5cd35bb536`。正常程序中未发现 `ANNOTATOR_E2E_LOCAL_DATA`、`hold_project_lock`、`synchronous_playback_probe` 或 `native_heartbeat` 测试入口标记；E2E 程序另行保留，没有混入交付。

两个完整覆盖更新包均使用 `scripts/package-update.mjs` 生成并逐项验证 ZIP 文件名、长度与 SHA-256，各含 38 个条目及 34 个配套资源。0.7.5 可直接更新到 0.7.7，无需先安装 0.7.6；同时提供 0.7.6 的对应更新包。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| AudioAnnotator-0.7.7-windows-x64-setup.exe | 222599463 | 97399c4f31b95d0561c4ed3b8aeceedbca8378b3b55649ad7d1546d110dc6ad7 |
| AudioAnnotator-0.7.5-to-0.7.7-update.zip | 7331779 | 50d15f4ad93155d4c97229e0140ecc3458c757c1b57a54b6fb99290e45d11b1d |
| AudioAnnotator-0.7.6-to-0.7.7-update.zip | 7331785 | 448955ab246117c48bfcb988126eb68becf64c87ecb90be0c148a0492ff44799 |

NAS 软件目录的 `测试版-0.7.7` 保存安装包、两个更新包、更新说明、验证记录及 SHA256SUMS.txt。安装包、更新包和更新说明通过唯一临时文件复制，哈希核对后更名，再验证最终文件；较早版本包保留。专用日志与清单位于本机 `.test-output/folder-removal/`。

未执行安装、卸载、正式包 UI 自动化或关闭用户应用；没有发布 GitHub Release 或合并 PR。项目、音频、作者层、私人工作区与交换格式不变；大规模 ZIP 导入问题仍独立排查，本轮没有修改导入逻辑。
