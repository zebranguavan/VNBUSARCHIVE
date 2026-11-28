// Lưu / xóa file ảnh. Dùng chung cho api/upload.js, api/delete-image.js, api/admin/replace-image.js.
//
//  - Bản chạy chính thức (host chứa vnbusarchive.io.vn, có CF_IMGBED_TOKEN): dùng CDN ảnh của dự án gốc (giữ nguyên hành vi cũ).
//  - Mọi bản triển khai khác: lưu vào SUPABASE STORAGE của chính bạn (bucket công khai, mặc định tên "photos";
//    đổi bằng biến môi trường IMAGE_BUCKET). Cần SUPABASE_URL và SUPABASE_SERVICE_ROLE_KEY.
//    Bucket được tạo bởi supabase/migrations/..._fix_photos_columns_and_storage.sql.
const AUTHOR_CDN = 'https://cdn.vnbusarchive.io.vn';

const bucketOf = (env) => env.IMAGE_BUCKET || 'photos';

export function useAuthorCdn(request, env) {
    return (request.headers.get('host') || '').includes('vnbusarchive.io.vn') && !!env.CF_IMGBED_TOKEN;
}

// Trả về URL công khai của ảnh đã lưu.
export async function storeImage({ request, env, sbAdmin, file, fileName }) {
    if (useAuthorCdn(request, env)) {
        const formData = new FormData();
        formData.append('file', file, fileName);
        const result = await fetch(`${AUTHOR_CDN}/upload`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.CF_IMGBED_TOKEN}` },
            body: formData
        }).then((res) => res.json());
        if (!result || !result[0] || !result[0].src) {
            console.error('[CDN UPLOAD ERROR]:', JSON.stringify(result));
            throw new Error(`Lỗi phản hồi từ CDN: ${JSON.stringify(result)}`);
        }
        const raw = result[0].src;
        return raw.startsWith('/') ? `${AUTHOR_CDN}${raw}` : raw;
    }

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('Thiếu biến môi trường SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY nên không lưu được ảnh vào Supabase Storage.');
    }
    const bucket = bucketOf(env);
    const { error } = await sbAdmin.storage.from(bucket).upload(fileName, file, {
        contentType: file.type || 'application/octet-stream',
        cacheControl: '31536000',
        upsert: false
    });
    if (error) {
        throw new Error(`Lỗi lưu ảnh vào Supabase Storage (bucket "${bucket}"): ${error.message || JSON.stringify(error)}`);
    }
    return sbAdmin.storage.from(bucket).getPublicUrl(fileName).data.publicUrl;
}

// Xóa file ảnh (cố gắng hết sức, không ném lỗi). Chỉ xóa file thuộc đúng kho lưu trữ của dự án này.
export async function removeImage({ request, env, sbAdmin, url }) {
    if (!url || typeof url !== 'string') return false;
    try {
        if (useAuthorCdn(request, env)) {
            if (!url.includes('vnbusarchive')) return false;
            const name = new URL(url).pathname.split('/').pop();
            if (!name) return false;
            const res = await fetch(`${AUTHOR_CDN}/api/manage/delete/${encodeURIComponent(name)}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${env.CF_IMGBED_TOKEN}` }
            });
            return res.ok;
        }

        if (!env.SUPABASE_URL || !sbAdmin) return false;
        const bucket = bucketOf(env);
        const prefix = `${env.SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object/public/${bucket}/`;
        if (!url.startsWith(prefix)) return false;
        const path = decodeURIComponent(url.slice(prefix.length).split('?')[0]);
        if (!path || path.includes('..')) return false;
        const { error } = await sbAdmin.storage.from(bucket).remove([path]);
        return !error;
    } catch (e) {
        console.warn('[WARN] removeImage:', e);
        return false;
    }
}
