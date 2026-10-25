# Run ONCE, elevated (Administrator), to trust the local dev CAs so your browser accepts the dev TLS
# without warnings:  Right-click -> Run with PowerShell (as Admin), or:  powershell -ExecutionPolicy Bypass -File trust-ca.ps1
#
# Trusts:
#   - certs\dev-ca.crt       the CA behind Caddy's *.lvh.me cert (the tenant admin panel at https://<tenant>.lvh.me)
#   - certs\acme-idp-ca.crt  the acme tenant's IdP cert (the login redirect hits the IdP at https://host.docker.internal:<port>)
#
# Each tenant you provision gets its OWN IdP CA under data\idp\<tenant>\tls\ca.crt; copy it next to this script
# (as <tenant>-idp-ca.crt) and re-run to trust it too.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$certs = @('certs\dev-ca.crt', 'certs\acme-idp-ca.crt')
foreach ($rel in $certs)
{
	$path = Join-Path $here $rel
	if (Test-Path $path)
	{
		Import-Certificate -FilePath $path -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
		Write-Host "trusted: $path"
	}
	else
	{
		Write-Warning "missing (skipped): $path"
	}
}
Write-Host "Done. Fully restart the browser to pick up the new trusted roots."
