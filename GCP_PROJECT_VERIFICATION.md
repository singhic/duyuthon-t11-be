# Firebase/GCP 프로젝트 일치 확인

프론트 FCM token은 `duyuthon-iyakmoji` Firebase 프로젝트에서 발급된다. 백엔드 FCM HTTP v1 발송도 같은 프로젝트로 보내야 한다.

## 확인할 값

프론트 env:

```text
VITE_FIREBASE_PROJECT_ID=duyuthon-iyakmoji
VITE_FIREBASE_MESSAGING_SENDER_ID=196557617071
```

Supabase Edge Secret:

```text
FCM_PROJECT_ID=duyuthon-iyakmoji
FCM_SERVICE_ACCOUNT_JSON=<duyuthon-iyakmoji FCM send 권한을 가진 서비스 계정 JSON>
```

## 반드시 맞아야 하는 조건

- Firebase Console project id가 `duyuthon-iyakmoji`
- Google Cloud Console project id가 `duyuthon-iyakmoji`
- `FCM_SERVICE_ACCOUNT_JSON`의 서비스 계정이 `duyuthon-iyakmoji` 프로젝트에 속해 있거나, 해당 프로젝트에서 FCM 발송 권한을 부여받음
- Firebase Cloud Messaging API 활성화
- 서비스 계정에 `Firebase Cloud Messaging API Admin` 또는 동등한 `firebase.messaging.messages.create` 권한 존재

## 현재 주의점

열려 있는 로컬 파일 `iyakmoji-firebase-adminsdk-fbsvc-e8223197f8.json`은 `project_id=iyakmoji`인 서비스 계정이다. 프론트 프로젝트 `duyuthon-iyakmoji`와 다르므로, 실발송 전에는 새 서비스 계정 JSON을 준비하거나 IAM 권한을 명확히 부여해야 한다.
