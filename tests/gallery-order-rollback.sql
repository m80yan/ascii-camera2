-- Run as the project SQL owner. All test data and reorders are rolled back.
begin;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select id from auth.users limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare a uuid; b uuid; c uuid; rev bigint; request uuid := gen_random_uuid();
        saved jsonb; replay jsonb; old_rank double precision; page jsonb;
begin
  insert into public.ascii_photos(ascii,color,user_id,is_animated)
    values ('order QA a','#00ff41',auth.uid(),false) returning id into a;
  insert into public.ascii_photos(ascii,color,user_id,is_animated)
    values ('order QA b','#00ff41',auth.uid(),true) returning id into b;
  insert into public.ascii_photos(ascii,color,user_id,is_animated)
    values ('order QA c','#00ff41',auth.uid(),false) returning id into c;
  select revision into rev from public.gallery_order_state;
  page := public.gallery_order_page(0,3,'all',true,null);
  assert page->'photos'->0->>'id' = c::text, 'New uploads must start first';
  saved := public.gallery_order_move(jsonb_build_array(jsonb_build_object('id',a,'anchor',c,'after',false)),rev,request);
  page := public.gallery_order_page(0,3,'all',true,null);
  assert page->'photos'->0->>'id' = a::text, 'Before-anchor move failed';
  replay := public.gallery_order_move(jsonb_build_array(jsonb_build_object('id',a,'anchor',c,'after',false)),rev,request);
  assert replay = saved, 'Retry must be idempotent';
  begin
    perform public.gallery_order_move(jsonb_build_array(jsonb_build_object('id',a,'anchor',c,'after',true)),rev,gen_random_uuid());
    raise exception 'Stale save was accepted';
  exception when sqlstate 'PT409' then null;
  end;
  begin
    perform public.gallery_order_page(3,3,'all',true,rev);
    raise exception 'Stale pagination was accepted';
  exception when sqlstate 'PT409' then null;
  end;
  rev := (saved->>'revision')::bigint;
  select curator_rank into old_rank from public.ascii_photos where id=a;
  begin
    perform public.gallery_order_move(jsonb_build_array(
      jsonb_build_object('id',a,'anchor',b,'after',true),
      jsonb_build_object('id',c,'anchor',gen_random_uuid(),'after',true)),rev,gen_random_uuid());
    raise exception 'Invalid batch was accepted';
  exception when sqlstate 'PT409' then null;
  end;
  assert (select curator_rank from public.ascii_photos where id=a) = old_rank, 'Batch must roll back atomically';
  assert (select revision from public.gallery_order_state) = rev, 'Failed batch advanced revision';
  perform public.gallery_order_move(jsonb_build_array(jsonb_build_object('id',a,'anchor',b,'after',true)),rev,gen_random_uuid());
  page := public.gallery_order_page(0,3,'all',true,null);
  assert page->'photos'->2->>'id' = a::text, 'After-anchor move failed';
  page := public.gallery_order_page(0,1,'loop',true,null);
  assert page->'photos'->0->>'id' = b::text, 'Media filter failed';
  assert not (page->'photos'->0 ? 'frames'), 'Pagination must not fetch Loop frames';
end;
$$;
rollback;
