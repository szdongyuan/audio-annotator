param(
    [Parameter(Mandatory)][int]$AppProcess,
    [ValidateSet('dump','click','keys','point','context','drag','picker','screenshot')][string]$Action = 'dump',
    [string]$Name = '', [string]$Keys = '', [string]$PathValue = '', [string]$Output = '',
    [int]$X = 0, [int]$Y = 0, [int]$EndX = 0, [int]$EndY = 0
)
# This helper only operates the explicitly owned release executable in this checkout.
# UIAutomation locates controls; input is delivered by real Win32 pointer/keyboard.
$ErrorActionPreference = 'Stop'
$expected = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../target/release/annotator-desktop.exe'))
$process = Get-Process -Id $AppProcess
if ($process.Path -ne $expected) { throw 'PID is not this checkout release executable' }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class ReleaseInput {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int command);
 [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a,uint b,bool attach);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flag);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr extra);
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h,EnumProc f,IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,string text);
}
'@
if ($Action -ne 'dump') { [ReleaseInput]::ShowWindow($process.MainWindowHandle,9) | Out-Null; Start-Sleep -Milliseconds 150 }
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$AppProcess)
$windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
$nodes = [System.Collections.Generic.List[object]]::new()
foreach ($window in $windows) { $nodes.Add($window); foreach ($node in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)) { $nodes.Add($node) } }
if ($Action -eq 'dump') {
    @($nodes | ForEach-Object { if ($_.Current.Name) { $r=$_.Current.BoundingRectangle; [pscustomobject]@{Name=$_.Current.Name;Type=$_.Current.ControlType.ProgrammaticName;Id=$_.Current.AutomationId;Enabled=$_.Current.IsEnabled;Offscreen=$_.Current.IsOffscreen;Rect=@($r.X,$r.Y,$r.Width,$r.Height)} } }) | ConvertTo-Json -Depth 4
    exit
}
function Assert-Foreground {
    [uint32]$foreground=0
    [ReleaseInput]::GetWindowThreadProcessId([ReleaseInput]::GetForegroundWindow(),[ref]$foreground) | Out-Null
    if ($foreground -ne $AppProcess) { throw "Refusing input: foreground $foreground is not owned PID $AppProcess" }
}
# A modal native picker may own the foreground. Keep that handle when already owned.
[uint32]$foreground=0
$thread=[ReleaseInput]::GetWindowThreadProcessId([ReleaseInput]::GetForegroundWindow(),[ref]$foreground)
if ($foreground -ne $AppProcess) {
    $self=[ReleaseInput]::GetCurrentThreadId(); [ReleaseInput]::AttachThreadInput($thread,$self,$true) | Out-Null
    try { [ReleaseInput]::BringWindowToTop($process.MainWindowHandle) | Out-Null; [ReleaseInput]::SetForegroundWindow($process.MainWindowHandle) | Out-Null; [ReleaseInput]::SetFocus($process.MainWindowHandle) | Out-Null }
    finally { [ReleaseInput]::AttachThreadInput($thread,$self,$false) | Out-Null }
}
Assert-Foreground
function Move-Owned([int]$px,[int]$py) {
    $p=[ReleaseInput+Point]::new(); $p.X=$px; $p.Y=$py
    $root=[ReleaseInput]::GetAncestor([ReleaseInput]::WindowFromPoint($p),2)
    [uint32]$owner=0; [ReleaseInput]::GetWindowThreadProcessId($root,[ref]$owner) | Out-Null
    if ($owner -ne $AppProcess) { throw "Pointer target belongs to PID $owner, not owned PID $AppProcess" }
    Assert-Foreground; [ReleaseInput]::SetCursorPos($px,$py) | Out-Null
}
if ($Action -eq 'keys') { [System.Windows.Forms.SendKeys]::SendWait($Keys); exit }
if ($Action -eq 'picker') {
    if (!$PathValue) { throw 'Picker path required' }
    $script:changed=0
    # Standard native file/folder picker edit IDs, scoped to this process window tree.
    foreach ($window in $nodes | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window -and $_.Current.IsEnabled -and $_.Current.NativeWindowHandle -ne 0 }) {
        [ReleaseInput]::EnumChildWindows([IntPtr]$window.Current.NativeWindowHandle,{param($child,$unused)
            $class=[Text.StringBuilder]::new(256); [ReleaseInput]::GetClassName($child,$class,256) | Out-Null
            if ($class.ToString() -eq 'Edit' -and [ReleaseInput]::GetDlgCtrlID($child) -in @(1148,1152,1001)) { [ReleaseInput]::SendMessage($child,12,[IntPtr]::Zero,$PathValue) | Out-Null; $script:changed++ }
            return $true
        },[IntPtr]::Zero) | Out-Null
    }
    if (!$script:changed) { throw 'No native picker edit found' }; "Set $script:changed native picker edit control(s)"; exit
}
$main=$windows | Where-Object { $_.Current.NativeWindowHandle -eq $process.MainWindowHandle } | Select-Object -First 1
if (!$main) { throw 'Owned main window unavailable' }
$r=$main.Current.BoundingRectangle
if ($Action -eq 'screenshot') {
    if (!$Output) { throw 'Screenshot output path required' }
    $bitmap=[Drawing.Bitmap]::new([int]$r.Width,[int]$r.Height); $graphics=[Drawing.Graphics]::FromImage($bitmap)
    try { $graphics.CopyFromScreen([int]$r.X,[int]$r.Y,0,0,$bitmap.Size); $bitmap.Save($Output,[Drawing.Imaging.ImageFormat]::Png) }
    finally { $graphics.Dispose(); $bitmap.Dispose() }; exit
}
if ($Action -eq 'click') {
    $element=$nodes | Where-Object { $_.Current.Name -eq $Name -and $_.Current.IsEnabled -and !$_.Current.IsOffscreen } | Select-Object -First 1
    if (!$element) { throw "No visible enabled control '$Name'" }
    $b=$element.Current.BoundingRectangle; $px=[int]($b.X+$b.Width/2); $py=[int]($b.Y+$b.Height/2)
} else {
    if ($X -lt 0 -or $Y -lt 0 -or $X -ge $r.Width -or $Y -ge $r.Height) { throw 'Point outside owned main window' }
    $px=[int]$r.X+$X; $py=[int]$r.Y+$Y
}
Move-Owned $px $py; Start-Sleep -Milliseconds 80
$down=if($Action -eq 'context'){8}else{2}; $up=if($Action -eq 'context'){16}else{4}
[ReleaseInput]::mouse_event($down,0,0,0,[UIntPtr]::Zero)
try {
    if ($Action -eq 'drag') {
        if ($EndX -lt 0 -or $EndY -lt 0 -or $EndX -ge $r.Width -or $EndY -ge $r.Height) { throw 'Drag end outside owned window' }
        for ($i=1;$i -le 12;$i++) { Move-Owned ([int]($px+($EndX-$X)*$i/12)) ([int]($py+($EndY-$Y)*$i/12)); Start-Sleep -Milliseconds 25 }
    }
} finally { [ReleaseInput]::mouse_event($up,0,0,0,[UIntPtr]::Zero) }
