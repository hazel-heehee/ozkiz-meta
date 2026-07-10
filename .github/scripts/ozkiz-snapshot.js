/* ============================================================================
 * ozkiz-snapshot.js
 * ozkiz-meta(메타 채널 관리) → 마케팅 대시보드 회의록용 스냅샷 생성 모듈
 * ----------------------------------------------------------------------------
 * 용도: 마케팅 대시보드 회의록 툴바에 "유입/GFA"처럼 버튼을 추가할 때 사용.
 *       버튼 클릭 → 아래 함수 호출 → 카드 HTML(문자열)을 받아서
 *       회의록 에디터(contenteditable)의 커서 위치에 삽입하면 됩니다.
 *
 * 특징:
 *  - 외부 의존성: @supabase/supabase-js 뿐 (대시보드에 이미 있을 것)
 *  - 반환 HTML은 전부 인라인 스타일(자체완결) → 회의록 CSS 없이도 그대로 렌더
 *  - ozkiz-meta의 "공개(anon) 읽기 키"만 사용 → 읽기 전용, 안전
 *
 * 제공 함수 (모두 async, HTML 문자열 반환):
 *   ozkizSnapshot.instaWeek(weekOffset = 0)      // 인스타 주간보고
 *   ozkizSnapshot.threadWeek(weekOffset = 0)     // 스레드 주간보고
 *   ozkizSnapshot.hashtagExposure()              // 인스타 해시태그 노출상황
 *
 *   weekOffset: 0 = 이번 주(금~목), 1 = 지난주, 2 = 2주 전 ...
 * ==========================================================================*/

