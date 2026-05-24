param(
  [string]$ProjectRef = "hygsrrmoawezonahnljn",
  [string]$SupabaseUrl = "https://hygsrrmoawezonahnljn.supabase.co",
  [string]$ImageDir = "images",
  [string]$ResultPath = "result/frontend-backend-e2e-20260524.md"
)

$ErrorActionPreference = "Stop"

function Get-KeyByName($keys, [string]$name) {
  $key = ($keys | Where-Object { $_.name -eq $name } | Select-Object -First 1).api_key
  if (-not $key) {
    throw "Missing Supabase API key: $name"
  }
  return $key
}

function Invoke-JsonRequest {
  param(
    [string]$Uri,
    [string]$Method = "Get",
    [hashtable]$Headers,
    $Body = $null,
    [int]$Depth = 12
  )

  try {
    $bodyText = $null
    if ($null -ne $Body) {
      if ($Body -is [string]) {
        $bodyText = $Body
      } else {
        $bodyText = $Body | ConvertTo-Json -Depth $Depth
      }
    }

    $response = Invoke-RestMethod -Uri $Uri -Method $Method -Headers $Headers -Body $bodyText
    return [PSCustomObject]@{
      ok = $true
      status = 200
      data = $response
      error = $null
    }
  } catch {
    $statusCode = $null
    $errorText = $_.Exception.Message
    if ($_.Exception.Response) {
      $statusCode = $_.Exception.Response.StatusCode.value__
      try {
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $errorText = $reader.ReadToEnd()
      } catch {
        $errorText = $_.Exception.Message
      }
    }

    return [PSCustomObject]@{
      ok = $false
      status = $statusCode
      data = $null
      error = $errorText
    }
  }
}

function Get-ImageContentType([string]$path) {
  $extension = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
  switch ($extension) {
    ".jpg" { return "image/jpeg" }
    ".jpeg" { return "image/jpeg" }
    ".png" { return "image/png" }
    default { throw "Unsupported image extension: $extension" }
  }
}

function Get-SeoulDate {
  $zone = [System.TimeZoneInfo]::FindSystemTimeZoneById("Korea Standard Time")
  $now = [System.TimeZoneInfo]::ConvertTimeFromUtc((Get-Date).ToUniversalTime(), $zone)
  return $now.ToString("yyyy-MM-dd")
}

function Get-DayOfWeekNumber([string]$date) {
  $parsed = [DateTime]::ParseExact($date, "yyyy-MM-dd", $null)
  return [int]$parsed.DayOfWeek
}

$keys = supabase projects api-keys --project-ref $ProjectRef --output json | ConvertFrom-Json
$anonKey = Get-KeyByName $keys "anon"
$serviceRoleKey = Get-KeyByName $keys "service_role"

$email = "codex-e2e-$([guid]::NewGuid().ToString('N'))@example.invalid"
$password = "T11!$([guid]::NewGuid().ToString('N'))aA1"
$createdUserId = $null
$uploadedPaths = New-Object System.Collections.Generic.List[string]
$scanIds = New-Object System.Collections.Generic.List[string]

$adminHeaders = @{
  apikey = $serviceRoleKey
  Authorization = "Bearer $serviceRoleKey"
  "Content-Type" = "application/json"
}

$summary = [ordered]@{
  projectRef = $ProjectRef
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  imageResults = @()
  confirmedMedication = $null
  scheduleE2E = $null
  cleanup = @{}
}

