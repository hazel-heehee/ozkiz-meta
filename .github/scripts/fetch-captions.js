// .github/scripts/fetch-captions.js
// 인스타 게시물 URL → Apify로 캡션 + 메타데이터 가져오기 → Supabase에 저장
//
// 작동 방식:
// 1. Supabase에서 link 있는데 text(캡션) 비어있는 게시물 조회
// 2. Apify instagram-scraper로 캡션, 좋아요, 댓글, 조회수 등 가져오기
// 3. 빈 필드만 업데이트 (사용자가 입력한 값은 절대 덮어쓰지 않음)

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const APIFY_TOKEN  = process.env.APIFY_TOKEN;

if (!SUPABASE_URL || !SUPABASE_KEY || !APIFY_TOKEN) {
  console.error('❌ 필수 환경 변수 누락');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  console.log('📥 빈 캡션 게시물 조회 중...');

  // text(캡션) 비어있거나 NULL인 게시물 (link 있는 것)
  const { data: posts, error } = await sb
    .from('insta_posts')
    .select('id, date, link, text, views, likes, comments, image_url')
    .not('link', 'is', null)
    .neq('link', '')
    .or('text.is.null,text.eq.')
    .order('date', { ascending: true });

  if (error) {
    console.error('❌ DB 조회 실패:', error);
    process.exit(1);
  }

  if (!posts || posts.length === 0) {
    console.log('✓ 처리할 게시물 없음 (모두 캡션 있음)');
    return;
  }

  console.log(`📊 처리 대상: ${posts.length}개 게시물`);

  // URL 정리 (?hl=ko 같은 쿼리 제거)
  const urls = posts.map(p => {
    const u = String(p.link || '').trim();
    return u.split('?')[0].replace(/\/$/, '');
  }).filter(u => u);

  console.log(`🚀 Apify 시작...`);

  // Apify instagram-scraper 호출
  const startRes = await axios.post(
    `https://api.apify.com/v2/acts/apify~instagram-scraper/runs?token=${APIFY_TOKEN}`,
    {
      directUrls: urls,
      resultsType: 'posts',
      resultsLimit: 1,  // URL당 1개
      addParentData: false
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  const runId = startRes.data.data.id;
  const datasetId = startRes.data.data.defaultDatasetId;
  console.log(`✓ Run 시작: ${runId}`);

  // 완료 대기 (폴링)
  let status = 'RUNNING';
  let waitSec = 0;
  while (status === 'RUNNING' || status === 'READY') {
    await new Promise(r => setTimeout(r, 10000));  // 10초마다 체크
    waitSec += 10;
    const statRes = await axios.get(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );
    status = statRes.data.data.status;
    console.log(`  ${waitSec}초 경과 — 상태: ${status}`);
    if (waitSec > 600) {  // 10분 timeout
      console.error('⏱️ Timeout');
      break;
    }
  }

  if (status !== 'SUCCEEDED') {
    console.error(`❌ Apify 실패: ${status}`);
    process.exit(1);
  }

  // 결과 가져오기
  console.log('📦 결과 데이터셋 가져오는 중...');
  const dsRes = await axios.get(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&clean=true`
  );
  const items = dsRes.data;
  console.log(`✓ ${items.length}개 데이터 받음`);

  // shortcode → 데이터 매핑
  function extractShortcode(url) {
    if (!url) return null;
    const clean = url.split('?')[0].replace(/\/$/, '');
    const m = clean.match(/\/(p|reel|tv)\/([^\/]+)/);
    return m ? m[2] : null;
  }

  const byShortcode = {};
  for (const item of items) {
    const sc = extractShortcode(item.url || item.shortCode);
    if (sc) byShortcode[sc] = item;
  }

  // DB 업데이트
  console.log(`💾 DB 업데이트 시작...`);
  let updated = 0;
  let skipped = 0;

  for (const post of posts) {
    const sc = extractShortcode(post.link);
    if (!sc) { skipped++; continue; }

    const item = byShortcode[sc];
    if (!item) {
      console.log(`  · ${post.date} ${sc}: Apify에 데이터 없음`);
      skipped++;
      continue;
    }

    // 업데이트 데이터 (빈 필드만 채움)
    const update = {};

    // 캡션
    if (!post.text && item.caption) {
      update.text = String(item.caption).substring(0, 5000);  // 너무 길면 잘라냄
    }

    // 좋아요 (사용자 데이터가 0이거나 없을 때만)
    if (!post.likes && typeof item.likesCount === 'number' && item.likesCount > 0) {
      update.likes = item.likesCount;
    }

    // 댓글
    if (!post.comments && typeof item.commentsCount === 'number' && item.commentsCount > 0) {
      update.comments = item.commentsCount;
    }

    // 조회수 (릴스만)
    if (!post.views && typeof item.videoViewCount === 'number' && item.videoViewCount > 0) {
      update.views = item.videoViewCount;
    }

    // 이미지 URL (Supabase Storage URL은 절대 덮어쓰지 않음)
    if (!post.image_url && item.displayUrl) {
      // 인스타 CDN URL은 만료되니 디스플레이용으로만 사용
      // 또는 무시 (사용자가 Ctrl+V로 직접 추가하는 게 더 안정적)
      // update.image_url = item.displayUrl;  // 주석 처리
    }

    if (Object.keys(update).length === 0) {
      skipped++;
      continue;
    }

    const { error: updErr } = await sb
      .from('insta_posts')
      .update(update)
      .eq('id', post.id);

    if (updErr) {
      console.error(`  ✗ ${post.date} ${sc}:`, updErr.message);
      skipped++;
    } else {
      updated++;
      const fields = Object.keys(update).join(', ');
      console.log(`  ✓ ${post.date} ${sc}: ${fields}`);
    }
  }

  console.log('\n══════════════════════════════════');
  console.log(`✅ 완료: ${updated}개 업데이트, ${skipped}개 스킵`);
  console.log('══════════════════════════════════');
}

main().catch(e => {
  console.error('💥 오류:', e.message);
  if (e.response?.data) console.error('  ', JSON.stringify(e.response.data).substring(0, 500));
  process.exit(1);
});
