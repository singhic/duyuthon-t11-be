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
  ranked as (
    select
      i.search_text,
      m.id,
      m.item_seq,
      m.item_name,
      m.entp_name,
      m.edi_code,
      similarity(m.item_name, i.search_text) as similarity_score,
      row_number() over (
        partition by i.search_text
        order by
          case
            when m.item_name = i.search_text then 1
            when m.edi_code = i.search_text then 2
            when i.search_text = any(m.bar_codes) then 3
            else 4
          end,
          similarity(m.item_name, i.search_text) desc
      )::integer as match_rank
    from inputs i
    join public.medications m
      on m.item_name % i.search_text
      or m.item_name ilike '%' || i.search_text || '%'
      or m.edi_code = i.search_text
      or i.search_text = any(m.bar_codes)
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

