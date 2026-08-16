param(
  [Parameter(Mandatory = $true)]
  [string]$Prompt,

  [string]$Cwd = "C:\Projects\Brain",
  [ValidateSet("read_only", "workspace_write", "full_access")]
  [string]$Sandbox = "read_only",
  [string]$Model = "",
  [string]$Python = "python",
  [string]$Runner = "C:\Projects\Brain\src\clo-telegram\tools\codex-sdk-run.py"
)

$promptFile = Join-Path $env:TEMP ("codex-sdk-prompt-{0}.txt" -f ([Guid]::NewGuid()))
$outFile = Join-Path $env:TEMP ("codex-sdk-out-{0}.json" -f ([Guid]::NewGuid()))

try {
  Set-Content -Path $promptFile -Value $Prompt -Encoding UTF8
  $argsList = @(
    $Runner,
    "--prompt-file", $promptFile,
    "--out-file", $outFile,
    "--sandbox", $Sandbox,
    "--cwd", $Cwd
  )
  if ($Model.Trim()) {
    $argsList += @("--model", $Model.Trim())
  }

  & $Python @argsList | Out-Null
  if (-not (Test-Path $outFile)) {
    throw "Codex SDK output file was not created."
  }
  Get-Content -Path $outFile -Raw
} finally {
  Remove-Item -Path $promptFile, $outFile -ErrorAction SilentlyContinue
}
