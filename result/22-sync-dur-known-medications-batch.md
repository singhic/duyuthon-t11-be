# sync-dur-interactions Known Medications Batch

## Purpose

`sync-drug-master` 또는 OCR cache-aside로 이미 적재된 `medications.item_seq`를 기준으로 DUR 병용금기 정보를 함께 적재할 수 있는지 검증했다.

## Code Change

수정 파일:

- `supabase/functions/sync-dur-interactions/index.ts`

추가된 요청 필드:

```ts
type RequestBody = {
  pageNo?: number;
  numOfRows?: number;
  itemSeq?: string;
  syncKnownMedications?: boolean;
  medicationLimit?: number;
  medicationOffset?: number;
  maxDurRowsPerMedication?: number;
};
```

운영 모드:

- 기존 page 호출 유지
- 기존 `itemSeq` 단건 호출 유지
- 신규 `syncKnownMedications=true` batch 호출 추가

## Deployment

```text
Deployed Functions on project hygsrrmoawezonahnljn: sync-dur-interactions
```

## Input

```json
{
  "syncKnownMedications": true,
  "medicationLimit": 2,
  "medicationOffset": 0,
  "maxDurRowsPerMedication": 20
}
```

호출 권한: admin user JWT

## Output

```json
{
  "mode": "known_medications",
  "pageNo": 1,
  "numOfRows": 100,
  "itemSeq": null,
  "syncKnownMedications": true,
  "medicationLimit": 2,
  "medicationOffset": 0,
  "medicationBatchCount": 2,
  "medicationTotalCount": 451,
  "apiRequestCount": 2,
  "apiItemCount": 20,
  "insertedOrUpdatedCount": 20,
  "skippedCount": 0
}
```

## Result

PASS.

원격 DB에 이미 적재된 약품 2건의 `item_seq`를 기준으로 DUR API를 2회 호출했고, 20개 DUR 항목을 `drug_interactions`에 insert/update했다.

## Operational Rule

정기 운영은 다음 흐름으로 고정한다.

```text
1. sync-drug-master 또는 analyze-medication cache-aside로 medications 적재
2. sync-dur-interactions syncKnownMedications=true 실행
3. medicationOffset을 증가시키며 batch 반복
4. gemini-chat/check-interactions는 적재된 drug_interactions만 근거로 사용
5. 근거가 없으면 안전하다고 답하지 않음
```

권장 batch 크기:

```text
medicationLimit: 20~50
maxDurRowsPerMedication: 100
```

한 번에 전체 약품을 모두 돌리면 Edge Function timeout 또는 공공 API quota 문제가 생길 수 있으므로, offset 기반으로 나눠 실행한다.
