// Kiểm thử schema trên PostgreSQL thật (PGlite) với các role của Supabase.
// Chạy: npm i --no-save @electric-sql/pglite && node supabase/tests/schema.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
const sql = fs.readFileSync(new URL('../migrations/20261128000000_init_schema.sql', import.meta.url), 'utf8');

// --- Giả lập môi trường Supabase ---
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`);
const A='11111111-1111-1111-1111-111111111111', B='22222222-2222-2222-2222-222222222222', ADM='33333333-3333-3333-3333-333333333333', BAN='44444444-4444-4444-4444-444444444444';
await db.exec(`insert into auth.users(id,email) values ('${A}','a@x'),('${B}','b@x'),('${ADM}','adm@x'),('${BAN}','ban@x')`);

console.log('1) Chạy migration');
await db.exec(sql);
const tables = (await db.query(`select count(*)::int n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`)).rows[0].n;
assert.equal(tables, 23); console.log('  ✓ migration chạy trọn vẹn, tạo đúng', tables, 'bảng');
const fns = (await db.query(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname like 'get\\_%' order by 1`)).rows.map(r=>r.proname);
assert.deepEqual(fns, ['get_home_stats','get_model_stats','get_operator_plates','get_operator_stats','get_trending_photos_24h','get_user_profile_stats']); console.log('  ✓ đủ 6 hàm RPC');

