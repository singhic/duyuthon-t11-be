# check-interactions

## Purpose

현재 복용약과 신규 약품 간 상호작용 검사 응답을 검증한다.

## Input

```json
{
  "medicationId": "70a3dac4-67fe-47e7-aead-27ab049abff2"
}
```

## Output

```json
{
  "severity": "unknown",
  "overallSeverity": "no_registered_warning",
  "isConfirmedSafe": false,
  "interactionCount": 0,
  "comparedMedicationCount": 1,
  "message": "현재 등록된 상호작용 경고는 없습니다. 다만 자동 검사 결과만으로 안전을 단정할 수는 없으니, 처방약은 의사 또는 약사에게 확인하세요."
}
```

## Result

PASS. “안전함”으로 단정하지 않고 `no_registered_warning`으로 반환했다.
