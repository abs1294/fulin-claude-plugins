# Convert one Word / Excel / PowerPoint file to PDF using the installed Office.
#
# Called by server.js so the page can preview Office files (a browser cannot
# render them itself). The source is opened read-only and never modified.
# Input:  -InB64 / -OutB64 = base64(UTF-8) of the source and target paths
#         (paths are CJK; this console's encoding is not UTF-8).
# Output: one line of JSON, {"ok":true} or {"ok":false,"error":"..."}.
#
# THIS FILE MUST STAY PURE ASCII (Windows PowerShell 5.1 reads a BOM-less
# script as ANSI).
param([string]$InB64, [string]$OutB64)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Out-Result($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); exit 0 }

try {
  $src = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($InB64))
  $dst = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($OutB64))
} catch { Out-Result @{ ok = $false; error = "bad arguments" } }
if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { Out-Result @{ ok = $false; error = "source not found" } }
$ext = [System.IO.Path]::GetExtension($src).ToLowerInvariant()

$app = $null
$doc = $null
try {
  if ($ext -in ".doc", ".docx", ".docm", ".rtf") {
    # Word: every New-Object is its own hidden instance, so quitting it cannot
    # touch a Word window the user has open.
    $app = New-Object -ComObject Word.Application
    $app.Visible = $false
    $app.DisplayAlerts = 0
    # Macros off. A file opened by a program runs its macros without asking unless this is set
    # (the default for automation is "low"), and the file may be an attachment somebody mailed.
    $app.AutomationSecurity = 3   # msoAutomationSecurityForceDisable
    # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles)
    $doc = $app.Documents.Open($src, $false, $true, $false)
    $doc.ExportAsFixedFormat($dst, 17)   # wdExportFormatPDF
    $doc.Close($false)
    $app.Quit()
  } elseif ($ext -in ".xls", ".xlsx", ".xlsm") {
    $app = New-Object -ComObject Excel.Application
    $app.Visible = $false
    $app.DisplayAlerts = $false
    $app.AutomationSecurity = 3   # msoAutomationSecurityForceDisable: macros off, see Word above
    $app.EnableEvents = $false
    # Open(Filename, UpdateLinks, ReadOnly)
    $doc = $app.Workbooks.Open($src, 0, $true)
    $doc.ExportAsFixedFormat(0, $dst)    # xlTypePDF
    $doc.Close($false)
    $app.Quit()
  } elseif ($ext -in ".ppt", ".pptx", ".pptm") {
    # PowerPoint is single-instance: New-Object hands back the one the user
    # may already have open. So it is only quit if it had nothing open before.
    $app = New-Object -ComObject PowerPoint.Application
    $hadOpen = $app.Presentations.Count
    # Macros off while this file is opened; the setting is put back, since this may be the user's own PowerPoint.
    $wasSecurity = $app.AutomationSecurity
    $app.AutomationSecurity = 3          # msoAutomationSecurityForceDisable
    try {
      # Open(FileName, ReadOnly, Untitled, WithWindow)
      $doc = $app.Presentations.Open($src, -1, 0, 0)
      $doc.SaveAs($dst, 32)              # ppSaveAsPDF
      $doc.Close()
    } finally { $app.AutomationSecurity = $wasSecurity }
    if ($hadOpen -eq 0) { $app.Quit() }
  } else {
    Out-Result @{ ok = $false; error = "not an Office file" }
  }
} catch {
  $msg = [string]$_.Exception.Message
  try { if ($doc) { $doc.Close($false) } } catch {}
  try { if ($app -and ($ext -notin ".ppt", ".pptx", ".pptm")) { $app.Quit() } } catch {}
  # Keep the message ASCII-safe for the caller: non-ASCII becomes '?'.
  $safe = -join ($msg.ToCharArray() | ForEach-Object { if ([int]$_ -lt 128) { $_ } else { "?" } })
  Out-Result @{ ok = $false; error = $safe.Substring(0, [Math]::Min(300, $safe.Length)) }
}

if (Test-Path -LiteralPath $dst -PathType Leaf) { Out-Result @{ ok = $true } }
Out-Result @{ ok = $false; error = "no PDF was produced" }
