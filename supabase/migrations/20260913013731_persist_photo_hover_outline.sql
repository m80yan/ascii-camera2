-- Persist the final, publish-time hover outline. Existing photos stay null and
-- continue to use the Gallery's legacy fallback rather than being reclassified.
alter table public.ascii_photos
  add column if not exists hover_outline text,
  add column if not exists frame_mask_kind text,
  add column if not exists preview_aspect text;

alter table public.ascii_photos
  drop constraint if exists ascii_photos_hover_outline_check,
  add constraint ascii_photos_hover_outline_check
    check (hover_outline is null or hover_outline in ('rectangle', 'square', 'circle', 'oval', 'character')),
  drop constraint if exists ascii_photos_frame_mask_kind_check,
  add constraint ascii_photos_frame_mask_kind_check
    check (frame_mask_kind is null or frame_mask_kind in ('oval', 'round'));

-- The Gallery reads through this RPC, so adding columns to the table alone is
-- insufficient: include the persisted outline contract in the returned row.
create or replace function public.gallery_order_page(
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
    select id, ascii, color, created_at, owner_id,
           hover_outline, frame_mask_kind, preview_aspect,
           is_animated, frame_count, fps, duration_ms,
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
