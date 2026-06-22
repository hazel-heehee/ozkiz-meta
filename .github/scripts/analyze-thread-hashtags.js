// .github/scripts/analyze-thread-hashtags.js
// 스레드 해시태그 검색 + 댓글 감성 분석
//
// 1. DB에서 활성 키워드 가져오기 (육아, 아동복 등)
// 2. 각 키워드를 Apify로 스레드 검색
// 3. 상위 10개 게시물 + 댓글 가져오기
// 4. Gemini로 감성 분석 (긍정/부정/중립)
// 5. DB에 저장

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const APIFY_TOKEN  = process.env.APIFY_TOKEN;
const GEMINI_KEY   = process.env.GEMINI_API_KEY;

const POSTS_PER_KEYWORD = 10;

if (!SUPABASE_URL || !SUPABASE_KEY || !APIFY_TOKEN) {
  console.error('❌ 환경 변수 누락 (SUPABASE_URL, SUPABASE_KEY, APIFY_TOKEN)');
  process.exit(1);
}
if (!GEMINI_KEY) {
  console.warn('⚠️ GEMINI_API_KEY 없음 - 감성 분석 건너뜀');
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
    if (waitSec > 2700) { console.error(`⏱️ Timeout (${label})`); break; }
  }
  return status;
}

// ────────────────────────────────────────
// Gemini 감성 분석
// ────────────────────────────────────────
async function analyzeWithGemini(keyword, posts) {
  if (!GEMINI_KEY) return null;

  // 게시물 + 댓글 텍스트 모으기
  const texts = [];
  posts.forEach((p, idx) => {
    texts.push(`[게시물 ${idx + 1}] ${p.text || ''}`);
    if (p.replies && Array.isArray(p.replies)) {
      p.replies.slice(0, 10).forEach((r, ri) => {
        const replyText = r.text || r.caption || '';
        if (replyText) texts.push(`  댓글 ${ri + 1}: ${replyText}`);
      });
    }
  });

  const combinedText = texts.join('\n').substring(0, 8000);  // 최대 8000자

  const prompt = `다음은 스레드(Threads)에서 "#${keyword}" 키워드로 검색한 상위 게시물과 댓글이야.
한국 아동복 브랜드 "오즈키즈" 관점에서 분석해줘.

분석 게시물:
${combinedText}

다음 JSON 형식으로만 답변해 (다른 텍스트 X, 코드 블록 X):
{
  "overall_sentiment": "긍정/부정/중립 중 하나",
  "sentiment_breakdown": {
    "positive": 게시물+댓글 중 긍정 개수,
    "negative": 부정 개수,
    "neutral": 중립 개수
  },
  "key_topics": ["주요 주제 1", "주요 주제 2", "주요 주제 3"],
  "key_insights": "오즈키즈에 도움될 핵심 인사이트 (2-3문장)",
  "pain_points": ["언급된 고민/문제 1", "고민 2"],
  "trends": ["발견된 트렌드 1", "트렌드 2"],
  "recommendation": "콘텐츠 전략 제안 (1-2문장)"
}`;

  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 4000, temperature: 0.3 }
      }
    );

    const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    // JSON 파싱
    const cleanedText = text.replace(/```json|```/g, '').trim();
    const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { raw_response: text };
  } catch (err) {
    console.warn(`  ⚠️ Gemini 분석 실패: ${err.message}`);
    return { error: err.message };
  }
}

