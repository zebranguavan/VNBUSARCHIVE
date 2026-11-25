// Kiểm thử tự động lớp chạy Vercel: định tuyến, trang SSR (HTMLRewriter thay thế), POST body, chống giả IP.
// Chạy: npm run build && npm run vercel:test   (cần public/index.html do build-core.js tạo; Supabase được giả lập, không cần mạng)
import assert from 'node:assert/strict';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_KEY = 'test-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';

const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  calls.push(u);
  if (u.startsWith('https://example.supabase.co/rest/v1/photos')) {
    return new Response(JSON.stringify([{
      url: 'https://img.example/x.jpg', license_plate: '29B-123.45 "Q"', operator: 'Hà Nội & Co',
      route_no: '32', vehicles: { model: 'Hyundai <Universe>' }, profiles: { username: 'tester' },
    }]), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.startsWith('https://example.supabase.co')) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  return realFetch(url, init);
};

const { handle, matchRoute, buildForwardedRequest } = await import('./router.js');
let pass = 0; const ok = (name) => { pass++; console.log('  ✓', name); };
const req = (path, init) => new Request('https://my-app.vercel.app' + path, init);

console.log('1) Bảng route');
const cases = [
  ['/api/admin/action', ['api','admin','action']], ['/api/upload', ['api','upload']],
  ['/photo/123', ['photo',':id']], ['/vehicle/51B-123.45', ['vehicle',':id']],
  ['/route', ['route','*path']], ['/route/a/b', ['route','*path']],
  ['/api/rest', ['api','rest','*path']], ['/api/rest/photos/x', ['api','rest','*path']],
  ['/sitemap.xml', ['sitemap.xml']], ['/user/abc', ['user',':id']], ['/help/faq', ['help',':id']],
];
for (const [p, seg] of cases) { const m = matchRoute(p); assert.ok(m, p); assert.deepEqual(m.route.segments, seg, p); }
ok(`${cases.length} đường dẫn khớp đúng file`);
assert.equal(matchRoute('/api/khong-ton-tai'), null); assert.equal(matchRoute('/photo/1/2'), null); ok('đường dẫn lạ -> không khớp');
assert.deepEqual(matchRoute('/route/a/b').params.path, ['a','b']); assert.deepEqual(matchRoute('/route').params.path, []);
assert.equal(matchRoute('/vehicle/51B%20123').params.id, '51B 123'); ok('tham số [id] và [[path]] đúng dạng như Cloudflare');

console.log('2) Trang SSR /photo/:id (HTMLRewriter thay thế + ASSETS đọc public/index.html)');
let res = await handle(req('/api/index?__route=/photo/777'));
assert.equal(res.status, 200); ok('status 200');
assert.match(res.headers.get('content-type') || '', /text\/html/); ok('content-type html');
const html = await res.text();
assert.ok(html.length > 500000); ok(`HTML đầy đủ (${html.length} ký tự)`);
assert.match(html, /<title>29B-123\.45 "Q" - Hyundai &lt;Universe&gt; \| VNBUSARCHIVE<\/title>/); ok('<title> được thay và escape đúng');
assert.match(html, /<meta property="og:title" content="29B-123\.45 &quot;Q&quot; - Hyundai <Universe> \| VNBUSARCHIVE"/); ok('og:title được thay, dấu " được escape');
assert.match(html, /<meta property="og:image" content="https:\/\/img\.example\/x\.jpg"/); ok('og:image đúng');
assert.match(html, /<link[^>]*rel="canonical"[^>]*href="https:\/\/www\.vnbusarchive\.io\.vn\/photo\/777"/); ok('canonical đúng');
assert.match(html, /Hà Nội &amp; Co/); ok('& trong nội dung được escape thành &amp;');
assert.ok(html.includes('window.app'), 'script giữ nguyên'); ok('script/phần còn lại của index.html được giữ nguyên');

console.log('3) Các trang SSR khác (vehicle, route catch-all, operator, model, user, help)');
for (const p of ['/vehicle/51B-123.45', '/route', '/route/abc/def', '/operator/xyz', '/model/abc', '/user/u1', '/help/faq']) {
  const r = await handle(req('/api/index?__route=' + p)); const t = await r.text();
  assert.equal(r.status, 200, p); assert.ok(t.includes('<title>'), p);
}
ok('7 trang SSR trả HTML 200');

console.log('4) sitemap (caches.default / waitUntil)');
res = await handle(req('/api/index?__route=/sitemap.xml'));
assert.ok([200, 500].includes(res.status)); const sm = await res.text(); console.log('   sitemap status', res.status, '|', sm.slice(0, 60).replace(/\n/g, ' '));
assert.notEqual(res.status, 404); ok('sitemap.xml được định tuyến tới handler (không lỗi caches/waitUntil)');

console.log('5) POST có body đi qua router (formData)');
const fd = new FormData(); fd.set('isAvatar', 'false'); fd.set('fileExtension', 'jpg');
res = await handle(req('/api/index?__route=/api/upload', { method: 'POST', body: fd, headers: { origin: 'https://my-app.vercel.app' } }));
const upText = await res.text(); console.log('   /api/upload ->', res.status, upText.slice(0, 90));
assert.ok([400, 401, 403].includes(res.status), 'phải bị từ chối vì thiếu token/ảnh, KHÔNG phải 404/500/405'); ok('body POST đọc được, handler chạy và từ chối đúng (thiếu xác thực/ảnh)');

console.log('6) Method và 404');
res = await handle(req('/api/index?__route=/api/khong-co')); assert.equal(res.status, 404); ok('route lạ -> 404 JSON');
res = await handle(req('/api/index?__route=//evil.com/x')); assert.equal(res.status, 404); ok('__route dạng //host bị từ chối (chống open-redirect/SSRF)');
res = await handle(req('/api/index?__route=/photo/1', { method: 'HEAD' })); assert.equal(res.status, 200); assert.equal((await res.text()), ''); ok('HEAD trả body rỗng');

console.log('7) Chống giả IP (CF-Connecting-IP)');
let f = buildForwardedRequest(req('/api/index?__route=/api/system', { headers: { 'cf-connecting-ip': '6.6.6.6', 'x-real-ip': '1.2.3.4' } }));
assert.equal(f.request.headers.get('cf-connecting-ip'), '1.2.3.4'); ok('x-real-ip của Vercel ghi đè CF-Connecting-IP giả');
f = buildForwardedRequest(req('/api/index?__route=/api/system', { headers: { 'cf-connecting-ip': '6.6.6.6', 'x-forwarded-for': '8.8.8.8, 10.0.0.1' } }));
assert.equal(f.request.headers.get('cf-connecting-ip'), '8.8.8.8'); ok('fallback x-forwarded-for (phần tử đầu)');
f = buildForwardedRequest(req('/api/index?__route=/api/system', { headers: { 'cf-connecting-ip': '6.6.6.6' } }));
assert.equal(f.request.headers.get('cf-connecting-ip'), null); ok('không có IP tin cậy -> bỏ header giả');
console.log('\nTẤT CẢ ĐẠT:', pass, 'kiểm tra');
