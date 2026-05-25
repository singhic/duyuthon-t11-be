# Frontend-backend OCR/E2E validation result

- Generated UTC: 2026-05-25T00:49:04.1775582Z
- Project: hygsrrmoawezonahnljn
- Image directory: images
- Temp user deleted: True

## 1. OCR/analyze/confirm by image

| Image | OCR | confidence | manual | failureReason | imageDeleted | analyze mode | detected/matched | confirm |
|---|---|---:|---|---|---|---|---:|---|
| prescription_1.jpeg | PASS | 0.6132253799999999 | True | low_ocr_confidence | True | review_required | 1/0 | SKIP |
| prescription_2.png | PASS | 0.8198266369811317 | False |  | True | review_required | 28/0 | SKIP |
| prescription_3.png | PASS |  | True | empty_ocr_text | True | FAIL | 0/0 | SKIP |
| prescription_4.jpg | PASS | 0.7653853146938774 | False |  | True | review_required | 21/0 | SKIP |
| prescription_5.jpg | PASS | 0.734832315897436 | False |  | True | review_required | 18/1 | PASS |
| prescription_6.jpg | PASS | 0.9071014495121953 | False |  | True | review_required | 6/5 | SKIP |

## 2. Confirm and schedule E2E

- Confirmed image: prescription_5.jpg
- Matched medication: ì§ì¤ë¡ë§¥ì¤ì 250ë°ë¦¬ê·¸ë(ìì§í¸ë¡ë§ì´ì ìíë¬¼)
- userMedicationId: 8f69d163-75dc-4fe9-83d0-f62021bc1f8c
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

- Detail JSON: result\frontend-backend-e2e-post-p6-candidate-fix.json
