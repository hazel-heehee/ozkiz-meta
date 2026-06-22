// .github/scripts/check-hashtag-exposure.js
// 인스타 해시태그 자동 측정:
// 1. 각 해시태그의 총 게시물 수 (search_count) — NEW!
// 2. top 30에서 ozkiz 게시물 노출 분석 (exposure_count, top9_count)

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const APIFY_TOKEN  = process.env.APIFY_TOKEN;

if (!SUPABASE_URL || !SUPABASE_KEY || !APIFY_TOKEN) {
  console.error('❌ 환경 변수 누락');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

function checkOzkizMatch(post) {
  const owner = (post.ownerUsername || '').toLowerCase();
  const caption = (post.caption || '').toLowerCase();
  const hashtags = (post.hashtags || []).map(h => String(h).toLowerCase());
  const mentions = (post.mentions || []).map(m => String(m).toLowerCase());

  const matches = {
    byAccount: owner === 'ozkiz_official',
    byCaption: caption.includes('오즈키즈') || caption.includes('ozkiz'),
    byHashtag: hashtags.some(h => h.includes('오즈키즈') || h.includes('ozkiz')),
    byMention: mentions.some(m => m.includes('ozkiz'))
  };
  matches.any = matches.byAccount || matches.byCaption || matches.byHashtag || matches.byMention;
  return matches;
}

function extractHashtagFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/tags\/([^\/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function waitForApifyRun(runId, label) {
  let status = 'RUNNING';
  let waitSec = 0;
  while (status === 'RUNNING' || status === 'READY') {
    await new Promise(r => setTimeout(r, 20000));
    waitSec += 20;
    const statRes = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    status = statRes.data.data.status;
    console.log(`  [${label}] ${waitSec}초 — ${status}`);
    if (waitSec > 5400) { console.error(`⏱️ Timeout (${label})`); break; }
  }
  return status;
}

async function main() {
  console.log('🔍 해시태그 자동 측정 시작\n');

  const { data: hashtags, error } = await sb
    .from('insta_hashtags')
    .select('id, keyword')
    .order('sort_order');

  if (error) throw new Error('DB 조회 실패: ' + error.message);
  console.log(`📊 측정할 해시태그: ${hashtags.length}개\n`);

  const urls = hashtags.map(h =>
    `https://www.instagram.com/explore/tags/${encodeURIComponent(h.keyword)}/`
  );

  // ─── 1단계: 해시태그 게시물 수 ───
  console.log('🏷️ 1단계: 해시태그 게시물 수 수집...');
  const hashtagPostCounts = {};

  try {
    const tagRes = await axios.post(
      `https://api.apify.com/v2/acts/apify~instagram-hashtag-scraper/runs?token=${APIFY_TOKEN}`,
      { hashtags: hashtags.map(h => h.keyword), resultsLimit: 1 },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const tagRunId = tagRes.data.data.id;
    const tagDatasetId = tagRes.data.data.defaultDatasetId;
    console.log(`✓ Tag Run 시작: ${tagRunId}`);

    const tagStatus = await waitForApifyRun(tagRunId, 'Tags');
    if (tagStatus === 'SUCCEEDED') {
      const tagDsRes = await axios.get(`https://api.apify.com/v2/datasets/${tagDatasetId}/items?token=${APIFY_TOKEN}&clean=true`);
      const tagItems = tagDsRes.data;
      tagItems.forEach(item => {
        const name = item.name || item.hashtag || item.tag;
        const count = item.postsCount || item.mediaCount || item.total || item.posts_count;
        if (name && typeof count === 'number') {
          hashtagPostCounts[name] = count;
        }
      });
      console.log(`✓ 게시물 수 수집: ${Object.keys(hashtagPostCounts).length}개`);
    } else {
      console.warn(`⚠️ Tags 실패: ${tagStatus} (없이 진행)`);
    }
  } catch (err) {
    console.warn(`⚠️ Tags 오류: ${err.message} (없이 진행)`);
  }

  // ─── 2단계: top 30 게시물 검색 ───
  console.log('\n🔍 2단계: top 30 게시물 검색 + 노출 분석...');

  const startRes = await axios.post(
    `https://api.apify.com/v2/acts/apify~instagram-scraper/runs?token=${APIFY_TOKEN}`,
    {
      directUrls: urls,
      resultsType: 'posts',
      resultsLimit: 30,
      addParentData: true
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  const runId = startRes.data.data.id;
  const datasetId = startRes.data.data.defaultDatasetId;
  console.log(`✓ Posts Run 시작: ${runId}`);

  const postsStatus = await waitForApifyRun(runId, 'Posts');
  if (postsStatus !== 'SUCCEEDED') {
    console.error(`❌ Posts 실패: ${postsStatus}`);
    process.exit(1);
  }

  console.log('\n📦 게시물 수신 중...');
  const dsRes = await axios.get(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&clean=true`);
  const items = dsRes.data;
  console.log(`✓ ${items.length}개 게시물 수신\n`);

  const byHashtag = {};
  items.forEach(item => {
    let kw = extractHashtagFromUrl(item.inputUrl)
          || extractHashtagFromUrl(item.parentInputUrl)
          || extractHashtagFromUrl(item.fromInputUrl)
          || item.hashtag
          || (item.parentData && item.parentData.name);

    if (!kw) return;
    if (!byHashtag[kw]) byHashtag[kw] = [];
    byHashtag[kw].push(item);

    // fallback: parent data에서 게시물 수
    if (!hashtagPostCounts[kw] && item.parentData) {
      const pc = item.parentData.postsCount || item.parentData.mediaCount;
      if (typeof pc === 'number') hashtagPostCounts[kw] = pc;
    }
  });

  // ─── 3단계: DB 저장 ───
  console.log('\n💾 3단계: DB 저장...');
  const today = new Date().toISOString().slice(0, 10);
  let updated = 0;
  let totalExposure = 0;

  for (const h of hashtags) {
    const posts = byHashtag[h.keyword] || [];
    const totalPosts = hashtagPostCounts[h.keyword];

    if (posts.length === 0 && totalPosts == null) {
      console.log(`  ⚠️ #${h.keyword}: 데이터 없음`);
      continue;
    }

    const breakdown = {
      total_posts: posts.length,
      hashtag_total_posts: totalPosts || null,
      exposure_count: 0,
      top9_count: 0,
      by_account: 0,
      by_caption: 0,
      by_hashtag: 0,
      by_mention: 0,
      ranks: []
    };

    posts.slice(0, 30).forEach((post, idx) => {
      const m = checkOzkizMatch(post);
      if (m.any) {
        breakdown.exposure_count++;
        if (m.byAccount) breakdown.by_account++;
        if (m.byCaption) breakdown.by_caption++;
        if (m.byHashtag) breakdown.by_hashtag++;
        if (m.byMention) breakdown.by_mention++;
        breakdown.ranks.push(idx + 1);
        if (idx < 9) breakdown.top9_count++;
      }
    });

    const { data: existing } = await sb
      .from('insta_hashtag_history')
      .select('id, search_count')
      .eq('hashtag_id', h.id)
      .eq('date', today)
      .maybeSingle();

    const update = {
      exposure_count: breakdown.exposure_count,
      top9_count: breakdown.top9_count,
      exposure_breakdown: breakdown
    };
    // 게시물 수 있으면 자동 갱신 (search_count)
    if (totalPosts != null && totalPosts > 0) {
      update.search_count = totalPosts;
    }

    let upsertError;
    if (existing) {
      const { error } = await sb.from('insta_hashtag_history').update(update).eq('id', existing.id);
      upsertError = error;
    } else {
      const { error } = await sb.from('insta_hashtag_history').insert({
        hashtag_id: h.id, date: today, ...update
      });
      upsertError = error;
    }

    if (upsertError) {
      console.error(`  ✗ #${h.keyword}:`, upsertError.message);
      continue;
    }

    updated++;
    totalExposure += breakdown.exposure_count;

    const status = breakdown.exposure_count > 0
      ? `✅ ${breakdown.exposure_count} (top9: ${breakdown.top9_count})`
      : `❌ 노출 없음`;
    const postsInfo = totalPosts ? ` [게시물 ${totalPosts.toLocaleString()}]` : '';
    const details = breakdown.exposure_count > 0
      ? ` @${breakdown.by_account} #${breakdown.by_hashtag} 캡${breakdown.by_caption} 멘${breakdown.by_mention}`
      : '';
    console.log(`  ${status}${postsInfo}${details} - #${h.keyword}`);
  }

  console.log('\n══════════════════════════════════');
  console.log(`✅ 완료`);
  console.log(`  · 측정: ${updated}/${hashtags.length}개 해시태그`);
  console.log(`  · 게시물 수 수집: ${Object.keys(hashtagPostCounts).length}개`);
  console.log(`  · 총 노출: ${totalExposure}개`);
  console.log(`  · 날짜: ${today}`);
  console.log('══════════════════════════════════');
}

main().catch(e => {
  console.error('\n💥 오류:', e.message);
  if (e.response?.data) console.error('  ', JSON.stringify(e.response.data).substring(0, 500));
  process.exit(1);
});
