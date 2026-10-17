#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('Upstream','Pagewise')][string]$Mode = 'Upstream',
    [string]$ApkPath = '',
    [string]$SdkRoot = (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
    [string]$BuildToolsVersion = '36.0.0',
    [ValidateSet('Debug','Release')][string]$BuildKind = 'Release',
    [string]$CertificateSha256 = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'Admission.Common.psm1') -Force -DisableNameChecking
$root = Split-Path $PSScriptRoot -Parent
$report = [ordered]@{ schemaVersion = 1; mode = $Mode; status = 'FAILED'; deviceTested = $false; installed = $false; checkedAtUtc = [DateTime]::UtcNow.ToString('o') }
$code = 1
try {
    if ($Mode -eq 'Upstream') {
        $provenance = Get-Content -LiteralPath (Join-Path $root 'artifacts/upstream/provenance.json') -Raw | ConvertFrom-Json
        if (-not $ApkPath) { $ApkPath = Join-Path $root ('artifacts/upstream/' + $provenance.asset.name) }
        $expectedHash = 'c7a2f65a33a62ccac466015ae24e82514bf3ca3e72db94f2262992793971b5a5'
        if ($provenance.asset.sha256 -ne $expectedHash) { throw 'APK_PROVENANCE_CHANGED: Recorded source digest does not match the frozen baseline.' }
        $CertificateSha256 = '56103db2e518cf800db66d148d45f886e93c12b1afc8944ec668713636c7bada'
    } else {
        if (-not $ApkPath) { throw 'APK_PATH_REQUIRED: Supply a real Pagewise artifact; the upstream APK is not Pagewise.' }
        if ($CertificateSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'APK_CERTIFICATE_REQUIRED: Supply the previously approved public signing-certificate SHA-256; no keys are read.' }
    }
    $ApkPath = (Resolve-Path -LiteralPath $ApkPath).Path
    $hash = (Get-FileHash -LiteralPath $ApkPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Mode -eq 'Upstream' -and $hash -ne $expectedHash) { throw "APK_DIGEST_MISMATCH: $hash" }
    $bt = Join-Path $SdkRoot ('build-tools/' + $BuildToolsVersion)
    $badging = Invoke-CheckedNative (Join-Path $bt 'aapt.exe') @('dump','badging',$ApkPath)
    $permissions = Invoke-CheckedNative (Join-Path $bt 'aapt.exe') @('dump','permissions',$ApkPath)
    if ($permissions -notmatch '(?m)^package:\s*\S+') { throw 'APK_PERMISSION_DUMP_INVALID: aapt did not identify the package; empty output is not an offline result.' }
    $metadata = ConvertFrom-ApkMetadata $badging $permissions
    Assert-ApkPolicy -Metadata $metadata -Mode $Mode -BuildKind $BuildKind
    $signature = Invoke-CheckedNative (Join-Path $bt 'apksigner.bat') @('verify','--print-certs',$ApkPath)
    $certs = @([regex]::Matches($signature, '(?im)^Signer #\d+ certificate SHA-256 digest:\s*([a-f0-9]{64})') | ForEach-Object { $_.Groups[1].Value.ToLowerInvariant() })
    if ($certs.Count -ne 1 -or $certs[0] -ne $CertificateSha256.ToLowerInvariant()) { throw 'APK_CERTIFICATE_MISMATCH: Verified signer does not match the pinned public certificate.' }
    $report.status = if ($Mode -eq 'Upstream') { 'UPSTREAM_ARTIFACT_VERIFIED' } else { 'PAGEWISE_STATIC_ARTIFACT_VERIFIED' }
    $report.apk = [ordered]@{ fileName = [IO.Path]::GetFileName($ApkPath); sha256 = $hash; certificateSha256 = $certs[0]; metadata = $metadata }
    $report.remaining = @('No device installation performed.','Static APK checks do not prove Note X3 Pro compatibility, offline runtime behavior or backup restore.')
    $code = 0
} catch {
    $report.error = $_.Exception.Message
}
Write-AdmissionReport $report (Join-Path $root 'artifacts/diagnostics') 'apk'
exit $code
