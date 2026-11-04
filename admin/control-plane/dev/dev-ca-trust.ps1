# Trust or remove the development console CA in the current user's root store (no elevation needed;
# Windows shows its own confirmation dialog).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File dev-ca-trust.ps1 -CaFile <path> -Install
#   powershell -NoProfile -ExecutionPolicy Bypass -File dev-ca-trust.ps1 -CaFile <path> -Remove
#   powershell -NoProfile -ExecutionPolicy Bypass -File dev-ca-trust.ps1 -CaFile <path> -ShowThumbprint
#
# Exactly one of the three switches is required (otherwise exit status 2).
param(
    [string]$CaFile,
    [switch]$Install,
    [switch]$Remove,
    [switch]$ShowThumbprint
)
$ErrorActionPreference = 'Stop'
$storePath = 'Cert:\CurrentUser\Root'
$usage = 'usage: dev-ca-trust.ps1 -CaFile <path> (-Install | -Remove | -ShowThumbprint)'

$chosen = @($Install.IsPresent, $Remove.IsPresent, $ShowThumbprint.IsPresent) | Where-Object { $_ }
if ((-not $CaFile) -or (@($chosen).Count -ne 1))
{
    [Console]::Error.WriteLine($usage)
    exit 2
}
if (-not (Test-Path -LiteralPath $CaFile -PathType Leaf))
{
    [Console]::Error.WriteLine("CA file not found: $CaFile")
    exit 1
}

$resolved = (Resolve-Path -LiteralPath $CaFile).ProviderPath
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($resolved)
$thumbprint = $cert.Thumbprint.ToUpperInvariant()

if ($ShowThumbprint)
{
    Write-Output $thumbprint
}
elseif ($Install)
{
    Import-Certificate -FilePath $resolved -CertStoreLocation $storePath | Out-Null
    Write-Output "installed: $thumbprint"
}
else
{
    $item = Join-Path $storePath $thumbprint
    if (Test-Path -LiteralPath $item)
    {
        Remove-Item -LiteralPath $item
        Write-Output "removed: $thumbprint"
    }
    else
    {
        Write-Output "not installed: $thumbprint"
    }
}