try {
  $createUser = Invoke-JsonRequest `
    -Uri "$SupabaseUrl/auth/v1/admin/users" `
    -Method Post `
    -Headers $adminHeaders `
    -Body @{
      email = $email
      password = $password
      email_confirm = $true
      user_metadata = @{ test = "frontend-backend-e2e-validation" }
    }
  if (-not $createUser.ok) {
    throw "Failed to create temp user: $($createUser.error)"
  }
  $createdUserId = $createUser.data.id

  $tokenHeaders = @{
    apikey = $anonKey
    "Content-Type" = "application/json"
  }
  $token = Invoke-JsonRequest `
    -Uri "$SupabaseUrl/auth/v1/token?grant_type=password" `
    -Method Post `
    -Headers $tokenHeaders `
    -Body @{
      email = $email
      password = $password
    }
  if (-not $token.ok) {
    throw "Failed to sign in temp user: $($token.error)"
  }

  $authHeaders = @{
    apikey = $anonKey
    Authorization = "Bearer $($token.data.access_token)"
    "Content-Type" = "application/json"
  }

  $storageHeaders = @{
    apikey = $anonKey
    Authorization = "Bearer $($token.data.access_token)"
    "x-upsert" = "true"
  }

  $images = Get-ChildItem -Path $ImageDir -File | Where-Object {
    $_.Extension.ToLowerInvariant() -in @(".jpg", ".jpeg", ".png")
  } | Sort-Object Name

  foreach ($image in $images) {
    $scanId = [guid]::NewGuid().ToString()
    $scanIds.Add($scanId) | Out-Null
    $contentType = Get-ImageContentType $image.FullName
    $ext = if ($contentType -eq "image/png") { "png" } else { "jpeg" }
    $imagePath = "$createdUserId/$scanId/original.$ext"
    $uploadedPaths.Add($imagePath) | Out-Null

    $bytes = [System.IO.File]::ReadAllBytes($image.FullName)
    Invoke-RestMethod `
      -Uri "$SupabaseUrl/storage/v1/object/prescription-temp/$imagePath" `
      -Method Post `
      -Headers $storageHeaders `
      -ContentType $contentType `
      -Body $bytes | Out-Null

    $insertScan = Invoke-JsonRequest `
      -Uri "$SupabaseUrl/rest/v1/scan_sessions" `
      -Method Post `
      -Headers ($authHeaders + @{ Prefer = "return=minimal" }) `
      -Body @{
        id = $scanId
        user_id = $createdUserId
        image_path = $imagePath
        status = "uploaded"
      }

    $result = [ordered]@{
      image = $image.Name
      scanId = $scanId
      uploadOk = $true
      scanInsertOk = $insertScan.ok
      googleOcr = $null
      analyze = $null
      confirm = $null
    }

    if (-not $insertScan.ok) {
      $result.scanInsertError = $insertScan.error
      $summary.imageResults += [PSCustomObject]$result
      continue
    }

    $ocr = Invoke-JsonRequest `
      -Uri "$SupabaseUrl/functions/v1/google-ocr" `
      -Method Post `
      -Headers $authHeaders `
      -Body @{ scanId = $scanId }

    if ($ocr.ok) {
      $ocrText = [string]$ocr.data.ocrText
      $result.googleOcr = [ordered]@{
        ok = $true
        confidence = $ocr.data.confidence
        ocrTextLength = $ocrText.Length
        needsManualReview = $ocr.data.needsManualReview
        failureReason = $ocr.data.failureReason
        imageDeleted = $ocr.data.imageDeleted
        pharmacyName = $ocr.data.pharmacyContact.name
        pharmacyPhone = $ocr.data.pharmacyContact.phone
        preview = if ($ocrText.Length -gt 120) { $ocrText.Substring(0, 120) } else { $ocrText }
      }
    } else {
      $result.googleOcr = [ordered]@{
        ok = $false
        status = $ocr.status
        error = $ocr.error
      }
      $summary.imageResults += [PSCustomObject]$result
      continue
    }

    $analyze = Invoke-JsonRequest `
      -Uri "$SupabaseUrl/functions/v1/analyze-medication" `
      -Method Post `
      -Headers $authHeaders `
      -Body @{ scanId = $scanId }

    if ($analyze.ok) {
      $detected = @($analyze.data.detectedMedications)
      $matched = @($detected | Where-Object { $_.medication_id })
      $result.analyze = [ordered]@{
        ok = $true
        resultMode = $analyze.data.resultMode
        matchQuality = $analyze.data.matchQuality
        detectedCount = $detected.Count
        matchedCount = $matched.Count
        needsUserConfirmation = $analyze.data.needsUserConfirmation
        autoDisplayReady = $analyze.data.autoDisplayReady
        publicLookupStatus = $analyze.data.publicLookup.status
        unmatchedCandidates = @($analyze.data.unmatchedCandidates)
        detected = @($detected | ForEach-Object {
          [ordered]@{
            id = $_.id
            detectedName = $_.detected_name
            matchedName = $_.matched_name
            medicationId = $_.medication_id
            confidence = $_.confidence
            matchQuality = $_.match_quality
            needsConfirmation = $_.needs_confirmation
          }
        })
      }

      if ($null -eq $summary.confirmedMedication -and $matched.Count -gt 0) {
        $candidate = $matched[0]
        $confirm = Invoke-JsonRequest `
          -Uri "$SupabaseUrl/functions/v1/confirm-medication" `
          -Method Post `
          -Headers $authHeaders `
          -Body @{
            detectedMedicationId = $candidate.id
            startDate = Get-SeoulDate
          }

        if ($confirm.ok) {
          $result.confirm = [ordered]@{
            ok = $true
            alreadyExists = $confirm.data.alreadyExists
            userMedicationId = $confirm.data.userMedication.id
            medicationId = $confirm.data.userMedication.medication_id
            sourceScanId = $confirm.data.userMedication.source_scan_id
          }
          $summary.confirmedMedication = [ordered]@{
            image = $image.Name
            scanId = $scanId
            detectedMedicationId = $candidate.id
            matchedName = $candidate.matched_name
            userMedicationId = $confirm.data.userMedication.id
            medicationId = $confirm.data.userMedication.medication_id
          }
        } else {
          $result.confirm = [ordered]@{
            ok = $false
            status = $confirm.status
            error = $confirm.error
          }
        }
      }
    } else {
      $result.analyze = [ordered]@{
        ok = $false
        status = $analyze.status
        error = $analyze.error
      }
    }

    $summary.imageResults += [PSCustomObject]$result
  }

  if ($summary.confirmedMedication) {
    $today = Get-SeoulDate
    $dow = Get-DayOfWeekNumber $today
    $userMedicationId = $summary.confirmedMedication.userMedicationId

    $suggest = Invoke-JsonRequest `
      -Uri "$SupabaseUrl/functions/v1/suggest-medication-schedules" `
      -Method Post `
      -Headers $authHeaders `
      -Body @{
        userMedicationId = $userMedicationId
        scanId = $summary.confirmedMedication.scanId
      }

    $firstSuggestion = $null
    if ($suggest.ok -and @($suggest.data.suggestions).Count -gt 0) {
      $firstSuggestion = @($suggest.data.suggestions)[0]
    }

    $takeTime = if ($firstSuggestion) { $firstSuggestion.takeTime } else { "09:00:00" }
    $timingRule = if ($firstSuggestion) { $firstSuggestion.timingRule } else { "custom" }
    $doseAmount = if ($firstSuggestion -and $null -ne $firstSuggestion.doseAmount) { $firstSuggestion.doseAmount } else { 1 }
    $doseUnit = if ($firstSuggestion -and $firstSuggestion.doseUnit) { $firstSuggestion.doseUnit } else { "tablet" }

    $schedule = Invoke-JsonRequest `
      -Uri "$SupabaseUrl/functions/v1/medication-schedules" `
      -Method Post `
      -Headers $authHeaders `
      -Body @{
        userMedicationId = $userMedicationId
        takeTime = $takeTime
        timingRule = $timingRule
        doseAmount = $doseAmount
        doseUnit = $doseUnit
        daysOfWeek = @($dow)
        notificationEnabled = $false
        startDate = $today
      }

    $checkBefore = Invoke-JsonRequest `
      -Uri "$SupabaseUrl/functions/v1/medication-checklist" `
      -Method Post `
      -Headers $authHeaders `
      -Body @{ date = $today }

    $log = $null
    $checkAfter = $null
    if ($schedule.ok) {
      $log = Invoke-JsonRequest `
        -Uri "$SupabaseUrl/functions/v1/medication-logs-check" `
        -Method Post `
        -Headers $authHeaders `
        -Body @{
          userMedicationId = $userMedicationId
          scheduleId = $schedule.data.schedule.id
          plannedDate = $today
          plannedTime = $schedule.data.schedule.take_time
          status = "taken"
        }

      $checkAfter = Invoke-JsonRequest `
        -Uri "$SupabaseUrl/functions/v1/medication-checklist" `
        -Method Post `
        -Headers $authHeaders `
        -Body @{ date = $today }
    }

    $summary.scheduleE2E = [ordered]@{
      date = $today
      dayOfWeek = $dow
      suggestOk = $suggest.ok
      suggestionCount = if ($suggest.ok) { @($suggest.data.suggestions).Count } else { 0 }
      usedFallbackSchedule = ($null -eq $firstSuggestion)
      scheduleOk = $schedule.ok
      scheduleId = if ($schedule.ok) { $schedule.data.schedule.id } else { $null }
      checklistBeforeOk = $checkBefore.ok
      checklistBeforeSummary = if ($checkBefore.ok) { $checkBefore.data.summary } else { $null }
      logOk = if ($log) { $log.ok } else { $false }
      logStatus = if ($log -and $log.ok) { $log.data.log.status } else { $null }
      checklistAfterOk = if ($checkAfter) { $checkAfter.ok } else { $false }
      checklistAfterSummary = if ($checkAfter -and $checkAfter.ok) { $checkAfter.data.summary } else { $null }
      errors = @(
        if (-not $suggest.ok) { "suggest: $($suggest.error)" }
        if (-not $schedule.ok) { "schedule: $($schedule.error)" }
        if (-not $checkBefore.ok) { "checkBefore: $($checkBefore.error)" }
        if ($log -and -not $log.ok) { "log: $($log.error)" }
        if ($checkAfter -and -not $checkAfter.ok) { "checkAfter: $($checkAfter.error)" }
      )
    }
  }
} finally {
  foreach ($path in $uploadedPaths) {
    Invoke-RestMethod `
      -Uri "$SupabaseUrl/storage/v1/object/prescription-temp" `
      -Method Delete `
      -Headers @{
        apikey = $serviceRoleKey
        Authorization = "Bearer $serviceRoleKey"
        "Content-Type" = "application/json"
      } `
      -Body (@{ prefixes = @($path) } | ConvertTo-Json) `
      -ErrorAction SilentlyContinue | Out-Null
  }

  if ($createdUserId) {
    Invoke-RestMethod `
      -Uri "$SupabaseUrl/auth/v1/admin/users/$createdUserId" `
      -Method Delete `
      -Headers $adminHeaders `
      -ErrorAction SilentlyContinue | Out-Null
    $summary.cleanup.tempUserDeleted = $true
  }
}

