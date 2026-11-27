# Cơ sở dữ liệu (Supabase)

Ứng dụng cần **Supabase** (PostgreSQL + Auth + REST API). Repo gốc không công khai schema, nên file
`supabase/migrations/20261128000000_init_schema.sql` được **suy ra từ mã nguồn** (23 bảng, RLS, 6 hàm RPC).
Kiểu dữ liệu, ràng buộc và chính sách RLS là suy đoán hợp lý, **không phải bản sao database gốc**.

## Cách tạo bảng

1. Tạo project tại supabase.com (hoặc qua Vercel Marketplace).
2. **SQL Editor → New query**, dán toàn bộ `supabase/migrations/20261128000000_init_schema.sql`, bấm **Run**.
   (Hoặc Supabase CLI: `npx supabase link --project-ref <mã>` rồi `npx supabase db push`.)
3. Chỉ chạy **một lần** trên project trống. Muốn làm lại: Database → xóa bảng, hoặc tạo project mới.
4. Cấp quyền quản trị cho tài khoản của bạn (sau khi đã đăng ký một lần trên web), chạy trong SQL Editor:
   ```sql
   update public.profiles set role = 'manager' where username = 'ten_cua_ban';
   ```
   Vai trò: `user` (mặc định) < `admin` < `manager`. `admin` và `manager` đều được ghi dữ liệu tham chiếu.
5. Kiểm tra: mở `https://<site>/api/system` thấy `SUPABASE_URL` và `SUPABASE_KEY`; đăng ký, đăng nhập, mở trang chủ.

Kiểm thử tự động schema trên PostgreSQL thật: `npm i --no-save @electric-sql/pglite && node supabase/tests/schema.test.mjs`.

## Quy ước quyền truy cập

Trình duyệt dùng **khóa công khai** nên mọi thứ phụ thuộc RLS. Mặc định **từ chối**; thao tác nhạy cảm (duyệt/từ chối ảnh,
cấm người dùng, đổi vai trò, ủng hộ...) đi qua API server (`functions/api/*`) dùng `SUPABASE_SERVICE_ROLE_KEY` (bỏ qua RLS).

- **Khách**: chỉ đọc ảnh đã duyệt và dữ liệu công khai; ghi được lượt xem.
- **Người dùng**: sửa hồ sơ của mình (không sửa role/ban/điểm), bình luận/thích, gửi yêu cầu chỉnh sửa, sửa ảnh của mình (không đổi `status`/`views`).
- **admin/manager** (`is_staff()`): ghi bảng tham chiếu, duyệt yêu cầu, đọc nhật ký.
- **Phân quyền phụ `quality_aud`** (`is_reviewer()`): xem được ảnh chưa duyệt.
- **Chỉ server**: `donations`, `admin_logs`, `banned_ips`, `reputation_logs`, `qr_login_sessions` (bật RLS, không có chính sách).

## Danh sách bảng

| Bảng | Vai trò | Cột chính | Đọc | Ghi (trình duyệt) |
|---|---|---|---|---|
| `profiles` | Hồ sơ (1-1 với `auth.users`) | `id`, `username` (duy nhất không phân biệt hoa thường), `avatar_url`, `role`, `subroles[]`, `ban_status` jsonb, `preferences` jsonb, `reputation_score`, `known_ips`, `favorite_photo_id`, `discord_custom_role_id` | Mọi người (trừ `known_ips`) | Chỉ hồ sơ của mình; chỉ các cột `username, avatar_url, preferences, favorite_photo_id`; `discord_custom_role_id` chỉ được đặt về NULL |
| `vehicles` | Xe, khóa chính = biển số | `license_plate`, `model`, `note` | Mọi người | admin/manager |
| `photos` | Ảnh (id là số) | `url`, `license_plate`→vehicles, `operator`, `type` (`bus`/`coach`), `route_no`, `borrowed_route`, `taken_at`, `uploader_id`→profiles, `note`, `exif_params`, `camera_model`, `location`, `status`, `denial_reason`, `is_documentary`, `views`, `audit_date`, `mod_note`, `review_progress`, `reviewer_count` | Khách: `approved`; chủ ảnh: ảnh của mình; reviewer: tất cả | Chủ ảnh/admin sửa các cột thông tin; xóa ảnh của mình; **không** `INSERT`, **không** đổi `status`/`views`/`review_*` |
| `vehicle_history` | Lịch sử khai thác của xe | `license_plate`, `operator`, `route`, `note`, `effective_date`, `display_order` | Mọi người | admin/manager |
| `edit_requests` | Yêu cầu chỉnh sửa | `requester_id`, `license_plate`, `new_data` jsonb (`request_type`, `photo_id`, `reason`...), `status` | Người gửi + admin/manager | Gửi (người dùng); duyệt (admin/manager) |
| `photo_comments` | Bình luận (có trả lời qua `parent_id`) | `photo_id`, `user_id`, `parent_id`, `content` | Mọi người | Bình luận bằng tên mình (không bị cấm); xóa của mình (hoặc admin) |
| `photo_likes` | Lượt thích | khóa chính `(photo_id, user_id)` | Mọi người | Thích/bỏ thích của mình (không bị cấm) |
| `photo_reviews` | Phiếu duyệt của quản trị viên | khóa chính `(photo_id, admin_id)`, `action`, `reason` | reviewer | Chỉ server |
| `photo_views_log` | Nhật ký lượt xem | `photo_id`, `viewer_id` | Không ai (trigger tăng `photos.views`) | Mọi người (khách cũng được) |
| `route_info` | Thông tin tuyến, khóa chính = `route_name` | `route_no`, `province`, `short_path`, `description`, `is_inactive`, `is_special`, `metadata` jsonb | Mọi người | admin/manager |
| `operator_info` | Nhà vận hành | `operator_name`, `logo_url`, `description`, `parent_operator` | Mọi người | admin/manager |
| `model_info` | Mẫu xe | `model_name`, `logo_url`, `description` | Mọi người | admin/manager |
| `donations` | Ủng hộ qua PayOS | `order_code` (duy nhất), `user_id`, `donor_name`, `amount`, `message`, `status`, `is_anonymous`, `payos_payment_link_id` | Chỉ server | Chỉ server |
| `admin_audit_logs` | Nhật ký thao tác quản trị | `admin_id`, `action_type`, `target_id`, `details` jsonb | admin/manager | admin/manager (ghi bằng id của mình) |
| `admin_logs` | Nhật ký phía server | `admin_id`, `target_user_id`, `action_type`, `details` | Chỉ server | Chỉ server |
| `admin_notes` | Ghi chú chung (luôn `id = 1`) | `content`, `updated_by` | admin/manager | admin/manager |
| `banned_ips` | IP bị chặn | `ip` (khóa chính), `reason` | Chỉ server | Chỉ server |
| `system_settings` | Công tắc hệ thống (vd `admin_ops`) | `id`, `is_active`, `auto_reactivate_at`, `reason`, `updated_by` | Mọi người | admin/manager |
| `custom_toasts` | Thông báo tùy chỉnh | `title`, `message`, `icon`, `color`, `link_url`, `link_label`, `sort_order`, `show_mode`, `duration`, `is_active` | Mọi người (chỉ mục đang bật) | admin/manager |
| `no_photo_zones` | Vùng cấm chụp trên bản đồ | `name`, `description`, `bounds` jsonb, `created_by` | Mọi người | admin/manager |
| `zone_edit_requests` | Đề xuất sửa vùng cấm chụp | `requester_id`, `type` (`add`/`update`), `target_zone_id`, `new_data`, `status` | Người gửi + admin/manager | Gửi (người dùng); xử lý (admin/manager) |
| `reputation_logs` | Lịch sử điểm uy tín | `user_id`, `photo_id`, `change_amount`, `reason` | Chỉ server | Chỉ server |
| `qr_login_sessions` | Phiên đăng nhập QR | `qid`, `status` | Chỉ server | Chỉ server |

