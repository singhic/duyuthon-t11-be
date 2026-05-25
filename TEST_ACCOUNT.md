# FCM Cron 테스트 계정 정보

## 테스트 설정 (2026-05-25)

### 테스트 사용자

- **User ID:** (로그인 후 기록)
  ```
  콘솔에서: supabase.auth.getUser() → user.id
  또는 DB에서: SELECT id FROM auth.users WHERE email = '<test-email>';
  ```
- **테스트 이메일:**
- **로그인 상태:** ✅ (로그인 후 확인)

### 테스트 약품

- **약품명:** 타이레놀 ER
- **약품 ID:** (DB에서 조회)
  ```sql
  SELECT id, item_name FROM medications
  WHERE item_name LIKE '%타이레놀%ER%' LIMIT 1;
  ```

### 테스트 일정

- **일정 ID:** (생성 후 기록)
- **복용 시간 (KST):** (현재 시간 + 15분)
- **알림 활성화:** ✅ notification_enabled=true
- **상태:** active=true

### FCM Token (단계 3에서)

- **FCM Token:** (저장 후 기록)
- **Token ID:** (DB에서 조회)
- **저장 상태:** ✅ notification_tokens에 저장됨

---

## 실행 명령어

### 1. 테스트 약품 조회

```sql
SELECT id, item_name, item_seq, administration_timing
FROM medications
WHERE item_name ILIKE '%타이레놀%' AND item_name ILIKE '%ER%'
LIMIT 5;
```

### 2. 테스트 사용자 조회

```sql
SELECT id, email, created_at FROM auth.users
ORDER BY created_at DESC LIMIT 1;
```

### 3. 현재 시간 기준 일정 생성

```
프론트 API: medication-schedules POST
{
  "medicationId": "<약품-id>",
  "frequency": "once_daily",
  "plannedTime": "HH:MM" (현재시간 + 15분),
  "startDate": "2026-05-25",
  "notificationEnabled": true
}
```

### 4. 생성된 일정 확인

```sql
SELECT id, user_id, medication_id, planned_time, notification_enabled, active
FROM medication_schedules
WHERE user_id = '<test-user-id>'
AND active = true
AND notification_enabled = true
ORDER BY planned_time;
```
