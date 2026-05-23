# sync-dur-interactions Retest

## Purpose

사용자가 제공한 최신 `식품의약품안전처_의약품안전사용서비스(DUR)품목정보.txt` 명세를 기준으로 `sync-dur-interactions`의 endpoint와 응답 구조를 재확인하고, 수정 후 원격에서 재검증했다.

## Finding

기존 코드는 구버전 endpoint를 호출하고 있었다.

```text
https://apis.data.go.kr/1471000/DURPrdlstInfoService02/getUsjntTabooInfoList02
```

명세 파일 기준 최신 병용금기 정보조회 endpoint는 아래가 맞다.

```text
https://apis.data.go.kr/1471000/DURPrdlstInfoService03/getUsjntTabooInfoList03
```

명세 파일의 주요 근거:

- Base URL: `apis.data.go.kr/1471000/DURPrdlstInfoService03`
- Operation: `GET /getUsjntTabooInfoList03`
- 요청 파라미터: `serviceKey`, `pageNo`, `numOfRows`, `type`, `typeName`, `ingrCode`, `itemName`, `start_change_date`, `end_change_date`, `itemSeq`, `bizrno`
- 응답 구조: `header`, `body.items.item`
- 병용금기 주요 필드: `ITEM_SEQ`, `ITEM_NAME`, `INGR_KOR_NAME`, `MIXTURE_ITEM_SEQ`, `MIXTURE_ITEM_NAME`, `MIXTURE_INGR_KOR_NAME`, `PROHBT_CONTENT`, `REMARK`, `DUR_SEQ`

## Code Change

수정 파일:

- `supabase/functions/sync-dur-interactions/index.ts`

수정 내용:

- endpoint를 `DURPrdlstInfoService03/getUsjntTabooInfoList03`로 변경
- log endpoint를 `getUsjntTabooInfoList03`로 변경
- 명세에 없는 중복 파라미터 `ItemSeq` 제거

응답 파싱 로직은 명세 구조와 맞다.

```ts
apiBody?.body?.items?.item
```

필드 매핑도 병용금기 응답 구조와 맞다.

```ts
ITEM_SEQ
ITEM_NAME
INGR_KOR_NAME
MIXTURE_ITEM_SEQ
MIXTURE_ITEM_NAME
MIXTURE_INGR_KOR_NAME
PROHBT_CONTENT
REMARK
DUR_SEQ
```

## Deployment

원격 Edge Function 배포 완료.

```text
Deployed Functions on project hygsrrmoawezonahnljn: sync-dur-interactions
```

배포 후 원격 상태:

```json
{
  "name": "sync-dur-interactions",
  "status": "ACTIVE",
  "verify_jwt": true,
  "version": 3
}
```

## Retest Method

운영자 승인에 따라 Supabase project API key를 CLI로 조회하되 값은 출력하지 않고 PowerShell 변수 안에서만 사용했다.

1. 임시 auth user 생성
2. `user_profiles.role = 'admin'` profile 생성
3. password grant로 임시 admin JWT 발급
4. `sync-dur-interactions` 호출
5. 임시 auth user 삭제

## Input

```json
{
  "pageNo": 1,
  "numOfRows": 1
}
```

호출 권한: admin user JWT

## Setup Output

```json
{
  "createUser": {
    "ok": true,
    "userId": "6c320113-3ec2-4039-bd83-f32110b2b769"
  },
  "profileInsert": {
    "statusCode": 201
  },
  "signIn": {
    "ok": true,
    "tokenType": "bearer"
  },
  "cleanup": {
    "statusCode": 200,
    "deletedUserId": "6c320113-3ec2-4039-bd83-f32110b2b769"
  }
}
```

## Function Output

HTTP status:

```json
200
```

Response body:

```json
{
  "pageNo": 1,
  "numOfRows": 1,
  "apiItemCount": 1,
  "insertedOrUpdatedCount": 1,
  "skippedCount": 0
}
```

## API Usage Log

```json
{
  "created_at": "2026-05-23 06:45:49.226753+00",
  "endpoint": "getUsjntTabooInfoList03",
  "request_count": 1,
  "status": "succeeded"
}
```

## Result

PASS.

`sync-dur-interactions`는 최신 DUR 병용금기 API 명세 기준으로 수정 및 원격 배포됐고, 실제 원격 호출에서 1건을 `drug_interactions`에 insert/update했다.

## Judgment

기존 실패 원인은 공공데이터 키 승인 문제가 아니라 구버전 endpoint 사용이었다.

최신 명세 기준으로는 다음 구조가 맞다.

```text
Base URL: https://apis.data.go.kr/1471000/DURPrdlstInfoService03
Path: /getUsjntTabooInfoList03
Method: GET
Required query: serviceKey
Common query: pageNo, numOfRows, type=json
Optional filters: itemSeq, itemName, ingrCode, typeName, start_change_date, end_change_date, bizrno
Response: header + body.items.item
```
