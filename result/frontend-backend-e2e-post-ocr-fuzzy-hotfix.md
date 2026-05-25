# Frontend-backend OCR/E2E validation result

- Generated UTC: 2026-05-25T00:10:01.4495129Z
- Project: hygsrrmoawezonahnljn
- Image directory: images
- Temp user deleted: True

## 1. OCR/analyze/confirm by image

| Image | OCR | confidence | manual | failureReason | imageDeleted | analyze mode | detected/matched | confirm |
|---|---|---:|---|---|---|---|---:|---|
| prescription_1.jpeg | PASS | 0.6132253799999999 | True | low_ocr_confidence | True | review_required | 1/0 | SKIP |
| prescription_2.png | PASS | 0.8198258839622637 | False |  | True | review_required | 25/0 | SKIP |
| prescription_3.png | PASS |  | True | empty_ocr_text | True | FAIL | 0/0 | SKIP |
| prescription_4.jpg | PASS | 0.7653862534693876 | False |  | True | review_required | 22/0 | SKIP |
| prescription_5.jpg | PASS | 0.734832315897436 | False |  | True | review_required | 19/0 | SKIP |

## 2. Confirm and schedule E2E

- No medication was confirmed

## 3. Gemini selected medication context

| Request | OK | selected source |
|---|---|---|

## 4. Raw JSON

- Detail JSON: result\frontend-backend-e2e-post-ocr-fuzzy-hotfix.json
