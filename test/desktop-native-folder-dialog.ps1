param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][ValidateSet('inspect', 'cancel', 'select')][string]$Action,
  [string]$FolderPath = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public sealed class NovelNativeWindowInfo {
  public IntPtr Handle;
  public IntPtr Owner;
  public uint ProcessId;
  public uint OwnerProcessId;
  public string ClassName;
  public string Title;
  public bool Visible;
}
public static class NovelNativeDialogWindow {
  private delegate bool EnumWindowsProc(IntPtr handle, IntPtr state);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr handle, uint command);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder className, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder title, int maxCount);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
  public static NovelNativeWindowInfo[] Enumerate() {
    var result = new List<NovelNativeWindowInfo>();
    EnumWindows((handle, state) => {
      uint processId;
      GetWindowThreadProcessId(handle, out processId);
      var owner = GetWindow(handle, 4);
      uint ownerProcessId = 0;
      if (owner != IntPtr.Zero) GetWindowThreadProcessId(owner, out ownerProcessId);
      var className = new StringBuilder(256);
      var title = new StringBuilder(1024);
      GetClassName(handle, className, className.Capacity);
      GetWindowText(handle, title, title.Capacity);
      result.Add(new NovelNativeWindowInfo { Handle = handle, Owner = owner, ProcessId = processId, OwnerProcessId = ownerProcessId, ClassName = className.ToString(), Title = title.ToString(), Visible = IsWindowVisible(handle) });
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
}
'@

$deadline = [DateTime]::UtcNow.AddSeconds(6)
$dialog = $null
$windowSnapshot = @()
do {
  $windows = [NovelNativeDialogWindow]::Enumerate()
  $windowSnapshot = @($windows | ForEach-Object {
    [pscustomobject]@{
      Name = $_.Title
      ClassName = $_.ClassName
      ProcessId = $_.ProcessId
      OwnerProcessId = $_.OwnerProcessId
      Handle = $_.Handle.ToInt64()
      Visible = $_.Visible
    }
  })
  foreach ($window in $windows) {
    if ($window.Visible -and $window.ClassName -eq '#32770' -and ($window.ProcessId -eq $ProcessId -or $window.OwnerProcessId -eq $ProcessId)) {
      $dialog = [System.Windows.Automation.AutomationElement]::FromHandle($window.Handle)
      break
    }
  }
  if (-not $dialog) { Start-Sleep -Milliseconds 200 }
} while (-not $dialog -and [DateTime]::UtcNow -lt $deadline)

if (-not $dialog) {
  throw "Native folder dialog owned by process $ProcessId was not found. Top-level windows: $($windowSnapshot | ConvertTo-Json -Compress)"
}

if ($Action -eq 'inspect') {
  $controls = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $snapshot = @($controls | ForEach-Object {
    [pscustomobject]@{
      Name = $_.Current.Name
      ClassName = $_.Current.ClassName
      Type = $_.Current.ControlType.ProgrammaticName
      AutomationId = $_.Current.AutomationId
      Enabled = $_.Current.IsEnabled
    }
  })
  [pscustomobject]@{ Name = $dialog.Current.Name; ClassName = $dialog.Current.ClassName; ProcessId = $dialog.Current.ProcessId; Controls = $snapshot } | ConvertTo-Json -Depth 5 -Compress
  exit 0
}

[void][NovelNativeDialogWindow]::SetForegroundWindow([IntPtr]::new($dialog.Current.NativeWindowHandle))
Start-Sleep -Milliseconds 150
if ($Action -eq 'cancel') {
  $cancelLabel = [string]::Concat([char]0x30ad, [char]0x30e3, [char]0x30f3, [char]0x30bb, [char]0x30eb)
  $cancel = $null
  $controls = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($control in $controls) {
    if ($control.Current.ClassName -eq 'Button' -and ($control.Current.Name -eq 'Cancel' -or $control.Current.Name -eq $cancelLabel)) { $cancel = $control; break }
  }
  if (-not $cancel) { throw "Cancel button not found in native dialog '$($dialog.Current.Name)'" }
  try {
    $cancel.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  } catch {
    $cancelHandle = [IntPtr]::new($cancel.Current.NativeWindowHandle)
    if ($cancelHandle -eq [IntPtr]::Zero) { throw }
    [void][NovelNativeDialogWindow]::SendMessage($cancelHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
  }
  [pscustomobject]@{ Action = 'cancel'; Dialog = $dialog.Current.Name } | ConvertTo-Json -Compress
  exit 0
}

if (-not $FolderPath -or -not [System.IO.Directory]::Exists($FolderPath)) {
  throw "Selected test folder does not exist: $FolderPath"
}

[System.Windows.Forms.SendKeys]::SendWait('^l')
Start-Sleep -Milliseconds 250
[System.Windows.Forms.SendKeys]::SendWait($FolderPath)
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 1200

$buttons = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$choose = $null
foreach ($button in $buttons) {
  $label = $button.Current.Name
  $selectFolderLabel = [string]::Concat([char]0x30d5, [char]0x30a9, [char]0x30eb, [char]0x30c0, [char]0x30fc, [char]0x306e, [char]0x9078, [char]0x629e)
  $selectFolderAltLabel = [string]::Concat([char]0x30d5, [char]0x30a9, [char]0x30eb, [char]0x30c0, [char]0x30fc, [char]0x3092, [char]0x9078, [char]0x629e)
  if ($button.Current.ClassName -eq 'Button' -and $button.Current.IsEnabled -and ($label -match '(?i)^(select folder|choose folder|open)$' -or $label -eq $selectFolderLabel -or $label -eq $selectFolderAltLabel)) {
    $choose = $button
    break
  }
}
if (-not $choose) {
  $labels = @($buttons | ForEach-Object { [pscustomobject]@{ Name = $_.Current.Name; Enabled = $_.Current.IsEnabled } })
  throw "Folder confirmation button not found in '$($dialog.Current.Name)': $($labels | ConvertTo-Json -Compress)"
}

$buttonName = $choose.Current.Name
try {
  $choose.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
} catch {
  $chooseHandle = [IntPtr]::new($choose.Current.NativeWindowHandle)
  if ($chooseHandle -eq [IntPtr]::Zero) { throw }
  [void][NovelNativeDialogWindow]::SendMessage($chooseHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
}
[pscustomobject]@{ Action = 'select'; Dialog = $dialog.Current.Name; Button = $buttonName; Folder = $FolderPath } | ConvertTo-Json -Compress