## Hàm RPC (tùy chọn)

Giao diện có cách dự phòng nếu các hàm này không có, nên chúng chỉ giúp nhanh hơn. Tên và tham số khớp đúng cách trình duyệt gọi:
`get_home_stats(pref_filter)`, `get_operator_stats(op_name)`, `get_model_stats(mdl_name)`,
`get_operator_plates(op_name)`, `get_trending_photos_24h(filter_type, limit_num)`, `get_user_profile_stats(target_user_id, is_own_profile)`.
Nội dung được suy ra từ cách giao diện dùng kết quả (các trường `total_photos`, `total_views`, `total_vehicles`, `total_routes`, `total_ops`, `total_likes`).

## Điểm đáng chú ý trong thiết kế

- **`profiles.ban_status` luôn phải có khóa `banned`** (mặc định `{"banned": false}`). Code lọc `ban_status->>'banned' <> 'true'`; nếu NULL thì dòng bị loại ra khỏi kết quả.
- **Ảnh không có `INSERT` từ trình duyệt**: chỉ `/api/upload` (service role) tạo ảnh. Trigger tự tạo dòng `vehicles` còn thiếu để khóa ngoại không làm tải ảnh lỗi.
- **`photos.views` chỉ tăng qua `photo_views_log`** (trigger); trình duyệt sửa trực tiếp sẽ bị từ chối, nên mã cũ `update({views})` âm thầm thất bại nhưng số liệu vẫn đúng.
- **Chống leo thang đặc quyền**: người dùng không tự đổi `role`, `subroles`, `ban_status`, `reputation_score`, `known_ips`, và không tự đặt `discord_custom_role_id` (server dùng nó để cấp role Discord).

## Những điều chưa chắc chắn (cần bạn xác nhận khi dùng)

- Kiểu dữ liệu và ràng buộc là suy đoán (ví dụ `taken_at` là `timestamptz`, `details` là `jsonb`, không đặt `CHECK` cho `role`/`status`/`type`).
- Quyền ghi bảng tham chiếu chỉ cho `admin`/`manager`. Nếu bản gốc cho các phân quyền phụ khác (`dev`, `admin_ops`...) ghi trực tiếp, hãy chỉnh `is_staff()`.
- `edit_requests` chỉ người gửi và quản trị viên đọc được; nếu giao diện cần hiển thị yêu cầu đang chờ cho mọi người, hãy nới chính sách `edit_req_read`.
- `qr_login_sessions` chỉ có `qid`, `status`, `created_at`; luồng đăng nhập QR đầy đủ (nằm ngoài repo) có thể cần thêm cột.
- Không tạo dữ liệu mẫu ngoài một dòng `admin_notes (id = 1)`; `system_settings` được giao diện tự `upsert`.
- Hồ sơ `profiles` do trình duyệt tự `upsert` sau khi đăng nhập (đúng cách mã gốc làm), không có trigger tự tạo khi đăng ký.
- Tên người dùng được ràng buộc duy nhất (không phân biệt hoa thường) bằng chỉ mục; nếu luồng đăng nhập tạo tên trùng sẽ báo lỗi.
