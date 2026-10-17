# Run from an elevated PowerShell. A dedicated virtual service account
# authenticates one installation SID; its executable is administrator-owned.
[CmdletBinding()]
param([string]$UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this installer in an elevated PowerShell.'
}
$sid = [Security.Principal.SecurityIdentifier]::new($UserSid).Value
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sid)))).Replace('-', '').ToLower().Substring(0,16) }
finally { $sha.Dispose() }
$name = "DshMultiRootBroker-$hash"
$directory = Join-Path $env:ProgramFiles $name
$sc = Join-Path $env:SystemRoot 'System32/sc.exe'
# Virtual service SIDs are deterministic and do not require a user password.
$serviceSidText = (& $sc showsid $name | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve broker service SID.' }
$serviceSid = [regex]::Match($serviceSidText, 'S-1-5-80-(?:[0-9]+-){4}[0-9]+').Value
if (-not $serviceSid) { throw 'Missing broker service SID.' }
if (-not ('DshBrokerRights' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'rights.cs') }
$rightsRecord = Join-Path $directory 'added-rights.json'
$service = Get-Service -Name $name -ErrorAction SilentlyContinue
if ($service) { Stop-Service $name -Force; & $sc delete $name | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Cannot remove previous broker service.' }; Start-Sleep -Milliseconds 500 }
# Revoke only rights this installer added; preserve pre-existing account policy.
if (Test-Path $rightsRecord) {
    # Windows PowerShell 5.1 emits the JSON array as a single object; cast the
    # result value directly (not inside @(...)) so it yields one element per
    # recorded right.
    [DshBrokerRights]::Remove($serviceSid, [string[]](Get-Content -Raw $rightsRecord | ConvertFrom-Json))
    Remove-Item $rightsRecord -Force
}
if ($Uninstall) { if (Test-Path $directory) { Remove-Item $directory -Recurse -Force }; Write-Output "Removed $name"; return }
New-Item -ItemType Directory -Path $directory -Force | Out-Null
# The installed code and directory must never be writable by the client user.
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
foreach ($trustee in @('S-1-5-18', 'S-1-5-32-544')) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($trustee), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
}
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($serviceSid), 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
Set-Acl -LiteralPath $directory -AclObject $acl
$exe = Join-Path $directory 'broker.exe'
if (Test-Path $exe) { Remove-Item $exe -Force }
$framework = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
& $compiler /nologo /target:exe /platform:anycpu "/out:$exe" "/reference:$(Join-Path $framework 'System.ServiceProcess.dll')" (Join-Path $PSScriptRoot 'service.cs')
if ($LASTEXITCODE -ne 0) { throw 'Broker compilation failed.' }
$pendingRecord = "$rightsRecord.pending"
$addedRights = [string[]]@()
$serviceCreated = $false
try {
    & $sc create $name binPath= "`"$exe`" $sid $name" start= auto obj= "NT SERVICE\$name" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Broker service registration failed.' }
    $serviceCreated = $true
    $addedRights = [DshBrokerRights]::Install($serviceSid)
    # Publish a complete record; a failed write must not leave malformed JSON
    # on the upgrade/uninstall path.
    ConvertTo-Json -InputObject @($addedRights) | Set-Content -LiteralPath $pendingRecord
    Move-Item -LiteralPath $pendingRecord -Destination $rightsRecord -Force
    Start-Service $name
    (Get-Service $name).WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
} catch {
    $installationError = $_
    try {
        if ($serviceCreated) {
            $failedService = Get-Service -Name $name -ErrorAction SilentlyContinue
            if ($failedService -and $failedService.Status -ne 'Stopped') { Stop-Service $name -Force }
        }
    } finally {
        try {
            # Revoke exactly this attempt's additions even if stopping fails.
            # Remove the record only AFTER successful revocation.
            [DshBrokerRights]::Remove($serviceSid, $addedRights)
            Remove-Item -LiteralPath $pendingRecord -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $rightsRecord -Force -ErrorAction SilentlyContinue
        } finally {
            if ($serviceCreated) {
                & $sc delete $name | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'Cannot roll back failed broker service registration.' }
            }
        }
    }
    throw $installationError
}
Write-Output "Installed $name for $sid"
