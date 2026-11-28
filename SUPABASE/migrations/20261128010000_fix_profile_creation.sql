-- =============================================================================
-- SỬA LỖI: hồ sơ (profiles) không được tạo -> "không hiện user", "không tìm thấy người dùng này"
--
-- Nguyên nhân: trình duyệt tạo hồ sơ bằng upsert, và PostgREST đặt cả cột khóa `id` vào danh sách UPDATE.
-- File 20261128000000_init_schema.sql ban đầu chưa cấp quyền UPDATE cho cột `id` nên lệnh bị từ chối
-- (mã nguồn không kiểm tra kết quả nên không hiện lỗi).
--
-- File này an toàn khi chạy lại nhiều lần. Dành cho project ĐÃ chạy init_schema trước đó.
-- (Project mới chạy init_schema bản hiện tại đã gồm sẵn các thay đổi này.)
-- Cách chạy: Supabase -> SQL Editor -> dán toàn bộ file -> Run.
-- =============================================================================
begin;

-- 1) Cho phép upsert hồ sơ. An toàn vì RLS chỉ cho sửa hàng của chính mình và trigger profiles_guard
--    luôn giữ nguyên id cũ khi UPDATE.
grant update (id) on public.profiles to authenticated;

-- 2) Tự tạo hồ sơ ngay khi có tài khoản mới trong auth.users (không phụ thuộc trình duyệt / xác nhận email).
create or replace function public.create_profile_for_auth_user(u auth.users) returns void
language plpgsql security definer set search_path = public as $$
declare
  base text;
  candidate text;
  n integer := 0;
begin
  base := left(trim(coalesce(
            nullif(u.raw_user_meta_data ->> 'username', ''),
            nullif(u.raw_user_meta_data ->> 'name', ''),
            nullif(u.raw_user_meta_data -> 'custom_claims' ->> 'global_name', ''),
            nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
            'User')), 20);
  if base = '' then base := 'User'; end if;
  candidate := base;
  loop
    begin
      insert into public.profiles (id, username, avatar_url)
      values (u.id, candidate,
              coalesce(nullif(u.raw_user_meta_data ->> 'avatar_url', ''), nullif(u.raw_user_meta_data ->> 'picture', '')))
      on conflict (id) do nothing;
      exit;
    exception when unique_violation then
      -- trùng tên (không phân biệt hoa thường): thêm hậu tố ngẫu nhiên
      n := n + 1;
      exit when n > 5;
      candidate := left(base, 15) || '_' || substr(md5(random()::text || clock_timestamp()::text), 1, 4);
    end;
  end loop;
end $$;
revoke execute on function public.create_profile_for_auth_user(auth.users) from public, anon, authenticated;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.create_profile_for_auth_user(new);
  exception when others then
    null;  -- không bao giờ chặn việc đăng ký; trình duyệt vẫn upsert hồ sơ khi đăng nhập
  end;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3) Tạo bù hồ sơ cho các tài khoản đã đăng ký trước đó mà chưa có hồ sơ
do $$
declare u auth.users;
begin
  for u in select * from auth.users a where not exists (select 1 from public.profiles p where p.id = a.id) loop
    perform public.create_profile_for_auth_user(u);
  end loop;
end $$;

commit;
