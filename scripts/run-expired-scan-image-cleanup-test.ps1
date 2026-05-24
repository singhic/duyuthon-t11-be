param(
  [string]$ProjectRef = "hygsrrmoawezonahnljn",
  [string]$SupabaseUrl = "https://hygsrrmoawezonahnljn.supabase.co",
  [string]$CronSecretVaultName = "maintenance_runner_cron_secret"
)

$ErrorActionPreference = "Stop"

function Convert-JsonFromCliOutput($output) {
  $text = ($output | Out-String).Trim()
  $objectStart = $text.IndexOf("{")
  $arrayStart = $text.IndexOf("[")

  if ($objectStart -lt 0 -and $arrayStart -lt 0) {
    throw "CLI output did not include JSON."
  }

  if ($arrayStart -ge 0 -and ($objectStart -lt 0 -or $arrayStart -lt $objectStart)) {
    $start = $arrayStart
    $end = $text.LastIndexOf("]")
  } else {
    $start = $objectStart
    $end = $text.LastIndexOf("}")
  }

  if ($start -lt 0 -or $end -lt $start) {
    throw "Failed to isolate JSON from CLI output."
  }

  return $text.Substring($start, $end - $start + 1) | ConvertFrom-Json
}

function Get-KeyByName($keys, [string]$name) {
  $key = ($keys | Where-Object { $_.name -eq $name } | Select-Object -First 1).api_key
  if (-not $key) {
    throw "Missing Supabase API key: $name"
  }
  return $key
}

function Escape-SqlLiteral([string]$value) {
  return $value.Replace("'", "''")
}

$keys = supabase projects api-keys --project-ref $ProjectRef --output json | ConvertFrom-Json
$serviceRoleKey = Get-KeyByName $keys "service_role"

$cronSecretNameSql = Escape-SqlLiteral $CronSecretVaultName
$cronQuery = Convert-JsonFromCliOutput (supabase db query --linked "select decrypted_secret as cron_secret from vault.decrypted_secrets where name = '$cronSecretNameSql' limit 1;")
$cronSecret = $cronQuery.rows[0].cron_secret
if (-not $cronSecret) {
  throw "Missing cron secret in vault: $CronSecretVaultName"
}

$adminHeaders = @{
  apikey = $serviceRoleKey
  Authorization = "Bearer $serviceRoleKey"
  "Content-Type" = "application/json"
}

$createdUserId = $null
$scanId = [guid]::NewGuid().ToString()
$objectPath = $null

try {
  $email = "codex-scan-cleanup-$([guid]::NewGuid().ToString('N'))@example.invalid"
  $password = "T11!$([guid]::NewGuid().ToString('N'))aA1"

  $createBody = @{
    email = $email
    password = $password
    email_confirm = $true
    user_metadata = @{
      test = "expired-scan-image-cleanup"
    }
  } | ConvertTo-Json -Depth 5

  $createdUser = Invoke-RestMethod `
    -Uri "$SupabaseUrl/auth/v1/admin/users" `
    -Method Post `
    -Headers $adminHeaders `
    -Body $createBody
  $createdUserId = $createdUser.id

  $objectPath = "$createdUserId/$scanId/original.jpeg"
  $imageBytes = [byte[]](0xff, 0xd8, 0xff, 0xd9)
  $storageHeaders = @{
    apikey = $serviceRoleKey
    Authorization = "Bearer $serviceRoleKey"
    "x-upsert" = "true"
  }

  Invoke-RestMethod `
    -Uri "$SupabaseUrl/storage/v1/object/prescription-temp/$objectPath" `
    -Method Post `
    -Headers $storageHeaders `
    -ContentType "image/jpeg" `
    -Body $imageBytes | Out-Null

  $expiredAt = (Get-Date).ToUniversalTime().AddDays(-1).ToString("o")
  $scanBody = @{
    id = $scanId
    user_id = $createdUserId
    image_path = $objectPath
    status = "uploaded"
    expires_at = $expiredAt
  } | ConvertTo-Json

  Invoke-RestMethod `
    -Uri "$SupabaseUrl/rest/v1/scan_sessions" `
    -Method Post `
    -Headers ($adminHeaders + @{ Prefer = "return=minimal" }) `
    -Body $scanBody | Out-Null

  $runnerHeaders = @{
    "Content-Type" = "application/json"
    "x-cron-secret" = $cronSecret
  }
  $runnerBody = @{
    job = "redact_expired_sensitive_data"
    dryRun = $false
  } | ConvertTo-Json

  $runnerResponse = Invoke-RestMethod `
    -Uri "$SupabaseUrl/functions/v1/maintenance-runner" `
    -Method Post `
    -Headers $runnerHeaders `
    -Body $runnerBody

  $encodedScanId = [uri]::EscapeDataString($scanId)
  $scanRows = Invoke-RestMethod `
    -Uri "$SupabaseUrl/rest/v1/scan_sessions?id=eq.$encodedScanId&select=id,image_path,image_deleted_at" `
    -Method Get `
    -Headers $adminHeaders

  $scanRowsArray = @($scanRows)
  if ($scanRowsArray.Count -ne 1) {
    throw "Expected one scan row after cleanup."
  }

  $objectPathSql = Escape-SqlLiteral $objectPath
  $objectQuery = Convert-JsonFromCliOutput (supabase db query --linked "select count(*)::int as object_count from storage.objects where bucket_id = 'prescription-temp' and name = '$objectPathSql';")
  $storageDeleted = ([int]$objectQuery.rows[0].object_count -eq 0)

  [PSCustomObject]@{
    projectRef = $ProjectRef
    scanId = $scanId
    functionStatus = "ok"
    scanImageCount = $runnerResponse.result.redacted.scanImageCount
    scanImageDeletedCount = $runnerResponse.result.redacted.scanImageDeletedCount
    scanImageFailedCount = $runnerResponse.result.redacted.scanImageFailedCount
    rowImagePathIsNull = ($null -eq $scanRowsArray[0].image_path)
    rowImageDeletedAtSet = ($null -ne $scanRowsArray[0].image_deleted_at)
    storageDeleted = $storageDeleted
  } | ConvertTo-Json -Depth 5
} finally {
  if ($scanId) {
    Invoke-RestMethod `
      -Uri "$SupabaseUrl/rest/v1/scan_sessions?id=eq.$scanId" `
      -Method Delete `
      -Headers $adminHeaders | Out-Null
  }

  if ($objectPath) {
    Invoke-RestMethod `
      -Uri "$SupabaseUrl/storage/v1/object/prescription-temp" `
      -Method Delete `
      -Headers @{
        apikey = $serviceRoleKey
        Authorization = "Bearer $serviceRoleKey"
        "Content-Type" = "application/json"
      } `
      -Body (@{ prefixes = @($objectPath) } | ConvertTo-Json) `
      -ErrorAction SilentlyContinue | Out-Null
  }

  if ($createdUserId) {
    Invoke-RestMethod `
      -Uri "$SupabaseUrl/auth/v1/admin/users/$createdUserId" `
      -Method Delete `
      -Headers $adminHeaders | Out-Null
  }
}
