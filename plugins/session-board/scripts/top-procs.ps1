param([int]$WaitMs = 1500)
# Every process twice, WaitMs apart: {a: [[pid, parent, name, memory, cpu (100 ns), started (ms)]], b: {pid: cpu}, ms}. As base64 of UTF-8
# JSON on one line (the console code page would damage a name).
$ErrorActionPreference = 'SilentlyContinue'
$q = 'SELECT ProcessId, ParentProcessId, Name, WorkingSetSize, KernelModeTime, UserModeTime, CreationDate FROM Win32_Process'
$a = @(Get-CimInstance -Query $q)
$t = [Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Milliseconds $WaitMs
$b = @{}
foreach ($x in (Get-CimInstance -Query 'SELECT ProcessId, KernelModeTime, UserModeTime FROM Win32_Process')) { $b[[string]$x.ProcessId] = [int64]$x.KernelModeTime + [int64]$x.UserModeTime }
$ms = $t.ElapsedMilliseconds
$zero = [datetime]::new(1970, 1, 1, 0, 0, 0, 'Utc')
$rows = foreach ($x in $a) { , @([int]$x.ProcessId, [int]$x.ParentProcessId, [string]$x.Name, [int64]$x.WorkingSetSize, ([int64]$x.KernelModeTime + [int64]$x.UserModeTime), $(if ($x.CreationDate) { [int64](($x.CreationDate.ToUniversalTime() - $zero).TotalMilliseconds) } else { 0 })) }
$json = @{ a = @($rows); b = $b; ms = $ms } | ConvertTo-Json -Compress -Depth 4
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
