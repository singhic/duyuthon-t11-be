# Frontend-backend OCR/E2E validation result

- Generated UTC: 2026-05-24T06:29:28.9917637Z
- Project: hygsrrmoawezonahnljn
- Image directory: images
- Temp user deleted: True
- Note: Initial run found `prescription_2.png` failing at `google-ocr` with pharmacy unique constraint 409. `google-ocr` pharmacy upsert was fixed and redeployed, then this result was regenerated.

## 1. OCR/analyze/confirm by image

| Image | OCR | confidence | manual | failureReason | imageDeleted | analyze mode | detected/matched | confirm |
|---|---|---:|---|---|---|---|---:|---|
| prescription_1.jpeg | PASS | 0.6132253925000001 | True | low_ocr_confidence | True | review_required | 1/0 | SKIP |
| prescription_2.png | PASS | 0.8195502728301883 | False |  | True | review_required | 24/0 | SKIP |
| prescription_3.png | PASS |  | True | empty_ocr_text | True | FAIL | 0/0 | SKIP |
| prescription_4.jpg | PASS | 0.7657503210204084 | False |  | True | review_required | 25/0 | SKIP |
| prescription_5.jpg | PASS | 0.734832315897436 | False |  | True | review_required | 25/1 | PASS |

## Findings

- `prescription_2.png` no longer fails after the `google-ocr` pharmacy upsert fix.
- `prescription_3.png` produced empty OCR text. `google-ocr` handled this as `empty_ocr_text`, but `analyze-medication` cannot proceed and returns 400 if called anyway. Frontend must stop at OCR review/retry for this case.
- Only `prescription_5.jpg` produced a matched medication and could continue to `confirm-medication`.
- `prescription_1.jpeg`, `prescription_2.png`, and `prescription_4.jpg` reached analyze but had no matched medication, so confirm was correctly skipped.
- All OCR successes reported `imageDeleted=true`.
- Schedule/checklist E2E passed using the confirmed medication from `prescription_5.jpg`.

## 2. Confirm and schedule E2E

- Confirmed image: prescription_5.jpg
- Matched medication: ì§ì¤ë¡ë§¥ì¤ì 250ë°ë¦¬ê·¸ë(ìì§í¸ë¡ë§ì´ì ìíë¬¼)
- userMedicationId: e0751533-85e2-4b2e-a812-df292673ba21
- suggest call: True, suggestion count: 0
- fallback schedule used: True
- schedule created: True
- checklist before: True
- log taken: True, status: taken
- checklist after: True

Checklist before summary:
```json
{
    "total":  1,
    "pending":  1,
    "taken":  0,
    "missed":  0,
    "skipped":  0
}
```

Checklist after summary:
```json
{
    "total":  1,
    "pending":  0,
    "taken":  1,
    "missed":  0,
    "skipped":  0
}
```

## 3. Raw JSON

- Detail JSON: result/frontend-backend-e2e-20260524.json
