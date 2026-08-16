param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("telegram", "openai")]
  [string]$Target,
  [switch]$ReadFromClipboard
)

$ErrorActionPreference = "Stop"
$environmentFile = "C:\Projects\Brain\src\clo-telegram\.env"
$ecosystemFile = "C:\Projects\Brain\src\clo-telegram\ecosystem.config.cjs"

function ConvertFrom-SecureValue([Security.SecureString]$SecureValue) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Normalize-CredentialValue([string]$SelectedTarget, [string]$Value) {
  $normalized = $Value.Trim().Trim([char[]]@('`', '"', "'"))
  if ($SelectedTarget -eq "telegram") {
    $tokenMatch = [regex]::Match($normalized, "\d{5,}:[A-Za-z0-9_-]{20,}")
    if ($tokenMatch.Success) {
      return $tokenMatch.Value
    }
  }
  return $normalized
}

function Test-TelegramCredential([string]$Value) {
  try {
    $response = Invoke-RestMethod -Method Get -Uri ("https://api.telegram.org/bot" + $Value + "/getMe") -TimeoutSec 15
    return $response.ok -eq $true
  }
  catch {
    return $false
  }
}

function Test-OpenAiCredential([string]$Value) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -SkipHttpErrorCheck -Method Get -Uri "https://api.openai.com/v1/models" -Headers @{ Authorization = ("Bearer " + $Value) } -TimeoutSec 15
    return [int]$response.StatusCode -eq 200
  }
  catch {
    return $false
  }
}

function Test-SelectedCredential([string]$SelectedTarget, [string]$Value) {
  if ($SelectedTarget -eq "telegram") {
    return Test-TelegramCredential $Value
  }
  return Test-OpenAiCredential $Value
}

function Set-EnvironmentCredential([string]$Name, [string]$Value, [string]$OriginalText) {
  $pattern = "(?m)^(\s*" + [regex]::Escape($Name) + "\s*=\s*).*?$"
  if (-not [regex]::IsMatch($OriginalText, $pattern)) {
    throw "설정 이름을 찾을 수 없습니다."
  }
  return [regex]::Replace($OriginalText, $pattern, { param($match) $match.Groups[1].Value + $Value }, 1)
}

function Restart-CloTelegram {
  pm2 delete clo-telegram *> $null
  pm2 start $ecosystemFile --only clo-telegram *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "텔레클로 신규 시작에 실패했습니다."
  }
}

$credentialName = if ($Target -eq "telegram") { "TELEGRAM_BOT_TOKEN" } else { "OPENAI_API_KEY" }
$plainValue = $null
while ($true) {
  $secureValue = $null
  $clipboardValue = $null
  if ($ReadFromClipboard) {
    Read-Host "$credentialName 값을 BotFather에서 복사한 뒤, 붙여 넣지 말고 Enter만 누르세요" | Out-Null
    $clipboardValue = Get-Clipboard -Raw
  }
  else {
    $secureValue = Read-Host "$credentialName 새 값을 붙여 넣으세요. 화면에는 표시되지 않습니다" -AsSecureString
  }
  $candidateValue = $null
  try {
    $candidateInput = if ($ReadFromClipboard) { $clipboardValue } else { ConvertFrom-SecureValue $secureValue }
    $candidateValue = Normalize-CredentialValue $Target $candidateInput
    if (-not [string]::IsNullOrWhiteSpace($candidateValue) -and (Test-SelectedCredential $Target $candidateValue)) {
      $plainValue = $candidateValue
      $candidateValue = $null
      break
    }
    Write-Warning "공급자 검증에 실패했습니다. BotFather가 발급한 새 토큰을 다시 입력하세요."
  }
  finally {
    $candidateInput = $null
    $candidateValue = $null
    $clipboardValue = $null
    if ($null -ne $secureValue) {
      $secureValue.Dispose()
      $secureValue = $null
    }
  }
}

$originalText = [IO.File]::ReadAllText($environmentFile)
$updated = $false

try {
  $updatedText = Set-EnvironmentCredential $credentialName $plainValue $originalText
  [IO.File]::WriteAllText($environmentFile, $updatedText, (New-Object Text.UTF8Encoding($false)))
  $updated = $true

  Restart-CloTelegram

  Start-Sleep -Seconds 3
  if (-not (Test-SelectedCredential $Target $plainValue)) {
    throw "재시작 후 공급자 검증에 실패했습니다."
  }

  Write-Host "$credentialName 회전 및 텔레클로 재시작 검증 완료"
}
catch {
  if ($updated) {
    [IO.File]::WriteAllText($environmentFile, $originalText, (New-Object Text.UTF8Encoding($false)))
    Restart-CloTelegram
  }
  Write-Error "$credentialName 회전 실패. 기존 설정을 복구했습니다."
  exit 1
}
finally {
  $plainValue = $null
  $secureValue = $null
}
