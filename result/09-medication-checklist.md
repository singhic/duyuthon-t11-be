# medication-checklist

## Purpose

오늘 복약 체크리스트 조회와 복용 완료 후 상태 반영을 검증한다.

## Input Before Check

```json
{
  "date": "2026-05-23"
}
```

## Output Before Check

```json
{
  "date": "2026-05-23",
  "summary": {
    "total": 1,
    "pending": 1,
    "taken": 0,
    "missed": 0,
    "skipped": 0
  },
  "itemCount": 1,
  "firstItem": {
    "medicationName": "테스트 복용약",
    "status": "pending",
    "plannedTime": "14:24:38"
  }
}
```

## Output After Check

```json
{
  "date": "2026-05-23",
  "summary": {
    "total": 1,
    "pending": 0,
    "taken": 1,
    "missed": 0,
    "skipped": 0
  },
  "itemCount": 1,
  "firstItem": {
    "medicationName": "테스트 복용약",
    "status": "taken",
    "plannedTime": "14:24:38"
  }
}
```

## Result

PASS. 복용 체크 전에는 `pending`, 체크 후에는 `taken`으로 반영됐다.
