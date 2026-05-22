create table if not exists public.medication_aliases (
  medication_id uuid not null references public.medications(id) on delete cascade,
  alias text not null,
  normalized_alias text generated always as (lower(regexp_replace(alias, '\s+', '', 'g'))) stored,
  source text not null default 'operator',
  created_at timestamptz not null default now(),
  primary key (medication_id, normalized_alias)
);

create index if not exists medication_aliases_alias_trgm_idx
  on public.medication_aliases using gin (alias gin_trgm_ops);

alter table public.medication_aliases enable row level security;

drop policy if exists "medication aliases readable" on public.medication_aliases;
create policy "medication aliases readable" on public.medication_aliases
  for select using (auth.role() in ('authenticated', 'anon'));

insert into public.medication_aliases (medication_id, alias, source)
select id, 'TYLENOL', 'known_brand_alias'
from public.medications
where item_name ilike '%타이레놀%'
on conflict (medication_id, normalized_alias) do nothing;

insert into public.medication_aliases (medication_id, alias, source)
select id, 'ASPIRIN', 'known_brand_alias'
from public.medications
where item_name ilike '%아스피린%'
on conflict (medication_id, normalized_alias) do nothing;

create or replace function public.find_medication_candidates_bulk(search_texts text[], max_results integer default 1)
returns table (
  search_text text,
  id uuid,
  item_seq text,
  item_name text,
  entp_name text,
  edi_code text,
  similarity_score real,
  match_rank integer
)
language sql
stable
as $$
  with inputs as (
    select distinct trim(value) as search_text
    from unnest(search_texts) as value
    where value is not null
      and length(trim(value)) > 1
  ),
  scored as (
    select
      i.search_text,
      m.id,
      m.item_seq,
      m.item_name,
      m.entp_name,
      m.edi_code,
      greatest(
        similarity(m.item_name, i.search_text),
        coalesce(max(similarity(ma.alias, i.search_text)), 0)
      )::real as similarity_score,
      min(
        case
          when lower(m.item_name) = lower(i.search_text) then 1
          when lower(ma.alias) = lower(i.search_text) then 1
          when m.edi_code = i.search_text then 2
          when i.search_text = any(m.bar_codes) then 3
          when ma.alias ilike '%' || i.search_text || '%' then 4
          when i.search_text ilike '%' || ma.alias || '%' then 5
          else 6
        end
      ) as priority
    from inputs i
    join public.medications m
      on m.item_name % i.search_text
      or m.item_name ilike '%' || i.search_text || '%'
      or m.edi_code = i.search_text
      or i.search_text = any(m.bar_codes)
      or exists (
        select 1
        from public.medication_aliases ma2
        where ma2.medication_id = m.id
          and (
            ma2.alias % i.search_text
            or lower(ma2.alias) = lower(i.search_text)
            or ma2.alias ilike '%' || i.search_text || '%'
            or i.search_text ilike '%' || ma2.alias || '%'
          )
      )
    left join public.medication_aliases ma on ma.medication_id = m.id
    group by i.search_text, m.id, m.item_seq, m.item_name, m.entp_name, m.edi_code
  ),
  ranked as (
    select
      scored.*,
      row_number() over (
        partition by search_text
        order by priority, similarity_score desc, item_name
      )::integer as match_rank
    from scored
  )
  select
    ranked.search_text,
    ranked.id,
    ranked.item_seq,
    ranked.item_name,
    ranked.entp_name,
    ranked.edi_code,
    ranked.similarity_score,
    ranked.match_rank
  from ranked
  where match_rank <= greatest(1, least(max_results, 20))
  order by search_text, match_rank;
$$;

create or replace function public.find_medication_candidates(search_text text, max_results integer default 5)
returns table (
  id uuid,
  item_seq text,
  item_name text,
  entp_name text,
  edi_code text,
  similarity_score real
)
language sql
stable
as $$
  select
    b.id,
    b.item_seq,
    b.item_name,
    b.entp_name,
    b.edi_code,
    b.similarity_score
  from public.find_medication_candidates_bulk(array[search_text], max_results) b;
$$;
