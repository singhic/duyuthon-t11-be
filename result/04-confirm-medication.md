# confirm-medication

## Purpose

분석된 약품 후보를 사용자의 현재 복용약으로 확정 등록한다.

## Input

```json
{
  "detectedMedicationId": "matched-detected-medication-id",
  "startDate": "2026-05-23",
  "customName": "테스트 복용약"
}
```

## Output

```json
{
  "alreadyExists": false,
  "userMedicationId": "temporary-user-medication-id",
  "medicationId": "70a3dac4-67fe-47e7-aead-27ab049abff2",
  "customName": "테스트 복용약",
  "active": true
}
```

## Result

PASS. 매칭된 약품이 현재 복용약으로 등록됐다.
