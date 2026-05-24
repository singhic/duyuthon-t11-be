이 문서는 프론트엔드 작업자가 Supabase Auth부터 OCR, 약품 분석, 챗봇, 복약 일정 API까지 바로 붙일 수 있도록 정리한 연동 문서다

현재 원격 Supabase 프로젝트:

```
Project ref: hygsrrmoawezonahnljn
Project URL: https://hygsrrmoawezonahnljn.supabase.co
```

## 1. 프론트엔드에서 필요한 환경변수

프론트엔드에는 공개 가능한 값만 넣는다.

### Vite

```
VITE_SUPABASE_URL=https://hygsrrmoawezonahnljn.supabase.co
VITE_SUPABASE_ANON_KEY=<Supabase anon 또는 publishable key>
VITE_FIREBASE_API_KEY=<Firebase web api key>
VITE_FIREBASE_AUTH_DOMAIN=iyakmoji.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=iyakmoji
VITE_FIREBASE_STORAGE_BUCKET=iyakmoji.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=478796151576
VITE_FIREBASE_APP_ID=1:478796151576:web:e25daf3fc1cc32345ffc6d
VITE_FIREBASE_WEB_PUSH_VAPID_KEY=<Firebase Console Web Push certificate key>
```

### Next.js

```
NEXT_PUBLIC_SUPABASE_URL=https://hygsrrmoawezonahnljn.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<Supabase anon 또는 publishable key>
NEXT_PUBLIC_FIREBASE_API_KEY=<Firebase web api key>
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=iyakmoji.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=iyakmoji
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=iyakmoji.firebasestorage.app
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=478796151576
NEXT_PUBLIC_FIREBASE_APP_ID=1:478796151576:web:e25daf3fc1cc32345ffc6d
NEXT_PUBLIC_FIREBASE_WEB_PUSH_VAPID_KEY=<Firebase Console Web Push certificate key>
```

<aside>
💡

ANON키는 @서상혁 에게 개인 DM으로 요청 부탁드립니다.

</aside>

프론트엔드에 절대 넣으면 안 되는 값:

```
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_SECRET_KEYS
GOOGLE_SERVICE_ACCOUNT_JSON
GOOGLE_VISION_API_KEY
GEMINI_API_KEY
DATA_GO_KR_SERVICE_KEY
FCM_PROJECT_ID
CRON_SECRET
```

위 값들은 모두 Supabase Edge Function Secret으로만 사용한다.

Firebase Web config와 VAPID public key는 프론트에 들어갈 수 있는 공개 설정이다. 다만 Google Cloud/Firebase Console에서 API key HTTP referrer 제한을 걸고, `GOOGLE_SERVICE_ACCOUNT_JSON` 같은 서버 권한 값은 절대 프론트에 넣지 않는다.

## 2. Supabase 클라이언트 생성

예시는 `@supabase/supabase-js` 기준이다.

```tsx
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
```

Next.js라면:

```tsx
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);
```

## 3. Auth 연동

현재 Google OAuth provider는 Supabase에 연결되어 있고, OAuth 시작 URL이 Google로 정상 리다이렉트되는 것을 확인했다.

### 3.1 Google 로그인

```tsx
export async function signInWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
    },
  });

  if (error) throw error;
  return data;
}
```

프론트 라우터에는 다음 경로를 준비한다.

```
/auth/callback
```

### 3.2 OAuth callback 처리

Supabase JS v2는 callback URL 진입 후 세션을 자동 복구할 수 있다. 앱 시작 시 아래처럼 세션을 확인한다.

```tsx
export async function getCurrentSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}
```

로그인 사용자 확인:

```tsx
export async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  return data.user;
}
```

로그아웃:

```tsx
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
```

### 3.3 로그인 후 프로필 생성

로그인 직후 `user_profiles`에 프로필이 없으면 생성한다.

```tsx
export async function ensureUserProfile() {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;

  const user = userData.user;
  if (!user) throw new Error("로그인이 필요합니다.");

  const { data: existing, error: selectError } = await supabase
    .from("user_profiles")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (selectError) throw selectError;
  if (existing) return existing;

  const { data, error } = await supabase
    .from("user_profiles")
    .insert({
      user_id: user.id,
      display_name:
        user.user_metadata?.full_name ??
        user.user_metadata?.name ??
        "사용자",
      role: "patient",
      accessibility_preference: {},
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}
```

주의:

- 프론트에서 `role: "admin"`을 넣으면 RLS 정책상 거부된다.
- 일반 사용자는 `patient` 또는 `caregiver`만 생성 가능하다.

## 4. 핵심 사용자 플로우

### 4.0 MVP 필수 흐름 고정

프론트는 아래 순서를 기준으로 구현한다.

```
(v - auth.service,AuthContext) 1. 로그인
(v - imageprocessing) 2. 처방전/약봉투/약 포장 이미지 업로드
(v - imageprocessing) 3. scan_sessions 생성
(v - loadingScreen) 4. google-ocr 호출
(v - Analyze) 5. analyze-medication 호출
(v - loadingScreen) 6. resultMode에 따라 약 정보 표시 또는 재촬영/확인 안내
(v - MedicineSelection) 7. 사용자가 약 후보를 확인하면 confirm-medication 호출
(담경 파트) 8. 복용법을 보고 medication-schedules 생성
(담경 파트) 9. 오늘 먹을 약 체크리스트 표시
(담경 파트) 10. 복용 완료/건너뜀 선택 시 medication-logs-check 호출
(v - ChatBot) 11. 사용자가 질문하면 gemini-chat 호출
() 12. 필요한 경우 check-interactions 호출
(태성 파트) 13. 푸시 알림
```

프론트에서 금지하는 처리:

- OCR 결과만 보고 현재 복용약 자동 등록
- `null`인 복용법/주의사항을 프론트에서 추측 생성
- `overallSeverity = "no_registered_warning"`을 “안전함”으로 표시
- Gemini 응답의 `disclaimer` 제거
- 같은 약을 active 복용약으로 직접 중복 insert
- [x]  사진 기반 OCR 분석 플로우는 다음 순서다.
    
    ```
    1. 로그인 확인
    2. scanId 생성
    3. Storage prescription-temp 버킷에 이미지 업로드
    4. scan_sessions row 생성
    5. google-ocr Edge Function 호출
    6. analyze-medication Edge Function 호출
    7. 사용자가 후보 약품 확인
    8. confirm-medication Edge Function 호출
    9. 필요 시 delete-scan-image Edge Function 호출
    ```
    

이미지 보관 정책:

- OCR 성공 시 백엔드가 원본 이미지를 즉시 삭제하고 `scan_sessions.image_path`를 비운다.
- [x]  앱 종료, 네트워크 장애, 화면 이탈 등으로 즉시 삭제 호출이 누락되어도 만료된 scan session의 남은 원본 이미지는 백엔드 redaction job이 TTL 기준으로 정리한다.
- 기본 TTL은 `scan_sessions.expires_at` 기준이며 현재 생성 후 30일이다.
- TTL cleanup은 scan session row 자체를 삭제하지 않고 Storage object 삭제 후 `image_path=null`, `image_deleted_at` 기록만 남긴다.

## 5. 공통 API 호출 규칙

모든 Edge Function은 로그인 세션이 필요하다. 프론트에서는 `supabase.functions.invoke()`를 사용하면 현재 세션의 Authorization header가 자동으로 포함된다.

직접 HTTP로 호출해야 한다면 다음 형식을 사용한다.

```
POST https://hygsrrmoawezonahnljn.supabase.co/functions/v1/{function-name}
Authorization: Bearer {access_token}
Content-Type: application/json
```

