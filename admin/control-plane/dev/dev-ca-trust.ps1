# Trust or remove a development CA (the console's per-domain CA, or a local platform IdP's CA under
# data/idp/<tenant>/tls/ca.crt) in the current user's root store (no elevation needed; Windows shows its own
# confirmation dialog).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File dev-ca-trust.ps1 -CaFile <path> -Install [-WhatIf]
#   powershell -NoProfile -ExecutionPolicy Bypass -File dev-ca-trust.ps1 -CaFile <path> -Remove [-WhatIf]
#   powershell -NoProfile -ExecutionPolicy Bypass -File dev-ca-trust.ps1 -Thumbprint <40 hex> -Remove [-WhatIf]
#   powershell -NoProfile -ExecutionPolicy Bypass -File dev-ca-trust.ps1 -CaFile <path> -ShowThumbprint
#
# Exactly one of -Install, -Remove, -ShowThumbprint is required (otherwise exit status 2). -Thumbprint is an
# alternative to -CaFile for -Remove only, for when the CA file is gone. -Install refuses any certificate that
# is not a name-constrained CA (every development CA minted now is; a local IdP CA minted before the constraint
# existed is refused until it is replaced, see README.md). -WhatIf reports what would happen and changes nothing.
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$CaFile,
    [string]$Thumbprint,
    [switch]$Install,
    [switch]$Remove,
    [switch]$ShowThumbprint
)
$ErrorActionPreference = 'Stop'
$storePath = 'Cert:\CurrentUser\Root'
$nameConstraintsOid = '2.5.29.30'
$usage = 'usage: dev-ca-trust.ps1 (-CaFile <path> | -Thumbprint <40 hex> with -Remove) (-Install | -Remove | -ShowThumbprint) [-WhatIf]'

$chosen = @($Install.IsPresent, $Remove.IsPresent, $ShowThumbprint.IsPresent) | Where-Object { $_ }
$haveFile = [bool]$CaFile
$haveThumb = [bool]$Thumbprint
if ((@($chosen).Count -ne 1) -or ($haveFile -eq $haveThumb) -or ($haveThumb -and -not $Remove))
{
    [Console]::Error.WriteLine($usage)
    exit 2
}
if ($haveThumb -and ($Thumbprint -notmatch '^[0-9A-Fa-f]{40}$'))
{
    [Console]::Error.WriteLine("invalid thumbprint (expected 40 hex characters): $Thumbprint")
    exit 2
}

if ($haveFile)
{
    if (-not (Test-Path -LiteralPath $CaFile -PathType Leaf))
    {
        [Console]::Error.WriteLine("CA file not found: $CaFile")
        exit 1
    }
    $resolved = (Resolve-Path -LiteralPath $CaFile).ProviderPath
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($resolved)
    $thumb = $cert.Thumbprint.ToUpperInvariant()
}
else
{
    $thumb = $Thumbprint.ToUpperInvariant()
}

if ((-not $ShowThumbprint) -and (-not (Test-Path -LiteralPath $storePath)))
{
    [Console]::Error.WriteLine("certificate store not available: $storePath")
    exit 1
}

if ($ShowThumbprint)
{
    Write-Output $thumb
}
elseif ($Install)
{
    $basic = $cert.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension] } | Select-Object -First 1
    $constraints = $cert.Extensions | Where-Object { $_.Oid.Value -eq $nameConstraintsOid } | Select-Object -First 1
    if ((-not $basic) -or (-not $basic.CertificateAuthority) -or (-not $constraints) -or (-not $constraints.Critical))
    {
        [Console]::Error.WriteLine("refusing: $CaFile is not a name-constrained CA")
        exit 1
    }
    if ($PSCmdlet.ShouldProcess($thumb, 'trust development CA'))
    {
        Import-Certificate -FilePath $resolved -CertStoreLocation $storePath | Out-Null
        Write-Output "installed: $thumb"
    }
    else
    {
        Write-Output "would install: $thumb"
    }
}
else
{
    $item = "$storePath\$thumb"
    if (-not (Test-Path -LiteralPath $item))
    {
        Write-Output "not installed: $thumb"
    }
    elseif ($PSCmdlet.ShouldProcess($thumb, 'remove development CA'))
    {
        Remove-Item -LiteralPath $item
        Write-Output "removed: $thumb"
    }
    else
    {
        Write-Output "would remove: $thumb"
    }
}
