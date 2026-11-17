# Bring the Windows Terminal window of one Claude session to the foreground.
#
# Called by server.js. Input: -Payload = base64(UTF-8 JSON {"titles":["...", ...]}),
# the texts that window's title could be, most trusted first. Base64 because the
# titles are CJK with commas and quotes, which do not survive argument quoting.
# Output: one line of JSON on stdout, ASCII only (window classes and process
# names, never window titles).
#
# THIS FILE MUST STAY PURE ASCII. Windows PowerShell 5.1 reads a script without
# a BOM as ANSI, so a literal non-ASCII character here would be mangled. The
# ellipsis is therefore built from its code point below.
#
# Why title matching: every Windows Terminal window belongs to the single
# WindowsTerminal.exe process, so a PID cannot tell them apart. Claude Code keeps
# the window title equal to the session's title, so the text identifies it.
#
# Modes:
#   focus (default)  find the window by title and bring it to the front
#   find             find it and report its handle, without touching it.
#                    With -ProcId N the window is first looked up through the
#                    console that process sits in, which needs no title at all:
#                    a session that has not been given a prompt yet has no
#                    title to match (measured 2026-11-15, its window was left
#                    open). Titles are only the fallback then.
#   close -Hwnd N    ask that window to close (WM_CLOSE). Used after a session
#                    was moved to the board, when the pane only shows "process
#                    exited". A window with several tabs asks the user first;
#                    that is Windows Terminal's own confirmation.
param([string]$Payload, [string]$Mode = "focus", [string]$Hwnd = "", [string]$ProcId = "")

$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Out-Result($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  exit 0
}

$titles = @()
if ($Mode -ne "close") {
  try {
    $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))
    $titles = @((ConvertFrom-Json $json).titles | Where-Object { $_ })
  } catch {
    Out-Result @{ state = "error"; error = "bad payload" }
  }
}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SbFocus {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
}
"@

if ($Mode -eq "close") {
  # Only ever a Windows Terminal window: the class is checked on the handle
  # itself, so a stale or wrong number cannot close some other program.
  $n = [long]0
  if (-not [long]::TryParse($Hwnd, [ref]$n) -or $n -le 0) { Out-Result @{ state = "error"; error = "bad handle" } }
  $h = [IntPtr]$n
  if (-not [SbFocus]::IsWindow($h)) { Out-Result @{ state = "gone" } }
  $cls = New-Object System.Text.StringBuilder 256
  [void][SbFocus]::GetClassName($h, $cls, 256)
  if ($cls.ToString() -ne "CASCADIA_HOSTING_WINDOW_CLASS") { Out-Result @{ state = "error"; error = "not a terminal window" } }
  [void][SbFocus]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)   # WM_CLOSE
  Start-Sleep -Milliseconds 600
  Out-Result @{ state = "closed"; stillOpen = [bool][SbFocus]::IsWindow($h) }
}

function Test-Terminal([IntPtr]$hw) {
  if ($hw -eq [IntPtr]::Zero) { return $false }
  $c = New-Object System.Text.StringBuilder 256
  [void][SbFocus]::GetClassName($hw, $c, 256)
  return $c.ToString() -eq "CASCADIA_HOSTING_WINDOW_CLASS"
}

# The terminal window a process lives in, by way of its console: the console's
# own (hidden) window is owned by the Windows Terminal window that hosts it.
if ($Mode -eq "find" -and $ProcId) {
  $n = [uint32]0
  if ([uint32]::TryParse($ProcId, [ref]$n) -and $n -gt 0) {
    [void][SbFocus]::FreeConsole()
    if ([SbFocus]::AttachConsole($n)) {
      $c = [SbFocus]::GetConsoleWindow()
      [void][SbFocus]::FreeConsole()
      foreach ($h in @([SbFocus]::GetAncestor($c, 3), [SbFocus]::GetWindow($c, 4), [SbFocus]::GetParent($c), [SbFocus]::GetAncestor($c, 2))) {
        if (Test-Terminal $h) { Out-Result @{ state = "hit"; hwnd = $h.ToInt64(); by = "console" } }
      }
    }
  }
}
if ($titles.Count -eq 0) { Out-Result @{ state = "none"; windows = 0; reason = "no title known for this session" } }

$wins = New-Object System.Collections.ArrayList
$cb = [SbFocus+EnumProc]{
  param($h, $l)
  if ([SbFocus]::IsWindowVisible($h)) {
    $cls = New-Object System.Text.StringBuilder 256
    [void][SbFocus]::GetClassName($h, $cls, 256)
    if ($cls.ToString() -eq "CASCADIA_HOSTING_WINDOW_CLASS") {
      $len = [SbFocus]::GetWindowTextLength($h)
      $t = ""
      if ($len -gt 0) { $sb = New-Object System.Text.StringBuilder ($len + 1); [void][SbFocus]::GetWindowText($h, $sb, $len + 1); $t = $sb.ToString() }
      [void]$wins.Add([PSCustomObject]@{ hwnd = $h; title = $t })
    }
  }
  return $true
}
[void][SbFocus]::EnumWindows($cb, [IntPtr]::Zero)

