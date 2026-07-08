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

// ─── 이미지 영구 저장: 스레드 CDN 이미지를 다운로드해 Supabase Storage(insta-media/auto)에 업로드 ───
// 스레드 CDN URL도 만료될 수 있어 영구 URL로 교체해 썸네일이 안 깨지게 함
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
    console.warn(`  ⚠️ 이미지 영구저장 실패(${filename}): ${e.message} — 원본 URL 유지`);
    return '';
  }
}

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

  // KST 기준 오늘 (UTC+9). 자정 근처 실행에도 날짜 안 어긋나게.
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // ─── 스레드 팔로워 자동 수집 (apify/threads-profile-api-scraper는 진짜 스레드 팔로워 제공) ───
  try {
    const profRes = await axios.post(
      `https://api.apify.com/v2/acts/apify~threads-profile-api-scraper/runs?token=${APIFY_TOKEN}`,
      { usernames: ['ozkiz_official'] },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const profRunId = profRes.data.data.id;
    const profDatasetId = profRes.data.data.defaultDatasetId;
    const profStatus = await waitForApifyRun(profRunId, 'Profile');
    if (profStatus === 'SUCCEEDED') {
      const profDs = await axios.get(`https://api.apify.com/v2/datasets/${profDatasetId}/items?token=${APIFY_TOKEN}&clean=true`);
      const prof = profDs.data[0];
      const fc = prof && prof.follower_count;
      if (fc && fc > 0) {
        const { error: fe } = await sb.from('followers').upsert({ date: today, count: fc }, { onConflict: 'date' });
        if (fe) console.warn(`⚠️ 스레드 팔로워 저장 실패: ${fe.message}`);
        else console.log(`✓ 스레드 팔로워 저장: ${fc.toLocaleString()}명 (${today})`);
      } else {
        console.warn('⚠️ 스레드 팔로워 값 없음 — 건너뜀');
      }
    } else {
      console.warn(`⚠️ 프로필 Actor 실패: ${profStatus} — 팔로워 건너뜀`);
    }
  } catch (e) {
    console.warn(`⚠️ 스레드 팔로워 수집 오류: ${e.message} — 건너뜀`);
  }

  // 게시물
  let postItems = items.filter(i =>
    (i.type === 'post' || i._type === 'POST' || i.itemType === 'post' || i.text || i.caption) &&
    (i.url || i.postUrl || i.link)
  );

  // 이어단 글(isReply:true)을 원글 캡션에 합치고 별도 항목 제거
  {
    const merged = [];
    let lastParent = null;
    for (const it of postItems) {
      if (it.isReply === true && lastParent) {
        const addText = (it.text || it.caption || '').trim();
        if (addText) {
          lastParent.text = ((lastParent.text || lastParent.caption || '').trim() + '\n\n' + addText).trim();
          if (lastParent.caption !== undefined) lastParent.caption = lastParent.text;
          lastParent._merged = true;
        }
      } else {
        merged.push(it);
        lastParent = it;
      }
    }
    postItems = merged;
  }

  console.log(`\n📝 게시물 처리: ${postItems.length}개 (이어단 글 합친 후)\n`);

  let updated = 0, inserted = 0;

  for (const post of postItems) {
    const link = normalizeLink(post.url || post.postUrl || post.link);
    if (!link) continue;

    const text = post.text || post.caption || '';
    const likes = post.likeCount ?? post.likes ?? post.like_count ?? 0;
    const replies = (Array.isArray(post.replies) ? post.replies.length : 0) || post.replyCount || post.reply_count ||
                    post.comments || post.commentCount || 0;
    const reposts = post.repostCount ?? post.reposts ?? post.repost_count ?? 0;
    const quotes = post.quoteCount ?? post.quotes ?? post.quote_count ?? 0;
    const shares = post.shareCount ?? post.shares ?? post.share_count ?? 0;
    // ⚠️ 이 Actor는 조회수(views)를 제공하지 않음 → 동기화로 건드리지 않고 기존값(수동 입력) 보존
    const image_url = extractImageUrl(post);
    // 날짜: date 필드(ISO 문자열) 우선. timestamp는 초 단위 유닉스값이라 ×1000 필요. 모두 KST(+9h)로 변환
    let date = today;
    if (post.date) {
      const d = new Date(post.date);
      if (!isNaN(d)) date = new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    } else if (post.timestamp) {
      const tnum = Number(post.timestamp);
      const ms = tnum < 1e12 ? tnum * 1000 : tnum;
      const d = new Date(ms);
      if (!isNaN(d)) date = new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    }

    const { data: existing } = await sb
      .from('posts')
      .select('id, text, category, type, image_url')
      .eq('link', link)
      .maybeSingle();

    // 이미지 영구 저장 (기존이 이미 영구본/사용자 업로드면 스킵)
    const existingImgT = String((existing && existing.image_url) || '').trim();
    const alreadyPermanentT = existingImgT.includes('insta-media') || existingImgT.includes('supabase');
    let finalImg = image_url;
    if (!alreadyPermanentT && image_url) {
      const code = (link.split('/post/')[1] || '').split(/[/?#]/)[0] || `id${Date.now()}`;
      const perm = await persistThumb(image_url, `thread_${code}.jpg`);
      if (perm) finalImg = perm;
    }

    if (existing) {
      // 인사이트 + image_url 갱신 (views는 제외 — 수동 입력값 보존). date는 갱신해서 과거 오류 교정
      const update = { likes, reposts, quotes, date, last_synced: today };
      if (shares > 0) update.shares = shares;
      if (replies !== undefined) { update.replies = replies; update.comments = replies; }
      if (text && (!existing.text || post._merged)) update.text = text;
      // 이미지 URL이 새로 있고 기존엔 없으면 추가
      if (finalImg && !alreadyPermanentT) update.image_url = finalImg;

      const { error } = await sb.from('posts').update(update).eq('id', existing.id);
      if (error) console.warn(`  ✗ ${link.substring(0, 50)}: ${error.message}`);
      else {
        updated++;
        console.log(`  ↻ ${(text || link).substring(0, 40)}... 💛${likes} 💬${replies} 🔁${reposts}${image_url?' 🖼️':''}`);
      }
    } else {
      // 신규 (views 제외 — 나중에 수동 입력)
      const insertData = {
        link, text, date,
        likes, reposts, quotes,
        last_synced: today,
        ...(shares > 0 ? { shares } : {}),
        ...(replies !== undefined ? { replies, comments: replies } : {}),
        ...(finalImg ? { image_url: finalImg } : {})
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
  console.log(`  · 팔로워: 수동 입력 관리 (스크래퍼 미사용)`);
  console.log(`  · 게시물: 신규 ${inserted}개 / 업데이트 ${updated}개`);
  console.log('══════════════════════════════════');
}

main().catch(e => {
  console.error('\n💥 오류:', e.message);
  if (e.response?.data) console.error('  ', JSON.stringify(e.response.data).substring(0, 500));
  process.exit(1);
});
