fn main() {
    tauri_build::build();
    // The playback worker references Tauri's native event path in library tests too.
    // Give those executables the same Common Controls v6 activation as the app;
    // otherwise TaskDialogIndirect cannot be resolved by the Windows loader.
    if std::env::var("TARGET").is_ok_and(|target| target.ends_with("windows-msvc")) {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
        // Tauri already supplies the app binary's manifest as a compiled resource.
        println!("cargo:rustc-link-arg-bin=annotator-desktop=/MANIFEST:NO");
    }
}
