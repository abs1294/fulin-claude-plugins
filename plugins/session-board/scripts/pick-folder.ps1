# Show the Windows folder picker and print the chosen path.
#
# Called by server.js. A web page cannot learn an absolute path from the
# browser's own picker, so the server asks Windows instead.
# Input:  -TitleB64 = base64(UTF-8) of the dialog title.
# Output: one line, base64(UTF-8) of the chosen path; an empty line if cancelled.
# Base64 both ways because paths and the title are CJK and this console's
# encoding is not UTF-8.
#
# THIS FILE MUST STAY PURE ASCII (Windows PowerShell 5.1 reads a BOM-less
# script as ANSI).
#
# Uses IFileOpenDialog (the modern Explorer-style picker) rather than
# FolderBrowserDialog (the small tree from Windows 2000).
#
# -StartB64  base64(UTF-8) of the folder the window opens in (from the board's
#            config.json). Optional; a folder that cannot be opened is ignored.
# -DryRun    set everything up, report the folder the window WOULD open in, and
#            exit without showing it. For checking the start folder unattended.
param([string]$TitleB64, [string]$StartB64, [switch]$DryRun)

$ErrorActionPreference = "Stop"
$title = "Select a folder"
try { if ($TitleB64) { $title = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TitleB64)) } } catch {}
$start = ""
try { if ($StartB64) { $start = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($StartB64)) } } catch {}

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SbPick {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW {}

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  // Method order is the COM vtable order (IModalWindow.Show, then IFileDialog). Do not reorder.
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr hwndOwner);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
  }

  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  // Windows lets a process take the foreground only right after a key press of its own: a tap of F24 (pressed and
  // released; a key no keyboard has and no program uses - Alt, the usual one, opens the menu of the program in front)
  // is that press. Without it the window opened behind or without the keyboard (seen 2026-11-19: the foreground
  // stayed on another program all the time the picker was open).
  public static void TakeForeground(IntPtr h) {
    keybd_event(0x87, 0, 0, UIntPtr.Zero);       // VK_F24 down
    keybd_event(0x87, 0, 2, UIntPtr.Zero);       // VK_F24 up (KEYEVENTF_KEYUP)
    SetForegroundWindow(h);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

  static string PathOf(IShellItem item) { string p; item.GetDisplayName(0x80058000, out p); return p ?? ""; }

  // start: folder to open in ("" = wherever Windows last left this window).
  // dryRun: do not show the window; return the folder it would open in.
  public static string Pick(IntPtr owner, string title, string start, bool dryRun) {
    IFileDialog d = (IFileDialog)new FileOpenDialogRCW();
    uint o;
    d.GetOptions(out o);
    d.SetOptions(o | 0x20 | 0x40);   // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
    d.SetTitle(title);
    if (!string.IsNullOrEmpty(start)) {
      try {
        Guid iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");   // IShellItem
        IShellItem folder;
        SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out folder);
        d.SetFolder(folder);   // SetFolder, not SetDefaultFolder: open here every time, not only the first
      } catch (Exception) { }   // a start folder that cannot be opened is not worth failing over
    }
    if (dryRun) { try { IShellItem cur; d.GetFolder(out cur); return PathOf(cur); } catch (Exception) { return ""; } }
    if (d.Show(owner) != 0) return "";   // cancelled
    IShellItem item;
    d.GetResult(out item);
    string path;
    item.GetDisplayName(0x80058000, out path);   // SIGDN_FILESYSPATH
    return path ?? "";
  }
}
"@

if ($DryRun) {
  $would = [SbPick]::Pick([IntPtr]::Zero, $title, $start, $true)
  [Console]::Out.WriteLine([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$would)))
  exit 0
}

# An always-on-top owner, so the dialog opens above the browser instead of behind it. Not see-through (Opacity 0
# makes it a layered window, and a dialog owned by one was seen to flicker, 2026-11-19): a borderless 1x1 window
# at the middle of the screen instead - one pixel, and the dialog opens centred on it, where it opened before (off
# the screen, the dialog would follow it there). Then the owner takes the foreground, and the dialog opens with it.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = "None"
$owner.StartPosition = "Manual"
$owner.Size = New-Object System.Drawing.Size(1, 1)
# The dialog opens with its top left corner at the owner (measured 2026-11-19: owner at the screen's middle put the
# dialog's corner there, the dialog in the lower right). So the owner stands half a dialog (about 850 x 480) up and
# left of the middle, and the dialog comes out centred.
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$x = [int]($area.X + [Math]::Max(0, ($area.Width - 850) / 2))
$y = [int]($area.Y + [Math]::Max(0, ($area.Height - 480) / 2))
$owner.Location = New-Object System.Drawing.Point($x, $y)
$owner.Show()
[SbPick]::TakeForeground($owner.Handle)
$owner.Activate()
$picked = ""
try { $picked = [SbPick]::Pick($owner.Handle, $title, $start, $false) } finally { $owner.Close() }

[Console]::Out.WriteLine([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$picked)))
exit 0
