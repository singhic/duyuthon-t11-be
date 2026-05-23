# medication-report

## Purpose

복약 로그를 기반으로 일별 복약률 리포트가 계산되는지 검증한다.

## Input

```json
{
  "startDate": "2026-05-23",
  "endDate": "2026-05-23"
}
```

## Output

```json
{
  "startDate": "2026-05-23",
  "endDate": "2026-05-23",
  "daily": [
    {
      "report_date": "2026-05-23",
      "planned_count": 1,
      "taken_count": 1,
      "missed_count": 0,
      "skipped_count": 0,
      "adherence_rate": 100
    }
  ],
  "summary": "선택한 기간의 복약 완료율은 100%입니다. 완료 1건, 미복용 0건, 건너뜀 0건입니다."
}
```

## Result

PASS. 체크된 복용 로그가 리포트에 반영됐다.
