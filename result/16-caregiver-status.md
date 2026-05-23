# caregiver-status

## Purpose

현재 사용자의 보호자 연결 상태 조회를 검증한다.

## Input

```json
{
  "method": "GET"
}
```

## Output

```json
{
  "totalLinks": 1,
  "asPatient": 0,
  "asCaregiver": 1,
  "firstStatus": "accepted"
}
```

## Result

PASS. 보호자 계정에서 환자와의 accepted link를 조회했다.
