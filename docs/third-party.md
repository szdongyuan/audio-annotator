# 第三方依赖及分发声明

本项目未指定自身许可证，不把第三方许可当作项目授权。依赖锁定在 `Cargo.lock` 与 `package-lock.json`。

`npm.cmd run notices` 从 Windows x64 Cargo 元数据及 npm 非开发依赖生成 `licenses/inventory.json` 和 `licenses/THIRD-PARTY-NOTICES.txt`。保守清单包含 Rust 构建与过程宏依赖，因此条目数大于最终二进制实际运行依赖数。缺少独立许可文件的 crate，读取其发布包声明和精确 Git 修订的上游许可；realfft 和 selectors 使用其声明的标准 MIT/MPL 文本，并记录发布包缺失单独许可文件的事实。

主要运行依赖：React/React DOM、Tauri API、dialog 插件和 Lucide（MIT/ISC，以清单为准）；Rust Tauri、CPAL、Rubato、RustFFT、Serde、SHA-2、UUID、Chrono、ZIP 及其依赖（具体 SPDX 表达式与完整通知见清单）。包含 BSD、MIT、Apache、Zlib、Unicode、MPL 等许可，不能笼统称为“全是 MIT”。

Symphonia 0.5.5 及其相关解码 crate 使用 MPL-2.0；selectors、cssparser、cssparser-macros、dtoa-short、option-ext 也声明 MPL-2.0。我们没有修改这些第三方 crate。安装目录 `licenses/sources/` 随包提供所有这些 crate 的精确版本 Cargo 源码归档（`.crate` 是 gzip tar），并保留全部文件级通知。完整 MPL 文本随通知分发，可据此获取、修改和重新分发所覆盖源文件。上游包括 [Symphonia](https://github.com/pdeljanov/Symphonia) 与 [Stylo selectors](https://github.com/servo/stylo)，其他仓库记录在 inventory.json。

`licenses/` 整个目录作为 Tauri bundle resource 安装，不只保留在仓库。WebView2 是 Microsoft 运行时，NSIS 包使用 Tauri 官方 `offlineInstaller` 方式内嵌 Microsoft 签名的离线安装程序；其许可由 Microsoft 提供。

FFmpeg（`ffmpeg-static`）仅用于开发阶段生成 FLAC/MP3 测试 fixture，不被前端导入，不作为 Tauri sidecar/resource，也不随安装包分发。Selenium、tauri-driver 和 Microsoft EdgeDriver 仅用于测试，均不随应用分发。

本版没有代码签名证书；应用与 NSIS 安装包未签名。依赖供应方签名不等于给应用签名。