$ellipsis = [string][char]0x2026
function Normalize([string]$s) {
  # Drop the leading status glyph (anything that is not a letter or digit) and
  # a trailing ellipsis: Windows Terminal truncates long titles.
  $x = $s -replace '^[^\p{L}\p{N}]+', ''
  $x = $x -replace ("[." + $ellipsis + "]+$"), ''
  return $x.Trim()
}

# hit / none / ambiguous. Compares the first 20 characters (titles are
# truncated, so more is not available), then ranks candidates by how many
# leading characters really agree. A tie is refused: focusing the wrong window
# is worse than focusing none.
#
# A window whose whole title equals the target wins outright, before any prefix
# comparison: without this a short title (under the 6-character floor below)
# could never be reached, and "fix login bug" tied with "fix login bug in admin
# page" because the score is capped at the shorter length.
function Find-Window([string]$target) {
  $exact = @($wins | Where-Object { (Normalize $_.title) -eq $target })
  if ($exact.Count -eq 1) { return [PSCustomObject]@{ state = "hit"; win = $exact[0] } }
  if ($exact.Count -gt 1) { return [PSCustomObject]@{ state = "ambiguous"; win = $null } }
  $cands = @()
  foreach ($w in $wins) {
    $wt = Normalize $w.title
    if (-not $wt) { continue }
    $n = [Math]::Min(20, [Math]::Min($wt.Length, $target.Length))
    if ($n -lt 6) { continue }
    if ($target.Substring(0, $n) -ne $wt.Substring(0, $n)) { continue }
    $max = [Math]::Min($wt.Length, $target.Length)
    $score = 0
    while ($score -lt $max -and $target[$score] -eq $wt[$score]) { $score++ }
    $cands += [PSCustomObject]@{ win = $w; score = $score }
  }
  if ($cands.Count -eq 0) { return [PSCustomObject]@{ state = "none"; win = $null } }
  if ($cands.Count -eq 1) { return [PSCustomObject]@{ state = "hit"; win = $cands[0].win } }
  $sorted = $cands | Sort-Object -Property score -Descending
  if ($sorted[0].score -gt $sorted[1].score) { return [PSCustomObject]@{ state = "hit"; win = $sorted[0].win } }
  return [PSCustomObject]@{ state = "ambiguous"; win = $null }
}

# Try every candidate title before giving up: one being ambiguous says nothing
# about the next. Only when none of them yields a single window is the result
# "ambiguous" (some title matched several windows) or "none".
$hit = $null
$matchedBy = -1
$sawAmbiguous = $false
for ($i = 0; $i -lt $titles.Count; $i++) {
  $t = Normalize ([string]$titles[$i])
  if (-not $t) { continue }
  $r = Find-Window $t
  if ($r.state -eq "hit") { $hit = $r.win; $matchedBy = $i; break }
  if ($r.state -eq "ambiguous") { $sawAmbiguous = $true }
}
if (-not $hit) {
  if ($sawAmbiguous) { Out-Result @{ state = "ambiguous"; windows = $wins.Count } }
  Out-Result @{ state = "none"; windows = $wins.Count; reason = "no window title matched" }
}

if ($Mode -eq "find") { Out-Result @{ state = "hit"; hwnd = $hit.hwnd.ToInt64(); windows = $wins.Count; matchedBy = $matchedBy } }

function Describe-Window([IntPtr]$hw) {
  if ($hw -eq [IntPtr]::Zero) { return "none" }
  $c = New-Object System.Text.StringBuilder 256
  [void][SbFocus]::GetClassName($hw, $c, 256)
  $wpid = [uint32]0
  [void][SbFocus]::GetWindowThreadProcessId($hw, [ref]$wpid)
  $pn = "?"
  try { $pn = (Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch {}
  return "$($c.ToString())/$pn"
}

$h = $hit.hwnd
$iconic = [SbFocus]::IsIconic($h)
$beforeH = [SbFocus]::GetForegroundWindow()
$before = Describe-Window $beforeH
$alreadyFront = ($beforeH.ToInt64() -eq $h.ToInt64())

if ($iconic) { [void][SbFocus]::ShowWindow($h, 9) }
# A tap on Alt lifts Windows' foreground lock for this process.
[SbFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[SbFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
$ok = [SbFocus]::SetForegroundWindow($h)
[void][SbFocus]::BringWindowToTop($h)
Start-Sleep -Milliseconds 200
$nowH = [SbFocus]::GetForegroundWindow()

Out-Result @{
  state = "hit"
  focused = ($nowH.ToInt64() -eq $h.ToInt64())
  setForeground = [bool]$ok
  alreadyFront = [bool]$alreadyFront
  iconic = [bool]$iconic
  matchedBy = $matchedBy
  windows = $wins.Count
  before = $before
  after = (Describe-Window $nowH)
}
