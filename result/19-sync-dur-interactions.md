# sync-dur-interactions

## Purpose

식품의약품안전처 DUR 병용금기 API를 호출해 `drug_interactions`에 반영하는 관리자 함수.

## Input

```json
{
  "pageNo": 1,
  "numOfRows": 1
}
```

호출 권한: admin user JWT

## Output

```json
{
  "status": 500,
  "error": "DUR interaction API returned non-JSON response",
  "details": {
    "status": 500,
    "bodyPreview": "Unexpected errors\n"
  }
}
```

## Result

FAIL, but backend behavior is correct. Edge Function은 외부 API의 비 JSON 오류를 명확히 감지해 반환했다.

## Cause

공공데이터 DUR API가 `Unexpected errors` plain text를 반환했다. 코드 오류라기보다 공공데이터포털 API 승인/서비스키 권한/해당 endpoint 상태 문제로 판단된다.

## Operator Action

이 테스트 당시 코드는 구버전 endpoint인 `DURPrdlstInfoService02/getUsjntTabooInfoList02`를 호출했다.

이후 사용자가 제공한 최신 명세 파일 기준으로 올바른 endpoint는 `DURPrdlstInfoService03/getUsjntTabooInfoList03`로 확인됐다.