$jsonPath = [System.IO.Path]::ChangeExtension($ResultPath, ".json")
$resultDir = [System.IO.Path]::GetDirectoryName($ResultPath)
if ($resultDir -and -not (Test-Path $resultDir)) {
  New-Item -ItemType Directory -Path $resultDir | Out-Null
}

$summaryObject = [PSCustomObject]$summary
$summaryObject | ConvertTo-Json -Depth 20 | Set-Content -Path $jsonPath -Encoding UTF8

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# Frontend-backend OCR/E2E validation result")
$lines.Add("")
$lines.Add("- Generated UTC: $($summary.generatedAt)")
$lines.Add("- Project: $ProjectRef")
$lines.Add("- Image directory: $ImageDir")
$lines.Add("- Temp user deleted: $($summary.cleanup.tempUserDeleted)")
$lines.Add("")
$lines.Add("## 1. OCR/analyze/confirm by image")
$lines.Add("")
$lines.Add("| Image | OCR | confidence | manual | failureReason | imageDeleted | analyze mode | detected/matched | confirm |")
$lines.Add("|---|---|---:|---|---|---|---|---:|---|")
foreach ($item in $summary.imageResults) {
  $ocrStatus = if ($item.googleOcr -and $item.googleOcr.ok) { "PASS" } else { "FAIL" }
  $confidence = if ($item.googleOcr -and $item.googleOcr.ok) { $item.googleOcr.confidence } else { "" }
  $manual = if ($item.googleOcr -and $item.googleOcr.ok) { $item.googleOcr.needsManualReview } else { "" }
  $failureReason = if ($item.googleOcr -and $item.googleOcr.ok) { $item.googleOcr.failureReason } else { $item.googleOcr.error }
  $imageDeleted = if ($item.googleOcr -and $item.googleOcr.ok) { $item.googleOcr.imageDeleted } else { "" }
  $mode = if ($item.analyze -and $item.analyze.ok) { $item.analyze.resultMode } else { "FAIL" }
  $detectedMatched = if ($item.analyze -and $item.analyze.ok) { "$($item.analyze.detectedCount)/$($item.analyze.matchedCount)" } else { "0/0" }
  $confirmStatus = if ($item.confirm -and $item.confirm.ok) { "PASS" } elseif ($item.confirm) { "FAIL" } else { "SKIP" }
  $lines.Add("| $($item.image) | $ocrStatus | $confidence | $manual | $failureReason | $imageDeleted | $mode | $detectedMatched | $confirmStatus |")
}

