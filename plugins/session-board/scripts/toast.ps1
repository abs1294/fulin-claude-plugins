param([string]$TitleB64 = '', [string]$MsgB64 = '', [string]$Sid = '', [string]$Scheme = 'sessionboard')
# Shows one Windows toast. Title and message arrive as base64 of UTF-8 so that
# this file can stay pure ASCII (Windows PowerShell reads a script without a
# byte-order mark in the system code page, which would garble any other text).
# Clicking the toast opens "<Scheme>:<Sid>", which the board registers to
# itself (lib/notify.js). One toast per session: a new one replaces the last.
$ErrorActionPreference = 'SilentlyContinue'
function FromB64([string]$s) { if (-not $s) { return '' }; try { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) } catch { return '' } }
$title = FromB64 $TitleB64
$msg = FromB64 $MsgB64
if (-not $title) { $title = 'Claude Code' }
if ($Sid -notmatch '^[0-9a-fA-F-]{8,64}$') { $Sid = '' }
$AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
  $launch = ''
  if ($Sid) { $launch = " activationType='protocol' launch='" + $Scheme + ':' + $Sid + "'" }
  $xmlText = "<toast$launch><visual><binding template='ToastGeneric'><text>" + (& $esc $title) + "</text><text>" + (& $esc $msg) + "</text></binding></visual></toast>"
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($xmlText)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  if ($Sid) { $toast.Tag = $Sid.Substring(0, [Math]::Min(64, $Sid.Length)); $toast.Group = 'session-board' }
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AUMID).Show($toast)
  'shown'
} catch { 'failed: ' + $_.Exception.Message }
