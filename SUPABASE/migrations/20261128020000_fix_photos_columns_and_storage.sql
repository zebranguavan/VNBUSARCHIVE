-- =============================================================================
-- SỬA LỖI: "Không thể tải ảnh lên - HTTP 500"
--
-- Có hai nguyên nhân phía database/kho ảnh, file này xử lý cả hai (chạy lại nhiều lần vẫn an toàn):
--  1) Thiếu cột photos.suspected_exif_fraud (api/upload.js chèn cột này) và photos.needs_third
--     (api/admin/action.js đọc/ghi khi duyệt ảnh). Thiếu cột thì lệnh chèn ảnh báo lỗi 500.
--  2) Chưa có bucket lưu ảnh. Bản code mới lưu ảnh vào Supabase Storage (bucket công khai "photos")
--     thay cho CDN của dự án gốc.
-- Cách chạy: Supabase -> SQL Editor -> dán toàn bộ file -> Run.
-- =============================================================================
begin;

alter table public.photos add column if not exists suspected_exif_fraud boolean not null default false;
alter table public.photos add column if not exists needs_third          boolean not null default false;

-- Bucket công khai: ai cũng xem được ảnh qua URL; chỉ server (service role) mới ghi/xóa được.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do update set public = true;

commit;
