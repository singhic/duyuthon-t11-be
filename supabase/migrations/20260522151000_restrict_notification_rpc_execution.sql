revoke execute on function public.due_medication_notifications(timestamptz, timestamptz, uuid)
  from public, anon, authenticated;

grant execute on function public.due_medication_notifications(timestamptz, timestamptz, uuid)
  to service_role;

revoke execute on function public.claim_due_medication_notifications(timestamptz, timestamptz, uuid, interval)
  from public, anon, authenticated;

grant execute on function public.claim_due_medication_notifications(timestamptz, timestamptz, uuid, interval)
  to service_role;
