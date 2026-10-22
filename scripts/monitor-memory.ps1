param([int]$RootProcess, [string]$Output, [string]$StopFile)
$samples = [System.Collections.Generic.List[object]]::new()
while (!(Test-Path -LiteralPath $StopFile)) {
    $all = Get-CimInstance Win32_Process
    $ids = [System.Collections.Generic.List[int]]::new(); $ids.Add($RootProcess)
    for ($i=0; $i -lt $ids.Count; $i++) { foreach ($child in $all | Where-Object ParentProcessId -EQ $ids[$i]) { $ids.Add([int]$child.ProcessId) } }
    $processes = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) })
    $native = $processes | Where-Object ProcessId -EQ $RootProcess
    $samples.Add(@{ utc=[DateTime]::UtcNow.ToString('o'); nativeWorkingSet=[long]$native.WorkingSetSize; treeWorkingSet=[long](($processes | Measure-Object WorkingSetSize -Sum).Sum); processes=@($processes | ForEach-Object { @{ id=$_.ProcessId; name=$_.Name; bytes=[long]$_.WorkingSetSize } }) })
    Start-Sleep -Milliseconds 1000
}
$samples | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 -LiteralPath $Output
