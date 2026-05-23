# sync-drug-master

## Purpose

공공 의약품 DB에서 약품 정보를 가져와 `medications`, `ingredients`, `medication_ingredients`에 저장하는 관리자 함수.

## Input

```json
{
  "itemName": "타이레놀",
  "pageNo": 1,
  "numOfRows": 3
}
```

호출 권한: admin user JWT

## Output

```json
{
  "pageNo": 1,
  "numOfRows": 3,
  "medicationCount": 3,
  "ingredientCount": 6
}
```

## Result

PASS. 공공 의약품 API 호출과 DB upsert가 정상 동작했다.