(function (global) {
  // ── ozkiz-meta 공개 읽기 설정 (읽기 전용 anon 키)
  const OZKIZ_SB_URL = 'https://tbltddivmxfuounnzcne.supabase.co';
  const OZKIZ_SB_KEY = 'sb_publishable_UyNSo1sU8K0HwUk2pvlZXA_aVLYS4-p';

  // supabase-js가 전역에 있으면 사용, 없으면 REST로 폴백
  function makeClient() {
    if (global.supabase && global.supabase.createClient) {
      return global.supabase.createClient(OZKIZ_SB_URL, OZKIZ_SB_KEY, {
        auth: { persistSession: false }
      });
    }
    return null;
  }
  const _sb = makeClient();

  // supabase-js가 없을 때 쓰는 REST 헬퍼
  async function rest(path) {
    const res = await fetch(`${OZKIZ_SB_URL}/rest/v1/${path}`, {
      headers: { apikey: OZKIZ_SB_KEY, Authorization: `Bearer ${OZKIZ_SB_KEY}` }
    });
    if (!res.ok) throw new Error(`ozkiz REST ${res.status}`);
    return res.json();
  }
  // 통일된 select
  async function q(table, sel, extra = '') {
    if (_sb) {
      // supabase-js 경로
      return _sb; // 실제 쿼리는 각 함수에서 처리 (아래는 REST 우선 사용)
    }
    return rest(`${table}?select=${encodeURIComponent(sel)}${extra}`);
  }

  // ── 주(週) 범위: 금~목. offset 0 = 이번 주
  function getWeekRange(offset = 0) {
    const today = new Date();
    const dow = today.getDay(); // 일0~토6
    let sub;
    if (dow === 4) sub = 0;
    else if (dow >= 5) sub = dow - 4;
    else sub = dow + 3;
    const end = new Date(today);
    end.setDate(today.getDate() - sub - offset * 7);
    const start = new Date(end);
    start.setDate(end.getDate() - 6);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { start: fmt(start), end: fmt(end) };
  }

  // ── 검색량 → 규모 라벨
  function sizeLabel(n) {
    if (!n || n <= 0) return null;
    if (n >= 10000000) return '천만';
    if (n >= 1000000) return '백만';
    if (n >= 100000) return '십만';
    if (n >= 10000) return '만';
    return '천';
  }

  // ── 공통 헬퍼 (대시보드 회의록 카드와 100% 동일한 div 레이아웃 — 빈 셀 없음)
  const wrap = (title, inner) =>
    `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:8px 0;background:#fff;font-family:'Pretendard','Apple SD Gothic Neo',sans-serif;color:#1a1a1a;max-width:890px">` +
    `<div style="font-size:15px;font-weight:700;color:#111;margin-bottom:12px">${title}</div>${inner}</div>`;
  const box = (inner, flex) => `<div style="flex:${flex || '1'};background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;box-sizing:border-box">${inner}</div>`;
  const lbl = (t) => `<div style="font-size:12px;color:#111;font-weight:700;margin-bottom:4px">${t}</div>`;
  const big = (t, color) => `<div style="font-size:22px;font-weight:800;letter-spacing:-.5px;color:${color || '#111'}">${t}</div>`;
  const esc = (s) => String(s || '').replace(/</g, '&lt;');
  const rangeLabel = (r) => `${r.start.slice(5).replace('-', '/')}~${r.end.slice(5).replace('-', '/')}`;

  // ── 목표 마커 진행률 패널 (진회색 선=목표, 컬러 막대=달성)
  const goalPanel = (titleLabel, goal, actual, unit, plusSign) => {
    const realPct = goal > 0 ? Math.round((actual / goal) * 100) : 0;
    const achieved = actual >= goal;
    const barColor = achieved ? '#10b981' : (realPct >= 60 ? '#f59e0b' : '#ef4444');
    const txtColor = achieved ? '#16a34a' : (realPct >= 60 ? '#d97706' : '#dc2626');
    const maxVal = Math.max(goal, Math.max(actual, 0), 1);
    const fillPct = Math.max(0, Math.round((actual / maxVal) * 100));
    const goalPct = Math.round((goal / maxVal) * 100);
    const diff = actual - goal;
    const noteTxt = achieved ? `목표 초과 +${diff.toLocaleString()}${unit}` : `목표까지 ${diff.toLocaleString()}${unit}`;
    return `<div style="flex:1;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;box-sizing:border-box">` +
      lbl(titleLabel) +
      `<div style="display:flex;justify-content:space-between;align-items:baseline;font-size:13px;margin-bottom:6px"><span>목표 <b style="font-size:15px;color:#475569">${goal.toLocaleString()}</b>${unit} · 달성 <b style="font-size:17px;color:${txtColor}">${plusSign && actual >= 0 ? '+' : ''}${actual.toLocaleString()}</b>${unit}</span><span style="font-size:16px;font-weight:800;color:${txtColor}">${realPct}%</span></div>` +
      `<div style="position:relative;height:14px;background:#eceef1;border-radius:7px;border:1px solid #e5e7eb"><div style="height:100%;width:${Math.min(fillPct, 100)}%;background:${barColor};border-radius:7px"></div><div style="position:absolute;top:-4px;left:calc(${Math.min(goalPct, 100)}% - 1px);width:3px;height:22px;background:#475569;border-radius:2px"></div></div>` +
      `<div style="display:flex;justify-content:space-between;font-size:11px;margin-top:4px"><span style="color:#94a3b8">진회색 선 = 목표</span><span style="color:${txtColor};font-weight:700">${noteTxt}</span></div>` +
      `</div>`;
  };

  // ── 잘된 콘텐츠 TOP3 (게시물 조회수 상위) — insta_posts / posts 에서 계산
  async function topPostsHtml(channel, wr) {
    try {
      let rows = [];
      if (channel === 'instagram') {
        const p = await rest(`insta_posts?select=date,views,likes,comments,text,link,image_url&date=gte.${wr.start}&date=lte.${wr.end}`);
        rows = (p || []).map((r) => ({ views: +r.views||0, likes: +r.likes||0, comments: +r.comments||0, text: r.text||'', link: r.link||'', img: r.image_url||'' }));
      } else {
        const p = await rest(`posts?select=date,views,likes,comments,text,link,image_url&date=gte.${wr.start}&date=lte.${wr.end}`);
        rows = (p || []).map((r) => ({ views: +r.views||0, likes: +r.likes||0, comments: +r.comments||0, text: r.text||'', link: r.link||'', img: r.image_url||'' }));
      }
      rows.sort((a, b) => b.views - a.views);
      const top = rows.filter((r) => r.views > 0).slice(0, 3);
      if (!top.length) return '';
      const cards = top.map((p, i) => {
        let link = String(p.link || '').trim();
        if (link && !link.startsWith('http')) link = 'https://' + link;
        const thumb = p.img ? `<img src="${p.img}" style="width:38px;height:38px;border-radius:6px;object-fit:cover;border:1px solid #e5e7eb;flex-shrink:0"/>` : '';
        const cap = esc(p.text).substring(0, 40);
        return `<div style="flex:1;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:9px 10px;box-sizing:border-box;min-width:0"><div style="display:flex;gap:7px;align-items:flex-start"><span style="font-size:15px;font-weight:800;color:#475569;line-height:1.2">${i + 1}</span>${thumb}<div style="min-width:0;flex:1"><div style="font-size:12px;color:#111;font-weight:600;line-height:1.5;word-break:break-word">${cap || '(내용 없음)'}</div><div style="font-size:11px;color:#334155;margin-top:3px;line-height:1.5">조회 <b style="color:#111">${p.views.toLocaleString()}</b> · ❤ ${p.likes.toLocaleString()} · 💬 ${p.comments.toLocaleString()}</div>${link ? `<a href="${link}" target="_blank" style="font-size:11px;color:#1d4ed8;font-weight:700;text-decoration:underline;display:inline-block;margin-top:2px">게시물 열기 ↗</a>` : ''}</div></div></div>`;
      }).join('');
      return `<div style="font-size:13px;color:#111;font-weight:700;margin:12px 0 6px">잘된 콘텐츠 TOP${top.length} <span style="color:#94a3b8;font-weight:400;font-size:11px">(조회수 기준)</span></div><div style="display:flex;gap:8px;align-items:stretch">${cards}</div>`;
    } catch (e) { return ''; }
  }

  const noteBox = (note) => note ? `<div style="margin-top:10px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px">${lbl('내용')}<div style="font-size:12px;color:#1a1a1a;line-height:1.7;white-space:pre-wrap">${esc(note)}</div></div>` : '';

  // ── 주간 목표 읽기 (app_settings: insta_week_goal / thread_week_goal, 없으면 기본값)
  async function getGoal(key, def) {
    try {
      const rows = await rest(`app_settings?select=key,value&key=eq.${key}`);
      if (rows && rows[0] && parseInt(rows[0].value)) return parseInt(rows[0].value);
    } catch (_) {}
    return def;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1) 인스타 주간보고
  //    - 현재 팔로워: insta_followers 최신(오늘 제외)
  //    - 주간 팔로워 증가: 주 시작~종료 사이 증감
  //    - 주간 조회수: insta_posts 중 해당 주 발행분 views 합
  //    - 메모: weekly_notes (channel='instagram', week_friday=주 시작일)
  // ─────────────────────────────────────────────────────────────────────────
  async function instaWeek(weekOffset = 0) {
    const r = getWeekRange(weekOffset);
    const prev = getWeekRange(weekOffset + 1);
    const today = new Date().toISOString().slice(0, 10);

    const followers = await rest(`insta_followers?select=date,count&order=date.asc`);
    let current = 0;
    for (let i = followers.length - 1; i >= 0; i--) {
      if (followers[i].date !== today && followers[i].count > 0) { current = followers[i].count; break; }
    }
    const before = followers.filter((f) => f.date < r.start && f.count > 0);
    const within = followers.filter((f) => f.date <= r.end && f.count > 0);
    const startVal = before.length ? before[before.length - 1].count : (within.length ? within[0].count : 0);
    const endVal = within.length ? within[within.length - 1].count : 0;
    const gain = endVal && startVal ? endVal - startVal : 0;
    const dailyGain = Math.round(gain / 7);

    const posts = await rest(`insta_posts?select=date,views&date=gte.${r.start}&date=lte.${r.end}`);
    const views = posts.reduce((s2, p) => s2 + (p.views || 0), 0);
    // 지난주 대비
    const prevPosts = await rest(`insta_posts?select=date,views&date=gte.${prev.start}&date=lte.${prev.end}`);
    const prevViews = prevPosts.reduce((s2, p) => s2 + (p.views || 0), 0);
    const viewsDelta = prevViews > 0 ? Math.round(((views - prevViews) / prevViews) * 100) : null;
    const viewsSub = viewsDelta == null ? `일평균 ${Math.round(views / 7).toLocaleString()}` :
      `일평균 ${Math.round(views / 7).toLocaleString()} · 지난주 대비 <b style="color:${viewsDelta >= 0 ? '#16a34a' : '#ef4444'}">${viewsDelta >= 0 ? '+' : ''}${viewsDelta}%</b>`;

    const goal = await getGoal('insta_week_goal', 100); // 팔로워 증가 목표 (명/일)

    let note = '';
    try {
      const notes = await rest(`weekly_notes?select=note&channel=eq.instagram&week_friday=eq.${r.start}`);
      if (notes && notes[0]) note = notes[0].note || '';
    } catch (_) {}

    const top3 = await topPostsHtml('instagram', r);
    const inner =
      `<div style="display:flex;gap:8px;align-items:stretch;margin-bottom:8px">` +
      box(lbl('현재 팔로워') + big(current ? current.toLocaleString() : '—') + `<div style="font-size:11px;color:#64748b;margin-top:2px">주간 증가 ${gain >= 0 ? '+' : ''}${gain.toLocaleString()}명</div>`, '0 0 150px') +
      goalPanel('목표 대비 진행률 (팔로워 증가)', goal, dailyGain, '명/일', true) +
      `</div>` +
      `<div style="display:flex;gap:8px;align-items:stretch">` +
      box(lbl('발행 (주간)') + `<div style="font-size:17px;font-weight:800">${posts.length}건</div>`) +
      box(lbl('조회수 (주간)') + `<div style="font-size:17px;font-weight:800;color:#3b82f6">${views.toLocaleString()}<span style="font-size:12px;color:#64748b;font-weight:400"> · ${viewsSub}</span></div>`) +
      `</div>` +
      top3 + noteBox(note);
    return wrap(`인스타 인사이트 주간보고 <span style="font-weight:400;color:#64748b">(${rangeLabel(r)})</span>`, inner);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2) 스레드 주간보고
  //    - 현재 팔로워: followers 최신(오늘 제외)
  //    - 주간 조회수/발행: posts 중 해당 주 발행분
  //    - 메모: weekly_notes (channel='threads')
  // ─────────────────────────────────────────────────────────────────────────
  async function threadWeek(weekOffset = 0) {
    const r = getWeekRange(weekOffset);
    const today = new Date().toISOString().slice(0, 10);

    const followers = await rest(`followers?select=date,count&order=date.asc`);
    let current = 0;
    for (let i = followers.length - 1; i >= 0; i--) {
      if (followers[i].date !== today && followers[i].count > 0) { current = followers[i].count; break; }
    }

    const posts = await rest(`posts?select=date,views&date=gte.${r.start}&date=lte.${r.end}`);
    const publishCount = posts.length;
    const views = posts.reduce((s2, p) => s2 + (p.views || 0), 0);
    const dailyViews = Math.round(views / 7);

    const goal = await getGoal('thread_week_goal', 3000); // 조회수 목표 (회/일)

    let note = '';
    try {
      const notes = await rest(`weekly_notes?select=note&channel=eq.threads&week_friday=eq.${r.start}`);
      if (notes && notes[0]) note = notes[0].note || '';
    } catch (_) {}

    const top3 = await topPostsHtml('threads', r);
    const inner =
      `<div style="display:flex;gap:8px;align-items:stretch;margin-bottom:8px">` +
      box(lbl('현재 팔로워') + big(current ? current.toLocaleString() : '—'), '0 0 150px') +
      goalPanel('목표 대비 진행률 (조회수)', goal, dailyViews, '회/일', false) +
      `</div>` +
      `<div style="display:flex;gap:8px;align-items:stretch">` +
      box(lbl('발행 (주간)') + `<div style="font-size:17px;font-weight:800">${publishCount}건</div>`) +
      box(lbl('주간 조회수') + `<div style="font-size:17px;font-weight:800;color:#3b82f6">${views.toLocaleString()}</div>`) +
      `</div>` +
      top3 + noteBox(note);
    return wrap(`스레드 인사이트 주간보고 <span style="font-weight:400;color:#64748b">(${rangeLabel(r)})</span>`, inner);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3) 인스타 해시태그 노출상황 (최신 측정일 기준)
  //    - insta_hashtags(마스터) + insta_hashtag_history(측정값·노출 분해)
  //    - TOP5(규모 큰 순, 노출>0) + 노출률 + 노출유형 분포 + 개선기회 + 게시물 링크
  // ─────────────────────────────────────────────────────────────────────────
  async function hashtagExposure() {
    const tags = await rest(`insta_hashtags?select=id,keyword,size_category,ended`);
    const active = tags.filter((t) => !t.ended);
    const hist = await rest(`insta_hashtag_history?select=hashtag_id,date,search_count,exposure_count,exposure_breakdown&order=date.desc`);
    if (!hist.length) return wrap('인스타 해시태그 노출상황', '<div style="font-size:12px;color:#94a3b8">측정 데이터가 없습니다.</div>');

    const latestDate = hist[0].date;
    const byId = {};
    hist.forEach((h) => { if (h.date === latestDate && byId[h.hashtag_id] == null) byId[h.hashtag_id] = h; });

    const sizeOrder = { '천만': 1, '백만': 2, '십만': 3, '5만': 4, '만': 5, '천': 6 };
    const enriched = active.map((t) => {
      const cell = byId[t.id] || {};
      const sc = cell.search_count || 0;
      return {
        keyword: t.keyword,
        searchCount: sc,
        exposureCount: cell.exposure_count || 0,
        breakdown: cell.exposure_breakdown || null,
        sizeCat: sizeLabel(sc) || t.size_category || '-',
        sizeRank: sizeOrder[sizeLabel(sc) || t.size_category] || 99
      };
    });
    const withExp = enriched.filter((h) => h.exposureCount > 0)
      .sort((a, b) => (a.sizeRank !== b.sizeRank ? a.sizeRank - b.sizeRank : b.searchCount - a.searchCount));
    const top5 = withExp.slice(0, 5);
    const exposureRate = active.length ? Math.round((withExp.length / active.length) * 100) : 0;

    // 노출 유형 분포
    const tot = { account: 0, hashtag: 0, caption: 0, mention: 0 };
    withExp.forEach((h) => {
      const b = h.breakdown || {};
      tot.account += b.by_account || 0; tot.hashtag += b.by_hashtag || 0;
      tot.caption += b.by_caption || 0; tot.mention += b.by_mention || 0;
    });
    const typeSum = tot.account + tot.hashtag + tot.caption + tot.mention;
    const labels = { account: '@계정 직접', hashtag: '오즈키즈 태그', caption: '캡션 언급', mention: '@멘션' };
    const methods = {
      account: '게시물 반응(저장·좋아요)을 높여 계정 게시물이 상위에 뜨게',
      hashtag: '게시물 해시태그에 이 키워드를 추가해',
      caption: '캡션에 이 키워드를 자연스럽게 언급해',
      mention: '고객 후기에서 @멘션을 유도해'
    };
    let dom = 'caption', domCnt = -1;
    Object.keys(tot).forEach((k) => { if (tot[k] > domCnt) { domCnt = tot[k]; dom = k; } });
    const typeDist = typeSum
      ? Object.keys(tot).filter((k) => tot[k] > 0).map((k) => `${labels[k]} <b>${tot[k]}</b> (${Math.round((tot[k] / typeSum) * 100)}%)`).join(' · ')
      : '데이터 없음';

    const zero = enriched.filter((h) => h.exposureCount === 0 && h.searchCount > 0).sort((a, b) => b.searchCount - a.searchCount);
    const opp = zero[0];
    const oppLine = opp
      ? `#${opp.keyword} — 검색량 ${opp.searchCount.toLocaleString()}인데 노출 0. 현재 노출의 ${typeSum ? Math.round((domCnt / typeSum) * 100) : 0}%가 '${labels[dom]}' 방식이니, ${methods[dom]} 노출을 노려보세요.`
      : '노출 0인 대형 키워드가 없어요. 지금 페이스 유지!';

    const rows = top5.map((h, i) => {
      const b = h.breakdown || {};
      const types = [];
      if (b.by_account) types.push(`@계정 ${b.by_account}`);
      if (b.by_hashtag) types.push(`태그 ${b.by_hashtag}`);
      if (b.by_caption) types.push(`캡션 ${b.by_caption}`);
      if (b.by_mention) types.push(`멘션 ${b.by_mention}`);
      const posts = Array.isArray(b.posts) ? b.posts.slice(0, 2) : [];
      const links = posts.filter((p) => p.url).map((p) =>
        `<a href="${p.url}" target="_blank" style="color:#1d4ed8;font-size:12px;font-weight:600;text-decoration:underline">${p.rank}위 게시물</a>`
      ).join(' · ') || '<span style="color:#94a3b8;font-size:11px">-</span>';
      return `<tr>` +
        `<td style="padding:6px 10px;border:1px solid #e5e7eb;font-size:12px;text-align:center">${i + 1}</td>` +
        `<td style="padding:6px 10px;border:1px solid #e5e7eb;font-size:12px;font-weight:700"><a href="https://www.instagram.com/explore/tags/${encodeURIComponent(h.keyword)}/" target="_blank" style="color:#1a1a1a;text-decoration:none">#${h.keyword}</a></td>` +
        `<td style="padding:6px 10px;border:1px solid #e5e7eb;font-size:12px;text-align:center">${h.sizeCat}</td>` +
        `<td style="padding:6px 10px;border:1px solid #e5e7eb;font-size:12px;text-align:right">${h.exposureCount}회</td>` +
        `<td style="padding:6px 10px;border:1px solid #e5e7eb;font-size:12px;text-align:right">${h.searchCount.toLocaleString()}</td>` +
        `<td style="padding:6px 10px;border:1px solid #e5e7eb;font-size:11px;color:#64748b">${types.join(' · ') || '-'}</td>` +
        `<td style="padding:6px 10px;border:1px solid #e5e7eb;text-align:center">${links}</td>` +
        `</tr>`;
    }).join('');

    const dt = new Date(latestDate);
    const inner =
      `<div style="font-size:12px;color:#64748b;margin-bottom:8px">노출률 <b style="color:#1a1a1a;font-size:14px">${exposureRate}%</b> (${active.length}개 중 ${withExp.length}개 노출)</div>` +
      `<table style="border-collapse:collapse;width:100%">` +
      `<tr style="background:#f8fafc">` +
      ['#', '키워드', '규모', '노출', '검색량', '노출 유형', '노출 게시물']
        .map((h) => `<th style="padding:6px 10px;border:1px solid #e5e7eb;font-size:11px;color:#64748b">${h}</th>`).join('') +
      `</tr>${rows || '<tr><td colspan="7" style="padding:10px;border:1px solid #e5e7eb;font-size:12px;text-align:center;color:#94a3b8">노출된 해시태그 없음</td></tr>'}` +
      `</table>` +
      `<div style="margin-top:8px;font-size:12px;color:#64748b">노출 유형 (총 ${typeSum}): ${typeDist}</div>` +
      `<div style="margin-top:6px;padding:8px 12px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;font-size:12px;line-height:1.6"><b>개선 기회</b> · ${oppLine}</div>`;
    return wrap(`인스타 해시태그 노출상황 <span style="font-weight:400;color:#64748b">(${dt.getMonth() + 1}/${dt.getDate()} 측정 기준)</span>`, inner);
  }

  global.ozkizSnapshot = { instaWeek, threadWeek, hashtagExposure, getWeekRange };
})(typeof window !== 'undefined' ? window : this);
