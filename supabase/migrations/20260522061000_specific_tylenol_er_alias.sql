insert into public.medication_aliases (medication_id, alias, source)
select id, 'TYLENOL ER', 'known_brand_alias'
from public.medications
where item_name ilike '%타이레놀%'
  and (
    item_name ilike '%이알%'
    or item_name ilike '%서방%'
    or item_name ilike '%8시간%'
  )
on conflict (medication_id, normalized_alias) do nothing;
