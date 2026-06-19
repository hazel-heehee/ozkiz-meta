// ════════════════════════════════════════════════════════════
// 🔄 경쟁사 추적 자동 동기화 스크립트
// 매일 새벽 1시(KST)에 GitHub Actions가 자동 실행
// ════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!APIFY_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ 환경변수 누락: APIFY_TOKEN, SUPABASE_URL, SUPABASE_KEY 필요');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// 어제 기준 날짜 (한국 시간)
function getKstDate(offsetDays = 0) {
  const now = new Date();
  // UTC + 9시간 = KST
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  kstNow.setUTCDate(kstNow.getUTCDate() + offsetDays);
  return kstNow.toISOString().slice(0, 10);
}

async function fetchProfilesFromApify(usernames) {
  console.log(`📡 Apify에서 ${usernames.length}개 경쟁사 프로필 가져오는 중...`);

  const directUrls = usernames.map(u => `https://www.instagram.com/${u}/`);

  const startTime = Date.now();
  try {
    const resp = await axios.post(
      `https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
      {
        directUrls,
        resultsType: 'details',
        resultsLimit: 1,
        addParentData: false
      },
      {
        timeout: 5 * 60 * 1000,  // 5분
        headers: { 'Content-Type': 'application/json' }
      }
    );

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`✓ Apify 응답 받음 (${elapsed}초, ${resp.data.length}개)`);
    return resp.data || [];
  } catch (e) {
    console.error('Apify 오류:', e.message);
    if (e.response) console.error('응답:', e.response.status, e.response.data);
    throw e;
  }
}

async function main() {
  const today = getKstDate(0);
  const yesterday = getKstDate(-1);
  console.log(`\n🚀 경쟁사 동기화 시작: ${today} (KST 기준)\n`);

  // 1. 경쟁사 목록 가져오기
  const { data: competitors, error: ce } = await sb
    .from('insta_competitors')
    .select('*')
    .order('sort_order', { ascending: true });

  if (ce) {
    console.error('경쟁사 목록 로드 실패:', ce.message);
    process.exit(1);
  }

  if (!competitors || !competitors.length) {
    console.error('등록된 경쟁사가 없어요');
    process.exit(1);
  }

  console.log(`📋 ${competitors.length}개 경쟁사:`, competitors.map(c => c.username).join(', '));

  // 2. Apify로 프로필 데이터 가져오기
  const usernames = competitors.map(c => c.username);
  const profiles = await fetchProfilesFromApify(usernames);

  // 3. 어제 데이터 가져오기 (증감 계산용)
  const { data: prevHistory } = await sb
    .from('insta_competitor_history')
    .select('*')
    .eq('date', yesterday);

  const prevMap = {};
  (prevHistory || []).forEach(h => { prevMap[h.username] = h; });

  // 4. 각 경쟁사 데이터 처리 + 저장
  let successCount = 0;
  let failCount = 0;

  for (const competitor of competitors) {
    const username = competitor.username;

    // Apify 응답에서 해당 username 매칭
    // (instagram-scraper는 ownerUsername 또는 username 필드 사용)
    const profile = profiles.find(p =>
      (p.username && p.username.toLowerCase() === username.toLowerCase()) ||
      (p.ownerUsername && p.ownerUsername.toLowerCase() === username.toLowerCase())
    );

    if (!profile) {
      console.warn(`⚠️  ${username}: Apify 데이터 없음`);
      failCount++;
      continue;
    }

    // 필드 추출 (액터마다 필드명이 다를 수 있어서 여러 후보 시도)
    const followers = profile.followersCount ?? profile.ownerFollowersCount ?? profile.followers ?? 0;
    const postsCount = profile.postsCount ?? profile.ownerPostsCount ?? profile.posts ?? 0;

    if (followers === 0) {
      console.warn(`⚠️  ${username}: 팔로워 수 0 (데이터 오류 가능성)`);
    }

    // 어제 데이터와 비교
    const prev = prevMap[username];
    const followerChange = prev && prev.followers ? followers - prev.followers : 0;
    const postsChange = prev && prev.posts_count ? postsCount - prev.posts_count : 0;

    // upsert
    const { error: ue } = await sb
      .from('insta_competitor_history')
      .upsert({
        username,
        date: today,
        followers,
        followers_change: followerChange,
        posts_count: postsCount,
        posts_change: postsChange,
        engagement: prev?.engagement || 0  // 참여율은 수동 입력 유지
      }, { onConflict: 'username,date' });

    if (ue) {
      console.error(`✗ ${username}: 저장 실패 - ${ue.message}`);
      failCount++;
    } else {
      const sign = followerChange >= 0 ? '+' : '';
      console.log(`✓ ${username}: ${followers.toLocaleString()}명 (${sign}${followerChange.toLocaleString()})`);
      successCount++;
    }
  }

  console.log(`\n🎯 완료: ${successCount}개 성공 / ${failCount}개 실패`);

  if (failCount > 0 && successCount === 0) {
    process.exit(1);
  }
}

main().catch(e => {
  console.error('\n❌ 치명적 오류:', e.message);
  process.exit(1);
});