공통 실패 응답:

```tsx
type ApiErrorResponse = {
  error: string;
  details?: unknown | null;
};
```

주요 HTTP status:

```
400: 요청 body 누락 또는 형식 오류
401: 로그인 세션 없음 또는 만료
403: 본인 데이터가 아니거나 admin 권한 없음
404: 대상 scan, 약품, 보호자 링크 등을 찾을 수 없음
405: 지원하지 않는 HTTP method
429: 일일 OCR/Gemini 사용량 초과
500: 서버 내부 처리 실패
502: Google OCR/Gemini/FCM 등 외부 API 응답 오류
```

프론트 처리 원칙:

- `401`은 재로그인으로 보낸다.
- `403`은 “접근 권한이 없습니다”로 표시한다.
- `429`는 “오늘 사용 가능한 횟수를 초과했습니다”로 표시한다.
- `500` 또는 `502`는 재시도 버튼과 전문가 확인 안내를 같이 제공한다.
- `details`는 개발/로그용이다. 그대로 사용자에게 보여주지 않는다.

## 6. 이미지 업로드

이미지는 `prescription-temp` private bucket에 업로드한다.

경로 규칙:

```
{user_id}/{scan_id}/original.{ext}
```

예시:

```tsx
export async function uploadPrescriptionImage(file: File) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const user = userData.user;
  if (!user) throw new Error("로그인이 필요합니다.");

  const scanId = crypto.randomUUID();
  if (!["image/jpeg", "image/png"].includes(file.type)) {
    throw new Error("jpg, jpeg, png 이미지만 업로드할 수 있습니다.");
  }

  const ext = file.type === "image/png" ? "png" : "jpeg";
  const imagePath = `${user.id}/${scanId}/original.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from("prescription-temp")
    .upload(imagePath, file, {
      contentType: file.type,
      upsert: true,
    });

  if (uploadError) throw uploadError;

  const { error: scanError } = await supabase
    .from("scan_sessions")
    .insert({
      id: scanId,
      user_id: user.id,
      image_path: imagePath,
      status: "uploaded",
    });

  if (scanError) throw scanError;

  return { scanId, imagePath };
}
```

지원 MIME type:

```
image/jpeg
image/png
```

`image/webp`, `image/heic`는 MVP OCR 직접 지원 대상이 아니다. 프론트에서 `jpeg` 또는 `png`로 변환한 뒤 업로드한다.

현재 Storage 파일 제한:

```
10MiB
```

## 7. OCR 호출

Edge Function:

```
POST /functions/v1/google-ocr
```

Request Body:

```tsx
type GoogleOcrRequest = {
  scanId: string;
};
```

Response Body:

```tsx
type GoogleOcrResponse = {
  scanId: string;
  ocrText: string;
  confidence: number | null;
  imageDeleted: boolean;
  needsManualReview: boolean;
  failureReason: "empty_ocr_text" | "low_ocr_confidence" | "ocr_request_failed" | "unsupported_image_type" | null;
  recommendedAction: string;
  pharmacyContact: {
    name: string | null;
    phone: string | null;
    address: string | null;
    rawLine: string | null;
    confidence: "high" | "medium" | "low";
    source: "ocr";
  } | null;
  next: string;
};
```

Supabase JS:

```tsx
export async function runOcr(scanId: string) {
  const { data, error } = await supabase.functions.invoke("google-ocr", {
    body: { scanId },
  });

  if (error) throw error;
  return data as {
    scanId: string;
    ocrText: string;
    confidence: number | null;
    imageDeleted: boolean;
    needsManualReview: boolean;
    failureReason: string | null;
    recommendedAction: string;
    pharmacyContact: {
      name: string | null;
      phone: string | null;
      address: string | null;
      rawLine: string | null;
      confidence: "high" | "medium" | "low";
      source: "ocr";
    } | null;
    next: string;
  };
}
```

성공 응답 예시:

```json
{
  "scanId": "uuid",
  "ocrText": "타이레놀정 500mg ...",
  "confidence": 0.91,
  "imageDeleted": true,
  "needsManualReview": false,
  "failureReason": null,
  "recommendedAction": "Call /functions/v1/analyze-medication",
  "pharmacyContact": {
    "name": "이약뭐지약국",
    "phone": "02-1234-5678",
    "address": "서울특별시 ...",
    "rawLine": "이약뭐지약국 TEL 02-1234-5678",
    "confidence": "high",
    "source": "ocr"
  },
  "next": "Call /functions/v1/analyze-medication"
}
```

저신뢰도 응답 예시:

```json
{
  "scanId": "uuid",
  "ocrText": "#8888\nDRIVE\nL\n0",
  "confidence": 0.61,
  "imageDeleted": true,
  "needsManualReview": true,
  "failureReason": "low_ocr_confidence",
  "recommendedAction": "OCR 신뢰도가 낮습니다. 인식된 약 이름과 복용법을 사용자가 직접 확인해야 합니다.",
  "pharmacyContact": null,
  "next": "OCR 신뢰도가 낮습니다. 인식된 약 이름과 복용법을 사용자가 직접 확인해야 합니다."
}
```

대표 실패 응답:

```json
{
  "error": "Scan session not found",
  "details": null
}
```

현재 OCR은 `GOOGLE_SERVICE_ACCOUNT_JSON` 기반 서비스 계정 인증으로 정상 작동한다.

UI 분기:

- `needsManualReview = true`: 자동 결과를 확정하지 말고 재촬영 또는 약사/의사 확인 안내를 표시한다.
- `failureReason = "low_ocr_confidence"`: 인식 텍스트는 보여주되 약품 등록 전 사용자 확인을 강제한다.
- `failureReason = "empty_ocr_text"`: 재촬영 안내를 우선 표시한다.
- `failureReason = "unsupported_image_type"`: 프론트 변환 또는 재업로드 안내를 표시한다.
    
    -png,jpg,webp,heic 모두 대응해둬서 그냥 재촬영으로 돌려보냄.
    
- `pharmacyContact`가 있으면 OCR 실패/저신뢰도 화면에서 처방 약국 연락처로 보여줄 수 있다.

## 8. 약품 분석 호출

Edge Function:

```
POST /functions/v1/analyze-medication
```

Request Body:

```tsx
type AnalyzeMedicationRequest = {
  scanId: string;
};
```

Response Body:

```tsx
type AnalyzeMedicationResponse = {
  scanId: string;
  candidates: string[];
  detectedMedications: Array<{
    id: string;
    scan_id: string;
    medication_id: string | null;
    detected_name: string;
    matched_name: string | null;
    confidence: number;
    match_quality: "high" | "medium" | "low" | "none" | "unknown";
    match_method: "exact" | "fuzzy" | "alias" | "edi_code" | "barcode" | "manual_review" | "none";
    dosage_instruction: Record<string, unknown>;
    warning_message: string | null;
    needs_confirmation: boolean;
    created_at: string;
    medications: {
      id: string;
      item_name: string;
      entp_name: string | null;
      efficacy: string | null;
      dosage: string | null;
      precautions: string | null;
      side_effects: string | null;
      storage_method: string | null;
      administration_timing: string | null;
      information_completeness: Record<string, boolean> | null;
      source: string | null;
      source_updated_at: string | null;
    } | null;
  }>;
  resultMode: "ready" | "review_required" | "no_candidates";
  matchQuality: "high" | "medium" | "low" | "none";
  unmatchedCandidates: string[];
  needsUserConfirmation: boolean;
  autoDisplayReady: boolean;
  informationAvailability: {
    hasMedicationDetails: boolean;
    missingFields: string[];
  };
  publicLookup: {
    attempted: boolean;
    status: "not_needed" | "succeeded" | "partial" | "failed" | "skipped_low_confidence";
    queriedCandidates: string[];
    insertedMedicationCount: number;
    message: string;
  };
  recommendedAction: string;
};
```

```tsx
export async function analyzeMedication(scanId: string) {
  const { data, error } = await supabase.functions.invoke("analyze-medication", {
    body: { scanId },
  });

  if (error) throw error;
  return data as {
    scanId: string;
    candidates: string[];
    detectedMedications: Array<{
      id: string;
      scan_id: string;
      medication_id: string | null;
      detected_name: string;
      matched_name: string | null;
      confidence: number;
      match_quality: "high" | "medium" | "low" | "none" | "unknown";
      match_method:
        | "exact"
        | "fuzzy"
        | "alias"
        | "edi_code"
        | "barcode"
        | "manual_review"
        | "none";
      warning_message: string | null;
      needs_confirmation: boolean;
      medications: {
        id: string;
        item_name: string;
        entp_name: string | null;
        efficacy: string | null;
        dosage: string | null;
        precautions: string | null;
        side_effects: string | null;
        storage_method: string | null;
        administration_timing: string | null;
        information_completeness: Record<string, boolean> | null;
        source: string | null;
        source_updated_at: string | null;
      } | null;
    }>;
    resultMode: "ready" | "review_required" | "no_candidates";
    matchQuality: "high" | "medium" | "low" | "none";
    unmatchedCandidates: string[];
    needsUserConfirmation: boolean;
    autoDisplayReady: boolean;
    informationAvailability: {
      hasMedicationDetails: boolean;
      missingFields: string[];
    };
    publicLookup: {
      attempted: boolean;
      status: "not_needed" | "succeeded" | "partial" | "failed" | "skipped_low_confidence";
      queriedCandidates: string[];
      insertedMedicationCount: number;
      message: string;
    };
    recommendedAction: string;
  };
}
```

응답 예시:

```json
{
  "scanId": "uuid",
  "candidates": ["TYLENOL ER"],
  "detectedMedications": [
    {
      "id": "detected-uuid",
      "scan_id": "scan-uuid",
      "medication_id": "medication-uuid",
      "detected_name": "TYLENOL ER",
      "matched_name": "타이레놀8시간이알서방정(아세트아미노펜)",
      "confidence": 0.99,
      "match_quality": "high",
      "match_method": "alias",
      "dosage_instruction": {},
      "warning_message": null,
      "needs_confirmation": false,
      "created_at": "2026-05-22T02:00:00.000Z",
      "medications": {
        "id": "medication-uuid",
        "item_name": "타이레놀8시간이알서방정(아세트아미노펜)",
        "entp_name": "켄뷰코리아판매유한회사",
        "efficacy": "공공 DB 원문",
        "dosage": "공공 DB 원문",
        "precautions": "공공 DB 원문",
        "side_effects": null,
        "storage_method": "공공 DB 원문",
        "administration_timing": null,
        "information_completeness": {
          "efficacy": true,
          "dosage": true,
          "precautions": true,
          "side_effects": false,
          "storage_method": true
        },
        "source": "data.go.kr",
        "source_updated_at": "2026-05-22T00:00:00.000Z"
      }
    }
  ],
  "resultMode": "ready",
  "matchQuality": "high",
  "unmatchedCandidates": [],
  "needsUserConfirmation": false,
  "autoDisplayReady": true,
  "informationAvailability": {
    "hasMedicationDetails": true,
    "missingFields": []
  },
  "publicLookup": {
    "attempted": false,
    "status": "not_needed",
    "queriedCandidates": [],
    "insertedMedicationCount": 0,
    "message": "내부 의약품 DB에서 후보를 찾았습니다. 공공 API 추가 조회가 필요하지 않습니다."
  },
  "recommendedAction": "약품 후보를 바로 표시할 수 있습니다. 사용자가 최종 확인하면 현재 복용약으로 등록하세요."
}
```

UI 표시 원칙:

- `resultMode = "ready"`이고 `autoDisplayReady = true`이면 약품 정보 화면을 바로 보여줄 수 있다. 단, 현재 복용약 등록은 사용자 확인 후에만 한다.
    - medicine_info로
- `resultMode = "review_required"`이면 후보는 보여주되 자동 등록을 막고 재촬영/사용자 확인을 안내한다.
    - candidates로 갔다가 medicine_info로. candidates에서는 후보군들이랑 재촬영 버튼 리스트업
- `resultMode = "no_candidates"`이면 약품명을 찾지 못한 상태이므로 재촬영 또는 약국/의료진 확인을 안내한다.
    - 재촬영으로, 안내 문구 필요
- `needs_confirmation = true`이면 사용자가 반드시 확인해야 한다.
    - candidates로
- `needsUserConfirmation = true`이면 화면 전체에서 “확인 필요” 상태를 표시한다.
- `confidence`가 낮으면 “인식이 확실하지 않아요”를 표시한다.
    - 기준 0.95
- `match_quality = "none"` 또는 `unmatchedCandidates`가 있으면 자동 등록을 막는다.
- `warning_message`가 있으면 그대로 사용자에게 보여준다.
- `medications`가 있으면 효능/복용법/주의사항/보관법을 이 객체에서 표시한다. 값이 `null`이면 프론트에서 추측 문구를 만들지 않는다.
- `publicLookup.attempted = true`이면 내부 DB에 없던 후보를 공공 의약품 API로 조회한 것이다. `status = "failed"`여도 전체 분석 결과는 표시하되, 공공 DB 확인 실패 안내를 함께 보여준다.
- `publicLookup.status = "skipped_low_confidence"`이면 OCR 신뢰도가 낮아 공공 API 자동 조회를 막은 상태다. 재촬영 또는 사용자 확인을 우선한다.

- `TYLENOL`처럼 브랜드명만 인식된 경우에는 여러 세부 제품이 있을 수 있어 `review_required`가 될 수 있다. `TYLENOL ER`처럼 세부 표기가 잡히면 더 구체적인 후보로 매칭된다.
- 약품 자동 등록은 하지 말고, 사용자 확인 후 `confirm-medication`을 호출한다.

## 9. 약품 확인 및 현재 복용약 등록

Edge Function:

```
POST /functions/v1/confirm-medication
```

Request Body:

```tsx
type ConfirmMedicationRequest = {
  detectedMedicationId?: string;
  userMedicationId?: string;
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  customName?: string;
};
```

요청 모드:

- OCR 후보 확정: `detectedMedicationId`를 보낸다.
- 기존 복용약 이름 수정: `userMedicationId`와 `customName`을 보낸다.
- 둘 다 없으면 `400`이 반환된다.
- `userMedicationId`가 있으면 이름 수정 모드가 우선된다. 이때 `scan_detected_medications`는 수정하지 않는다.
- `userMedicationId` 이름 수정 모드에서는 `customName`이 필수다. 빈 문자열 또는 공백만 보내면 `400`이 반환된다.

Response Body:

```tsx
type ConfirmMedicationResponse = {
  userMedication: {
    id: string;
    user_id: string;
    medication_id: string;
    source_scan_id: string | null;
    custom_name: string | null;
    start_date: string | null;
    end_date: string | null;
    source: "scan" | "caregiver" | "admin" | "manual_confirmed";
    active: boolean;
    created_at: string;
    updated_at: string;
	  medications?: {
      id: string;
      item_name: string;
      entp_name: string | null;
      efficacy: string | null;
      dosage: string | null;
      precautions: string | null;
      storage_method: string | null;
      administration_timing: string | null;
    } | null;
  };
  alreadyExists: boolean;
  schedules: MedicationSchedule[];
};
```

```tsx
export async function confirmMedication(params: {
  detectedMedicationId?: string;
  userMedicationId?: string;
  startDate?: string;
  endDate?: string;
  customName?: string;
}) {
  const { data, error } = await supabase.functions.invoke("confirm-medication", {
    body: params,
  });

  if (error) throw error;
  return data as {
    userMedication: {
      id: string;
      user_id: string;
      medication_id: string;
      source_scan_id: string;
      custom_name: string | null;
      start_date: string | null;
      end_date: string | null;
      source: string;
      active: boolean;
	    medications?: {
        id: string;
        item_name: string;
        entp_name: string | null;
      } | null;
    };
    alreadyExists: boolean;
    schedules: MedicationSchedule[];
  };
}
```

OCR 후보 확정 사용 예:

```tsx
await confirmMedication({
  detectedMedicationId,
  startDate: new Date().toISOString().slice(0, 10),
  customName: selectedDisplayName,
});
```

기존 복용약 이름 수정 사용 예:

```tsx
await confirmMedication({
  userMedicationId,
  customName: "아침 혈압약",
});
```

동일 사용자의 동일 약품이 이미 active 상태이면 새로 등록하지 않고 기존 `userMedication`을 반환한다. 이때 `customName`이 있고 기존 `custom_name`과 다르면 기존 `user_medications.custom_name`을 업데이트한다. 기존 active 복약 일정과 알림 설정은 `schedules`에 함께 내려온다. 신규 등록이면 `alreadyExists=false`, `schedules=[]`다.

기존 복용약 이름 수정 모드에서는 `userMedicationId`로 현재 로그인 사용자의 `user_medications` row를 찾고, `custom_name`만 업데이트한다. 해당 row가 현재 사용자 소유가 아니거나 없으면 `404`가 반환된다.

에러 처리:

- `400`: `detectedMedicationId`와 `userMedicationId`가 모두 없음
- `400`: `userMedicationId` 이름 수정 모드에서 `customName`이 비어 있음
- `404`: `userMedicationId`에 해당하는 현재 사용자 복용약이 없음
- `403`: `detectedMedicationId`가 현재 사용자 scan에 속하지 않음
- `500`: DB 조회 또는 업데이트 실패

적용 커밋:

```
feat: Update request body to allow userMedicationId and enhance error handling for medication confirmation
```

## 10. 이미지 삭제

분석이 끝나면 민감 이미지 삭제를 권장한다.

Edge Function:

```
POST /functions/v1/delete-scan-image
```

Request Body:

```tsx
type DeleteScanImageRequest = {
  scanId: string;
};
```

Response Body:

```tsx
type DeleteScanImageResponse = {
  scanId: string;
  deleted: boolean;
};
```

```tsx
export async function deleteScanImage(scanId: string) {
  const { data, error } = await supabase.functions.invoke("delete-scan-image", {
    body: { scanId },
  });

  if (error) throw error;
  return data as {
    scanId: string;
    deleted: boolean;
  };
}
```

권장 UX:

- OCR/분석 완료 직후 자동 호출
- 실패 시 조용히 재시도 큐에 넣기
- 사용자에게 원본 이미지를 장기 보관하지 않는다고 안내

백엔드 fallback:

- `delete-scan-image` 호출이 누락되어도 `scan_sessions.expires_at`이 지난 뒤 redaction job이 `prescription-temp`에 남은 원본 이미지를 정리한다.
- 이 fallback은 즉시 삭제 UX를 대체하지 않는다. 민감 이미지 노출 시간을 줄이기 위해 프론트는 가능한 순간에 `delete-scan-image`를 호출한다.

## 11. 챗봇 호출

현재 Gemini 모델:

```
gemini-2.5-flash
```

Edge Function:

```
POST /functions/v1/gemini-chat
```

Request Body:

```tsx
type GeminiChatRequest = {
  question: string;
  scanId?: string;
  chatSessionId?: string;
  userMedicationId?: string;
  detectedMedicationId?: string;
  medicationId?: string;
};
```

Response Body:

```tsx
type GeminiChatResponse = {
  chatSessionId: string;
  answer: string;
  safetyLevel: "info" | "caution" | "urgent";
  needsDoctorOrPharmacist: boolean;
  citedMedicationIds: string[];
  citedInteractionIds: string[];
  disclaimer: string;
  safetyIntent?: "general" | "interaction" | "dose_change" | "stop_medication" | "alcohol" | "pregnancy" | "emergency" | "prompt_attack";
  selectedMedicationContext?: {
    source: "user_medication" | "detected_medication" | "medication_master" | "scan" | "active_medications";
    userMedicationId: string | null;
    detectedMedicationId: string | null;
    medicationId: string | null;
    name: string | null;
  };
  interactionEvidence?: {
    mode: "not_interaction_question" | "confirmed_warning" | "no_registered_warning" | "insufficient_context";
    checkedMedicationIds: string[];
    interactions: Array<{
      id: string;
      severity: string;
      description: string | null;
      recommendation: string | null;
      source: string | null;
      updated_at: string | null;
    }>;
    message: string;
    isConfirmedSafe: false;
  };
};
```

```tsx
export async function askMedicationChatbot(params: {
  question: string;
  scanId?: string;
  chatSessionId?: string;
  userMedicationId?: string;
  detectedMedicationId?: string;
  medicationId?: string;
}) {
  const { data, error } = await supabase.functions.invoke("gemini-chat", {
    body: params,
  });

  if (error) throw error;
  return data as {
    chatSessionId: string;
    answer: string;
    safetyLevel: "info" | "caution" | "urgent";
    needsDoctorOrPharmacist: boolean;
    citedMedicationIds: string[];
    citedInteractionIds: string[];
    disclaimer: string;
    safetyIntent?: "general" | "interaction" | "dose_change" | "stop_medication" | "alcohol" | "pregnancy" | "emergency" | "prompt_attack";
    selectedMedicationContext?: {
      source: "user_medication" | "detected_medication" | "medication_master" | "scan" | "active_medications";
      userMedicationId: string | null;
      detectedMedicationId: string | null;
      medicationId: string | null;
      name: string | null;
    };
    interactionEvidence?: {
      mode: "not_interaction_question" | "confirmed_warning" | "no_registered_warning" | "insufficient_context";
      checkedMedicationIds: string[];
      interactions: unknown[];
      message: string;
      isConfirmedSafe: false;
    };
  };
}
```

사용 예:

```tsx
const result = await askMedicationChatbot({
  question: "이 약 밥 먹고 바로 먹어도 돼요?",
  scanId,
});
```

특정 약 상세 화면에서는 `userMedicationId`, OCR 후보 카드에서는 `detectedMedicationId`, 약품 마스터 상세에서는 `medicationId`를 함께 보낸다. 프론트가 약 이름/복용법 원문을 직접 보내더라도 백엔드는 이를 공식 근거로 쓰지 않는다. 공식 맥락은 ID로 조회한 DB 데이터만 사용한다.

응답 예시:

```json
{
  "chatSessionId": "chat-uuid",
  "answer": "현재 정보만으로는 식전 복용 여부를 정확히 알 수 없습니다. 약봉투의 복용법을 다시 확인하거나 약사에게 확인해 주세요.",
  "safetyLevel": "caution",
  "needsDoctorOrPharmacist": true,
  "citedMedicationIds": [],
  "citedInteractionIds": [],
  "disclaimer": "이 정보는 참고용이며 AI 답변은 틀릴 수 있습니다. 정확한 복약 방법과 약물 상호작용은 의사 또는 약사에게 확인하세요.",
  "safetyIntent": "interaction"
}
```

UI 표시 원칙:

- `safetyLevel = "info"`: 일반 안내
- `safetyLevel = "caution"`: 주의 색상과 약사/의사 상담 안내
- `safetyLevel = "urgent"`: 강한 경고 UI, 전문가 상담 우선
- `needsDoctorOrPharmacist = true`이면 답변 하단에 상담 안내를 반드시 표시
- `disclaimer`는 답변 하단에 표시
- `safetyIntent = "dose_change"`이면 용량 변경 금지 안내를 우선 표시한다.
- `safetyIntent = "stop_medication"`이면 임의 중단 금지 안내를 우선 표시한다.
- `safetyIntent = "alcohol"` 또는 `"pregnancy"`이면 “가능/안전” 단정 없이 상담 안내를 강조한다.
- `safetyIntent = "emergency"`이면 챗봇 답변보다 119/응급실 안내 UI를 최우선으로 표시한다.
- `safetyIntent = "prompt_attack"`이면 복약 범위 밖 요청 거절로 처리한다.
- 상호작용 질문은 `gemini-chat`이 먼저 내부 DB 근거를 확인한다.
- `interactionEvidence.mode = "insufficient_context"`이면 함께 복용 가능 여부를 표시하지 말고 전문가 확인 안내를 보여준다.
- `interactionEvidence.mode = "no_registered_warning"`은 “안전함”이 아니라 “현재 DB에 등록된 경고 없음”으로 표시한다.
- `interactionEvidence.mode = "confirmed_warning"`이면 `interactions[].recommendation`과 전문가 확인 안내를 강조한다.

답변 화면에 항상 포함할 문구:

```
이 정보는 참고용이며, 정확한 복약 방법은 의사 또는 약사에게 확인하세요.
```

## 12. 복약 일정 관리

Edge Function:

```
GET    /functions/v1/medication-schedules
POST /functions/v1/medication-schedules
PATCH  /functions/v1/medication-schedules
DELETE /functions/v1/medication-schedules
```

### 12.0 일정 조회

Query:

```tsx
type ListMedicationSchedulesQuery = {
  userMedicationId?: string;
  active?: "true" | "false";
};
```

사용 예:

```tsx
export async function listMedicationSchedules(params?: {
  userMedicationId?: string;
  active?: boolean;
}) {
  const query = new URLSearchParams();
  if (params?.userMedicationId) query.set("userMedicationId", params.userMedicationId);
  if (params?.active !== undefined) query.set("active", String(params.active));

  const { data, error } = await supabase.functions.invoke(
    `medication-schedules${query.size ? `?${query}` : ""}`,
    { method: "GET" },
  );

  if (error) throw error;
  return data as { schedules: MedicationSchedule[] };
}
```

### 12.1 일정 생성

Request Body:

```tsx
type CreateMedicationScheduleRequest = {
  userMedicationId: string;
  takeTime?: string; // HH:mm 또는 HH:mm:ss
  takeTimes?: string[]; // HH:mm 또는 HH:mm:ss, 하루 여러 번 복용 시 사용
  timingRule?: "before_meal" | "after_meal" | "with_meal" | "bedtime" | "custom";
  doseAmount?: number;
  doseUnit?: string;
  daysOfWeek?: number[]; // 0=Sunday ... 6=Saturday
  notificationEnabled?: boolean;
  startDate?: string; // YYYY-MM-DD, 기본값 오늘
  endDate?: string | null; // YYYY-MM-DD, 없으면 종료일 없음
  active?: boolean;
};
```

Response Body:

```tsx
type MedicationSchedule = {
  id: string;
  user_medication_id: string;
  take_time: string;
  timing_rule: "before_meal" | "after_meal" | "with_meal" | "bedtime" | "custom" | null;
  dose_amount: number | null;
  dose_unit: string | null;
  days_of_week: number[];
  notification_enabled: boolean;
  start_date: string;
  end_date: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

type CreateMedicationScheduleResponse = {
  schedule: MedicationSchedule | null;
  schedules: MedicationSchedule[];
};
```

```tsx
export async function createMedicationSchedule(params: {
  userMedicationId: string;
  takeTime?: string;
  takeTimes?: string[];
  timingRule?: "before_meal" | "after_meal" | "with_meal" | "bedtime" | "custom";
  doseAmount?: number;
  doseUnit?: string;
  daysOfWeek?: number[];
  notificationEnabled?: boolean;
  startDate?: string;
  endDate?: string | null;
  active?: boolean;
}) {
  const { data, error } = await supabase.functions.invoke("medication-schedules", {
    body: params,
  });

  if (error) throw error;
  return data;
}
```

예시:

```tsx
await createMedicationSchedule({
  userMedicationId,
  takeTimes: ["09:00:00", "13:00:00", "19:00:00"],
  timingRule: "after_meal",
  doseAmount: 1,
  doseUnit: "정",
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  startDate: "2026-05-22",
  endDate: null,
  notificationEnabled: true,
});
```

`takeTime`과 `takeTimes`는 동시에 보내지 않는다. `takeTimes`의 중복 시간은 백엔드에서 정규화 후 제거한다. 이미 같은 `userMedicationId + take_time + active=true` 일정이 있으면 새로 만들지 않고 기존 schedule을 반환한다.

### 12.2 일정 수정

Request Body:

```tsx
type UpdateMedicationScheduleRequest = {
  scheduleId: string;
  takeTime?: string; // HH:mm 또는 HH:mm:ss
  timingRule?: "before_meal" | "after_meal" | "with_meal" | "bedtime" | "custom";
  doseAmount?: number | null;
  doseUnit?: string | null;
  daysOfWeek?: number[];
  notificationEnabled?: boolean;
  startDate?: string;
  endDate?: string | null;
  active?: boolean;
};
```

사용 예:

```tsx
export async function updateMedicationSchedule(params: UpdateMedicationScheduleRequest) {
  const { data, error } = await supabase.functions.invoke("medication-schedules", {
    method: "PATCH",
    body: params,
  });

  if (error) throw error;
  return data as { schedule: MedicationSchedule };
}
```

### 12.3 일정 비활성화

삭제는 DB hard delete가 아니라 `active=false`, `notification_enabled=false` 처리다.

```tsx
export async function deactivateMedicationSchedule(scheduleId: string) {
  const { data, error } = await supabase.functions.invoke("medication-schedules", {
    method: "DELETE",
    body: { scheduleId },
  });

  if (error) throw error;
  return data as { schedule: MedicationSchedule };
}
```

요일 값:

```
0 = Sunday
1 = Monday
2 = Tuesday
3 = Wednesday
4 = Thursday
5 = Friday
6 = Saturday
```

검증 규칙:

- `daysOfWeek`는 0~6 정수만 허용한다.
- `startDate`는 일정 적용 시작일이다.
- `endDate`가 있으면 `startDate`보다 빠를 수 없다.
- 알림 대상 조회는 현재 복용약의 `start_date/end_date`와 일정의 `start_date/end_date/active`를 모두 반영한다.

### 12.4 복약 일정 후보 생성

OCR 원문 또는 공공 DB 복용법에서 알림 일정 후보를 만든다. 이 API는 일정을 바로 생성하지 않는다. 프론트는 후보를 보여주고 사용자가 확인한 뒤 `medication-schedules`를 호출해야 한다.

Edge Function:

```
POST /functions/v1/suggest-medication-schedules
```

Request Body:

```tsx
type SuggestMedicationSchedulesRequest = {
  userMedicationId: string;
  scanId?: string;
};
```

Response Body:

```tsx
type SuggestMedicationSchedulesResponse = {
  userMedicationId: string;
  medicationName: string | null;
  suggestions: Array<{
    takeTime: string; // HH:mm:ss
    timingRule: "before_meal" | "after_meal" | "with_meal" | "bedtime" | "custom";
    doseAmount: number | null;
    doseUnit: string | null;
    daysOfWeek: number[];
    source: "ocr" | "drug_db" | "fallback";
    confidence: "high" | "medium" | "low";
    reason: string;
  }>;
  needsUserConfirmation: true;
  message: string;
};
```

사용 예:

```tsx
const { data, error } = await supabase.functions.invoke("suggest-medication-schedules", {
  body: { userMedicationId, scanId },
});
if (error) throw error;
```

UI 원칙:

- 후보는 “추천”이 아니라 “감지된 일정 후보”로 표시한다.
- 사용자가 처방전/약봉투 지시와 맞는지 확인해야 한다.
- 후보가 없으면 직접 시간/요일/용량을 설정하게 한다.

## 13. 복용 완료 체크

Edge Function:

```
POST /functions/v1/medication-logs-check
```

Request Body:

```tsx
type MedicationLogCheckRequest = {
  userMedicationId: string;
  scheduleId?: string;
  plannedDate: string; // YYYY-MM-DD
  plannedTime?: string; // HH:mm:ss
  status?: "taken" | "missed" | "skipped";
};
```

Response Body:

```tsx
type MedicationLogCheckResponse = {
  log: {
    id: string;
    user_medication_id: string;
    schedule_id: string | null;
    planned_date: string;
    planned_time: string | null;
    taken_at: string | null;
    status: "pending" | "taken" | "missed" | "skipped";
    created_at: string;
    updated_at: string;
  };
};
```

```tsx
export async function checkMedicationLog(params: {
  userMedicationId: string;
  scheduleId?: string;
  plannedDate: string;
  plannedTime?: string;
  status?: "taken" | "missed" | "skipped";
}) {
  const { data, error } = await supabase.functions.invoke("medication-logs-check", {
    body: params,
  });

  if (error) throw error;
  return data;
}
```

예시:

```tsx
await checkMedicationLog({
  userMedicationId,
  scheduleId,
  plannedDate: "2026-05-22",
  plannedTime: "09:00:00",
  status: "taken",
});
```

### 13.1 오늘 복약 체크리스트 조회

하루 화면에서 “오늘 먹을 약” 목록을 보여주는 API다. 일정이 적용되는 약만 반환하며, 이미 체크한 로그가 있으면 해당 상태를 같이 반환한다.

Edge Function:

```
POST /functions/v1/medication-checklist
```

Request Body:

```tsx
type MedicationChecklistRequest = {
  date?: string; // YYYY-MM-DD, 기본값 Asia/Seoul 기준 오늘
};
```

Response Body:

```tsx
type MedicationChecklistResponse = {
  date: string;
  dayOfWeek: number;
  summary: {
    total: number;
    pending: number;
    taken: number;
    missed: number;
    skipped: number;
  };
  items: Array<{
    scheduleId: string;
    userMedicationId: string;
    medicationId: string;
    medicationName: string | null;
    entpName: string | null;
    plannedDate: string;
    plannedTime: string;
    timingRule: "before_meal" | "after_meal" | "with_meal" | "bedtime" | "custom" | null;
    doseAmount: number | null;
    doseUnit: string | null;
    status: "pending" | "taken" | "missed" | "skipped";
    log: Record<string, unknown> | null;
  }>;
};
```

사용 예:

```tsx
const { data, error } = await supabase.functions.invoke("medication-checklist", {
  body: { date: "2026-05-22" },
});
if (error) throw error;
```

체크 버튼 동작:

- `status = "taken"` 버튼 → `medication-logs-check` 호출
- `status = "skipped"` 버튼 → `medication-logs-check` 호출
- 호출 후 `medication-checklist`를 다시 조회해 화면을 갱신한다.

## 14. 상호작용 검사

Edge Function:

```
POST /functions/v1/check-interactions
```

Request Body:

```tsx
type CheckInteractionsRequest = {
  medicationId: string;
};
```

Response Body:

```tsx
type CheckInteractionsResponse = {
  severity: "contraindicated" | "major" | "moderate" | "minor" | "unknown";
  overallSeverity: "no_registered_warning" | "caution" | "danger" | "unknown";
  isConfirmedSafe: boolean;
  comparedMedicationCount: number;
  interactions: Array<{
    id: string;
    ingredient_a_id: string;
    ingredient_b_id: string;
    severity: "contraindicated" | "major" | "moderate" | "minor" | "unknown";
    description: string;
    recommendation: string | null;
    source: string | null;
    source_url: string | null;
    updated_at: string;
  }>;
  message: string;
};
```

```tsx
export async function checkInteractions(medicationId: string) {
  const { data, error } = await supabase.functions.invoke("check-interactions", {
    body: { medicationId },
  });

  if (error) throw error;
  return data as {
    severity: "contraindicated" | "major" | "moderate" | "minor" | "unknown";
    overallSeverity: "no_registered_warning" | "caution" | "danger" | "unknown";
    isConfirmedSafe: boolean;
    comparedMedicationCount: number;
    interactions: unknown[];
    message: string;
  };
}
```

주의:

- `severity = "unknown"`은 “안전함”이 아니다.
- `overallSeverity = "no_registered_warning"`은 “현재 DB 기준 등록된 경고 없음”이지, 의학적으로 안전하다는 뜻이 아니다.
- `comparedMedicationCount = 0`이면 사용자의 현재 복용약이 없어 비교 대상이 없는 상태다.
- 현재 백엔드는 자동검사만으로 `isConfirmedSafe = true`를 반환하지 않는다.
- 상호작용 DB에 정보가 부족하다는 뜻일 수 있다.
- UI에는 “자동 검사 결과만으로 안전을 단정할 수 없습니다”를 표시한다.

## 15. 알림 토큰 등록 및 복약 알림 대상

프론트 앱은 푸시 토큰을 발급받은 뒤 백엔드에 저장한다.

### 15.0 Web FCM 설정

Firebase Web SDK config는 프론트 공개 설정이다. 백엔드는 이 config를 직접 사용하지 않고, Supabase Secret의 `GOOGLE_SERVICE_ACCOUNT_JSON`과 `FCM_PROJECT_ID=iyakmoji`로 FCM HTTP v1 발송을 수행한다.

프론트에서 추가로 준비할 값:

```
Firebase Console > Project settings > Cloud Messaging > Web Push certificates > Key pair
```

이 VAPID key를 `VITE_FIREBASE_WEB_PUSH_VAPID_KEY` 또는 `NEXT_PUBLIC_FIREBASE_WEB_PUSH_VAPID_KEY`에 넣는다.

Firebase 초기화와 token 발급 예:

```tsx
import { initializeApp } from "<https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js>";
import {
  getMessaging,
  getToken,
  isSupported,
  onMessage,
} from "<https://www.gstatic.com/firebasejs/12.13.0/firebase-messaging.js>";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export async function registerFcmToken() {
  if (!(await isSupported())) return { supported: false, token: null };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { supported: true, token: null };

  const app = initializeApp(firebaseConfig);
  const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
  const messaging = getMessaging(app);
  const token = await getToken(messaging, {
    vapidKey: import.meta.env.VITE_FIREBASE_WEB_PUSH_VAPID_KEY,
    serviceWorkerRegistration: registration,
  });

  await saveNotificationToken({
    token,
    provider: "fcm",
    platform: "web",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul",
    enabled: true,
  });

  onMessage(messaging, (payload) => {
    // foreground 상태에서는 앱 UI 토스트/배너로 표시한다.
    console.info("foreground FCM message", payload);
  });

  return { supported: true, token };
}
```

`public/firebase-messaging-sw.js` 예:

```jsx
importScripts("<https://www.gstatic.com/firebasejs/12.13.0/firebase-app-compat.js>");
importScripts("<https://www.gstatic.com/firebasejs/12.13.0/firebase-messaging-compat.js>");

firebase.initializeApp({
  apiKey: "<Firebase web api key>",
  authDomain: "iyakmoji.firebaseapp.com",
  projectId: "iyakmoji",
  storageBucket: "iyakmoji.firebasestorage.app",
  messagingSenderId: "478796151576",
  appId: "1:478796151576:web:e25daf3fc1cc32345ffc6d",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  self.registration.showNotification(
    payload.notification?.title || "복약 시간입니다",
    {
      body: payload.notification?.body || "복약 일정을 확인해 주세요.",
      icon: "/icon-192.png",
      data: payload.data || {},
    },
  );
});
```

프론트 처리 원칙:

- 알림 권한을 거부해도 앱 사용은 막지 않는다.
- token 발급 실패는 설정/권한 문제로 보고 재시도 버튼을 제공한다.
- 같은 token은 여러 번 저장해도 백엔드에서 upsert된다.
- token 저장 후에도 실제 발송은 백엔드 scheduled job이 수행한다.

Edge Function:

```
POST /functions/v1/notification-tokens
GET /functions/v1/notification-tokens
```

Request Body:

```tsx
type SaveNotificationTokenRequest = {
  token: string;
  provider?: "fcm" | "apns"; // 현재 실제 발송은 fcm 기준
  deviceId?: string;
  platform?: "ios" | "android" | "web";
  timezone?: string; // 기본값 Asia/Seoul
  enabled?: boolean;
};
```

POST Response Body:

```tsx
type SaveNotificationTokenResponse = {
  token: {
    id: string;
    provider: "fcm" | "apns";
    device_id: string | null;
    platform: "ios" | "android" | "web" | null;
    timezone: string;
    enabled: boolean;
    last_seen_at: string;
    created_at: string;
  };
};
```

GET Response Body:

```tsx
type ListNotificationTokensResponse = {
  tokens: SaveNotificationTokenResponse["token"][];
};
```

```tsx
export async function saveNotificationToken(params: {
  token: string;
  provider?: "fcm" | "apns";
  deviceId?: string;
  platform?: "ios" | "android" | "web";
  timezone?: string;
  enabled?: boolean;
}) {
  const { data, error } = await supabase.functions.invoke("notification-tokens", {
    body: params,
  });

  if (error) throw error;
  return data;
}
```

운영자 또는 scheduled job용 FCM 알림 발송 함수:

```
POST /functions/v1/send-medication-reminders
```

운영자 admin 계정만 호출할 수 있다.

Request Body:

```tsx
type SendMedicationRemindersRequest = {
  windowStart?: string; // ISO datetime
  windowEnd?: string; // ISO datetime
  targetUserId?: string;
  dryRun?: boolean;
  includeReminders?: boolean;
};
```

Response Body:

```tsx
type SendMedicationRemindersResponse = {
  dryRun: boolean;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  pendingCount: number;
  results?: Array<{
    deliveryId?: string;
    tokenId: string;
    ok: boolean;
    messageId?: string;
    error?: string;
    status?: "sent" | "failed" | "skipped";
  }>;
  reminders?: Array<Record<string, unknown>>;
  message: string;
};
```

```tsx
export async function sendMedicationReminders(params?: {
  windowStart?: string;
  windowEnd?: string;
  targetUserId?: string;
  dryRun?: boolean;
  includeReminders?: boolean;
}) {
  const { data, error } = await supabase.functions.invoke("send-medication-reminders", {
    body: params ?? { dryRun: true },
  });

  if (error) throw error;
  return data as {
    dryRun: boolean;
    sentCount: number;
    failedCount: number;
    skippedCount: number;
    pendingCount: number;
    results?: Array<{
      deliveryId?: string;
      tokenId: string;
      ok: boolean;
      messageId?: string;
      error?: string;
      status?: "sent" | "failed" | "skipped";
    }>;
    message: string;
  };
}
```

주의:

- 일반 프론트 사용자는 이 함수를 호출하지 않는다.
- 앱은 `notification-tokens`로 FCM 토큰만 저장한다.
- 운영자 또는 Supabase scheduled job이 `send-medication-reminders`를 주기적으로 호출한다.
- `dryRun = true`이면 실제 푸시를 보내지 않고 대상만 계산한다.
- `dryRun = false`이면 발송 대상을 먼저 `medication_notification_deliveries`에 claim한 뒤 FCM HTTP v1으로 전송한다.
- 같은 토큰/일정/날짜/시간 조합은 발송 이력으로 중복 전송을 막는다.
- FCM이 `UNREGISTERED` 또는 invalid token 계열 오류를 반환하면 해당 토큰은 자동 비활성화된다.
- 프론트 token 저장 전에는 운영 scheduled job을 `dryRun = true`로 유지한다.
- token 저장 후에는 운영자가 `targetUserId`, `includeReminders = true`, `dryRun = true`로 대상 계산을 먼저 확인하고, controlled 1회 발송 성공 후에만 `dryRun = false`로 전환한다.

## 16. 보호자 연동

Edge Functions:

```
POST /functions/v1/caregiver-invite
POST /functions/v1/caregiver-respond
GET  /functions/v1/caregiver-status
```

caregiver-invite Request Body:

```tsx
type CaregiverInviteRequest = {
  patientUserId?: string;
  caregiverUserId?: string;
  permissionScope?: {
    medication_status?: boolean;
    scan_results?: boolean;
    reports?: boolean;
  };
};
```

caregiver-invite Response Body:

```tsx
type CaregiverInviteResponse = {
  caregiverLink: CaregiverLink;
  invitedBy: "patient" | "caregiver";
  nextAction: string;
};

type CaregiverLink = {
  id: string;
  patient_user_id: string;
  caregiver_user_id: string;
  status: "invited" | "accepted" | "revoked";
  permission_scope: Record<string, boolean>;
  consented_at: string | null;
  revoked_at: string | null;
  invited_by_user_id: string | null;
  created_at: string;
};
```

보호자 초대 또는 요청:

```tsx
await supabase.functions.invoke("caregiver-invite", {
  body: {
    patientUserId,
    caregiverUserId,
    permissionScope: {
      medication_status: true,
      scan_results: false,
      reports: true,
    },
  },
});
```

caregiver-respond Request Body:

```tsx
type CaregiverRespondRequest = {
  caregiverLinkId: string;
  action: "accepted" | "revoked";
};
```

caregiver-respond Response Body:

```tsx
type CaregiverRespondResponse = {
  caregiverLink: CaregiverLink;
};
```

승인/철회:

```tsx
await supabase.functions.invoke("caregiver-respond", {
  body: {
    caregiverLinkId,
    action: "accepted", // 또는 "revoked"
  },
});
```

caregiver-status Response Body:

```tsx
type CaregiverStatusResponse = {
  caregiverLinks: CaregiverLink[];
  asPatient: CaregiverLink[];
  asCaregiver: CaregiverLink[];
};
```

주의:

- 보호자 권한은 읽기 중심이다.
- 환자와 보호자 모두 링크 참여자여야 한다.
- 승인 전에는 보호자가 환자 복약 데이터를 볼 수 없다.

## 17. 복약 히스토리/리포트

Edge Function:

```
POST /functions/v1/medication-report
```

Request Body:

```tsx
type MedicationReportRequest = {
  patientUserId?: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
};
```

Response Body:

```tsx
type MedicationReportResponse = {
  patientUserId: string;
  startDate: string;
  endDate: string;
  daily: Array<{
    report_date: string;
    planned_count: number;
    taken_count: number;
    missed_count: number;
    skipped_count: number;
    adherence_rate: number;
  }>;
  summary: string;
};
```

```tsx
export async function getMedicationReport(params: {
  patientUserId?: string;
  startDate: string;
  endDate: string;
}) {
  const { data, error } = await supabase.functions.invoke("medication-report", {
    body: params,
  });

  if (error) throw error;
  return data as {
    patientUserId: string;
    startDate: string;
    endDate: string;
    daily: Array<{
      report_date: string;
      planned_count: number;
      taken_count: number;
      missed_count: number;
      skipped_count: number;
      adherence_rate: number;
    }>;
    summary: string;
  };
}
```

리포트 문장은 Gemini 추론이 아니라 복약 로그 집계 기반으로 생성된다.

## 18. 직접 조회 가능한 주요 테이블

프론트에서 RLS 범위 안에서 조회 가능한 테이블:

```
user_profiles
scan_sessions
scan_detected_medications
user_medications
medication_schedules
medication_logs
chat_sessions
chat_messages
medications
ingredients
medication_ingredients
pharmacies
drug_interactions
consents
notification_tokens
caregiver_links
```

현재 복용약 조회 예:

```tsx
export async function listActiveUserMedications() {
  const { data, error } = await supabase
    .from("user_medications")
    .select(`
      id,
      custom_name,
      start_date,
      end_date,
      active,
      medications (
        id,
        item_name,
        efficacy,
        dosage,
        precautions,
        storage_method
      )
    `)
    .eq("active", true)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data;
}
```

스캔 결과 조회 예:

```tsx
export async function getScanResult(scanId: string) {
  const { data, error } = await supabase
    .from("scan_detected_medications")
    .select(`
      id,
      detected_name,
      matched_name,
      confidence,
      needs_confirmation,
      warning_message,
      medications (
        id,
        item_name,
        efficacy,
        dosage,
        precautions,
        storage_method
      )
    `)
    .eq("scan_id", scanId)
    .order("confidence", { ascending: false });

  if (error) throw error;
  return data;
}
```

## 19. 권장 화면 구성

- [x]  19.1 로그인 화면
    
    필수 요소:
    
    - Google 로그인 버튼
    - 개인정보/민감정보 처리 안내
    - “본 서비스는 참고용이며 정확한 복약은 전문가에게 확인” 문구

### 19.2 메인 화면

고령층 타겟이므로 단순하게 구성한다.

필수 요소:

- 큰 카메라 버튼
- 최근 복용 예정 약
- 오늘 복용 완료 상태
- 챗봇 진입 버튼

### 19.3 OCR 진행 화면

상태 단계:

```
이미지 업로드 중
텍스트 인식 중
약품 정보 확인 중
결과 준비 완료
```

실패 상태:

```
사진이 흐릿해요. 다시 촬영해 주세요.
약 이름을 확실히 찾지 못했어요. 약사 또는 의사에게 확인해 주세요.
```

### 19.4 약품 확인 화면

각 후보 카드에 표시:

- OCR에서 읽은 이름
- 매칭된 약품명
- confidence
- 주요 효능
- 복용법
- 주의사항
- “이 약이 맞아요” 버튼
- “아니에요/다시 촬영” 버튼

주의:

- confidence가 낮은 약을 자동 등록하지 않는다.
- `warning_message`가 있으면 카드 상단에 표시한다.

### 19.5 챗봇 화면

필수 요소:

- 사용자 질문 입력
- AI 답변
- safety level 표시
- 면책 문구
- 전문가 상담 권장 표시

금지:

- 챗봇 답변을 처방처럼 보이게 만들지 않기
- “복용해도 안전합니다” 같은 단정형 문구를 강하게 디자인하지 않기

## 20. 에러 처리

### 20.1 인증 오류

상태:

```
401 Unauthorized
```

처리:

- 세션 만료로 보고 재로그인 유도

### 20.2 OCR 실패

가능 원인:

- 이미지 없음
- Storage 업로드 실패
- OCR API 오류
- 일일 사용량 초과

처리:

- 재촬영 안내
- 네트워크 재시도
- 일정 횟수 이상 실패 시 약사/의사 확인 안내

### 20.3 Gemini 실패

가능 원인:

- quota 초과
- safety block
- 네트워크 오류

처리:

- “지금은 답변을 생성하지 못했어요” 표시
- 약품 기본 정보는 DB 기반으로 계속 보여주기
- 전문가 상담 안내

### 20.4 약품 매칭 실패

상태:

```
detectedMedicationCount = 0
또는 needs_confirmation = true
```

처리:

- 다시 촬영 버튼
- OCR 원문 일부 표시
- 전문가 확인 안내

## 21. 현재 원격 테스트 결과

2026-05-22 기준:

```
Google OAuth 시작: 정상
DB lint: 정상
Edge Functions: ACTIVE
OCR: 정상
Gemini 챗봇: 정상
sync-drug-master: 정상
복약 일정/로그: 정상
상호작용 검사: 정상
```

`test_image.jpeg` OCR 결과:

```
confidence: 0.6132253799999999
ocrTextLength: 15
ocrPreview:
#8888
DRIVE
L
0
```

이 이미지는 실제 약봉투/처방전이 아니어서 약품 인식 품질 검증용으로는 부족하다. 실제 약봉투 또는 처방전 샘플 이미지로 추가 테스트가 필요하다.

Gemini 테스트 결과:

```
question: 타이레놀은 식후에 먹어야 하나요?
answer: 타이레놀은 식사와 관계없이 드실 수 있습니다. 빈속에 드셔도 괜찮고, 속이 불편하시면 식사 후에 드셔도 좋습니다.
safetyLevel: info
needsDoctorOrPharmacist: false
```

## 22. 프론트 작업자가 주의할 보안 사항

- service role key를 절대 사용하지 않는다.
- Google/Gemini/API key를 프론트에 넣지 않는다.
- 이미지는 private bucket에만 업로드한다.
- 이미지 분석 후 삭제 함수를 호출한다.
- 사용자가 확인하지 않은 약을 현재 복용약으로 등록하지 않는다.
- 챗봇 답변을 의학적 확정 판단처럼 보여주지 않는다.
- 보호자 기능은 동의 플로우가 준비되기 전까지 노출하지 않는다.

## 23. 프론트 작업자가 백엔드에 요청해야 할 수 있는 추가 개선

현재 구현으로 MVP 연동은 가능하지만, 실제 제품 품질을 위해 다음 개선이 필요할 수 있다.

- OCR 결과가 낮은 confidence일 때 더 친절한 실패 코드 반환
- 약품 후보 매칭 알고리즘 개선
- 실제 약봉투 이미지 기반 테스트셋 구축
- 앱 배포 후 실제 단말 FCM 수신 검증
- 오래된 OCR/채팅 민감정보 정리 scheduled job 운영 설정
- 보호자 알림 발송
- 챗봇 답변에 더 명확한 citation 구조 제공
