# 0.7.8 正常构建与本机交付校验

本记录仅覆盖发布构建和包完整性。功能验收见 [Task 10](task10.md)，播放测量见 [Task 4](task4-playback.md)。交付采用 Windows x64。

## 构建来源与隔离

正常构建使用冻结的产品输入 `7b7c0c2c73a8e88bc3a5957618cd509d351b11ef`，命令为 `npm run tauri -- build --bundles nsis`，退出码 0。没有启用 `e2e` feature。该临时检查点只用于记录构建来源，最终分支将保留等价产品文件并压缩临时历史。

构建前记录并备份 466 个源码、配置、许可证和打包文档输入；构建后逐项 SHA-256 相同。类型检查和 Vite 构建通过，Rust 正常 release 编译通过，NSIS 生成成功。Vite 仍有既有大块体积提示，未作为构建失败处理。

本机完整记录位于 `D:/Work/annotator/.test-output/collaborative-workspace-production-078/`：`production-inputs-before.json` 与 `source-inputs/`、`production-build.log`、`production-audit.json`、三个 `package-0.7.x.json`、`local-packages.json`。生产输入及独立正常 release 副本在该目录保留，不依赖后续 Cargo 缓存内容。

正常 EXE 的产品版本为 0.7.8，SHA-256 为 `72c27bbb6058ee27216641c7a994b8187f06aa3496b492007a263880c535e4d7`。UTF-8/UTF-16 扫描未发现 `ANNOTATOR_E2E`、`ANNOTATOR_IMPORT_SOURCE_FIXTURES`、`hold_project_lock`、`synchronous_playback_probe`、`native_heartbeat` 或 `Injected folder publication failure`。34 个配套资源与冻结源码中的文件逐项一致。

功能测试专用 E2E EXE 的 SHA-256 为 `48947c8a535ca0c441f53d215c8cc5d67c4f6476442fc438c85d5b8a328ad863`；它与正常交付 EXE 分开保存，不会放入软件交付目录。

## 安装与完整更新

三个更新包由既有 `scripts/package-update.mjs` 顺序生成，分别支持 0.7.5、0.7.6、0.7.7 直接到 0.7.8。每包均有 38 个条目，包含同一正常 EXE、34 个资源及更新元数据/说明/校验单；已验证 ZIP 全部路径、长度和 SHA-256 与本机 payload 相同。项目及交换格式保持原有兼容语义。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| AudioAnnotator-0.7.8-windows-x64-setup.exe | 222727752 | 0032d2cc2a5dd9a25f8bc2eb995eafd82407adbb504a12baa416924fd083c306 |
| AudioAnnotator-0.7.5-to-0.7.8-update.zip | 7549425 | 943759ad70b749214e78ca7ceb0a8bcbdd7b7cd6c2ae2d3e59fff3b12ea2cecc |
| AudioAnnotator-0.7.6-to-0.7.8-update.zip | 7549425 | 9f335bf3a68ffba07fb88f2bcb833fc304507c767d567133da9eb593b8273728 |
| AudioAnnotator-0.7.7-to-0.7.8-update.zip | 7549426 | 2b9c9ca49ae311fe2641255b859dab43331c182867e5ebbc0d5c2ce7e44417ba |

交付说明要求先保存并关闭软件，再覆盖原程序目录中的全部更新内容；项目和音频目录保持原位。新安装包包含离线 WebView2 运行环境，更新包沿用既有运行环境。包未签名。

## 发布状态与限制

正常包尚未运行安装或卸载，也未使用实际用户配置启动生产程序；真实 UI 功能验证使用上述独立 E2E 构建。未进行声学回环或多台物理电脑测试。

最终全量规格及代码质量审查均 PASS。已交付到新的 `N:/精成数据标注/软件/测试版-0.7.8`，不覆盖旧版本。安装包、三个更新包、更新说明、独立验证记录及 SHA256SUMS 共七个文件，经唯一临时文件复制、临时哈希核对、更名和最终长度/哈希核对后发布；原 0.7.7 目录六个文件在前后均保持不变。本机回执为 `nas-publication.json`。尚未自动安装、合并或发布 GitHub Release。

## 集成后校验与证据位置

新主目录集成后，完整前端 1078 测试、构建/类型检查及 21 项 Node 检查再次 PASS。前端三个主要产物名称仍为 `index-DQ7GOkkQ.css`、`index-D7pUkqvh.js`、`THIRD-PARTY-NOTICES-C8M96zO6.js`，与正常包构建一致。没有重新覆盖已经校验的正常 EXE 或 NAS 包。

原始测试证据现保存在主目录 `.test-output/collaborative-workspace-evidence-078`；原 23907 文件 / 1578527742 字节全部保留，214 项关键文件 SHA-256 一致。完整临时历史的本机审计 bundle 为 8908525 字节，SHA-256 `b14887b5a2cf7d43d850ff19320e51f44b7f324593b0abe1d3d2f99896fa84e2`，已执行 `git bundle verify`。这份 bundle 不进入最终单提交分支或交付包。
