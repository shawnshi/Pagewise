#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$Serial = '',
    [string]$SdkRoot = (Join-Path $env:LOCALAPPDATA 'Android\Sdk')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'Admission.Common.psm1') -Force -DisableNameChecking
$root = Split-Path $PSScriptRoot -Parent
$report = [ordered]@{ schemaVersion = 1; status = 'FAILED'; readOnly = $true; installed = $false; realDeviceAdmission = 'NOT_PASSED'; checkedAtUtc = [DateTime]::UtcNow.ToString('o') }
$code = 1
$id = ''
try {
    $adb = Join-Path $SdkRoot 'platform-tools/adb.exe'
    $listing = Invoke-CheckedNative $adb @('devices','-l')
    $devices = @(ConvertFrom-AdbDevices $listing -RequireHeader)
    # Do not persist hardware serials or collect book/app/user data.
    $report.deviceCount = $devices.Count
    $report.deviceStates = @($devices | ForEach-Object { $_.State })
    $selected = Select-AdbDevice -Devices $devices -Serial $Serial
    $id = $selected.Serial
    $manufacturer = (Invoke-CheckedNative $adb @('-s',$id,'shell','getprop','ro.product.manufacturer')).Trim()
    $brand = (Invoke-CheckedNative $adb @('-s',$id,'shell','getprop','ro.product.brand')).Trim()
    $model = (Invoke-CheckedNative $adb @('-s',$id,'shell','getprop','ro.product.model')).Trim()
    $abi = (Invoke-CheckedNative $adb @('-s',$id,'shell','getprop','ro.product.cpu.abi')).Trim()
    $apiText = (Invoke-CheckedNative $adb @('-s',$id,'shell','getprop','ro.build.version.sdk')).Trim()
    if ($apiText -notmatch '^\d+$') { throw 'DEVICE_API_INVALID: getprop did not return a numeric SDK value.' }
    $report.device = [ordered]@{ manufacturer = $manufacturer; brand = $brand; model = $model; abi = $abi; api = [int]$apiText }
    Assert-NoteX3Pro -Manufacturer $manufacturer -Brand $brand -Model $model -Abi $abi -Api ([int]$apiText)
    $webview = Invoke-CheckedNative $adb @('-s',$id,'shell','dumpsys','webviewupdate')
    $current = @($webview -split '\r?\n' | Where-Object { $_ -match '^\s*Current WebView package' })
    if ($current.Count -ne 1 -or $current[0] -match '(?i)null|not installed|none') { throw 'WEBVIEW_UNKNOWN: No unique current WebView package was confirmed.' }
    $report.device.webview = $current[0].Trim()
    $report.status = 'DEVICE_METADATA_VERIFIED'
    $report.remaining = @('Metadata only: original APK startup, actual EPUB rendering, refresh and suspend/resume are NOT tested.','No install, launch, uninstall, data clear, private-file scan, screenshot or book access is performed by this script.','Use docs/device-admission.md for the remaining human-observed gate.')
    $code = 0
} catch {
    $report.error = $_.Exception.Message
    foreach ($privateSerial in @($Serial,$id)) { if ($privateSerial) { $report.error = $report.error.Replace($privateSerial,'<device>') } }
    if ($report.error -match '^DEVICE_(NONE|NOT_FOUND|AMBIGUOUS|UNAVAILABLE|VENDOR_MISMATCH|MODEL_MISMATCH|ABI_MISMATCH|API_CHANGED):|^WEBVIEW_UNKNOWN:') {
        $report.status = 'BLOCKED'
        $code = 2
    }
}
Write-AdmissionReport $report (Join-Path $root 'artifacts/diagnostics') 'device'
exit $code
