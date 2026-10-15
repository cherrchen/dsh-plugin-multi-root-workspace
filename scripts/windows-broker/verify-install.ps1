# Native lifecycle evidence on an elevated, disposable Windows CI host.
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot 'install.ps1'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sid)))).Replace('-', '').ToLower().Substring(0,16) }
finally { $sha.Dispose() }
$name = "DshMultiRootBroker-$hash"
$serviceSid = [regex]::Match((sc.exe showsid $name | Out-String), 'S-1-5-80-(?:[0-9]+-){4}[0-9]+').Value
$record = Join-Path (Join-Path $env:ProgramFiles $name) 'added-rights.json'
$required = @('SeServiceLogonRight','SeCreateTokenPrivilege','SeAssignPrimaryTokenPrivilege','SeTcbPrivilege','SeDebugPrivilege','SeImpersonatePrivilege')
function Read-Policy {
    $file = Join-Path $env:TEMP ([Guid]::NewGuid().ToString() + '.inf')
    try {
        secedit.exe /export /cfg $file /areas USER_RIGHTS /quiet | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Cannot export account policy.' }
        $policy = @{}
        foreach ($line in Get-Content $file) {
            if ($line -match '^(Se\w+)\s*=\s*(.*)$') { $policy[$Matches[1]] = @($Matches[2].Split(',') | ForEach-Object { $_.Trim().TrimStart('*') } | Where-Object { $_ } | Sort-Object) }
        }
        return $policy
    } finally { Remove-Item $file -Force -ErrorAction SilentlyContinue }
}
function Assert-Rights($policy, $expected) {
    foreach ($right in $required) {
        if (($policy[$right] -contains $serviceSid) -ne ($expected -contains $right)) { throw "Unexpected service policy for $right" }
    }
}
# Capture the host's installed state; the installer must not touch other SIDs.
$installed = Read-Policy
Assert-Rights $installed $required
$added = [string[]]@(Get-Content -Raw $record | ConvertFrom-Json)
$preexisting = @($required | Where-Object { $added -notcontains $_ })
& $installer -Uninstall
$baseline = Read-Policy
Assert-Rights $baseline $preexisting
if (Get-Service $name -ErrorAction SilentlyContinue) { throw 'Service remains after uninstall.' }
if (Test-Path (Split-Path $record)) { throw 'Installation directory remains after uninstall.' }
foreach ($right in $required) {
    if ((@($installed[$right] | Where-Object { $_ -ne $serviceSid }) -join ',') -ne (@($baseline[$right] | Where-Object { $_ -ne $serviceSid }) -join ',')) { throw "Other account policy changed for $right" }
}
# Simulate pre-existing policy on this dedicated account. Installation may only
# record/revoke its own additions. Preserve the original baseline on cleanup.
$seed = [DshBrokerRights]::Install($serviceSid)
[DshBrokerRights]::Remove($serviceSid, [string[]]@($seed | Where-Object { $_ -ne 'SeServiceLogonRight' }))
try {
    # Inject each post-grant failure through PowerShell's command resolution.
    # Include a partial staging record, then verify actual LSA policy and SCM.
    foreach ($step in @('Set-Content', 'Move-Item', 'Start-Service')) {
        Set-Item -Path "Function:global:$step" -Value {
            Microsoft.PowerShell.Management\Set-Content -LiteralPath "$record.pending" -Value '['
            throw 'Injected installation failure'
        }
        $failed = $false
        try { & $installer }
        catch {
            if ($_.Exception.Message -notlike '*Injected installation failure*') { throw }
            $failed = $true
        } finally { Remove-Item -LiteralPath "Function:global:$step" -Force }
        if (-not $failed) { throw "Failure injection did not run: $step" }
        Assert-Rights (Read-Policy) @($preexisting + 'SeServiceLogonRight')
        if (Test-Path $record) { throw 'Rollback retained a committed rights record.' }
        if (Test-Path "$record.pending") { throw 'Rollback retained a partial rights record.' }
        if (Get-Service $name -ErrorAction SilentlyContinue) { throw 'Rollback retained the failed service.' }
    }
    & $installer
    Assert-Rights (Read-Policy) $required
    if (@(Get-Content -Raw $record | ConvertFrom-Json) -contains 'SeServiceLogonRight') { throw 'Installer recorded a pre-existing right.' }
    & $installer # Upgrade must preserve the same pre-existing right.
    if (@(Get-Content -Raw $record | ConvertFrom-Json) -contains 'SeServiceLogonRight') { throw 'Upgrade recorded a pre-existing right.' }
    & $installer -Uninstall
    Assert-Rights (Read-Policy) @($preexisting + 'SeServiceLogonRight')
} finally {
    & $installer -Uninstall
    if ($seed -contains 'SeServiceLogonRight') { [DshBrokerRights]::Remove($serviceSid, [string[]]@('SeServiceLogonRight')) }
}
Assert-Rights (Read-Policy) $preexisting
& $installer
Write-Output 'Broker lifecycle verified: install, upgrade, uninstall, pre-existing rights preserved; other accounts unchanged.'
