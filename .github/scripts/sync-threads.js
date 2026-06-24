// .github/scripts/sync-threads.js
// 스레드 ozkiz_official 자동 동기화 (이미지 URL 포함)
// 매일 KST 23:45 실행

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const APIFY_TOKEN  = process.env.APIFY_TOKEN;
const TARGET_USERNAME = 'ozkiz_official';
const MAX_POSTS = 10;

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

function normalizeLink(url) {
  if (!url) return null;
  let link = String(url).split('?')[0];
  // threads.net → threads.com
  link = link.replace('threads.net', 'threads.com');
  if (!link.endsWith('/')) link += '/';
  return link;
}

// 이미지 URL 추출 (다양한 필드 시도)
function extractImageUrl(post) {
  // Apify automation-lab/threads-scraper 응답 패턴
  if (post.images && post.images.length > 0) {
    return typeof post.images[0] === 'string' ? post.images[0] : (post.images[0].url || post.images[0].src || '');
  }
  if (post.mediaUrls && post.mediaUrls.length > 0) return post.mediaUrls[0];
  if (post.media && Array.isArray(post.media) && post.media.length > 0) {
    return post.media[0].url || post.media[0].src || post.media[0].image_url || '';
  }
  if (post.attachments && Array.isArray(post.attachments) && post.attachments.length > 0) {
    return post.attachments[0].url || post.attachments[0].image_url || '';
  }
  return post.imageUrl || post.image_url || post.mediaUrl || post.displayUrl || post.thumbnail || '';
}

async function main() {
  console.log(`🧵 스레드 자동 동기화 시작 (@${TARGET_USERNAME})\n`);

  // Apify 실행
  console.log('🚀 Apify Threads Scraper 시작...');
  const startRes = await axios.post(
    `https://api.apify.com/v2/acts/automation-lab~threads-scraper/runs?token=${APIFY_TOKEN}`,
    {
      mode: 'posts',
      usernames: [TARGET_USERNAME],
      maxPosts: MAX_POSTS
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  const runId = startRes.data.data.id;
  const datasetId = startRes.data.data.defaultDatasetId;
  console.log(`✓ Run 시작: ${runId}`);

  const status = await waitForApifyRun(runId, 'Threads');
  if (status !== 'SUCCEEDED') {
    console.error(`❌ 실패: ${status}`);
    process.exit(1);
  }

  console.log('\n📦 결과 수신 중...');
  const dsRes = await axios.get(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&clean=true`);
  const items = dsRes.data;
  console.log(`✓ ${items.length}개 항목 수신\n`);

  // 디버그: 첫 게시물 키 출력 (image_url 필드 찾기 위해)
  if (items.length > 0) {
    console.log('🔍 첫 항목 키들:', Object.keys(items[0]).join(', '));
  }

  // 프로필 (팔로워)
  const today = new Date().toISOString().slice(0, 10);
  let profileSaved = false;
  const profileItem = items.find(i =>
    i.type === 'profile' || i._type === 'PROFILE' ||
    i.itemType === 'profile' || i.username === TARGET_USERNAME
  );

  if (profileItem) {
    const followers = profileItem.followers || profileItem.followerCount ||
                      profileItem.followers_count || profileItem.followerCounts;
    if (typeof followers === 'number' && followers > 0) {
      console.log(`👥 프로필: 팔로워 ${followers.toLocaleString()}명`);
      try {
        const { error } = await sb.from('followers').upsert({ date: today, count: followers }, { onConflict: 'date' });
        if (error) console.warn(`  ⚠️ followers 저장 실패: ${error.message}`);
        else { profileSaved = true; console.log(`  ✓ 팔로워 수 저장됨`); }
      } catch (e) { console.warn(`  ⚠️ followers 저장 오류: ${e.message}`); }
    }
  }

  // 게시물
  const postItems = items.filter(i =>
    (i.type === 'post' || i._type === 'POST' || i.itemType === 'post' || i.text || i.caption) &&
    (i.url || i.postUrl || i.link)
  );

  console.log(`\n📝 게시물 처리: ${postItems.length}개\n`);

  let updated = 0, inserted = 0;

  for (const post of postItems) {
    const link = normalizeLink(post.url || post.postUrl || post.link);
    if (!link) continue;

    const text = post.text || post.caption || '';
    const likes = post.likes || post.likeCount || post.like_count || 0;
    const replies = post.replies?.length || post.replyCount || post.reply_count ||
                    post.comments || post.commentCount || 0;
    const reposts = post.reposts || post.repostCount || post.repost_count || 0;
    const quotes = post.quotes || post.quoteCount || post.quote_count || 0;
    const shares = post.shares || post.shareCount || post.share_count || 0;
    const views = post.views || post.viewCount || post.view_count || 0;
    const image_url = extractImageUrl(post);
    const timestamp = post.timestamp || post.publishedAt || post.published_at ||
                       post.takenAt || post.createdAt;
    const date = timestamp ? new Date(timestamp).toISOString().slice(0, 10) : today;

    const { data: existing } = await sb
      .from('posts')
      .select('id, text, category, type, image_url')
      .eq('link', link)
      .maybeSingle();

    if (existing) {
      // 인사이트 + image_url 갱신 (이미지 없으면 기존 유지)
      const update = { likes, reposts, quotes, views, last_synced: today };
      if (shares > 0) update.shares = shares;
      if (replies !== undefined) { update.replies = replies; update.comments = replies; }
      if (!existing.text && text) update.text = text;
      // 이미지 URL이 새로 있고 기존엔 없으면 추가
      if (image_url && !existing.image_url) update.image_url = image_url;

      const { error } = await sb.from('posts').update(update).eq('id', existing.id);
      if (error) console.warn(`  ✗ ${link.substring(0, 50)}: ${error.message}`);
      else {
        updated++;
        console.log(`  ↻ ${(text || link).substring(0, 40)}... 💛${likes} 💬${replies} 🔁${reposts}${image_url?' 🖼️':''}`);
      }
    } else {
      // 신규
      const insertData = {
        link, text, date,
        likes, reposts, quotes, views,
        last_synced: today,
        ...(shares > 0 ? { shares } : {}),
        ...(replies !== undefined ? { replies, comments: replies } : {}),
        ...(image_url ? { image_url } : {})
      };
      const { error } = await sb.from('posts').insert(insertData);
      if (error) console.warn(`  ✗ ${link.substring(0, 50)}: ${error.message}`);
      else {
        inserted++;
        console.log(`  + ${(text || link).substring(0, 40)}... 💛${likes}${image_url?' 🖼️':''}`);
      }
    }
  }

  console.log('\n══════════════════════════════════');
  console.log(`✅ 완료`);
  console.log(`  · 프로필: ${profileSaved ? '✓' : '⚠️'}`);
  console.log(`  · 게시물: 신규 ${inserted}개 / 업데이트 ${updated}개`);
  console.log('══════════════════════════════════');
}

main().catch(e => {
  console.error('\n💥 오류:', e.message);
  if (e.response?.data) console.error('  ', JSON.stringify(e.response.data).substring(0, 500));
  process.exit(1);
});
