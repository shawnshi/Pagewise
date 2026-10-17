#requires -Version 7.0
# Pure fixtures only: no ADB/device/network/book/credential access.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts/Admission.Common.psm1') -Force -DisableNameChecking
$script:passed = 0
$script:failed = 0
function Test-Case([string]$Name, [scriptblock]$Run) {
    try { & $Run; $script:passed++; Write-Output "PASS $Name" }
    catch { $script:failed++; Write-Output "FAIL $Name :: $($_.Exception.Message)" }
}
function Assert-True([bool]$Value) { if (-not $Value) { throw 'Assertion failed' } }
function Assert-Throws([scriptblock]$Run, [string]$Id) {
    $caught = $null
    try { & $Run } catch { $caught = $_.Exception.Message }
    if (-not $caught -or $caught -notmatch ('^' + [regex]::Escape($Id) + ':')) { throw "Expected $Id, observed '$caught'" }
}
function New-Metadata([string]$Package = 'io.pagewise.reader', [string]$Permissions = '') {
    $badging = "package: name='$Package' versionCode='1' versionName='1.15.0'`nsdkVersion:'24'`ntargetSdkVersion:'36'`nnative-code: 'arm64-v8a'"
    ConvertFrom-ApkMetadata $badging $Permissions
}
Test-Case 'Empty ADB output does not invent a device' {
    $items = @(ConvertFrom-AdbDevices "List of devices attached`n`n")
    Assert-True ($items.Count -eq 0)
    Assert-Throws { Select-AdbDevice -Devices $items } 'DEVICE_NONE'
}
Test-Case 'Malformed or empty ADB transport output is not no-device evidence' {
    Assert-Throws { ConvertFrom-AdbDevices '' -RequireHeader } 'ADB_LIST_INVALID'
    Assert-Throws { ConvertFrom-AdbDevices 'unexpected adapter output' -RequireHeader } 'ADB_LIST_INVALID'
    $items = @(ConvertFrom-AdbDevices "List of devices attached`n`n" -RequireHeader)
    Assert-True ($items.Count -eq 0)
}
Test-Case 'ADB states parse without storing diagnostic chatter' {
    $items = @(ConvertFrom-AdbDevices "* daemon started successfully *`nList of devices attached`nsynthetic1`tdevice product:test`nsynthetic2`tunauthorized`nsynthetic3`toffline")
    Assert-True ($items.Count -eq 3 -and $items[0].State -eq 'device' -and $items[1].State -eq 'unauthorized' -and $items[2].State -eq 'offline')
}
Test-Case 'Multiple devices require explicit selection' {
    $items = @(ConvertFrom-AdbDevices "a device`nb device")
    Assert-Throws { Select-AdbDevice -Devices $items } 'DEVICE_AMBIGUOUS'
    Assert-True ((Select-AdbDevice -Devices $items -Serial 'b').Serial -eq 'b')
}
Test-Case 'Unauthorized device never passes' {
    Assert-Throws { Select-AdbDevice -Devices @(ConvertFrom-AdbDevices 'a unauthorized') } 'DEVICE_UNAVAILABLE'
}
Test-Case 'Offline device never passes' {
    Assert-Throws { Select-AdbDevice -Devices @(ConvertFrom-AdbDevices 'a offline') } 'DEVICE_UNAVAILABLE'
}
Test-Case 'Requested missing device is distinct from no devices' {
    Assert-Throws { Select-AdbDevice -Devices @(ConvertFrom-AdbDevices 'a device') -Serial 'missing' } 'DEVICE_NOT_FOUND'
}
Test-Case 'Both Android 12 API levels accepted for known target' {
    Assert-NoteX3Pro 'ONYX' 'ONYX' 'NoteX3Pro' 'arm64-v8a' 31
    Assert-NoteX3Pro 'Onyx' 'BOOX' 'Note X3 Pro' 'arm64-v8a' 32
}
Test-Case 'Wrong vendor, model, ABI and changed OS rejected separately' {
    Assert-Throws { Assert-NoteX3Pro 'other' 'other' 'NoteX3Pro' 'arm64-v8a' 31 } 'DEVICE_VENDOR_MISMATCH'
    Assert-Throws { Assert-NoteX3Pro 'ONYX' 'ONYX' 'NoteAir3' 'arm64-v8a' 31 } 'DEVICE_MODEL_MISMATCH'
    Assert-Throws { Assert-NoteX3Pro 'ONYX' 'ONYX' 'NoteX3Pro' 'x86_64' 31 } 'DEVICE_ABI_MISMATCH'
    Assert-Throws { Assert-NoteX3Pro 'ONYX' 'ONYX' 'NoteX3Pro' 'arm64-v8a' 30 } 'DEVICE_API_CHANGED'
}
Test-Case 'Metadata extracts actual manifest permission and ABI' {
    $meta = New-Metadata -Permissions "package: name='io.pagewise.reader'`nuses-permission: name='android.permission.INTERNET'"
    Assert-True ($meta.Permissions.Count -eq 1 -and $meta.Permissions[0] -eq 'android.permission.INTERNET' -and $meta.Abis[0] -eq 'arm64-v8a')
}
Test-Case 'Original baseline can pass only upstream policy' {
    $meta = New-Metadata -Package 'com.yzfly.lightread.debug' -Permissions "uses-permission: name='android.permission.INTERNET'"
    Assert-ApkPolicy -Metadata $meta -Mode Upstream
    Assert-Throws { Assert-ApkPolicy -Metadata $meta -Mode Pagewise } 'APK_PAGEWISE_IDENTITY_MISMATCH'
}
Test-Case 'Offline Pagewise release and explicit debug identities separate' {
    Assert-ApkPolicy -Metadata (New-Metadata) -Mode Pagewise
    $meta = New-Metadata -Package 'io.pagewise.reader.debug'
    Assert-ApkPolicy -Metadata $meta -Mode Pagewise -BuildKind Debug
    Assert-Throws { Assert-ApkPolicy -Metadata $meta -Mode Pagewise -BuildKind Release } 'APK_PAGEWISE_IDENTITY_MISMATCH'
}
Test-Case 'Internet, install and broad storage permissions rejected' {
    foreach ($name in @('INTERNET','REQUEST_INSTALL_PACKAGES','MANAGE_EXTERNAL_STORAGE','READ_EXTERNAL_STORAGE','WRITE_EXTERNAL_STORAGE')) {
        $meta = New-Metadata -Permissions "uses-permission: name='android.permission.$name'"
        Assert-Throws { Assert-ApkPolicy -Metadata $meta -Mode Pagewise } 'APK_FORBIDDEN_PERMISSION'
    }
}
Test-Case 'SDK-scoped permission variants also rejected' {
    $meta = New-Metadata -Permissions "uses-permission-sdk-23: name='android.permission.INTERNET'"
    Assert-Throws { Assert-ApkPolicy -Metadata $meta -Mode Pagewise } 'APK_FORBIDDEN_PERMISSION'
}
Test-Case 'Real aapt platformBuildVersionName cannot override app version' {
    $badging = "package: name='com.yzfly.lightread.debug' versionCode='1015000' versionName='1.15.0' platformBuildVersionName='16' platformBuildVersionCode='36' compileSdkVersion='36' compileSdkVersionCodename='16'`nsdkVersion:'24'`ntargetSdkVersion:'36'`nnative-code: 'arm64-v8a'"
    $meta = ConvertFrom-ApkMetadata $badging ''
    Assert-True ($meta.Version -eq '1.15.0')
    Assert-ApkPolicy -Metadata $meta -Mode Upstream
}
Test-Case 'Malformed APK metadata is an error, not empty data' {
    Assert-Throws { ConvertFrom-ApkMetadata 'not badging' '' } 'APK_METADATA_INVALID'
    Assert-Throws { ConvertFrom-ApkMetadata "package: name='io.pagewise.reader' versionName='1'" '' } 'APK_METADATA_INVALID'
}
Test-Case 'Wrong ABI and minimum SDK rejected' {
    $meta = New-Metadata; $meta.Abis = @('arm64-v8a','x86_64')
    Assert-Throws { Assert-ApkPolicy -Metadata $meta -Mode Pagewise } 'APK_ABI_MISMATCH'
    $meta = New-Metadata; $meta.MinApi = 32
    Assert-Throws { Assert-ApkPolicy -Metadata $meta -Mode Pagewise } 'APK_MIN_SDK_MISMATCH'
}
Write-Output "RESULT passed=$script:passed failed=$script:failed"
if ($script:failed) { exit 1 }
exit 0
