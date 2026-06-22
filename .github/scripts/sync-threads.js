// .github/scripts/sync-threads.js
// 스레드 ozkiz_official 자동 동기화
// 매일 KST 23:45 실행
// - 게시물 인사이트 자동 갱신 (likes, replies, reposts, views, quotes)
// - 팔로워 수 자동 기록

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

// 스레드 link 정규화
function normalizeLink(url) {
  if (!url) return null;
  let link = String(url).split('?')[0];
  if (!link.endsWith('/')) link += '/';
  return link;
}

async function main() {
  console.log(`🧵 스레드 자동 동기화 시작 (@${TARGET_USERNAME})\n`);

  // ────────────────────────────────────────
  // Apify로 스레드 크롤링
  // ────────────────────────────────────────
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

  // ────────────────────────────────────────
  // 1. 프로필 정보 (팔로워 수)
  // ────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  let profileSaved = false;

  // 프로필 정보 추출 (여러 필드명 시도)
  const profileItem = items.find(i =>
    i.type === 'profile' || i._type === 'PROFILE' ||
    i.itemType === 'profile' || i.username === TARGET_USERNAME
  );

  if (profileItem) {
    const followers = profileItem.followers || profileItem.followerCount ||
                      profileItem.followers_count || profileItem.followerCounts;
    if (typeof followers === 'number' && followers > 0) {
      console.log(`👥 프로필: 팔로워 ${followers.toLocaleString()}명`);

      // followers 테이블에 저장 (스레드 팔로워 추적)
      try {
        const { error } = await sb.from('followers').upsert({
          date: today,
          count: followers
        }, { onConflict: 'date' });

        if (error) {
          console.warn(`  ⚠️ followers 저장 실패: ${error.message}`);
        } else {
          profileSaved = true;
          console.log(`  ✓ 팔로워 수 저장됨`);
        }
      } catch (e) {
        console.warn(`  ⚠️ followers 저장 오류: ${e.message}`);
      }
    }
  } else {
    console.log('⚠️ 프로필 정보 없음 (게시물만 처리)');
  }

  // ────────────────────────────────────────
  // 2. 게시물 인사이트 자동 갱신
  // ────────────────────────────────────────
  const postItems = items.filter(i =>
    (i.type === 'post' || i._type === 'POST' || i.itemType === 'post' || i.text || i.caption) &&
    (i.url || i.postUrl || i.link)
  );

  console.log(`\n📝 게시물 처리: ${postItems.length}개\n`);

  let updated = 0;
  let inserted = 0;

  for (const post of postItems) {
    const link = normalizeLink(post.url || post.postUrl || post.link);
    if (!link) continue;

    const text = post.text || post.caption || '';
    const likes = post.likes || post.likeCount || post.like_count || 0;
    const replies = post.replies || post.replyCount || post.reply_count ||
                    post.comments || post.commentCount || 0;
    const reposts = post.reposts || post.repostCount || post.repost_count || 0;
    const quotes = post.quotes || post.quoteCount || post.quote_count || 0;
    const shares = post.shares || post.shareCount || post.share_count || 0;
    const views = post.views || post.viewCount || post.view_count || 0;
    const timestamp = post.timestamp || post.publishedAt || post.published_at ||
                       post.takenAt || post.createdAt;
    const date = timestamp ? new Date(timestamp).toISOString().slice(0, 10) : today;

    // 기존 게시물 확인 (link 기준)
    const { data: existing } = await sb
      .from('posts')
      .select('id, text, category, type')
      .eq('link', link)
      .maybeSingle();

    if (existing) {
      // UPDATE: 인사이트만 갱신 (분류는 보호)
      const update = {
        likes, replies, reposts, quotes, views,
        last_synced: today
      };
      // shares가 있으면 추가
      if (shares > 0) update.shares = shares;
      // text가 비어 있으면 채워주기 (사용자가 입력 안 한 경우)
      if (!existing.text && text) update.text = text;

      const { error } = await sb.from('posts').update(update).eq('id', existing.id);
      if (error) {
        console.warn(`  ✗ 업데이트 실패: ${link.substring(0, 50)} - ${error.message}`);
      } else {
        updated++;
        console.log(`  ↻ 업데이트: ${(text || '(빈 캡션)').substring(0, 30)}... 💛${likes} 💬${replies} 🔁${reposts}`);
      }
    } else {
      // INSERT: 신규 게시물
      const { error } = await sb.from('posts').insert({
        link, text, date,
        likes, replies, reposts, quotes, views,
        ...(shares > 0 ? { shares } : {}),
        last_synced: today
      });

      if (error) {
        console.warn(`  ✗ 추가 실패: ${link.substring(0, 50)} - ${error.message}`);
      } else {
        inserted++;
        console.log(`  + 신규: ${(text || '(빈 캡션)').substring(0, 30)}... 💛${likes} 💬${replies} 🔁${reposts}`);
      }
    }
  }

  console.log('\n══════════════════════════════════');
  console.log(`✅ 완료`);
  console.log(`  · 프로필: ${profileSaved ? '✓ 팔로워 저장' : '⚠️ 없음'}`);
  console.log(`  · 게시물: 신규 ${inserted}개 / 업데이트 ${updated}개`);
  console.log(`  · 날짜: ${today}`);
  console.log('══════════════════════════════════');
}

main().catch(e => {
  console.error('\n💥 오류:', e.message);
  if (e.response?.data) console.error('  ', JSON.stringify(e.response.data).substring(0, 500));
  process.exit(1);
});
