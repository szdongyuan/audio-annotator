param([string]$TauriDriver = '', [string]$EdgeDriver = '', [string]$WebViewVersion = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$toolsRoot = Join-Path $root '.tools'
New-Item -ItemType Directory -Force $toolsRoot | Out-Null
if (!$WebViewVersion) {
    $runtime = Get-ChildItem "${env:ProgramFiles(x86)}/Microsoft/EdgeWebView/Application" -Directory | Where-Object Name -Match '^\d+\.\d+\.\d+\.\d+$' | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if (!$runtime) { throw 'WebView2 runtime missing; install Microsoft WebView2 first.' }
    $WebViewVersion = $runtime.Name
}
if (!$TauriDriver) {
    $install = Join-Path $toolsRoot 'tauri-driver'
    $TauriDriver = Join-Path $install 'bin/tauri-driver.exe'
    if (!(Test-Path -LiteralPath $TauriDriver)) {
        & cargo install tauri-driver --version 2.1.0 --locked --root $install
        if ($LASTEXITCODE) { throw 'Official crates.io tauri-driver installation failed.' }
    }
}
if (!$EdgeDriver) {
    $dir = Join-Path $toolsRoot 'edgedriver'
    $EdgeDriver = Join-Path $dir 'msedgedriver.exe'
    if (!(Test-Path -LiteralPath $EdgeDriver) -or !((& $EdgeDriver --version) -match [regex]::Escape($WebViewVersion))) {
        New-Item -ItemType Directory -Force $dir | Out-Null
        $url = "https://msedgedriver.microsoft.com/$WebViewVersion/edgedriver_win64.zip"
        $zip = Join-Path $dir 'driver.zip'
        Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 180
        Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
    }
}
$version = & $EdgeDriver --version
if ($LASTEXITCODE -or !($version -match [regex]::Escape($WebViewVersion))) { throw "EdgeDriver must match WebView2 $WebViewVersion; found $version" }
$signature = Get-AuthenticodeSignature -LiteralPath $EdgeDriver
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'Microsoft EdgeDriver signature validation failed.' }
$driverHelp = & $TauriDriver --help
if ($LASTEXITCODE) { throw 'tauri-driver is not executable.' }
$installed = & cargo install --list --root (Join-Path $toolsRoot 'tauri-driver')
$record = @{ tauriDriver = (Resolve-Path $TauriDriver).Path; edgeDriver = (Resolve-Path $EdgeDriver).Path; tauriVersion = ($installed | Select-Object -First 1); helpVerified = [bool]($driverHelp -match 'USAGE'); webViewVersion = $WebViewVersion; edgeVersion = $version; edgeSha256 = (Get-FileHash $EdgeDriver -Algorithm SHA256).Hash; signature = [string]$signature.Status; source = "https://msedgedriver.microsoft.com/$WebViewVersion/edgedriver_win64.zip" }
$record | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $toolsRoot 'webdriver.json')
$record | ConvertTo-Json
