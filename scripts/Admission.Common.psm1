#requires -Version 7.0
Set-StrictMode -Version Latest

function Invoke-CheckedNative {
    param([Parameter(Mandatory)][string]$Program, [string[]]$Arguments = @())
    if (-not (Test-Path -LiteralPath $Program -PathType Leaf)) { throw "Tool not found: $Program" }
    $lines = @(& $Program @Arguments 2>&1)
    $code = $LASTEXITCODE
    $text = ($lines | ForEach-Object { $_.ToString() }) -join "`n"
    if ($code -ne 0) { throw "Native command failed ($code): $([IO.Path]::GetFileName($Program)) $($Arguments -join ' ')`n$text" }
    return $text
}

function ConvertFrom-AdbDevices {
    param([AllowEmptyString()][string]$Text, [switch]$RequireHeader)
    if ($RequireHeader -and $Text -notmatch '(?m)^List of devices attached\s*\r?$') { throw 'ADB_LIST_INVALID: Successful ADB output has no device-list header; this is not evidence of no devices.' }
    foreach ($line in ($Text -split '\r?\n')) {
        if ($line -match '^(?<serial>\S+)\s+(?<state>device|offline|unauthorized)(?:\s|$)') {
            [pscustomobject]@{ Serial = $Matches.serial; State = $Matches.state }
        }
    }
}

function Select-AdbDevice {
    param([object[]]$Devices = @(), [string]$Serial = '')
    if ($Devices.Count -eq 0) { throw 'DEVICE_NONE: ADB returned no devices; connect and authorize the target tablet.' }
    if ($Serial) {
        $selected = @($Devices | Where-Object { $_.Serial -ceq $Serial })
        if ($selected.Count -ne 1) { throw 'DEVICE_NOT_FOUND: The requested serial is not listed by ADB.' }
    } else {
        if ($Devices.Count -ne 1) { throw 'DEVICE_AMBIGUOUS: Multiple devices are listed; supply -Serial explicitly.' }
        $selected = @($Devices[0])
    }
    if ($selected[0].State -ne 'device') { throw "DEVICE_UNAVAILABLE: Target state is $($selected[0].State); do not bypass device authorization." }
    return $selected[0]
}

function Assert-NoteX3Pro {
    param([string]$Manufacturer, [string]$Brand, [string]$Model, [string]$Abi, [int]$Api)
    if (($Manufacturer -notmatch '(?i)onyx|boox') -and ($Brand -notmatch '(?i)onyx|boox')) {
        throw 'DEVICE_VENDOR_MISMATCH: Target is not identified as ONYX/BOOX.'
    }
    $normalized = ($Model -replace '[^a-zA-Z0-9]', '').ToLowerInvariant()
    if ($normalized -ne 'notex3pro') { throw "DEVICE_MODEL_MISMATCH: Observed model '$Model' is not the approved Note X3 Pro identifier; inspect before proceeding." }
    if ($Abi -ne 'arm64-v8a') { throw "DEVICE_ABI_MISMATCH: Expected arm64-v8a, observed $Abi." }
    if ($Api -notin @(31,32)) { throw "DEVICE_API_CHANGED: Expected Android 12 / API 31 or 32, observed API $Api; reassess firmware compatibility." }
}

function ConvertFrom-ApkMetadata {
    param([Parameter(Mandatory)][string]$Badging, [Parameter(Mandatory)][AllowEmptyString()][string]$Permissions)
    if ($Badging -notmatch "(?m)^package: name='(?<package>[^']+)'[^\r\n]*?\sversionName='(?<version>[^']+)'") { throw 'APK_METADATA_INVALID: Missing package/version.' }
    $package = $Matches.package; $version = $Matches.version
    if ($Badging -notmatch "(?m)^sdkVersion:'(?<api>\d+)'") { throw 'APK_METADATA_INVALID: Missing minSdk.' }
    $minApi = [int]$Matches.api
    if ($Badging -notmatch "(?m)^targetSdkVersion:'(?<api>\d+)'") { throw 'APK_METADATA_INVALID: Missing targetSdk.' }
    $targetApi = [int]$Matches.api
    if ($Badging -notmatch '(?m)^native-code:\s*(?<abis>[^\r\n]+)') { throw 'APK_METADATA_INVALID: Missing native ABI list.' }
    $abis = @([regex]::Matches($Matches.abis, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
    $grants = @([regex]::Matches($Permissions, "(?m)^uses-permission(?:-sdk-\d+)?: name='([^']+)'") | ForEach-Object { $_.Groups[1].Value })
    return [pscustomobject]@{ Package = $package; Version = $version; MinApi = $minApi; TargetApi = $targetApi; Abis = $abis; Permissions = $grants }
}

function Assert-ApkPolicy {
    param([Parameter(Mandatory)]$Metadata, [ValidateSet('Upstream','Pagewise')][string]$Mode = 'Upstream', [ValidateSet('Debug','Release')][string]$BuildKind = 'Release')
    if ($Mode -eq 'Upstream') {
        if ($Metadata.Package -ne 'com.yzfly.lightread.debug' -or $Metadata.Version -ne '1.15.0') { throw 'APK_UPSTREAM_IDENTITY_MISMATCH: Not the pinned v1.15.0 Android baseline.' }
    } else {
        $expected = if ($BuildKind -eq 'Debug') { 'io.pagewise.reader.debug' } else { 'io.pagewise.reader' }
        if ($Metadata.Package -ne $expected) { throw "APK_PAGEWISE_IDENTITY_MISMATCH: Expected $expected, observed $($Metadata.Package)." }
        $forbidden = @('android.permission.INTERNET','android.permission.REQUEST_INSTALL_PACKAGES','android.permission.MANAGE_EXTERNAL_STORAGE','android.permission.READ_EXTERNAL_STORAGE','android.permission.WRITE_EXTERNAL_STORAGE')
        foreach ($permission in $forbidden) {
            if ($Metadata.Permissions -contains $permission) { throw "APK_FORBIDDEN_PERMISSION: $permission is present in the packaged manifest." }
        }
    }
    if ($Metadata.MinApi -gt 31 -or $Metadata.MinApi -lt 24) { throw 'APK_MIN_SDK_MISMATCH: Expected minSdk 24 through 31, compatible with both Android 12 API levels.' }
    if ($Metadata.Abis.Count -ne 1 -or $Metadata.Abis[0] -ne 'arm64-v8a') { throw 'APK_ABI_MISMATCH: Expected arm64-v8a only.' }
}

function Write-AdmissionReport {
    param([Parameter(Mandatory)]$Report, [Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$Prefix)
    [IO.Directory]::CreateDirectory($Directory) | Out-Null
    $path = Join-Path $Directory ("$Prefix-" + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8) + '.json')
    $json = $Report | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($path, $json + "`n", [Text.UTF8Encoding]::new($false))
    Write-Output $json
    Write-Output "Report: $path"
}

Export-ModuleMember -Function Invoke-CheckedNative,ConvertFrom-AdbDevices,Select-AdbDevice,Assert-NoteX3Pro,ConvertFrom-ApkMetadata,Assert-ApkPolicy,Write-AdmissionReport
