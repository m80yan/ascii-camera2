-- Additive upgrade; existing photo content, ownership and RLS are preserved.
-- Curator is currently a UI mode, not a server-side administrator role.
-- These INVOKER functions retain the project's existing authenticated write policy.
alter table public.ascii_photos add column curator_rank double precision;
with ranks as (
  select id, row_number() over (order by created_at desc, id) * 1024.0 as rank
  from public.ascii_photos
)
update public.ascii_photos p set curator_rank = ranks.rank from ranks where p.id = ranks.id;
alter table public.ascii_photos alter column curator_rank set not null;
create index ascii_photos_curator_rank_idx on public.ascii_photos (curator_rank, id);
create index ascii_photos_type_curator_rank_idx on public.ascii_photos (is_animated, curator_rank, id);

create table public.gallery_order_state (
  id boolean primary key default true check (id),
  revision bigint not null default 0,
  last_request uuid,
  last_user uuid,
  last_result jsonb
);
insert into public.gallery_order_state(id) values (true);
alter table public.gallery_order_state enable row level security;
revoke all on public.gallery_order_state from anon, authenticated;
grant select on public.gallery_order_state to anon, authenticated;
grant update on public.gallery_order_state to authenticated;
create policy gallery_order_read on public.gallery_order_state for select to anon, authenticated using (true);
create policy gallery_order_write on public.gallery_order_state for update to authenticated
  using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null);

create function public.gallery_order_photo_change() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  -- Serialize uploads/deletions with reorder saves; counts/views do not change revision.
  update public.gallery_order_state set revision = revision + 1 where id;
  if TG_OP = 'INSERT' then
    select coalesce(min(curator_rank), 0) - 1024 into new.curator_rank from public.ascii_photos;
    return new;
  end if;
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.gallery_order_photo_change() from public, anon, authenticated;
create trigger gallery_order_photo_insert before insert on public.ascii_photos
  for each row execute function public.gallery_order_photo_change();
create trigger gallery_order_photo_delete before delete on public.ascii_photos
  for each row execute function public.gallery_order_photo_change();
create trigger gallery_order_photo_visibility before update of is_deleted on public.ascii_photos
  for each row when (old.is_deleted is distinct from new.is_deleted)
  execute function public.gallery_order_photo_change();

create function public.gallery_order_page(
  page_offset integer default 0, page_limit integer default 20,
  media_filter text default 'all', include_deleted boolean default false,
  expected_revision bigint default null
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_revision bigint; v_photos jsonb;
begin
  select revision into v_revision from public.gallery_order_state where id;
  if expected_revision is not null and expected_revision <> v_revision then
    raise sqlstate 'PT409' using message = 'Gallery order changed. Reload the current view.';
  end if;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.curator_rank, p.id), '[]'::jsonb)
  into v_photos from (
    select id, ascii, color, created_at, owner_id, is_animated, frame_count, fps, duration_ms,
           is_deleted, likes_count, downloads_count, views_count, curator_rank
    from public.ascii_photos
    where (include_deleted or not coalesce(is_deleted, false))
      and (media_filter = 'all' or coalesce(is_animated, false) = (media_filter = 'loop'))
    order by curator_rank, id
    limit greatest(1, least(page_limit, 100)) offset greatest(0, page_offset)
  ) p;
  return jsonb_build_object('revision', v_revision, 'photos', v_photos);
end;
$$;
revoke all on function public.gallery_order_page(integer,integer,text,boolean,bigint) from public;
grant execute on function public.gallery_order_page(integer,integer,text,boolean,bigint) to anon, authenticated;

create function public.gallery_order_move(
  moves jsonb, expected_revision bigint, request_id uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare s public.gallery_order_state; m jsonb; source_id uuid; anchor_id uuid;
        anchor_rank double precision; neighbor_rank double precision; next_rank double precision;
        move_after boolean; result jsonb;
begin
  if auth.uid() is null then raise insufficient_privilege using message = 'Sign in before saving order.'; end if;
  if request_id is null or jsonb_typeof(moves) <> 'array' or jsonb_array_length(moves) not between 1 and 100 then
    raise invalid_parameter_value using message = 'Invalid reorder batch.';
  end if;
  select * into s from public.gallery_order_state where id for update;
  if s.last_request = request_id and s.last_user = auth.uid() then return s.last_result; end if;
  if expected_revision is null or expected_revision <> s.revision then
    raise sqlstate 'PT409' using message = 'Gallery order changed in another window. Your order was not saved.';
  end if;
  for m in select value from jsonb_array_elements(moves) loop
    source_id := (m->>'id')::uuid;
    anchor_id := (m->>'anchor')::uuid;
    move_after := coalesce((m->>'after')::boolean, false);
    if source_id = anchor_id or source_id is null or anchor_id is null then
      raise invalid_parameter_value using message = 'Invalid reorder target.';
    end if;
    select curator_rank into anchor_rank from public.ascii_photos where id = anchor_id;
    if not found then raise sqlstate 'PT409' using message = 'Target photo is no longer available.'; end if;
    if move_after then
      select min(curator_rank) into neighbor_rank from public.ascii_photos where curator_rank > anchor_rank and id <> source_id;
      next_rank := case when neighbor_rank is null then anchor_rank + 1024 else anchor_rank + (neighbor_rank-anchor_rank)/2 end;
    else
      select max(curator_rank) into neighbor_rank from public.ascii_photos where curator_rank < anchor_rank and id <> source_id;
      next_rank := case when neighbor_rank is null then anchor_rank - 1024 else neighbor_rank + (anchor_rank-neighbor_rank)/2 end;
    end if;
    -- Rare precision exhaustion: rebalance ranks on the server, without fetching images.
    if next_rank = anchor_rank or next_rank = neighbor_rank then
      with ranks as (
        select id, row_number() over(order by curator_rank, id)*1024.0 as rank from public.ascii_photos
      ) update public.ascii_photos p set curator_rank = ranks.rank from ranks where p.id = ranks.id;
      select curator_rank into anchor_rank from public.ascii_photos where id = anchor_id;
      next_rank := anchor_rank + case when move_after then 512 else -512 end;
    end if;
    update public.ascii_photos set curator_rank = next_rank where id = source_id;
    if not found then raise sqlstate 'PT409' using message = 'Photo is no longer available or editable.'; end if;
  end loop;
  -- Only metadata is returned; caller already owns the visible image data.
  select jsonb_build_object('revision', s.revision + 1, 'ranks', coalesce(jsonb_agg(
    jsonb_build_object('id', p.id, 'rank', p.curator_rank)), '[]'::jsonb)) into result
  from public.ascii_photos p where p.id in (select (value->>'id')::uuid from jsonb_array_elements(moves));
  update public.gallery_order_state set revision = s.revision + 1, last_request = request_id,
    last_user = auth.uid(), last_result = result where id;
  return result;
end;
$$;
revoke all on function public.gallery_order_move(jsonb,bigint,uuid) from public, anon;
grant execute on function public.gallery_order_move(jsonb,bigint,uuid) to authenticated;
