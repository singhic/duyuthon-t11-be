# Frontend-backend OCR/E2E validation result

- Generated UTC: 2026-05-25T00:06:53.2106133Z
- Project: hygsrrmoawezonahnljn
- Image directory: images
- Temp user deleted: True

## 1. OCR/analyze/confirm by image

| Image | OCR | confidence | manual | failureReason | imageDeleted | analyze mode | detected/matched | confirm |
|---|---|---:|---|---|---|---|---:|---|
| prescription_1.jpeg | PASS | 0.6132253799999999 | True | low_ocr_confidence | True | review_required | 1/0 | SKIP |
| prescription_2.png | PASS | 0.8198079766037731 | False |  | True | review_required | 25/1 | PASS |
| prescription_3.png | PASS |  | True | empty_ocr_text | True | FAIL | 0/0 | SKIP |
| prescription_4.jpg | PASS | 0.765379695102041 | False |  | True | review_required | 23/1 | SKIP |
| prescription_5.jpg | PASS | 0.7348547425641027 | False |  | True | review_required | 19/1 | SKIP |

## 2. Confirm and schedule E2E

- Confirmed image: prescription_2.png
- Matched medication: ë¦¬íë ì¬íë¬ì¤ì ìì¡0.5%(ì¹´ë¥´ë³µìë©í¸ìë£°ë¡ì¤ì¤ëí¸ë¥¨)(1íì©)
- userMedicationId: 554bc428-2803-4a2a-a3e9-7c5483e9709e
- suggest call: True, suggestion count: 2
- fallback schedule used: False
- schedule created: False, count: 0
- confirm existing: True, alreadyExists: True, schedules: 0
- checklist before: True
- log taken: False, status: 
- checklist after: False

Checklist before summary:
```json
{
    "total":  0,
    "pending":  0,
    "taken":  0,
    "missed":  0,
    "skipped":  0
}
```

Checklist after summary:
```json
```

## 3. Gemini selected medication context

| Request | OK | selected source |
|---|---|---|
| userMedicationId | True | user_medication |
| detectedMedicationId | True | detected_medication |
| medicationId | True | medication_master |

## 4. Raw JSON

- Detail JSON: result\frontend-backend-e2e-post-ocr-fuzzy-deploy.json
