create or replace function public.find_medication_candidates_bulk(search_texts text[], max_results integer default 1)
returns table (
  search_text text,
  id uuid,
  item_seq text,
  item_name text,
  entp_name text,
  edi_code text,
  similarity_score real,
  match_rank integer,
  match_source text,
  alias_requires_confirmation boolean,
  alias_type text
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
          when lower(ma.alias) = lower(i.search_text) then coalesce(ma.priority, 100)
          when m.edi_code = i.search_text then 2
          when i.search_text = any(m.bar_codes) then 3
          when ma.alias ilike '%' || i.search_text || '%' then coalesce(ma.priority, 100) + 10
          when i.search_text ilike '%' || ma.alias || '%' then coalesce(ma.priority, 100) + 20
          else 1000
        end
      ) as priority,
      bool_or(lower(ma.alias) = lower(i.search_text)) as has_exact_alias,
      bool_or(ma.alias ilike '%' || i.search_text || '%' or i.search_text ilike '%' || ma.alias || '%') as has_alias_match,
      (
        array_agg(ma.requires_confirmation order by coalesce(ma.priority, 100), length(ma.alias) desc, ma.alias)
        filter (
          where lower(ma.alias) = lower(i.search_text)
            or ma.alias ilike '%' || i.search_text || '%'
            or i.search_text ilike '%' || ma.alias || '%'
        )
      )[1] as alias_requires_confirmation,
      (
        array_agg(ma.alias_type order by coalesce(ma.priority, 100), length(ma.alias) desc, ma.alias)
        filter (
          where lower(ma.alias) = lower(i.search_text)
            or ma.alias ilike '%' || i.search_text || '%'
            or i.search_text ilike '%' || ma.alias || '%'
        )
      )[1] as alias_type
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
    ranked.match_rank,
    case
      when lower(ranked.item_name) = lower(ranked.search_text) then 'exact'
      when ranked.edi_code = ranked.search_text then 'edi_code'
      when ranked.has_exact_alias or ranked.has_alias_match then 'alias'
      else 'fuzzy'
    end as match_source,
    coalesce(ranked.alias_requires_confirmation, false) as alias_requires_confirmation,
    ranked.alias_type
  from ranked
  where match_rank <= greatest(1, least(max_results, 20))
  order by search_text, match_rank;
$$;
