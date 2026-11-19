begin;

create function public.list_counter_products()
returns table (name text, category text, price_cents integer, photo_version uuid)
language sql stable security definer set search_path = '' as $$
  select p.name, p.category, p.price_cents, p.photo_version
    from public.pos_products p
    where p.active and p.stock > 0
    order by (p.photo_version is not null) desc, p.created_at desc, p.id desc
    limit 12;
$$;

create function public.counter_product_photo(p_version uuid)
returns text language sql stable security definer set search_path = '' as $$
  select encode(photo.content, 'base64')
    from public.pos_products p
    join private.pos_product_photos photo on photo.product_id = p.id
    where p.photo_version = p_version and p.active and p.stock > 0;
$$;

revoke all on function public.list_counter_products(), public.counter_product_photo(uuid) from public, anon, authenticated;
grant execute on function public.list_counter_products(), public.counter_product_photo(uuid) to anon, authenticated;
notify pgrst, 'reload schema';

commit;
