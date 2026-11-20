//! Read-only shared-project probe. Never adopts an author or opens a private workspace.
use annotator_core::collaboration::{atomic, CollaborationRepository};
use std::{fs, io, path::PathBuf, time::Instant};

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let no_pause = args.iter().any(|v| v == "--no-pause");
    let Some(root) = args
        .iter()
        .find(|v| *v != "--no-pause")
        .map(PathBuf::from)
    else {
        eprintln!("用法：project_diagnostic <项目路径> [--no-pause]");
        std::process::exit(2);
    };
    let mut report = format!("Audio Annotator shared-project read diagnostic\nTime: {}\nProject: {}\nNo project files or author sessions are written.\n\n", chrono::Utc::now(), root.display());
    println!("正在只读检查项目，请等待完成……");
    for part in root.ancestors().filter(|p| !p.as_os_str().is_empty()) {
        let result = atomic::safe_existing(part);
        report.push_str(&format!("Path check {}: {:?}\n", part.display(), result));
    }
    report.push_str(&format!("Canonical path: {:?}\n", root.canonicalize()));
    for name in ["collaboration.json", "organization.json", "recycle.json"] {
        let path = root.join(name);
        let result = fs::File::open(&path).and_then(|file| file.metadata().map(|m| m.len()));
        report.push_str(&format!("Open {}: {:?}\n", path.display(), result));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        report.push_str(&format!(
            "Local data path {}: {:?}\n",
            local.display(),
            atomic::safe_existing(&local)
        ));
        let app = local.join("com.audioannotator.desktop");
        if app.exists() {
            report.push_str(&format!(
                "App data path {}: {:?}\n",
                app.display(),
                atomic::safe_existing(&app)
            ));
        }
    }
    let started = Instant::now();
    match CollaborationRepository::open(&root) {
        Ok(repo) => report.push_str(&format!(
            "Repository read OK: {} media, {:.2}s\n",
            repo.manifest().media.len(),
            started.elapsed().as_secs_f64()
        )),
        Err(error) => report.push_str(&format!(
            "Repository read FAILED after {:.2}s:\n{}\n",
            started.elapsed().as_secs_f64(),
            serde_json::to_string_pretty(&error).unwrap()
        )),
    }
    let path = std::env::temp_dir().join(format!(
        "audio-annotator-open-diagnostic-{}.txt",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    ));
    match fs::write(&path, report.as_bytes()) {
        Ok(()) => println!(
            "检查结果：\n{report}\n请将这个诊断文件发给维护者：\n{}",
            path.display()
        ),
        Err(error) => println!("{report}\n无法保存诊断文件：{error}"),
    }
    if !no_pause {
        println!("按回车退出。");
        let mut line = String::new();
        let _ = io::stdin().read_line(&mut line);
    }
}