$lines.Add("")
$lines.Add("## 2. Confirm and schedule E2E")
$lines.Add("")
if ($summary.confirmedMedication) {
  $lines.Add("- Confirmed image: $($summary.confirmedMedication.image)")
  $lines.Add("- Matched medication: $($summary.confirmedMedication.matchedName)")
  $lines.Add("- userMedicationId: $($summary.confirmedMedication.userMedicationId)")
} else {
  $lines.Add("- No medication was confirmed")
}

if ($summary.scheduleE2E) {
  $lines.Add("- suggest call: $($summary.scheduleE2E.suggestOk), suggestion count: $($summary.scheduleE2E.suggestionCount)")
  $lines.Add("- fallback schedule used: $($summary.scheduleE2E.usedFallbackSchedule)")
  $lines.Add("- schedule created: $($summary.scheduleE2E.scheduleOk)")
  $lines.Add("- checklist before: $($summary.scheduleE2E.checklistBeforeOk)")
  $lines.Add("- log taken: $($summary.scheduleE2E.logOk), status: $($summary.scheduleE2E.logStatus)")
  $lines.Add("- checklist after: $($summary.scheduleE2E.checklistAfterOk)")
  $lines.Add("")
  $lines.Add("Checklist before summary:")
  $lines.Add('```json')
  $lines.Add(($summary.scheduleE2E.checklistBeforeSummary | ConvertTo-Json -Depth 5))
  $lines.Add('```')
  $lines.Add("")
  $lines.Add("Checklist after summary:")
  $lines.Add('```json')
  $lines.Add(($summary.scheduleE2E.checklistAfterSummary | ConvertTo-Json -Depth 5))
  $lines.Add('```')
}

$lines.Add("")
$lines.Add("## 3. Raw JSON")
$lines.Add("")
$lines.Add("- Detail JSON: $jsonPath")

$lines | Set-Content -Path $ResultPath -Encoding UTF8

$summaryObject | ConvertTo-Json -Depth 20
