param([string]$Pids = '')
# Prints the command line of each given claude process, as base64 of a UTF-8
# JSON object {pid: commandLine}. Base64 because the text can hold any
# character and the console code page would damage it.
$ErrorActionPreference = 'SilentlyContinue'
$out = @{}
foreach ($p in ($Pids -split ',')) {
  if ($p -match '^\d+$') {
    $x = Get-CimInstance Win32_Process -Filter "ProcessId=$p"
    if ($x -and $x.Name -match '^claude' -and $x.CommandLine) { $out[$p] = [string]$x.CommandLine }
  }
}
$json = if ($out.Count) { $out | ConvertTo-Json -Compress } else { '{}' }
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
