<#
.SYNOPSIS
  Create an invoice locally: populated .xlsx + .pdf + a row in the tracker workbook.

  With NO parameters it reads the NewInvoice tab of your tracker workbook (fill the yellow cells,
  SAVE and CLOSE the workbook in LibreOffice, then run:  .\new-invoice.ps1 ).

.EXAMPLES
  .\new-invoice.ps1                 # uses the NewInvoice tab
  .\new-invoice.ps1 -DryRun         # same, but only shows number and total

  .\new-invoice.ps1 -Client C001 -Title "Garden fence repair" -WorkQty 2.5 -WorkPrice 40 `
      -MaterialsPrice 18.5 -MaterialsDetail "Timber panels, screws" -Postage 4.2

  .\new-invoice.ps1 -InputFile .\invoice.json          # same thing from a JSON file
  .\new-invoice.ps1 -Client C001 -Title "Test" -WorkPrice 10 -DryRun   # show number and total only

  If scripts are blocked:  powershell -ExecutionPolicy Bypass -File .\new-invoice.ps1 -Client ...

Leave a price out to leave that line off the invoice. Quantity left out = 1.
Date is dd/mm/yyyy (blank = today). Days = payment terms (blank = client's value, else Settings default).
#>
[CmdletBinding()]
param(
    [string]$Client = "",
    [string]$Title = "",
    [string]$Date = "",
    [Nullable[int]]$Days = $null,
    [Nullable[double]]$WorkQty = $null,
    [Nullable[double]]$WorkPrice = $null,
    [Nullable[double]]$MaterialsQty = $null,
    [Nullable[double]]$MaterialsPrice = $null,
    [string]$MaterialsDetail = "",
    [Nullable[double]]$Postage = $null,
    [string]$Notes = "",
    [string]$InputFile = "",
    [string]$Config = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# find Python
$py = Get-Command py -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python -ErrorAction SilentlyContinue }
if (-not $py) { throw "Python not found. Install Python 3 from python.org (tick 'Add to PATH')." }

$cleanup = $false
$fromForm = ($InputFile -eq "" -and $Client -eq "" -and $Title -eq "")
if ($fromForm) {
    $argsList = @((Join-Path $here "generate_invoice.py"), "--form")
} elseif ($InputFile -eq "") {
    if ($Client -eq "" -or $Title -eq "") { throw "Give both -Client and -Title (or use -InputFile, or no parameters to use the NewInvoice tab)." }
    $data = [ordered]@{
        clientId         = $Client
        issueDate        = $Date
        paymentTermsDays = $Days
        title            = $Title
        work             = [ordered]@{ qty = $WorkQty; price = $WorkPrice }
        materials        = [ordered]@{ qty = $MaterialsQty; price = $MaterialsPrice; detail = $MaterialsDetail }
        postage          = [ordered]@{ price = $Postage }
        notes            = $Notes
    }
    $InputFile = Join-Path ([System.IO.Path]::GetTempPath()) ("invoice_" + [guid]::NewGuid().ToString("N") + ".json")
    $data | ConvertTo-Json -Depth 5 | Set-Content -Path $InputFile -Encoding UTF8
    $cleanup = $true
}

if (-not $fromForm) { $argsList = @((Join-Path $here "generate_invoice.py"), "--input", $InputFile) }
if ($Config -ne "") { $argsList += @("--config", $Config) }
if ($DryRun) { $argsList += "--dry-run" }

try {
    & $py.Source @argsList
    $code = $LASTEXITCODE
} finally {
   # if ($cleanup -and (Test-Path $InputFile)) { Remove-Item $InputFile -Force }
}
exit $code