async function main() {
  console.log('🔍 스레드 해시태그 검색 + 감성 분석 시작\n');

  // 1. DB에서 해시태그 가져오기
  const { data: hashtags, error } = await sb
    .from('thread_hashtags')
    .select('id, keyword')
    .order('sort_order');

  if (error) throw new Error('DB 조회 실패: ' + error.message);
  console.log(`📊 분석할 키워드: ${hashtags.length}개`);
  hashtags.forEach(h => console.log(`  · #${h.keyword}`));
  console.log('');

  // 2. Apify로 스레드 검색
  // automation-lab/threads-scraper 사용 (search 모드)
  const today = new Date().toISOString().slice(0, 10);
  let totalUpdated = 0;

  for (const h of hashtags) {
    console.log(`\n══════════════════════════════════`);
    console.log(`🔍 #${h.keyword} 분석 시작`);
    console.log(`══════════════════════════════════`);

    // 검색 실행
    let posts = [];
    try {
      const startRes = await axios.post(
        `https://api.apify.com/v2/acts/automation-lab~threads-scraper/runs?token=${APIFY_TOKEN}`,
        {
          mode: 'search',
          searchQueries: [h.keyword],
          search_filter: 'top',
          maxPosts: POSTS_PER_KEYWORD,
          includeReplies: true
        },
        { headers: { 'Content-Type': 'application/json' } }
      );

      const runId = startRes.data.data.id;
      const datasetId = startRes.data.data.defaultDatasetId;
      console.log(`✓ Apify Run 시작: ${runId}`);

      const status = await waitForApifyRun(runId, h.keyword);
      if (status !== 'SUCCEEDED') {
        console.warn(`  ⚠️ 검색 실패: ${status}`);
        continue;
      }

      const dsRes = await axios.get(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&clean=true`);
      const items = dsRes.data;

      // 게시물만 필터 (프로필 제외)
      posts = items.filter(i =>
        (i.type === 'post' || i._type === 'POST' || i.itemType === 'post' || i.text || i.caption)
      ).slice(0, POSTS_PER_KEYWORD);

      console.log(`  ✓ ${posts.length}개 게시물 수신`);
    } catch (apifyErr) {
      console.warn(`  ⚠️ Apify 오류: ${apifyErr.message}`);
      continue;
    }

    if (posts.length === 0) {
      console.log(`  ⚠️ 게시물 없음`);
      continue;
    }

    // 댓글 카운트
    let totalComments = 0;
    posts.forEach(p => {
      if (Array.isArray(p.replies)) totalComments += p.replies.length;
      else if (typeof p.replyCount === 'number') totalComments += p.replyCount;
    });

    // 3. Gemini 감성 분석
    console.log(`\n🤖 Gemini 감성 분석 중...`);
    const sentimentResult = await analyzeWithGemini(h.keyword, posts);

    if (sentimentResult && !sentimentResult.error) {
      console.log(`  ✓ 전체 톤: ${sentimentResult.overall_sentiment || '?'}`);
      if (sentimentResult.sentiment_breakdown) {
        const b = sentimentResult.sentiment_breakdown;
        console.log(`    긍정 ${b.positive || 0} / 부정 ${b.negative || 0} / 중립 ${b.neutral || 0}`);
      }
      if (sentimentResult.key_topics) {
        console.log(`  ✓ 주요 주제: ${sentimentResult.key_topics.join(', ')}`);
      }
    }

    // 4. 게시물 데이터 간소화 (DB 저장용)
    const postsData = posts.map((p, idx) => ({
      rank: idx + 1,
      url: p.url || p.postUrl || '',
      author: p.author || p.username || p.ownerUsername || '',
      text: (p.text || p.caption || '').substring(0, 500),
      likes: p.likes || p.likeCount || 0,
      replies: p.replies?.length || p.replyCount || 0,
      reposts: p.reposts || p.repostCount || 0,
      timestamp: p.timestamp || p.publishedAt || null,
      top_comments: (Array.isArray(p.replies) ? p.replies.slice(0, 5) : []).map(r => ({
        text: (r.text || '').substring(0, 200),
        author: r.author || r.username || '',
        likes: r.likes || r.likeCount || 0
      }))
    }));

    // 5. DB 저장 (같은 날 같은 키워드면 update)
    const { data: existing } = await sb
      .from('thread_hashtag_analysis')
      .select('id')
      .eq('hashtag_id', h.id)
      .eq('date', today)
      .maybeSingle();

    const dataToSave = {
      hashtag_id: h.id,
      hashtag_keyword: h.keyword,
      date: today,
      total_posts: posts.length,
      total_comments: totalComments,
      posts_data: postsData,
      sentiment_summary: sentimentResult
    };

    let saveError;
    if (existing) {
      const { error: e } = await sb
        .from('thread_hashtag_analysis')
        .update(dataToSave)
        .eq('id', existing.id);
      saveError = e;
    } else {
      const { error: e } = await sb
        .from('thread_hashtag_analysis')
        .insert(dataToSave);
      saveError = e;
    }

    if (saveError) {
      console.error(`  ✗ 저장 실패: ${saveError.message}`);
    } else {
      totalUpdated++;
      console.log(`  ✅ 저장 완료`);
    }
  }

  console.log('\n══════════════════════════════════');
  console.log(`✅ 완료: ${totalUpdated}/${hashtags.length}개 키워드 분석`);
  console.log(`  · 날짜: ${today}`);
  console.log('══════════════════════════════════');
}

main().catch(e => {
  console.error('\n💥 오류:', e.message);
  if (e.response?.data) console.error('  ', JSON.stringify(e.response.data).substring(0, 500));
  process.exit(1);
});
