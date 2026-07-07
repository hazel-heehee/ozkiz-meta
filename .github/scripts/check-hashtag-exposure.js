// .github/scripts/check-hashtag-exposure.js
// 인스타 해시태그 자동 측정:
// 1. 각 해시태그의 총 게시물 수 (search_count) — NEW!
// 2. top 30에서 ozkiz 게시물 노출 분석 (exposure_count, top9_count)

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const APIFY_TOKEN  = process.env.APIFY_TOKEN;
const GEMINI_KEY   = process.env.GEMINI_API_KEY; // 없으면 감성 분석만 건너뜀

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

// ─── Gemini 감성 분석 (분석 대상 해시태그만, 이미 받은 게시물 재활용 = Apify 추가비용 0) ───
async function analyzeInstaHashtag(keyword, posts) {
  if (!GEMINI_KEY) return null;
  const texts = [];
  posts.slice(0, 10).forEach((p, idx) => {
    texts.push(`[게시물 ${idx + 1}] @${p.ownerUsername || '?'}: ${(p.caption || '').substring(0, 600)}`);
    const comments = Array.isArray(p.latestComments) ? p.latestComments : [];
    comments.slice(0, 8).forEach((c, ci) => {
      const t = c.text || '';
      if (t) texts.push(`  댓글 ${ci + 1}: ${t.substring(0, 200)}`);
    });
  });
  const combined = texts.join('\n').substring(0, 8000);
  const prompt = `다음은 인스타그램에서 "#${keyword}" 해시태그의 상위 게시물과 댓글이야.
한국 아동복 브랜드 "오즈키즈" 관점에서 분석해줘.

분석 게시물:
${combined}

다음 JSON 형식으로만 답변해 (다른 텍스트 X, 코드 블록 X):
{
  "overall_sentiment": "긍정/부정/중립 중 하나",
  "sentiment_breakdown": { "positive": 숫자, "negative": 숫자, "neutral": 숫자 },
  "key_topics": ["주제1", "주제2", "주제3"],
  "key_insights": "오즈키즈에 도움될 핵심 인사이트 (2-3문장)",
  "pain_points": ["고민1", "고민2"],
  "trends": ["트렌드1", "트렌드2"],
  "recommendation": "콘텐츠 전략 제안 (1-2문장)"
}`;
  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 4000, temperature: 0.3 } }
    );
    const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const m = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { raw_response: text };
  } catch (err) {
    console.warn(`  ⚠️ Gemini 분석 실패(#${keyword}): ${err.message}`);
    return { error: err.message };
  }
}

