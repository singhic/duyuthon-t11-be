# Frontend-backend OCR/E2E validation result

- Generated UTC: 2026-05-25T01:17:42.1677949Z
- Project: hygsrrmoawezonahnljn
- Image directory: images-p6-test
- Temp user deleted: True

## 1. OCR/analyze/confirm by image

| Image | OCR | confidence | manual | failureReason | imageDeleted | analyze mode | detected/matched | confirm |
|---|---|---:|---|---|---|---|---:|---|
| prescription_6.jpg | PASS | 0.907101439512195 | False |  | True | review_required | 6/5 | PASS |

## 2. Confirm and schedule E2E

- Confirmed image: prescription_6.jpg
- Matched medication: 코데닝정
- userMedicationId: 55422567-ea26-4254-a0c5-6b2ab6ad2cf1
- suggest call: True, suggestion count: 0
- fallback schedule used: True
- schedule created: True, count: 2
- confirm existing: True, alreadyExists: True, schedules: 2
- checklist before: True
- log taken: True, status: taken
- checklist after: True

Checklist before summary:
```json
{
  "total": 2,
  "pending": 2,
  "taken": 0,
  "missed": 0,
  "skipped": 0
}
```

Checklist after summary:
```json
{
  "total": 2,
  "pending": 1,
  "taken": 1,
  "missed": 0,
  "skipped": 0
}
```

## 3. Gemini selected medication context

| Request | OK | selected source |
|---|---|---|
| userMedicationId | True | user_medication |
| detectedMedicationId | True | detected_medication |
| medicationId | True | medication_master |

## 4. Raw JSON

- Detail JSON: result/frontend-backend-e2e-post-p6-alternatives-deploy.json