// Dữ liệu ban đầu bằng service_role
const as = async (role, uid, fn) => { await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub','${uid||''}', false)`); try { return await fn(); } finally { await db.exec('reset role'); } };
const q = (s, p) => db.query(s, p);
const fails = async (s, re, msg) => { let err; try { await q(s); } catch (e) { err = e; } assert.ok(err, 'phải lỗi: ' + msg); if (re) assert.match(err.message, re, msg); console.log('  ✓', msg); };

await db.exec(`set role service_role`);
await q(`insert into public.profiles(id,username) values ('${A}','alice'),('${B}','bob')`);
await q(`insert into public.profiles(id,username,role) values ('${ADM}','admin1','admin')`);
await q(`insert into public.profiles(id,username,ban_status) values ('${BAN}','banned1','{"banned": true}')`);
await q(`insert into public.photos(url,license_plate,operator,type,route_no,status,uploader_id,views) values
  ('u1','29B-1','Hà Nội','bus','32','approved','${A}',5),
  ('u2','29B-2','Hà Nội','bus','33','pending','${A}',0),
  ('u3','51B-9','Sài Gòn','coach','01','approved','${B}',2),
  ('u4','30A-7','Hà Nội','bus','34','approved','${BAN}',9)`);
await db.exec('reset role');
const vc = (await q(`select count(*)::int n from public.vehicles`)).rows[0].n; assert.equal(vc, 4); console.log('  ✓ trigger tự tạo vehicles khi chèn ảnh (không lỗi khóa ngoại):', vc, 'xe');
assert.equal((await q(`select ban_status->>'banned' b from public.profiles where id='${A}'`)).rows[0].b, 'false'); console.log("  ✓ ban_status mặc định có khóa banned='false'");

console.log('2) Khách (anon)');
await as('anon', null, async () => {
  const r = (await q(`select url from public.photos order by id`)).rows.map(x=>x.url); assert.deepEqual(r, ['u1','u3','u4']); console.log('  ✓ chỉ thấy ảnh đã duyệt (không thấy ảnh pending)');
  assert.ok((await q(`select username, role, ban_status from public.profiles`)).rows.length === 4); console.log('  ✓ đọc được hồ sơ công khai');
  await fails(`select known_ips from public.profiles`, /permission denied/i, 'KHÔNG đọc được profiles.known_ips (IP người dùng)');
  await fails(`select * from public.donations`, /permission denied/i, 'KHÔNG đọc được donations');
  await fails(`select * from public.photo_views_log`, /permission denied/i, 'KHÔNG đọc được photo_views_log');
  await fails(`insert into public.photos(url) values ('x')`, /permission denied/i, 'KHÔNG chèn được ảnh');
  await fails(`update public.photos set views = 999`, /permission denied/i, 'KHÔNG sửa được ảnh');
  await q(`insert into public.photo_views_log(photo_id) values (1)`); console.log('  ✓ ghi được lượt xem');
});
assert.equal((await q(`select views from public.photos where id=1`)).rows[0].views, 6); console.log('  ✓ trigger tăng photos.views 5 -> 6');

console.log('3) Người dùng thường (Alice)');
await as('authenticated', A, async () => {
  await q(`insert into public.profiles(id,username,avatar_url,preferences) values ('${A}','alice2','a.png','{}') on conflict (id) do update set username=excluded.username, avatar_url=excluded.avatar_url, preferences=excluded.preferences`);
  console.log('  ✓ upsert hồ sơ của chính mình (đúng cách trình duyệt làm)');
  await fails(`update public.profiles set role='admin' where id='${A}'`, /permission denied/i, 'KHÔNG tự nâng role thành admin');
  await fails(`update public.profiles set ban_status='{"banned": false}' where id='${A}'`, /permission denied/i, 'KHÔNG tự sửa ban_status');
  await fails(`update public.profiles set reputation_score=9999 where id='${A}'`, /permission denied/i, 'KHÔNG tự sửa điểm uy tín');
  await fails(`insert into public.profiles(id,username,role) values ('${B}','x','admin')`, /permission denied/i, 'KHÔNG chèn hồ sơ kèm role');
  const r = await q(`update public.profiles set username='hack' where id='${B}'`); assert.equal(r.affectedRows, 0); console.log('  ✓ KHÔNG sửa được hồ sơ người khác (0 dòng)');
  await q(`update public.profiles set discord_custom_role_id='123' where id='${A}'`);
  assert.equal((await q(`select discord_custom_role_id d from public.profiles where id='${A}'`)).rows[0].d, null); console.log('  ✓ trigger chặn tự đặt discord_custom_role_id');
  assert.equal((await q(`select count(*)::int n from public.photos where status='pending'`)).rows[0].n, 1); console.log('  ✓ thấy ảnh pending CỦA MÌNH');
  await fails(`update public.photos set status='approved' where id=2`, /permission denied/i, 'KHÔNG tự duyệt ảnh (status)');
  await fails(`update public.photos set views=1000000 where id=1`, /permission denied/i, 'KHÔNG sửa views');
  await q(`update public.photos set note='ghi chú' where id=1`); console.log('  ✓ sửa note ảnh của mình');
  assert.equal((await q(`update public.photos set note='x' where id=3`)).affectedRows, 0); console.log('  ✓ KHÔNG sửa được ảnh của người khác');
  await fails(`update public.photos set uploader_id='${B}' where id=1`, /row-level security/i, 'KHÔNG chuyển quyền sở hữu ảnh cho người khác');
  await q(`insert into public.photo_comments(photo_id,user_id,content) values (1,'${A}','hay')`); console.log('  ✓ bình luận bằng danh nghĩa mình');
  await fails(`insert into public.photo_comments(photo_id,user_id,content) values (1,'${B}','giả mạo')`, /row-level security/i, 'KHÔNG bình luận giả danh người khác');
  await q(`insert into public.photo_likes(photo_id,user_id) values (3,'${A}')`); console.log('  ✓ thích ảnh');
  await q(`insert into public.edit_requests(requester_id,license_plate,new_data) values ('${A}','29B-1','{"request_type":"update_vehicle_details"}')`); console.log('  ✓ gửi yêu cầu chỉnh sửa');
  await fails(`insert into public.vehicles(license_plate) values ('NEW')`, /row-level security/i, 'KHÔNG tự thêm/sửa dữ liệu xe (chỉ admin)');
  await fails(`insert into public.route_info(route_name) values ('X')`, /row-level security/i, 'KHÔNG tự sửa route_info');
  assert.equal((await q(`select count(*)::int n from public.admin_audit_logs`)).rows[0].n, 0); console.log('  ✓ KHÔNG đọc được nhật ký quản trị (RLS lọc về 0 dòng)');
  await fails(`insert into public.admin_audit_logs(admin_id,action_type) values ('${A}','x')`, /row-level security/i, 'KHÔNG ghi được nhật ký quản trị');
});

console.log('4) Người dùng thường khác (Bob) không thấy yêu cầu của Alice');
await as('authenticated', B, async () => {
  assert.equal((await q(`select count(*)::int n from public.edit_requests`)).rows[0].n, 0); console.log('  ✓ không đọc được edit_requests của người khác');
  assert.equal((await q(`select count(*)::int n from public.photos where status='pending'`)).rows[0].n, 0); console.log('  ✓ không thấy ảnh pending của người khác');
});

console.log('5) Tài khoản bị cấm (banned1)');
await as('authenticated', BAN, async () => {
  await fails(`insert into public.photo_comments(photo_id,user_id,content) values (1,'${BAN}','spam')`, /row-level security/i, 'người bị cấm KHÔNG bình luận được');
  await fails(`insert into public.photo_likes(photo_id,user_id) values (1,'${BAN}')`, /row-level security/i, 'người bị cấm KHÔNG thích được');
});

console.log('6) Quản trị viên (role=admin)');
await as('authenticated', ADM, async () => {
  assert.equal((await q(`select count(*)::int n from public.photos`)).rows[0].n, 4); console.log('  ✓ thấy mọi ảnh kể cả pending');
  await q(`insert into public.vehicles(license_plate,model) values ('NEW','Hyundai') on conflict (license_plate) do update set model=excluded.model`); console.log('  ✓ upsert vehicles');
  await q(`insert into public.operator_info(operator_name,description) values ('Hà Nội','x') on conflict (operator_name) do update set description=excluded.description`); console.log('  ✓ upsert operator_info');
  assert.equal((await q(`select count(*)::int n from public.edit_requests`)).rows[0].n, 1); console.log('  ✓ đọc mọi edit_requests');
  await q(`update public.edit_requests set status='approved' where id=1`); console.log('  ✓ duyệt edit_requests');
  await q(`insert into public.admin_audit_logs(admin_id,action_type,target_id,details) values ('${ADM}','x','1','"d"')`); console.log('  ✓ ghi admin_audit_logs');
  await q(`update public.admin_notes set content='hi' where id=1`); console.log('  ✓ sửa admin_notes');
  await fails(`update public.photos set status='denied' where id=1`, /permission denied/i, 'ngay cả admin cũng phải duyệt qua API server (client không đổi status)');
});

console.log('7) Hàm RPC (khách)');
await as('anon', null, async () => {
  const h = (await q(`select * from public.get_home_stats('both')`)).rows[0]; assert.deepEqual([h.total_photos,h.total_vehicles,h.total_routes].map(Number), [2,2,2]); console.log('  ✓ get_home_stats (bỏ ảnh người bị cấm & pending):', JSON.stringify(h));
  const hc = (await q(`select * from public.get_home_stats('coach')`)).rows[0]; assert.equal(Number(hc.total_photos), 1); console.log('  ✓ lọc theo loại xe');
  const o = (await q(`select * from public.get_operator_stats('hà nội')`)).rows[0]; assert.equal(Number(o.total_photos), 1); console.log('  ✓ get_operator_stats:', JSON.stringify(o));
  const t = (await q(`select id,url from public.get_trending_photos_24h('both', 5)`)).rows; assert.equal(t[0].url, 'u1'); assert.ok(!t.some(r=>r.url==='u4')&&!t.some(r=>r.url==='u2')); console.log('  ✓ get_trending_photos_24h (đứng đầu = ảnh vừa có lượt xem):', t.map(r=>r.url).join(','));
  const p = (await q(`select * from public.get_operator_plates('Hà Nội')`)).rows; assert.equal(p.length, 1); console.log('  ✓ get_operator_plates:', JSON.stringify(p[0]));
  await q(`select * from public.get_model_stats('Hyundai')`); console.log('  ✓ get_model_stats chạy được');
  const u = (await q(`select * from public.get_user_profile_stats('${A}', false)`)).rows[0]; assert.equal(Number(u.total_photos), 1); console.log('  ✓ get_user_profile_stats:', JSON.stringify(u));
});

console.log('8) Bảng chỉ server: người dùng đã đăng nhập cũng bị chặn');
await as('authenticated', A, async () => {
  for (const t of ['donations','admin_logs','banned_ips','reputation_logs','qr_login_sessions']) await fails(`select * from public.${t}`, /permission denied/i, `KHÔNG đọc được ${t}`);
});
await as('service_role', null, async () => {
  await q(`insert into public.donations(order_code,amount) values (123,50000)`); await q(`insert into public.banned_ips(ip,reason) values ('1.2.3.4','x') on conflict (ip) do update set reason='y'`);
  await q(`insert into public.photo_reviews(photo_id,admin_id,action) values (1,'${ADM}','approve') on conflict (photo_id,admin_id) do update set action=excluded.action`);
  console.log('  ✓ service_role (API server) đọc/ghi được, upsert photo_reviews theo (photo_id,admin_id)');
});
console.log('\nTẤT CẢ ĐẠT');
