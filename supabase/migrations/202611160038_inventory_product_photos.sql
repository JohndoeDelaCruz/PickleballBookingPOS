begin;

alter table public.pos_products add column photo_version uuid unique;

create table private.pos_product_photos (
  product_id uuid primary key references public.pos_products(id) on delete cascade,
  content bytea not null check (octet_length(content) between 5 and 524288)
);
alter table private.pos_product_photos enable row level security;
revoke all on private.pos_product_photos from public, anon, authenticated;

create function public.pos_save_product_with_photo(p_product jsonb, p_photo text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  saved_id uuid;
  photo_bytes bytea;
begin
  perform private.pos_require_staff(true);
  if p_product->>'id' is not null and p_product->>'revision' is null then
    raise exception 'POS: Reload this product before saving.';
  end if;

  if p_photo is not null then
    if length(p_photo) not between 8 and 699052 or length(p_photo) % 4 <> 0
      or p_photo !~ '^[a-zA-Z0-9+/]+={0,2}$' then
      raise exception 'POS: Choose a valid product photo.';
    end if;
    photo_bytes := decode(p_photo, 'base64');
    if octet_length(photo_bytes) not between 5 and 524288
      or substring(photo_bytes from 1 for 3) <> decode('ffd8ff', 'hex')
      or substring(photo_bytes from octet_length(photo_bytes) - 1) <> decode('ffd9', 'hex') then
      raise exception 'POS: Choose a valid product photo.';
    end if;
  end if;

  -- Save the product, audit event and photo in one transaction using the existing revision check.
  saved_id := public.pos_save_product(p_product);
  if photo_bytes is null then
    delete from private.pos_product_photos where product_id = saved_id;
    update public.pos_products set photo_version = null where id = saved_id;
  else
    insert into private.pos_product_photos (product_id, content) values (saved_id, photo_bytes)
      on conflict on constraint pos_product_photos_pkey do update set content = excluded.content;
    update public.pos_products set photo_version = gen_random_uuid() where id = saved_id;
  end if;
  return saved_id;
end;
$$;

create function public.pos_product_photo(p_version uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.pos_require_staff();
  return (select encode(photo.content, 'base64')
    from public.pos_products p join private.pos_product_photos photo on photo.product_id = p.id
    where p.photo_version = p_version);
end;
$$;

revoke all on function public.pos_save_product_with_photo(jsonb, text), public.pos_product_photo(uuid) from public, anon, authenticated;
grant execute on function public.pos_save_product_with_photo(jsonb, text), public.pos_product_photo(uuid) to authenticated;
notify pgrst, 'reload schema';

commit;
