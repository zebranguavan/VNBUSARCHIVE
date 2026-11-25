# Triển khai VNBUSARCHIVE lên Vercel

Dự án gốc viết cho **Cloudflare Pages** (thư mục `functions/`). Repo này đã có sẵn lớp chạy cho **Vercel** mà **không sửa code trong `functions/`**, nên cùng một repo vẫn deploy được lên cả hai nơi.

## Cách hoạt động

```
Trình duyệt ─► Vercel
   ├─ File tĩnh (public/): index.html, app.<hash>.js, tailwind.css, /vendor, /media ...
   └─ /api/*, /photo/:id, /vehicle/:id, /operator/:id, /model/:id, /route/*, /user/:id, /help/:id, /sitemap.xml
        └─(rewrite trong vercel.json)─► api/index.js  (MỘT function duy nhất)
              └─ vercel/router.js chọn đúng file trong functions/ và gọi onRequest*(context)
```

| Thành phần | Vai trò |
|---|---|
| `api/index.js` | Điểm vào duy nhất của Vercel Functions |
| `vercel/router.js` | Định tuyến theo quy tắc đặt tên của Cloudflare (`[id].js`, `[[path]].js`), đặt lại `CF-Connecting-IP` |
| `vercel/cf-compat.js` | Dựng lại `context` (`env`, `params`, `waitUntil`, `env.ASSETS`) |
| `vercel/html-rewriter.js` | Thay thế `HTMLRewriter` và `caches.default` (chỉ có trên Cloudflare) |
| `vercel/routes.js`, `vercel.json` | **Tự sinh** từ `functions/` và `csp.json` khi chạy `npm run build` |
| `functions/package.json`, `api/package.json`, `vercel/package.json` | Đánh dấu `"type": "module"` cho riêng các thư mục này (không ảnh hưởng `build-core.js`) |

Dùng một function duy nhất để không vướng giới hạn số lượng function và để dùng chung một lần khởi động.

## Các bước triển khai

1. **Import repo** vào Vercel (Add New → Project → chọn GitHub repo). Preset chọn **Other**; `vercel.json` đã khai báo Build Command `npm run build` và Output Directory `public`.
2. **Thêm biến môi trường** (Settings → Environment Variables, tick cả Production và Preview):

   | Nhóm | Biến |
   |---|---|
   | Supabase | `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
   | Thanh toán PayOS | `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY` |
   | Lưu ảnh | `CF_IMGBED_TOKEN` |
   | Discord | `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`, `DISCORD_REPORT_CHANNEL_ID`, `DISCORD_HELP_CHANNEL_ID`, `DISCORD_ROLE_50`, `DISCORD_ROLE_200`, `DISCORD_ROLE_500`, `DISCORD_ROLE_1000`, `DISCORD_ROLE_2000` |
   | Email | `RESEND_API_KEY` |
   | Chống bot | `CAPTCHA_SECRET`, `TURNSTILE_SECRET_KEY` |
   | Khác | `FIREBASE_BUS_URL` (dùng lúc build để tạo `public/token.js`), `FIREBASE_URL` |

   Chỉ cần khai báo những nhóm bạn thật sự dùng. Khóa `SUPABASE_SERVICE_ROLE_KEY` và các khóa bí mật **không** được đưa vào code hay commit.
3. **Deploy.** Lần build đầu sẽ chạy `npm run build` (tạo `public/`, `tailwind.css`, và đồng bộ `vercel.json`).
4. **Cấu hình dịch vụ ngoài** theo địa chỉ mới (`https://ten-du-an.vercel.app` hoặc domain riêng):
   - Supabase → Authentication → URL Configuration: Site URL và Redirect URLs.
   - Cloudflare Turnstile: thêm hostname mới vào site key.
   - Webhook PayOS (nếu dùng): trỏ tới `/api/donate/webhook` của địa chỉ mới.

## Khi sửa code

- Sửa `csp.json` hoặc thêm/xóa/đổi tên file trong `functions/` → chạy `npm run build` (hoặc `npm run vercel:generate`) rồi **commit cả `vercel.json` và `vercel/routes.js`**. Vercel đọc `vercel.json` từ repo trước khi build, nên file này phải được commit sẵn.
- Kiểm thử nhanh lớp chạy Vercel: `npm run build && npm run vercel:test` (không cần mạng, Supabase được giả lập).

## Khác biệt so với Cloudflare cần biết

- **Chặn IP ở tường lửa Cloudflare** (`api/manager.js` dùng `CF_ZONE_ID`, `CF_API_TOKEN`) không có trên Vercel. Code tự bỏ qua khi thiếu hai biến này nên không gây lỗi, nhưng việc chặn IP sẽ không được thực thi ở tầng mạng.
- **Giới hạn kích thước body**: theo hiểu biết của người viết, Vercel Functions giới hạn khoảng 4,5 MB mỗi request. `api/upload.js` nhận ảnh qua `formData`, nên ảnh lớn có thể bị từ chối. Hãy xem trang *Limits* của Vercel và nén ảnh phía trình duyệt, hoặc cho trình duyệt tải thẳng lên nơi lưu ảnh.
- **IP người dùng**: router ghi đè `CF-Connecting-IP` bằng IP do Vercel cung cấp (`x-real-ip`), vì nếu không client có thể tự gửi header này để giả IP.
- **Tên miền cố định**: các trang SSR vẫn đặt `canonical`/`og:url` về `https://www.vnbusarchive.io.vn`. Muốn dùng domain của bạn, thay chuỗi này trong `functions/` và `_core.html`. Các hàm kiểm tra `origin`/`referer` chỉ bật khi host chứa `vnbusarchive.io.vn`; với domain khác chúng cho qua, bạn nên tự thêm kiểm tra cho domain của mình.
- **File thừa trong `public/`**: `_headers`, `_routes.json` (sinh cho Cloudflare) vẫn được Vercel phục vụ như file tĩnh. Không nguy hiểm nhưng không có tác dụng.
- **Deployment Protection**: trên bản Preview có bật bảo vệ, truy cập từ bên ngoài (crawler, webhook) sẽ bị chặn. Dùng domain Production khi cấu hình webhook.
- **Gói Hobby** của Vercel dành cho dùng cá nhân, phi thương mại. Dự án có nhận ủng hộ nên hãy đọc kỹ điều khoản của Vercel.

## Lỗi thường gặp

| Triệu chứng | Nguyên nhân có thể |
|---|---|
| `/api/...` trả 404 JSON `{"error":"Not Found"}` | Thêm file mới trong `functions/` nhưng chưa chạy lại `npm run build` / chưa commit `vercel/routes.js` |
| Trang `/photo/...` trả lỗi 500 | Thiếu `SUPABASE_URL`/`SUPABASE_KEY`, hoặc `public/index.html` chưa có trong bundle; xem Runtime Logs |
| Mất giao diện (không có CSS) | Build không tạo được `public/tailwind.css`; xem log bước "Đang biên dịch Tailwind CSS" |
| Đăng nhập/xác minh email lỗi | Chưa cập nhật Site URL và Redirect URLs trong Supabase |
| CAPTCHA không hiện | Chưa thêm hostname vào Turnstile site key |