async function main() {
  console.log('🔍 해시태그 자동 측정 시작\n');

  const { data: hashtags, error } = await sb
    .from('insta_hashtags')
    .select('id, keyword, analyze_sentiment')
    .order('sort_order');

  if (error) throw new Error('DB 조회 실패: ' + error.message);
  console.log(`📊 측정할 해시태그: ${hashtags.length}개\n`);

  const urls = hashtags.map(h =>
    `https://www.instagram.com/explore/tags/${encodeURIComponent(h.keyword)}/`
  );

  // ─── 1단계: 해시태그 게시물 수 ───
  console.log('🏷️ 1단계: 해시태그 게시물 수 수집...');
  const hashtagPostCounts = {};

  // "588.49 K" / "4.05 M" / "60.1만" 같은 축약 표기를 실제 숫자로 변환
  const parsePostsCount = (raw) => {
    if (raw == null) return null;
    if (typeof raw === 'number') return raw;
    let s = String(raw).trim().toLowerCase().replace(/,/g, '');
    let mult = 1;
    if (s.includes('k')) mult = 1e3;
    else if (s.includes('m')) mult = 1e6;
    else if (s.includes('b')) mult = 1e9;
    else if (s.includes('만')) mult = 1e4;
    else if (s.includes('억')) mult = 1e8;
    const num = parseFloat(s.replace(/[^0-9.]/g, ''));
    if (isNaN(num)) return null;
    return Math.round(num * mult);
  };

  try {
    // instagram-hashtag-stats: 해시태그별 총 게시물 수(posts) 제공
    const tagRes = await axios.post(
      `https://api.apify.com/v2/acts/apify~instagram-hashtag-stats/runs?token=${APIFY_TOKEN}`,
      { hashtags: hashtags.map(h => h.keyword) },
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
        // name은 URL 인코딩될 수 있어 디코드
        let name = item.name || item.hashtag || item.tag || '';
        try { name = decodeURIComponent(name); } catch(_) {}
        // posts("588.49 K")가 정확. postsCount는 부풀려진 값이라 사용 안 함.
        const count = parsePostsCount(item.posts);
        if (name && count != null && count > 0) {
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
      ranks: [],
      posts: []
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
        // 순위에 오른 게시물 정보 저장 (화면에서 순위 클릭 → 게시물 열기 + 툴팁)
        const shortCode = post.shortCode || post.shortcode || post.code || '';
        const url = post.url || (shortCode ? `https://www.instagram.com/p/${shortCode}/` : '');
        const matchType = m.byAccount ? '계정' : m.byCaption ? '캡션' : m.byHashtag ? '해시태그' : m.byMention ? '멘션' : '';
        const cap = (post.caption || '').replace(/\s+/g, ' ').slice(0, 40);
        breakdown.posts.push({
          rank: idx + 1,
          url,
          owner: post.ownerUsername || post.ownerFullName || '',
          match_type: matchType,
          caption_preview: cap,
          likes: post.likesCount || 0,
          comments: post.commentsCount || 0
        });
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

    // ─── 감성 분석 (analyze_sentiment 체크된 해시태그만, 이미 받은 posts 재활용) ───
    if (h.analyze_sentiment && posts.length > 0) {
      console.log(`  🤖 #${h.keyword} 감성 분석 중...`);
      const sentiment = await analyzeInstaHashtag(h.keyword, posts);
      if (sentiment) {
        let totalComments = 0;
        posts.slice(0, 10).forEach(p => {
          if (Array.isArray(p.latestComments)) totalComments += p.latestComments.length;
          else if (typeof p.commentsCount === 'number') totalComments += p.commentsCount;
        });
        const postsData = posts.slice(0, 10).map((p, idx) => ({
          rank: idx + 1,
          url: p.url || (p.shortCode ? `https://www.instagram.com/p/${p.shortCode}/` : ''),
          author: p.ownerUsername || '',
          text: (p.caption || '').substring(0, 500),
          likes: p.likesCount || 0,
          replies: p.commentsCount || 0,
          image_url: p.displayUrl || '',
          timestamp: p.timestamp || null,
          top_comments: (Array.isArray(p.latestComments) ? p.latestComments.slice(0, 5) : []).map(c => ({
            text: (c.text || '').substring(0, 200),
            author: c.ownerUsername || '',
            likes: c.likesCount || 0
          }))
        }));
        const analysisRow = {
          hashtag_id: h.id,
          hashtag_keyword: h.keyword,
          date: today,
          total_posts: Math.min(posts.length, 10),
          total_comments: totalComments,
          posts_data: postsData,
          sentiment_summary: sentiment
        };
        const { data: exAnal } = await sb.from('insta_hashtag_analysis')
          .select('id').eq('hashtag_id', h.id).eq('date', today).maybeSingle();
        let aErr;
        if (exAnal) { const { error: e } = await sb.from('insta_hashtag_analysis').update(analysisRow).eq('id', exAnal.id); aErr = e; }
        else { const { error: e } = await sb.from('insta_hashtag_analysis').insert(analysisRow); aErr = e; }
        if (aErr) console.warn(`  ⚠️ 분석 저장 실패: ${aErr.message}`);
        else console.log(`  ✓ 감성 분석 저장 (${sentiment.overall_sentiment || '?'})`);
      }
    }

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
