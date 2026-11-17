# Shows a file (selected) or a folder in File Explorer, and brings that Explorer window to the front.
#
# The board runs in the background, and Windows does not let a background program put a window it starts in
# front of what you are working in: Explorer opened, but behind the browser. So the window is looked for once it
# exists (by the folder it shows) and raised the same way scripts/focus-window.ps1 raises a terminal window.
#
#   -PathB64  the path, UTF-8 then base64 (a path may hold characters a command line would mangle)
# Prints one line of JSON: {state: "front" | "opened" | "failed", hwnd, reason}
#   front   the window is in front      opened  Explorer was started but its window could not be raised
param([string]$PathB64)
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
function Out-Result($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); exit 0 }
try {
  $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PathB64))
  if (-not (Test-Path -LiteralPath $path)) { Out-Result @{ state = "failed"; reason = "not found" } }
  $isFolder = (Get-Item -LiteralPath $path -Force).PSIsContainer
  $folder = if ($isFolder) { $path } else { [IO.Path]::GetDirectoryName($path) }   # (Split-Path cannot take -LiteralPath together with -Parent in Windows PowerShell 5.1)
  $folder = $folder.TrimEnd('\')

  Add-Type @"
using System; using System.Runtime.InteropServices;
public static class SbReveal {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
  $shell = New-Object -ComObject Shell.Application
  # The Explorer windows there are, as {hwnd, folder}. A window that is not showing a folder of the disk has no path.
  function Get-Explorers {
    $out = @()
    foreach ($w in @($shell.Windows())) {
      try { $p = [string]$w.Document.Folder.Self.Path; if ($p) { $out += [PSCustomObject]@{ hwnd = [int64]$w.HWND; folder = $p.TrimEnd('\') } } } catch {}
    }
    return $out
  }
  $before = @(Get-Explorers | ForEach-Object { $_.hwnd })

  if ($isFolder) { Start-Process explorer.exe -ArgumentList ('"' + $path + '"') }
  else { Start-Process explorer.exe -ArgumentList ('/select,"' + $path + '"') }

  # Its window: one that was not there before and shows this folder; failing that (Explorer reused a window) any that shows it.
  $hit = $null
  for ($i = 0; $i -lt 30 -and -not $hit; $i++) {
    Start-Sleep -Milliseconds 150
    $now = @(Get-Explorers | Where-Object { $_.folder -ieq $folder })
    $hit = $now | Where-Object { $before -notcontains $_.hwnd } | Select-Object -First 1
    if (-not $hit -and $i -ge 12) { $hit = $now | Select-Object -First 1 }
  }
  if (-not $hit) { Out-Result @{ state = "opened"; reason = "its window was not found" } }

  $h = [IntPtr]$hit.hwnd
  if ([SbReveal]::IsIconic($h)) { [void][SbReveal]::ShowWindow($h, 9) }
  # A press and release of Alt: after it Windows lets this process set the foreground window.
  [SbReveal]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [SbReveal]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][SbReveal]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 120
  $front = ([SbReveal]::GetForegroundWindow().ToInt64() -eq $hit.hwnd)
  Out-Result @{ state = $(if ($front) { "front" } else { "opened" }); hwnd = $hit.hwnd; reason = $(if ($front) { "" } else { "Windows did not let it come to the front" }) }
} catch {
  Out-Result @{ state = "failed"; reason = ([string]$_.Exception.Message).Substring(0, [Math]::Min(160, ([string]$_.Exception.Message).Length)) }
}
