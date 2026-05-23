# caregiver-invite

## Purpose

환자가 보호자를 초대하는 흐름을 검증한다.

## Input

```json
{
  "patientUserId": "temporary-patient-user-id",
  "caregiverUserId": "temporary-caregiver-user-id",
  "permissionScope": {
    "medication_status": true,
    "scan_results": true,
    "reports": true
  }
}
```

## Output

```json
{
  "caregiverLinkId": "temporary-caregiver-link-id",
  "status": "invited",
  "invitedBy": "patient",
  "nextAction": "caregiver can view invitation status, but patient consent is already represented by the invite."
}
```

## Result

PASS. 보호자 초대 링크가 생성됐다.
