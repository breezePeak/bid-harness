param([string]$InputDocument, [string]$OutputPdf)
$ErrorActionPreference = 'Stop'
$bidApplication = $null
$bidDocument = $null
$bidHadDocuments = $true
try {
    $bidApplication = New-Object -ComObject 'Word.Application.12'
    $bidHadDocuments = $bidApplication.Documents.Count -gt 0
    if (-not $bidHadDocuments) { $bidApplication.Visible = $false }
    $bidDocument = $bidApplication.Documents.Open($InputDocument, $false, $false)
    $null = $bidDocument.Fields.Update()
    for ($bidIndex = 1; $bidIndex -le $bidDocument.TablesOfContents.Count; $bidIndex++) {
        $bidDocument.TablesOfContents.Item($bidIndex).Update()
    }
    $bidDocument.Save()
    $bidDocument.ExportAsFixedFormat($OutputPdf, 17)
    if (-not (Test-Path -LiteralPath $OutputPdf)) { throw 'WPS did not create the requested PDF.' }
    Get-Item -LiteralPath $OutputPdf | Select-Object FullName,Length
}
finally {
    if ($null -ne $bidDocument) { $bidDocument.Close(0) }
    if ($null -ne $bidApplication -and -not $bidHadDocuments -and $bidApplication.Documents.Count -eq 0) { $bidApplication.Quit() }
}
