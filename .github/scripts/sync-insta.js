// .github/scripts/sync-insta.js
// 인스타 ozkiz_official 본인 게시물 자동 동기화
// 매일 KST 23:45 실행 — 좋아요/댓글/조회수/캡션/타입 갱신
// (도달·저장·공유·프로필방문·외부링크는 Apify 미제공 → 수동 입력 유지)

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const APIFY_TOKEN  = process.env.APIFY_TOKEN;
const TARGET_USERNAME = 'ozkiz_official';
const MAX_POSTS = 5;
const INSTA_ACTOR = 'apify~instagram-scraper';

if (!SUPABASE_URL || !SUPABASE_KEY || !APIFY_TOKEN) {
  console.error('❌ 환경 변수 누락');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

async function waitForApifyRun(runId, label) {
  let status = 'RUNNING';
  let waitSec = 0;
  while (status === 'RUNNING' || status === 'READY') {
    await new Promise(r => setTimeout(r, 15000));
    waitSec += 15;
    const statRes = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    status = statRes.data.data.status;
    console.log(`  [${label}] ${waitSec}초 — ${status}`);
    if (waitSec > 1800) { console.error(`⏱️ Timeout (${label})`); break; }
  }
  return status;
}


// ─── 썸네일 영구 저장: IG CDN 이미지를 다운로드해 Supabase Storage(insta-media/auto)에 업로드 ───
// IG CDN URL은 며칠 뒤 만료(403)되므로, 영구 URL로 교체해 썸네일이 안 깨지게 함
async function persistThumb(cdnUrl, filename) {
  if (!cdnUrl) return '';
  try {
    const img = await axios.get(cdnUrl, { responseType: 'arraybuffer', timeout: 20000 });
    const contentType = img.headers['content-type'] || 'image/jpeg';
    const path = `auto/${filename}`;
    await axios.post(
      `${SUPABASE_URL}/storage/v1/object/insta-media/${path}`,
      img.data,
      { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'apikey': SUPABASE_KEY, 'Content-Type': contentType, 'x-upsert': 'true' }, maxBodyLength: Infinity }
    );
    return `${SUPABASE_URL}/storage/v1/object/public/insta-media/${path}`;
  } catch (e) {
    console.warn(`  ⚠️ 썸네일 저장 실패(${filename}): ${e.message} — CDN URL 유지`);
    return '';
  }
}

(async () => {
  console.log(`📸 인스타 동기화 시작 — @${TARGET_USERNAME}, 최신 ${MAX_POSTS}개`);

  // 1) Actor 실행
  const runRes = await axios.post(
    `https://api.apify.com/v2/acts/${INSTA_ACTOR}/runs?token=${APIFY_TOKEN}`,
    {
      directUrls: [`https://www.instagram.com/${TARGET_USERNAME}/`],
      resultsType: 'posts',
      resultsLimit: MAX_POSTS,
      addParentData: false
    },
    { headers: { 'Content-Type': 'application/json' } }
  );
  const runId = runRes.data.data.id;
  const datasetId = runRes.data.data.defaultDatasetId;
  console.log('  Run:', runId, '| dataset:', datasetId);

  // 2) 완료 대기
  const status = await waitForApifyRun(runId, 'insta');
  if (status !== 'SUCCEEDED') {
    console.error('❌ Actor 실패:', status);
    process.exit(1);
  }

  // 3) 데이터셋
  const itemsRes = await axios.get(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&clean=true&format=json`
  );
  const items = Array.isArray(itemsRes.data) ? itemsRes.data : [];
  console.log(`  수신 항목: ${items.length}개`);
  if (items.length > 0) console.log('  첫 항목 키:', Object.keys(items[0]).join(', '));

  // 4) 기존 게시물 shortCode 맵
  const { data: existingRows } = await sb
    .from('insta_posts')
    .select('id, link, text, image_url');
  const existingByShortcode = {};
  (existingRows || []).forEach(r => {
    const m = String(r.link || '').match(/\/(p|reel|tv)\/([^/]+)/);
    if (m) existingByShortcode[m[2]] = r;
  });

  let added = 0, updated = 0, skipped = 0;

  for (const item of items) {
    try {
      const shortCode = item.shortCode || item.id || '';
      if (!shortCode) { skipped++; continue; }

      // 타입 분류
      let post_type = '피드';
      const childCount = Array.isArray(item.childPosts) ? item.childPosts.length : 0;
      if (item.type === 'Video') post_type = childCount >= 2 ? '캐러셀' : '릴스';
      else if (item.type === 'Sidecar' || childCount >= 2) post_type = '캐러셀';
      else if (item.type === 'Image') post_type = '피드';
      else post_type = childCount >= 2 ? '캐러셀' : '피드';

      // 날짜 (UTC → KST +9h)
      const ts = item.timestamp || item.takenAtTimestamp;
      let dateStr = '';
      if (ts) {
        const d = new Date(ts);
        const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
        dateStr = kst.toISOString().slice(0, 10);
      }

      const url = item.url || `https://www.instagram.com/p/${shortCode}/`;
      const caption = item.caption || '';

      // 썸네일 영구 저장 (기존이 이미 영구본/사용자 업로드면 스킵해 비용·시간 절약)
      const existing0 = existingByShortcode[shortCode];
      const existingImg0 = String((existing0 && existing0.image_url) || '').trim();
      const alreadyPermanent = existingImg0.includes('insta-media') || existingImg0.includes('supabase');
      let permanentImg = '';
      if (!alreadyPermanent && item.displayUrl) {
        permanentImg = await persistThumb(item.displayUrl, `insta_${shortCode}.jpg`);
      }

      const postData = {
        date: dateStr,
        post_type,
        link: url,
        text: caption,
        image_url: permanentImg || item.displayUrl || '',
        video_url: item.videoUrl || '',
        views: parseInt(item.videoViewCount || item.videoPlayCount || 0) || 0,
        likes: parseInt(item.likesCount || 0) || 0,
        comments: parseInt(item.commentsCount || 0) || 0
      };

      const existing = existingByShortcode[shortCode];
      if (existing) {
        const updateData = {
          views: postData.views,
          likes: postData.likes,
          comments: postData.comments,
          post_type: postData.post_type
        };
        // 사용자 업로드 이미지(Supabase Storage)는 보호
        const existingImg = String(existing.image_url || '').trim();
        const isUserUploaded = existingImg.includes('insta-media') || existingImg.includes('supabase');
        if (!isUserUploaded && postData.image_url) updateData.image_url = postData.image_url;
        if (postData.video_url) updateData.video_url = postData.video_url;
        if (!existing.text && postData.text) updateData.text = postData.text;

        const { error } = await sb.from('insta_posts').update(updateData).eq('id', existing.id);
        if (error) console.warn('  ✗ update', shortCode, error.message);
        else { updated++; console.log(`  ↻ ${(caption||url).slice(0,30)}... ♥${postData.likes} 💬${postData.comments}`); }
      } else {
        const { error } = await sb.from('insta_posts').insert(postData);
        if (error) console.warn('  ✗ insert', shortCode, error.message);
        else { added++; console.log(`  + ${(caption||url).slice(0,30)}... ♥${postData.likes}`); }
      }
    } catch (e) {
      console.error('  게시물 처리 실패:', item.shortCode, e.message);
    }
  }

  console.log(`✅ 인스타 동기화 완료 — 신규 ${added} / 업데이트 ${updated} / 건너뜀 ${skipped}`);
})().catch(e => { console.error('❌ 인스타 동기화 오류:', e.message); process.exit(1); });
