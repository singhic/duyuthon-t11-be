# Frontend-backend OCR/E2E validation result

- Generated UTC: 2026-05-24T12:03:19.3276639Z
- Project: hygsrrmoawezonahnljn
- Image directory: images
- Temp user deleted: True

## 1. OCR/analyze/confirm by image

| Image | OCR | confidence | manual | failureReason | imageDeleted | analyze mode | detected/matched | confirm |
|---|---|---:|---|---|---|---|---:|---|
| prescription_1.jpeg | PASS | 0.6132253925000001 | True | low_ocr_confidence | True | review_required | 1/0 | SKIP |
| prescription_2.png | PASS | 0.8198266369811317 | False |  | True | review_required | 24/0 | SKIP |
| prescription_3.png | PASS |  | True | empty_ocr_text | True | FAIL | 0/0 | SKIP |
| prescription_4.jpg | PASS | 0.7653033679591835 | False |  | True | review_required | 25/0 | SKIP |
| prescription_5.jpg | PASS | 0.7394961234210526 | False |  | True | review_required | 24/1 | PASS |

## 2. Confirm and schedule E2E

- Confirmed image: prescription_5.jpg
- Matched medication: ì§ì¤ë¡ë§¥ì¤ì 250ë°ë¦¬ê·¸ë(ìì§í¸ë¡ë§ì´ì ìíë¬¼)
- userMedicationId: 0b668b83-4922-46ab-9786-0b55108079e8
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
    "total":  2,
    "pending":  2,
    "taken":  0,
    "missed":  0,
    "skipped":  0
}
```

Checklist after summary:
```json
{
    "total":  2,
    "pending":  1,
    "taken":  1,
    "missed":  0,
    "skipped":  0
}
```

## 3. Gemini selected medication context

| Request | OK | selected source |
|---|---|---|
| userMedicationId | True | user_medication |
| detectedMedicationId | True | detected_medication |
| medicationId | True | medication_master |

## 4. Raw JSON

- Detail JSON: result/frontend-backend-e2e-20260524.json
