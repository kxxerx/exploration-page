// exploration-site: v1.5 anonymous community polish
// 기존 기념품샵의 Supabase Auth/site_id 로그인 구조를 그대로 사용합니다.
import { supabase } from "./supabaseClient.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { qs, showMessage, authEmailFromLoginId, revealMemberLinks, applyVisitorModeClass } from "./common.js";

await revealMemberLinks();

const ORG_LABELS = {
  baekildream: "백일몽 주식회사",
  disaster_agency: "초자연 재난관리국",
  entity: "괴이",
  unaffiliated: "무소속",
  other: "기타"
};

const DEPT_LABELS = {
  field_exploration: "현장탐사팀",
  research: "연구팀",
  security: "보안팀",
  agent: "요원",
  entity: "괴이",
  none: "없음",
  other: "기타"
};

const VISITOR_LABELS = {
  human: "일반",
  infected: "오염자",
  entity: "괴이"
};

let currentProfile = null;
let scenarioList = [];
let scenarioCache = new Map();
let currentRoom = null;
let currentMembers = [];
let currentState = null;
let currentMessages = [];
let currentInventory = [];
let roomListCache = [];
let partyListCache = [];
let realtimeChannel = null;
let fallbackPollTimer = null;
let heartbeatTimer = null;
let cleanupTimer = null;
let currentPartyDetailId = null;
let currentPartyCommentsExpanded = false;
let roomPage = 1;
let communityPage = 1;
let communityListCache = [];
let currentCommunityDetailId = null;
let currentCommunityCommentsExpanded = false;
const ROOM_PAGE_SIZE = 10;
const COMMUNITY_PAGE_SIZE = 10;
const COMMENT_PREVIEW_LIMIT = 5;
let currentAccessToken = null;
const SOLO_TEST_CODES = new Set(["/테스트 재난001", "/테스트 재난 001", "/test disaster001", "/test disaster-001"]);
const ROOM_EXIT_NOTICE_TEXT = "이 페이지에서 벗어나면 탐사방에서 자동으로 퇴장되며, 당신이 마지막 참가자라면 방이 영구적으로 삭제될 수 있습니다. 진행 내역을 보존하려면 저장 파일을 내려받는 것을 권장합니다.";
let roomExitNoticeShownFor = null;
let endingSettlementInFlight = false;

function safeText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeAttr(value) {
  return safeText(value).replaceAll("'", "&#39;");
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

function getStateJson() {
  return currentState?.state_json && typeof currentState.state_json === "object" ? currentState.state_json : {};
}

function getScenario() {
  return currentRoom ? scenarioCache.get(currentRoom.scenario_id) : null;
}

function normalizeItemId(value) {
  return String(value || "").trim();
}

function getItemCatalog() {
  return getScenario()?.itemCatalog || {};
}

function getItemMeta(itemId) {
  const catalog = getItemCatalog();
  return catalog?.[itemId] || { name: itemId, type: "item", detail: "아직 상세 설명이 등록되지 않았습니다." };
}

function getRoomInventoryMap() {
  const inv = getStateJson().roomInventory || {};
  return inv && typeof inv === "object" ? inv : {};
}

function hasRoomItem(itemId) {
  const id = normalizeItemId(itemId);
  return !!id && Number(getRoomInventoryMap()[id]?.quantity || 0) > 0;
}

function getMemberMetric(member) {
  const state = getStateJson();
  const metrics = state.memberMetrics || {};
  const saved = member?.user_id ? metrics[member.user_id] : null;
  // 탐사방 내부 오염/가면붕괴는 상점 프로필 수치를 끌어오지 않는다.
  // 방 상태(state_json.memberMetrics) 안에서만 별도 관리하고, 없으면 0부터 시작한다.
  return {
    pollution: Number(saved?.pollution ?? 0),
    mask_collapse_rate: Number(saved?.mask_collapse_rate ?? 0)
  };
}

function getMyMetric() {
  return getMemberMetric(getMyMemberSnapshot());
}

function cleanEffectText(text = "") {
  return String(text)
    .replace(/\n?\[획득\/변화\][\s\S]*?(?=\n\n|$)/g, "")
    .trim();
}

function cleanChoiceLabel(label = "") {
  return String(label)
    .replace(/^\[만약 현재 누적 오염도가 [^\]]+\]\s*/g, "")
    .replace(/\s*\(오염도 [^)]+\)/g, "")
    .replace(/\s*\(효과: [^)]+\)/g, "")
    .trim();
}

function clampMetric(value) {
  return Math.max(0, Math.min(100, Number(value || 0)));
}

function buildMetricBar(value, variant = "pollution") {
  const pct = clampMetric(value);
  return `<div class="metric-bar ${variant}" title="${pct}%"><span style="width:${pct}%"></span></div>`;
}

function isSoloBlocked() {
  const activeCount = currentMembers.filter((member) => !member.left_at).length;
  return activeCount < 2 && !getStateJson().soloTestMode;
}

function buildStatePatchForEffects(effects = []) {
  const state = getStateJson();
  const inventory = { ...(state.roomInventory || {}) };
  const metrics = { ...(state.memberMetrics || {}) };
  const myMember = getMyMemberSnapshot();
  const myId = currentProfile?.id;
  const myMetric = { ...getMyMetric() };
  const logs = [];

  for (const effect of effects || []) {
    if (effect.type === "add_item" && effect.itemId) {
      const itemId = normalizeItemId(effect.itemId);
      const meta = getItemMeta(itemId);
      inventory[itemId] = {
        itemId,
        name: meta.name || itemId,
        type: meta.type || "item",
        quantity: Number(inventory[itemId]?.quantity || 0) + Number(effect.quantity || 1),
        acquiredAt: new Date().toISOString()
      };
      logs.push(`${meta.type === "clue" ? "단서" : "아이템"} 획득: ${meta.name || itemId}`);
    }
    if (effect.type === "pollution") {
      const org = myMember?.organization_code_snapshot || currentProfile?.organization_code;
      const delta = org === "disaster_agency" && effect.disasterAgencyAmount != null ? Number(effect.disasterAgencyAmount) : Number(effect.amount || 0);
      myMetric.pollution = clampMetric(Number(myMetric.pollution || 0) + delta);
      logs.push("오염도가 갱신됐습니다.");
    }
    if (effect.type === "mask_collapse") {
      const delta = Number(effect.amount || 0);
      myMetric.mask_collapse_rate = clampMetric(Number(myMetric.mask_collapse_rate || 0) + delta);
      logs.push("오염도가 갱신됐습니다.");
    }
  }

  if (myId) metrics[myId] = { ...(metrics[myId] || {}), ...myMetric };
  const patch = { roomInventory: inventory, memberMetrics: metrics };
  if (logs.length) patch.lastEffectLog = logs;
  return patch;
}

function mergePatches(...patches) {
  return Object.assign({}, ...patches.filter(Boolean));
}

function metricLabel(profile) {
  if (profile?.visitor_type === "entity") {
    return `동기화 ${Number(profile.mask_collapse_rate || 0)}`;
  }
  return `오염도 ${Number(profile?.pollution || 0)}`;
}

function setVisible(selector, visible) {
  const node = qs(selector);
  if (node) node.hidden = !visible;
}

function showOnAirSplash() {
  const node = qs("#onAirSplash");
  if (!node) return;
  node.classList.remove("is-visible");
  // restart animation
  void node.offsetWidth;
  node.classList.add("is-visible");
  window.setTimeout(() => node.classList.remove("is-visible"), 4600);
}

function showLoggedOutView() {
  currentProfile = null;
  document.body.classList.remove("in-room");
  setVisible("#loginPanel", true);
  setVisible("#sideLoginPanel", true);
  setVisible("#profilePanel", false);
  setVisible("#appPanel", true);
  setVisible("#roomPanel", false);
  setVisible("#mainNav", true);
  qs("#roomList") && (qs("#roomList").textContent = "방 목록은 회원만 보실 수 있습니다.");
  qs("#partyList") && (qs("#partyList").textContent = "파티 모집글은 회원만 보실 수 있습니다.");
  qs("#communityList") && (qs("#communityList").textContent = "익명 게시판은 회원만 보실 수 있습니다.");
  qs("#myRoomsList") && (qs("#myRoomsList").textContent = "내 탐사방은 로그인 후 보입니다.");
}

function showLoggedInLounge() {
  if (currentRoom) return;
  document.body.classList.remove("in-room");
  setVisible("#loginPanel", false);
  setVisible("#sideLoginPanel", false);
  setVisible("#appPanel", true);
  setVisible("#mainNav", true);
  setVisible("#profilePanel", true);
}

function updateChatPlaceholder() {
  const input = qs("#chatInput");
  if (!input) return;
  input.placeholder = currentProfile?.role === "admin" ? "메시지 입력 · 관리자 테스트 코드 사용 가능" : "메시지 입력";
}

function showRoomExitNotice() {
  if (!currentRoom?.id || roomExitNoticeShownFor === currentRoom.id) return;
  const modal = qs("#roomExitNoticeModal");
  if (!modal) return;
  roomExitNoticeShownFor = currentRoom.id;
  try { modal.showModal(); } catch (_) { modal.setAttribute("open", ""); }
}

function makeDownload(filename, content, mime = "application/json") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  currentAccessToken = data.session?.access_token || null;
  return data.session;
}

async function loadProfile() {
  const session = await getSession();
  if (!session) {
    showLoggedOutView();
    return null;
  }

  showLoggedInLounge();
  document.querySelectorAll(".requires-login").forEach((node) => { node.hidden = false; });

  const { data: profile, error } = await supabase
    .from("profiles")
    .select(`
      id,
      site_id,
      display_name,
      band_nickname,
      visitor_type,
      organization_code,
      department_code,
      affiliation_label,
      character_key,
      currency,
      pollution,
      mask_collapse_rate,
      role,
      status
    `)
    .eq("id", session.user.id)
    .single();

  if (error) throw error;
  if (profile.status === "withdrawn") {
    await supabase.auth.signOut();
    showMessage("비활성화된 계정입니다.", "error");
    showLoggedOutView();
    return null;
  }

  profile.role = String(profile.role || "user").toLowerCase();
  currentProfile = profile;
  applyVisitorModeClass(profile);
  const adminNav = qs("#adminNavButton");
  if (adminNav) adminNav.hidden = profile.role !== "admin";
  if (profile.role === "admin") {
    document.querySelectorAll(".requires-admin").forEach((node) => { node.hidden = false; });
  }
  renderProfile(profile);
  await loadInventory();
  startCleanupTimer();
  showLoggedInLounge();
  return profile;
}

function renderProfile(profile) {
  const displayName = profile.display_name || "익명";
  const bandName = profile.band_nickname || "-";
  const currency = Number(profile.currency || 0);
  qs("#profileCard").innerHTML = `
    <div class="profile-name">${safeText(displayName)}</div>
    <p class="profile-sub">${safeText(bandName)}</p>
    <div class="profile-stats">
      <div class="profile-line"><strong>유쾌주화</strong>${currency.toLocaleString("ko-KR")}개</div>
    </div>
  `;
}

async function loadInventory() {
  const box = qs("#inventoryPreview");
  if (!box) return;
  if (!currentProfile) {
    box.textContent = "로그인 후 보입니다.";
    box.classList.add("muted");
    return;
  }

  box.textContent = "가방을 불러오는 중...";
  box.classList.add("muted");

  const { data, error } = await supabase
    .from("inventories")
    .select("quantity, updated_at, items(id, name, item_kind, category)")
    .eq("user_id", currentProfile.id)
    .gt("quantity", 0)
    .order("updated_at", { ascending: false })
    .limit(6);

  if (error) {
    box.textContent = `가방을 불러오지 못했습니다: ${error.message}`;
    return;
  }

  currentInventory = data || [];
  if (!currentInventory.length) {
    box.textContent = "가방에 표시할 아이템이 없습니다.";
    return;
  }

  box.classList.remove("muted");
  box.innerHTML = currentInventory.map((row) => {
    const item = row.items || {};
    return `
      <div class="inventory-item">
        <strong>${safeText(item.name || "이름 없는 아이템")}</strong>
        <span>× ${Number(row.quantity || 0)}</span>
      </div>
    `;
  }).join("");
}


async function loadScenarioList() {
  const response = await fetch(`scenarios/scenario-list.json?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("시나리오 목록을 불러오지 못했습니다.");
  const list = await response.json();
  scenarioList = list.filter((scenario) => scenario.status === "published");
  renderScenarioSelect();
}

function renderScenarioSelect() {
  const selects = [qs("#scenarioSelect"), qs("#partyScenarioSelect"), qs("#editPartyScenarioSelect")].filter(Boolean);
  selects.forEach((select) => {
    select.innerHTML = "";
    scenarioList.forEach((scenario) => {
      const option = document.createElement("option");
      option.value = scenario.id;
      option.textContent = `${scenario.title}${scenario.version ? ` · v${scenario.version}` : ""}`;
      select.appendChild(option);
    });
  });
}


async function loadRoomList() {
  const box = qs("#roomList");
  if (!box || !currentProfile) return;
  box.textContent = "탐사방을 불러오는 중...";
  box.classList.add("muted");

  await cleanupStaleRooms();
  const { data, error } = await supabase.rpc("list_exploration_rooms");
  if (error) {
    box.textContent = `탐사방 목록을 불러오지 못했습니다: ${error.message}`;
    return;
  }

  roomListCache = data || [];
  roomPage = Math.min(roomPage, Math.max(1, Math.ceil(roomListCache.length / ROOM_PAGE_SIZE)));
  renderRoomList();
}

function renderRoomList() {
  const box = qs("#roomList");
  if (!box) return;
  if (!roomListCache.length) {
    box.textContent = "현재 열린 탐사방이 없습니다.";
    box.classList.add("muted");
    return;
  }
  box.classList.remove("muted");
  const totalPages = Math.max(1, Math.ceil(roomListCache.length / ROOM_PAGE_SIZE));
  roomPage = Math.min(Math.max(1, roomPage), totalPages);
  const start = (roomPage - 1) * ROOM_PAGE_SIZE;
  const pagedRooms = roomListCache.slice(start, start + ROOM_PAGE_SIZE);
  const listHtml = pagedRooms.map((room) => {
    const scenario = scenarioList.find((item) => item.id === room.scenario_id);
    const isPrivate = room.visibility === "private";
    const isFull = Number(room.current_players || 0) >= Number(room.max_players || 0);
    const isEnded = room.status === "ended";
    const disabled = isPrivate || isFull || isEnded;
    const disabledReason = isPrivate ? "비공개" : isFull ? "인원 마감" : isEnded ? "종료" : "";
    const badges = [
      `<span class="badge ${isPrivate ? "private" : "public"}">${isPrivate ? "비공개" : "공개"}</span>`,
      isFull ? `<span class="badge full">마감</span>` : "",
      `<span class="badge">${safeText(room.status || "waiting")}</span>`
    ].join("");
    return `
      <article class="room-item ${disabled ? "is-disabled" : ""}">
        <div>
          <div class="room-title-line"><strong>${safeText(room.title || "이름 없는 탐사방")}</strong>${badges}</div>
          <div class="room-meta">${safeText(scenario?.title || room.scenario_id)} · ${Number(room.current_players || 0)}/${Number(room.max_players || 0)}명 · ${formatDate(room.created_at)}</div>
        </div>
        <div class="room-card-actions">
          <button type="button" data-join-public-room="${safeAttr(room.id)}" ${disabled ? "disabled" : ""}>${disabled ? disabledReason : "입장"}</button>
          ${currentProfile?.role === "admin" ? `<button type="button" class="ghost-button danger" data-admin-delete-room="${safeAttr(room.id)}">삭제</button>` : ""}
        </div>
      </article>
    `;
  }).join("");
  const pagerHtml = totalPages > 1 ? `
    <div class="pager">
      <button type="button" class="ghost-button" data-room-page="prev" ${roomPage <= 1 ? "disabled" : ""}>이전</button>
      <span>${roomPage} / ${totalPages}</span>
      <button type="button" class="ghost-button" data-room-page="next" ${roomPage >= totalPages ? "disabled" : ""}>다음</button>
    </div>` : "";
  box.innerHTML = listHtml + pagerHtml;
}

async function loadPartyPosts() {
  const box = qs("#partyList");
  if (!box || !currentProfile) return;
  box.textContent = "모집글을 불러오는 중...";
  box.classList.add("muted");
  await cleanupExpiredPartyPosts();
  const { data, error } = await supabase.rpc("list_exploration_party_posts");
  if (error) {
    box.textContent = `모집글을 불러오지 못했습니다: ${error.message}`;
    return;
  }
  partyListCache = data || [];
  renderPartyPosts();
}

function renderPartyPosts() {
  const box = qs("#partyList");
  if (!box) return;
  if (!partyListCache.length) {
    box.textContent = "아직 올라온 익명 모집글이 없습니다.";
    box.classList.add("muted");
    return;
  }
  box.classList.remove("muted");
  box.innerHTML = partyListCache.map((post) => {
    const scenario = scenarioList.find((item) => item.id === post.scenario_id);
    const isCreator = !!post.is_creator;
    const isAdmin = currentProfile?.role === "admin";
    const isClosed = post.status === "closed";
    const hasApplied = !!post.has_applied;
    const count = Number(post.applicant_count || 0);
    const comments = Number(post.comment_count || 0);
    const deadlineText = post.recruitment_deadline ? ` · 마감 ${formatDate(post.recruitment_deadline)}` : "";
    const statusBadge = isClosed
      ? `<span class="badge full">모집 마감</span>`
      : `<span class="badge public">모집 중</span>`;
    const ownerButtons = (isCreator || isAdmin) ? `
      ${isCreator ? `<button type="button" class="ghost-button" data-edit-party="${safeAttr(post.id)}" ${isClosed ? "disabled" : ""}>수정</button>` : ""}
      <button type="button" class="ghost-button danger" data-delete-party="${safeAttr(post.id)}">삭제</button>
      ${isCreator ? `<button type="button" class="secondary-action" data-party-room="${safeAttr(post.id)}" ${isClosed ? "disabled" : ""}>방 만들기</button>` : ""}
    ` : "";
    const applicantButtons = !isCreator && !isClosed ? (
      hasApplied
        ? `<button type="button" class="ghost-button" data-cancel-party="${safeAttr(post.id)}">참여 취소</button>`
        : `<button type="button" class="primary-action" data-apply-party="${safeAttr(post.id)}">참여 의사</button>`
    ) : "";
    return `
      <article class="party-item ${isClosed ? "is-disabled" : ""}">
        <header class="party-item-head">
          <strong>${safeText(post.title || "익명 모집")}</strong>
          ${statusBadge}
        </header>
        <div class="party-item-meta">${safeText(scenario?.title || post.scenario_id || "시나리오 미정")} · ${safeText(post.play_time || "시간 미정")} · 신청 ${count}명 · 댓글 ${comments}개${safeText(deadlineText)}</div>
        <p class="party-item-content">${safeText(post.content || "내용 없음")}</p>
        <footer class="party-actions">
          <button type="button" class="ghost-button" data-detail-party="${safeAttr(post.id)}">자세히 보기</button>
          <button type="button" class="ghost-button danger" data-report-target="party_post" data-report-id="${safeAttr(post.id)}">신고</button>
          ${applicantButtons}
          ${ownerButtons}
        </footer>
      </article>
    `;
  }).join("");
}

async function loadPartyComments(postId) {
  const { data, error } = await supabase.rpc("list_exploration_party_comments", { p_post_id: postId });
  if (error) throw error;
  return data || [];
}

function renderPartyDetail(post) {
  const detail = qs("#partyDetailBody");
  if (!detail || !post) return;
  const scenario = scenarioList.find((item) => item.id === post.scenario_id);
  const isClosed = post.status === "closed";
  const count = Number(post.applicant_count || 0);
  const comments = Number(post.comment_count || 0);
  detail.innerHTML = `
    <p class="kicker">Anonymous Board</p>
    <h2>${safeText(post.title || "익명 모집")}</h2>
    <div class="room-meta">${safeText(scenario?.title || post.scenario_id || "시나리오 미정")} · ${safeText(post.play_time || "시간 미정")} · 신청 ${count}명 · 댓글 ${comments}개${post.recruitment_deadline ? ` · 마감 ${formatDate(post.recruitment_deadline)}` : ""}</div>
    <div class="party-detail-content">${safeText(post.content || "내용 없음")}</div>
    <div class="party-actions"><button type="button" class="ghost-button danger" data-report-target="party_post" data-report-id="${safeAttr(post.id)}">모집글 신고</button></div>
    ${isClosed ? `<p class="small muted">모집 마감된 글입니다. 마감 후 2일이 지나면 목록 정리 시 삭제됩니다.</p>` : ""}
  `;
}

function renderPartyComments(comments = []) {
  const box = qs("#partyCommentList");
  if (!box) return;
  if (!comments.length) {
    box.textContent = "아직 댓글이 없습니다.";
    box.classList.add("muted");
    return;
  }
  box.classList.remove("muted");
  const hiddenCount = Math.max(0, comments.length - COMMENT_PREVIEW_LIMIT);
  const visibleComments = currentPartyCommentsExpanded ? comments : comments.slice(-COMMENT_PREVIEW_LIMIT);
  const itemsHtml = visibleComments.map((comment) => `
    <article class="comment-item">
      <div class="comment-head">
        <strong>${safeText(comment.anonymous_label || "익명 탐사자")}</strong>
        <span>${formatDate(comment.created_at)}</span>
      </div>
      <p>${safeText(comment.body || "")}</p>
      <div class="comment-actions">
        <button type="button" class="mini-button danger" data-report-target="party_comment" data-report-id="${safeAttr(comment.id)}">신고</button>
        ${(comment.is_mine || currentProfile?.role === "admin") ? `<button type="button" class="mini-button danger" data-delete-comment="${safeAttr(comment.id)}">댓글 삭제</button>` : ""}
      </div>
    </article>
  `).join("");
  const foldHtml = comments.length > COMMENT_PREVIEW_LIMIT ? `
    <button type="button" class="ghost-button full" data-toggle-comments="1">
      ${currentPartyCommentsExpanded ? "이전 댓글 접기" : `이전 댓글 ${hiddenCount}개 더 보기`}
    </button>` : "";
  box.innerHTML = itemsHtml + foldHtml;
}

async function openPartyDetail(postId) {
  const post = partyListCache.find((item) => item.id === postId);
  if (!post) return;
  currentPartyDetailId = postId;
  currentPartyCommentsExpanded = false;
  qs("#partyCommentPostId").value = postId;
  renderPartyDetail(post);
  qs("#partyCommentBody").value = "";
  openModal("#partyDetailModal");
  try {
    const comments = await loadPartyComments(postId);
    renderPartyComments(comments);
  } catch (error) {
    qs("#partyCommentList").textContent = `댓글을 불러오지 못했습니다: ${error.message}`;
  }
}


function communityStatusLabel(post) {
  return post?.status === "visible" ? "게시 중" : "숨김";
}

async function loadCommunityPosts(page = communityPage) {
  const box = qs("#communityList");
  if (!box || !currentProfile) return;
  communityPage = Math.max(1, Number(page || 1));
  box.textContent = "게시글을 불러오는 중...";
  box.classList.add("muted");
  const { data, error } = await supabase.rpc("list_exploration_community_posts", {
    p_page: communityPage,
    p_limit: COMMUNITY_PAGE_SIZE
  });
  if (error) {
    box.textContent = `게시글을 불러오지 못했습니다: ${error.message}`;
    return;
  }
  communityListCache = data || [];
  renderCommunityPosts();
}

function renderCommunityPosts() {
  const box = qs("#communityList");
  const pager = qs("#communityPagination");
  if (!box) return;
  if (!communityListCache.length) {
    box.textContent = "아직 올라온 익명 게시글이 없습니다.";
    box.classList.add("muted");
    if (pager) pager.hidden = true;
    return;
  }
  const totalCount = Number(communityListCache[0]?.total_count || communityListCache.length || 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / COMMUNITY_PAGE_SIZE));
  box.classList.remove("muted");
  box.innerHTML = communityListCache.map((post) => `
    <article class="community-item">
      <header class="community-item-head">
        <strong>${safeText(post.title || "익명 게시글")}</strong>
        <span class="badge public">${safeText(communityStatusLabel(post))}</span>
      </header>
      <div class="community-item-meta">
        ${safeText(post.anonymous_alias || "익명 탐사자")} · ${safeText(ORG_LABELS[post.organization_code] || post.organization_label || "소속 미상")} · ${formatDate(post.created_at)} · 댓글 ${Number(post.comment_count || 0)}개
      </div>
      <p class="community-item-content">${safeText(post.body || "").slice(0, 180)}${String(post.body || "").length > 180 ? "..." : ""}</p>
      <footer class="community-actions">
        <button type="button" class="ghost-button" data-detail-community="${safeAttr(post.id)}">자세히 보기</button>
        ${post.is_mine ? `<button type="button" class="ghost-button danger" data-delete-community-post="${safeAttr(post.id)}">삭제</button>` : ""}
        <button type="button" class="ghost-button danger" data-report-target="community_post" data-report-id="${safeAttr(post.id)}">신고</button>
      </footer>
    </article>
  `).join("");
  if (pager) {
    pager.hidden = totalPages <= 1;
    pager.innerHTML = `
      <button type="button" class="ghost-button" data-community-page="prev" ${communityPage <= 1 ? "disabled" : ""}>이전</button>
      <span>${communityPage} / ${totalPages}</span>
      <button type="button" class="ghost-button" data-community-page="next" ${communityPage >= totalPages ? "disabled" : ""}>다음</button>
    `;
  }
}

async function openCommunityDetail(postId) {
  currentCommunityDetailId = postId;
  currentCommunityCommentsExpanded = false;
  const detail = qs("#communityDetailBody");
  const commentsBox = qs("#communityCommentList");
  if (detail) detail.innerHTML = "불러오는 중...";
  if (commentsBox) commentsBox.textContent = "댓글을 불러오는 중...";
  qs("#communityCommentPostId") && (qs("#communityCommentPostId").value = postId);
  qs("#communityParentCommentId") && (qs("#communityParentCommentId").value = "");
  qs("#communityCommentBody") && (qs("#communityCommentBody").value = "");
  qs("#communityReplyHint") && (qs("#communityReplyHint").hidden = true);
  openModal("#communityDetailModal");
  try {
    const { data, error } = await supabase.rpc("get_exploration_community_post", { p_post_id: postId });
    if (error) throw error;
    const post = Array.isArray(data) ? data[0] : data;
    if (!post) throw new Error("게시글을 찾지 못했습니다.");
    renderCommunityDetail(post);
    const comments = await loadCommunityComments(postId);
    renderCommunityComments(comments);
  } catch (error) {
    if (detail) detail.innerHTML = `<p class="muted">게시글을 불러오지 못했습니다: ${safeText(error.message)}</p>`;
  }
}

function renderCommunityDetail(post) {
  const detail = qs("#communityDetailBody");
  if (!detail) return;
  detail.innerHTML = `
    <p class="kicker">Anonymous Lounge</p>
    <h2>${safeText(post.title || "익명 게시글")}</h2>
    <div class="room-meta">${safeText(post.anonymous_alias || "익명 탐사자")} · ${safeText(ORG_LABELS[post.organization_code] || post.organization_label || "소속 미상")} · ${formatDate(post.created_at)} · 댓글 ${Number(post.comment_count || 0)}개</div>
    <div class="community-detail-content">${safeText(post.body || "")}</div>
    <div class="community-actions">
      ${post.is_mine ? `<button type="button" class="ghost-button danger" data-delete-community-post="${safeAttr(post.id)}">삭제</button>` : ""}
      <button type="button" class="ghost-button danger" data-report-target="community_post" data-report-id="${safeAttr(post.id)}">게시글 신고</button>
    </div>
  `;
}

async function loadCommunityComments(postId) {
  const { data, error } = await supabase.rpc("list_exploration_community_comments", { p_post_id: postId });
  if (error) throw error;
  return data || [];
}

function renderCommunityComments(comments = []) {
  const box = qs("#communityCommentList");
  if (!box) return;
  if (!comments.length) {
    box.textContent = "아직 댓글이 없습니다.";
    box.classList.add("muted");
    return;
  }
  box.classList.remove("muted");
  const rootComments = comments.filter((c) => !c.parent_comment_id);
  const repliesByParent = new Map();
  comments.filter((c) => c.parent_comment_id).forEach((c) => {
    const arr = repliesByParent.get(c.parent_comment_id) || [];
    arr.push(c);
    repliesByParent.set(c.parent_comment_id, arr);
  });
  const hiddenCount = Math.max(0, rootComments.length - COMMENT_PREVIEW_LIMIT);
  const visibleRoots = currentCommunityCommentsExpanded ? rootComments : rootComments.slice(-COMMENT_PREVIEW_LIMIT);
  const html = visibleRoots.map((comment) => {
    const replies = repliesByParent.get(comment.id) || [];
    return `
      <article class="comment-item community-root-comment">
        <div class="comment-head"><strong>${safeText(comment.anonymous_alias || "익명 탐사자")}</strong><span>${formatDate(comment.created_at)}</span></div>
        <p>${safeText(comment.body || "")}</p>
        <div class="comment-actions">
          <button type="button" class="mini-button" data-reply-community-comment="${safeAttr(comment.id)}" data-reply-label="${safeAttr(comment.anonymous_alias || "익명 탐사자")}">답글</button>
          <button type="button" class="mini-button danger" data-report-target="community_comment" data-report-id="${safeAttr(comment.id)}">신고</button>
          ${(comment.is_mine || currentProfile?.role === "admin") ? `<button type="button" class="mini-button danger" data-delete-community-comment="${safeAttr(comment.id)}">삭제</button>` : ""}
        </div>
        ${replies.map((reply) => `
          <article class="comment-item community-reply-comment">
            <div class="comment-head"><strong>${safeText(reply.anonymous_alias || "익명 탐사자")}</strong><span>${formatDate(reply.created_at)}</span></div>
            <p>${safeText(reply.body || "")}</p>
            <div class="comment-actions">
              <button type="button" class="mini-button danger" data-report-target="community_comment" data-report-id="${safeAttr(reply.id)}">신고</button>
              ${(reply.is_mine || currentProfile?.role === "admin") ? `<button type="button" class="mini-button danger" data-delete-community-comment="${safeAttr(reply.id)}">삭제</button>` : ""}
            </div>
          </article>`).join("")}
      </article>
    `;
  }).join("");
  const foldHtml = rootComments.length > COMMENT_PREVIEW_LIMIT ? `<button type="button" class="ghost-button full" data-toggle-community-comments="1">${currentCommunityCommentsExpanded ? "이전 댓글 접기" : `이전 댓글 ${hiddenCount}개 더 보기`}</button>` : "";
  box.innerHTML = foldHtml + html;
}


async function loadScenario(scenarioId) {
  if (scenarioCache.has(scenarioId)) return scenarioCache.get(scenarioId);
  const meta = scenarioList.find((item) => item.id === scenarioId);
  if (!meta) throw new Error("시나리오 정보를 찾을 수 없습니다.");
  const response = await fetch(`scenarios/${meta.file}?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("시나리오 파일을 불러오지 못했습니다.");
  const scenario = await response.json();
  scenarioCache.set(scenarioId, scenario);
  return scenario;
}

async function createRoom({ scenarioId, title, maxPlayers, visibility = "public", roomPassword = "", startSectionKey = null, stateJson = {} }) {
  const scenario = await loadScenario(scenarioId);
  const startKey = startSectionKey || scenario.startSection || "intro";
  const { data, error } = await supabase.rpc("create_exploration_room", {
    p_scenario_id: scenarioId,
    p_title: title || `${scenario.title} 탐사방`,
    p_max_players: Number(maxPlayers || 2),
    p_start_section_key: startKey,
    p_state_json: stateJson || {},
    p_visibility: visibility,
    p_room_password: roomPassword || null
  });
  if (error) throw error;
  closeModal("#createRoomModal");
  closeModal("#resumeRoomModal");
  showMessage(`방을 만들었습니다. 초대코드: ${data.invite_code}`, "success");
  await openRoom(data.room_id);
  await Promise.all([loadMyRooms(), loadRoomList()]);
}

async function joinRoomByCode(inviteCode, roomPassword = "") {
  const { data, error } = await supabase.rpc("join_exploration_room", {
    p_invite_code: inviteCode.trim().toUpperCase(),
    p_room_password: roomPassword || null
  });
  if (error) throw error;
  closeModal("#joinRoomModal");
  showMessage("탐사방에 입장했습니다.", "success");
  await openRoom(data.room_id);
  await Promise.all([loadMyRooms(), loadRoomList()]);
}

async function joinPublicRoomById(roomId) {
  const { data, error } = await supabase.rpc("join_exploration_room_by_id", { p_room_id: roomId });
  if (error) throw error;
  showMessage("탐사방에 입장했습니다.", "success");
  await openRoom(data.room_id);
  await Promise.all([loadMyRooms(), loadRoomList()]);
}

async function loadMyRooms() {
  if (!currentProfile) return;
  const box = qs("#myRoomsList");
  box.textContent = "불러오는 중...";

  const { data: memberships, error: memberError } = await supabase
    .from("exploration_room_members")
    .select("room_id, role, joined_at, left_at")
    .eq("user_id", currentProfile.id)
    .is("left_at", null)
    .order("joined_at", { ascending: false });

  if (memberError) {
    box.textContent = `방 목록을 불러오지 못했습니다: ${memberError.message}`;
    return;
  }

  if (!memberships?.length) {
    box.textContent = "아직 들어간 탐사방이 없습니다.";
    return;
  }

  const roomIds = memberships.map((item) => item.room_id);
  const { data: rooms, error: roomError } = await supabase
    .from("exploration_rooms")
    .select("id, scenario_id, title, invite_code, max_players, status, visibility, host_user_id, created_at")
    .in("id", roomIds)
    .order("created_at", { ascending: false });

  if (roomError) {
    box.textContent = `방 정보를 불러오지 못했습니다: ${roomError.message}`;
    return;
  }

  const byRoomId = new Map(memberships.map((item) => [item.room_id, item]));
  box.classList.remove("muted");
  box.innerHTML = rooms.map((room) => {
    const scenario = scenarioList.find((item) => item.id === room.scenario_id);
    const membership = byRoomId.get(room.id);
    return `
      <div class="room-item">
        <div>
          <strong>${safeText(room.title)}</strong><br>
          <span class="small muted">${safeText(scenario?.title || room.scenario_id)} · ${safeText(room.status)} · ${safeText(membership?.role || "player")}</span>
        </div>
        <button type="button" data-open-room="${safeAttr(room.id)}">입장</button>
      </div>
    `;
  }).join("");
}

async function openRoom(roomId) {
  document.body.classList.add("in-room");
  await closeRealtime();
  setVisible("#loginPanel", false);
  setVisible("#appPanel", false);
  setVisible("#roomPanel", true);
  await loadRoomBundle(roomId);
  setupRealtime(roomId);
  startHeartbeat(roomId);
  showRoomExitNotice();
  qs("#roomPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}


async function cleanupStaleRooms() {
  if (!currentProfile) return;
  try {
    await supabase.rpc("cleanup_stale_exploration_rooms", { p_stale_minutes: 60 });
  } catch (_) {
    // 정리 실패는 사용자 흐름을 막지 않는다.
  }
}

async function cleanupExpiredPartyPosts() {
  if (!currentProfile) return;
  try {
    await supabase.rpc("cleanup_expired_exploration_party_posts");
  } catch (_) {
    // 파티 게시판 청소 실패는 사용자 흐름을 막지 않는다.
  }
}

async function heartbeatRoom() {
  if (!currentRoom?.id) return;
  try {
    await supabase.rpc("heartbeat_exploration_room", { p_room_id: currentRoom.id });
  } catch (_) {
    // 탭 생존 신호라 조용히 실패 처리한다.
  }
}

function startHeartbeat(roomId) {
  stopHeartbeat();
  if (!roomId) return;
  heartbeatRoom();
  heartbeatTimer = window.setInterval(heartbeatRoom, 30000);
}

function stopHeartbeat() {
  if (heartbeatTimer) window.clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function startCleanupTimer() {
  if (cleanupTimer) return;
  cleanupStaleRooms();
  cleanupTimer = window.setInterval(async () => {
    await cleanupStaleRooms();
    if (currentProfile && !currentRoom) await loadRoomList();
  }, 5 * 60 * 1000);
}

async function loadRoomBundle(roomId, options = {}) {
  const { silent = false } = options;
  const { data: room, error: roomError } = await supabase
    .from("exploration_rooms")
    .select("id, scenario_id, title, host_user_id, invite_code, max_players, status, visibility, created_at, started_at, ended_at")
    .eq("id", roomId)
    .single();
  if (roomError) throw roomError;

  currentRoom = room;
  document.body.classList.add("in-room");
  setVisible("#appPanel", false);
  setVisible("#roomPanel", true);
  await loadScenario(room.scenario_id);
  await Promise.all([loadMembers(), loadRoomState(), loadMessages()]);
  renderRoom();
  if (!silent) showMessage("탐사방 정보를 불러왔습니다.", "success");
}

async function loadMembers() {
  if (!currentRoom) return;
  const { data, error } = await supabase
    .from("exploration_room_members")
    .select("room_id, user_id, role, character_key_snapshot, display_name_snapshot, organization_code_snapshot, department_code_snapshot, affiliation_label_snapshot, visitor_type_snapshot, pollution_snapshot, mask_collapse_rate_snapshot, joined_at, left_at")
    .eq("room_id", currentRoom.id)
    .is("left_at", null)
    .order("joined_at", { ascending: true });
  if (error) throw error;
  currentMembers = data || [];
  renderMembers();
}

async function loadRoomState() {
  if (!currentRoom) return;
  const { data, error } = await supabase
    .from("exploration_room_state")
    .select("room_id, current_section_key, state_json, updated_by, updated_at")
    .eq("room_id", currentRoom.id)
    .single();
  if (error) throw error;
  currentState = data;
}

async function loadMessages() {
  if (!currentRoom) return;
  const { data, error } = await supabase
    .from("exploration_room_messages")
    .select("id, room_id, sender_id, sender_display_name, message_type, content, created_at")
    .eq("room_id", currentRoom.id)
    .order("created_at", { ascending: true })
    .limit(300);
  if (error) throw error;
  currentMessages = data || [];
  renderMessages();
}

function getMyMemberSnapshot() {
  if (!currentProfile) return null;
  return currentMembers.find((member) => member.user_id === currentProfile.id) || null;
}

function conditionMatches(condition = {}) {
  const member = getMyMemberSnapshot();
  const metric = getMyMetric();
  const context = {
    character_key: member?.character_key_snapshot ?? currentProfile?.character_key,
    organization_code: member?.organization_code_snapshot ?? currentProfile?.organization_code,
    department_code: member?.department_code_snapshot ?? currentProfile?.department_code,
    affiliation_label: member?.affiliation_label_snapshot ?? currentProfile?.affiliation_label,
    visitor_type: member?.visitor_type_snapshot ?? currentProfile?.visitor_type,
    pollution: metric.pollution,
    mask_collapse_rate: metric.mask_collapse_rate
  };

  return Object.entries(condition || {}).every(([key, expected]) => {
    if (key === "min_pollution") return Number(context.pollution || 0) >= Number(expected);
    if (key === "max_pollution") return Number(context.pollution || 0) <= Number(expected);
    if (key === "min_mask_collapse_rate") return Number(context.mask_collapse_rate || 0) >= Number(expected);
    if (key === "item") return hasRoomItem(expected);
    if (key === "not_item") return !hasRoomItem(expected);
    if (key === "items") return (expected || []).every((itemId) => hasRoomItem(itemId));
    if (Array.isArray(expected)) return expected.includes(context[key]);
    return context[key] === expected;
  });
}

async function renderRoom() {
  if (!currentRoom || !currentState) return;
  const scenario = await loadScenario(currentRoom.scenario_id);
  const sectionKey = currentState.current_section_key || scenario.startSection;
  const section = scenario.sections?.[sectionKey];
  const isHost = currentRoom.host_user_id === currentProfile?.id;

  qs("#roomTitleView").textContent = currentRoom.title;
  qs("#roomMetaView").textContent = `${scenario.title} · ${currentRoom.visibility === "private" ? "비공개" : "공개"} · 초대코드 ${currentRoom.invite_code} · ${currentRoom.status} · 최대 ${currentRoom.max_players}명`;
  qs("#scenarioTitle").textContent = `${scenario.title} · ${sectionKey}`;
  const imageNode = qs("#scenarioImage");
  const imageUrl = section.image || section.imageUrl || scenario.coverImage || "";
  if (imageNode && imageUrl) {
    imageNode.hidden = false;
    imageNode.style.backgroundImage = `linear-gradient(135deg, rgba(158,29,41,.18), rgba(232,179,90,.08)), url('${String(imageUrl).replaceAll("'", "%27")}')`;
  } else if (imageNode) {
    imageNode.hidden = true;
    imageNode.style.backgroundImage = "";
  }
  document.querySelectorAll(".host-only").forEach((node) => { node.hidden = !isHost; });

  if (!section) {
    qs("#sectionTitle").textContent = "섹션 오류";
    qs("#storyText").textContent = `시나리오 파일에서 '${sectionKey}' 섹션을 찾지 못했습니다.`;
    qs("#choiceList").innerHTML = "";
    return;
  }

  qs("#sectionTitle").textContent = section.title || sectionKey;
  const privateBlocks = (section.visibilityBlocks || [])
    .filter((block) => conditionMatches(block.condition || {}))
    .map((block) => `<div class="story-private">${safeText(block.text || "")}</div>`)
    .join("");
  qs("#storyText").innerHTML = `${safeText(cleanEffectText(section.commonText || ""))}${privateBlocks}`;
  const effectBox = qs("#sectionEffectLog");
  const logs = getStateJson().lastEffectLog || [];
  if (effectBox && logs.length) {
    effectBox.hidden = false;
    effectBox.innerHTML = logs.map((line) => `<span>${safeText(line)}</span>`).join("");
  } else if (effectBox) {
    effectBox.hidden = true;
    effectBox.innerHTML = "";
  }
  renderRoomInventory();
  updateChatPlaceholder();

  const choices = (section.choices || []).filter((choice) => !choice.requires || conditionMatches(choice.requires));
  const soloBlocked = isSoloBlocked();
  if (!choices.length) {
    const ending = section.ending ? buildEndingNotice(section.ending) : "";
    qs("#choiceList").innerHTML = `<div class="message">선택지가 없습니다. ${ending}</div>`;
    if (section.ending) await settleCurrentEnding(section.ending, sectionKey);
    return;
  }

  const soloBlockedMessage = soloBlocked
    ? (currentProfile?.role === "admin"
      ? `<div class="message subtle">혼자서는 진행할 수 없습니다. 관리자 테스트 코드를 대화창에 입력하면 진행할 수 있습니다.</div>`
      : `<div class="message subtle">혼자서는 진행할 수 없습니다.</div>`)
    : "";
  qs("#choiceList").innerHTML = `
    ${soloBlockedMessage}
    ${choices.map((choice, index) => `
      <button type="button" class="choice-button ${choice.requires ? "private-choice" : ""}" data-choice-index="${index}" ${soloBlocked ? "disabled" : ""}>
        ${safeText(cleanChoiceLabel(choice.label))}
      </button>
    `).join("")}
  `;

  qs("#choiceList").querySelectorAll("[data-choice-index]").forEach((button) => {
    button.addEventListener("click", async () => {
      const choice = choices[Number(button.dataset.choiceIndex)];
      await chooseNext(choice);
    });
  });
}

function renderMembers() {
  const box = qs("#memberList");
  if (!currentMembers.length) {
    box.textContent = "참가자가 없습니다.";
    return;
  }
  box.classList.remove("muted");
  box.innerHTML = currentMembers.map((member) => {
    const metric = getMemberMetric(member);
    const isEntity = member.visitor_type_snapshot === "entity";
    return `
      <div class="member-item">
        <strong>${safeText(member.display_name_snapshot || "익명")}</strong>
        <span class="small muted">${safeText(member.affiliation_label_snapshot || "소속 미지정")} · ${safeText(member.role)}</span>
        <div class="member-metric-row">
          <span>${isEntity ? "가면붕괴율" : "오염진행도"}</span>
          ${buildMetricBar(isEntity ? metric.mask_collapse_rate : metric.pollution, isEntity ? "sync" : "pollution")}
        </div>
      </div>
    `;
  }).join("");
}

function renderRoomInventory() {
  const box = qs("#roomInventoryList");
  if (!box) return;
  const inventory = getRoomInventoryMap();
  const entries = Object.values(inventory).filter((item) => Number(item.quantity || 0) > 0);
  if (!entries.length) {
    box.textContent = "아직 획득한 단서나 아이템이 없습니다.";
    box.classList.add("muted");
    return;
  }
  box.classList.remove("muted");
  box.innerHTML = entries.map((item) => {
    const meta = getItemMeta(item.itemId);
    return `
      <button type="button" class="room-inventory-item" data-room-item="${safeAttr(item.itemId)}">
        <strong>${safeText(meta.name || item.name || item.itemId)}</strong>
        <span>${safeText(meta.type === "clue" ? "단서" : "아이템")} · ×${Number(item.quantity || 1)}</span>
      </button>
    `;
  }).join("");
}

function openRoomItemDetail(itemId) {
  const meta = getItemMeta(itemId);
  qs("#inventoryDetailBody").innerHTML = `
    <p class="kicker">${safeText(meta.type === "clue" ? "Clue" : "Item")}</p>
    <h2>${safeText(meta.name || itemId)}</h2>
    <div class="party-detail-content">${safeText(meta.detail || "아직 상세 설명이 등록되지 않았습니다.")}</div>
  `;
  openModal("#inventoryDetailModal");
}

function renderMessages() {
  const box = qs("#chatLog");
  if (!currentMessages.length) {
    box.textContent = "아직 채팅이 없습니다.";
    box.classList.add("muted");
    return;
  }
  box.classList.remove("muted");
  box.innerHTML = currentMessages.map((message) => {
    const systemClass = message.message_type === "system" ? " system" : "";
    const sender = message.message_type === "system" ? "시스템" : (message.sender_display_name || "익명");
    return `
      <div class="chat-message${systemClass}">
        <strong>${safeText(sender)} · ${formatDate(message.created_at)}</strong>
        <div>${safeText(message.content || "")}</div>
        ${message.message_type === "system" ? "" : `<button type="button" class="mini-button danger" data-report-target="room_message" data-report-id="${safeAttr(message.id)}">신고</button>`}
      </div>
    `;
  }).join("");
  box.scrollTop = box.scrollHeight;
}

function buildEndingNotice(ending = {}) {
  const typeLabel = { good: "굿 엔딩", hidden: "히든 엔딩", normal: "노멀 엔딩", bad: "배드 엔딩" }[ending.type] || "엔딩";
  return `<p class="small muted">${safeText(typeLabel)}에 도달했습니다. 결과 정산이 연결된 경우 상점의 유쾌주화와 오염도에 반영됩니다.</p>`;
}

async function settleCurrentEnding(ending = {}, sectionKey = "") {
  if (!currentRoom?.id || !currentProfile?.id || endingSettlementInFlight) return;
  endingSettlementInFlight = true;
  try {
    const resultCode = ending.resultCode || `${currentRoom.scenario_id}:${sectionKey}:${ending.type || "ending"}`;
    const { data, error } = await supabase.rpc("settle_exploration_result", {
      p_room_id: currentRoom.id,
      p_scenario_id: currentRoom.scenario_id,
      p_result_code: resultCode,
      p_ending_type: ending.type || "ending",
      p_currency_delta: Number(ending.currencyReward || ending.currencyDelta || 0),
      p_pollution_delta: ending.pollutionDelta == null ? null : Number(ending.pollutionDelta),
      p_set_pollution_to: ending.setPollutionTo == null ? null : Number(ending.setPollutionTo)
    });
    if (error) throw error;
    if (data?.applied) {
      showMessage("탐사 결과가 상점 계정에 정산되었습니다.", "success");
      await loadProfile();
    }
  } catch (error) {
    // SQL이 아직 적용되지 않은 상태에서도 엔딩 화면 자체는 막지 않는다.
    showMessage(`탐사 결과 정산은 아직 적용되지 않았습니다: ${error.message}`, "error");
  } finally {
    endingSettlementInFlight = false;
  }
}

async function chooseNext(choice) {
  if (!choice?.next || !currentRoom) return;
  if (isSoloBlocked()) {
    showMessage(currentProfile?.role === "admin" ? "혼자서는 진행할 수 없습니다. 관리자 테스트 코드를 입력하면 진행할 수 있습니다." : "혼자서는 진행할 수 없습니다.", "error");
    return;
  }
  const scenario = await loadScenario(currentRoom.scenario_id);
  const nextSection = scenario.sections?.[choice.next];
  const effectPatch = buildStatePatchForEffects([...(choice.effects || []), ...((nextSection?.effects) || [])]);
  const { error } = await supabase.rpc("advance_exploration_room", {
    p_room_id: currentRoom.id,
    p_next_section_key: choice.next,
    p_choice_label: cleanChoiceLabel(choice.label || ""),
    p_state_patch: mergePatches(choice.setState || {}, effectPatch)
  });
  if (error) {
    showMessage(error.message, "error");
    return;
  }
  await loadRoomBundle(currentRoom.id, { silent: true });
}

async function setupRealtime(roomId) {
  await closeRealtime();
  realtimeChannel = supabase
    .channel(`exploration-room-${roomId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "exploration_room_state", filter: `room_id=eq.${roomId}` }, async () => {
      await loadRoomBundle(roomId, { silent: true });
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "exploration_room_messages", filter: `room_id=eq.${roomId}` }, async () => {
      await loadMessages();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "exploration_room_members", filter: `room_id=eq.${roomId}` }, async () => {
      await loadMembers();
    })
    .subscribe();

  fallbackPollTimer = window.setInterval(async () => {
    if (currentRoom?.id === roomId) {
      try { await loadRoomBundle(roomId, { silent: true }); } catch (_) { /* fallback polling should stay quiet */ }
    }
  }, 12000);
}

async function closeRealtime() {
  if (fallbackPollTimer) {
    clearInterval(fallbackPollTimer);
    fallbackPollTimer = null;
  }
  if (realtimeChannel) {
    await supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

async function postChat(content) {
  if (!currentRoom) return;
  const { error } = await supabase.rpc("post_exploration_message", {
    p_room_id: currentRoom.id,
    p_content: content,
    p_message_type: "normal"
  });
  if (error) throw error;
  await loadMessages();
}

function buildSavePayload() {
  const scenario = scenarioCache.get(currentRoom.scenario_id);
  return {
    format: "pollution-exploration-save-v1",
    savedAt: new Date().toISOString(),
    roomTitle: currentRoom.title,
    scenarioId: currentRoom.scenario_id,
    scenarioTitle: scenario?.title || currentRoom.scenario_id,
    scenarioVersion: scenario?.version || null,
    currentSectionKey: currentState?.current_section_key || scenario?.startSection || "intro",
    stateJson: currentState?.state_json || {},
    members: currentMembers.map((member) => ({
      display_name: member.display_name_snapshot,
      character_key: member.character_key_snapshot,
      organization_code: member.organization_code_snapshot,
      department_code: member.department_code_snapshot,
      affiliation_label: member.affiliation_label_snapshot,
      visitor_type: member.visitor_type_snapshot
    }))
  };
}

function downloadSave() {
  if (!currentRoom || !currentState) return;
  const payload = buildSavePayload();
  const filename = `exploration-save-${currentRoom.scenario_id}-${Date.now()}.json`;
  makeDownload(filename, JSON.stringify(payload, null, 2));
}

function downloadChat() {
  if (!currentRoom) return;
  const lines = currentMessages.map((message) => {
    const sender = message.message_type === "system" ? "시스템" : (message.sender_display_name || "익명");
    return `[${formatDate(message.created_at)}] ${sender}: ${message.content || ""}`;
  });
  makeDownload(`exploration-chat-${currentRoom.id}-${Date.now()}.txt`, lines.join("\n"), "text/plain");
}

async function updateRoomSettings({ title, maxPlayers, visibility, roomPassword }) {
  if (!currentRoom) return;
  const { data, error } = await supabase.rpc("update_exploration_room_settings", {
    p_room_id: currentRoom.id,
    p_title: title,
    p_max_players: Number(maxPlayers || 2),
    p_visibility: visibility,
    p_room_password: roomPassword || null
  });
  if (error) throw error;
  closeModal("#roomSettingsModal");
  showMessage("방 설정을 저장했습니다.", "success");
  await loadRoomBundle(data.room_id || currentRoom.id, { silent: true });
  await Promise.all([loadRoomList(), loadMyRooms()]);
}

async function leaveCurrentRoom() {
  if (!currentRoom) return;
  const ok = window.confirm("정말 나가시겠습니까? 진행 내역을 보존하려면 저장 파일을 내려받는 것을 권장합니다. 마지막 참가자가 나가면 방이 영구적으로 삭제될 수 있습니다.");
  if (!ok) return;
  const roomId = currentRoom.id;
  await closeRealtime();
  stopHeartbeat();
  const { data, error } = await supabase.rpc("leave_exploration_room", { p_room_id: roomId });
  if (error) throw error;
  currentRoom = null;
  currentMembers = [];
  currentState = null;
  currentMessages = [];
  setVisible("#roomPanel", false);
  showLoggedInLounge();
  switchTab("rooms");
  await Promise.all([loadMyRooms(), loadRoomList()]);
  showMessage(data?.room_deleted ? "마지막 참가자가 나가 탐사방이 삭제되었습니다." : "라운지로 나왔습니다.", "success");
  qs("#appPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function clearChat() {
  if (!currentRoom) return;
  const ok = window.confirm("현재 방 채팅 로그를 DB에서 삭제할까요? 다운로드하지 않은 로그는 사라집니다.");
  if (!ok) return;
  const { error } = await supabase.rpc("clear_exploration_room_messages", { p_room_id: currentRoom.id });
  if (error) {
    showMessage(error.message, "error");
    return;
  }
  await loadMessages();
  showMessage("채팅 로그를 초기화했습니다.", "success");
}

async function readJsonFile(file) {
  const text = await file.text();
  return JSON.parse(text);
}


function openReportModal(targetType, targetId) {
  if (!targetType || !targetId) return;
  const targetTypeInput = qs("#reportTargetType");
  const targetIdInput = qs("#reportTargetId");
  const reasonInput = qs("#reportReason");
  const detailInput = qs("#reportDetail");
  if (!targetTypeInput || !targetIdInput || !reasonInput || !detailInput) {
    showMessage("신고 창을 찾지 못했습니다. 새로고침 후 다시 시도해 주세요.", "error");
    return;
  }
  targetTypeInput.value = targetType;
  targetIdInput.value = targetId;
  reasonInput.value = targetType === "room_message" ? "troll" : "abuse";
  detailInput.value = "";
  openModal("#reportModal");
}

async function submitReport({ targetType, targetId, reason, detail }) {
  const { error } = await supabase.rpc("submit_exploration_report", {
    p_target_type: targetType,
    p_target_id: targetId,
    p_reason: reason,
    p_detail: detail || null
  });
  if (error) throw error;
  closeModal("#reportModal");
  showMessage("신고를 접수했습니다. 검토 전까지 해당 내용은 숨김 처리됩니다.", "success");
  if (targetType === "party_post") await loadPartyPosts();
  if (targetType === "party_comment" && currentPartyDetailId) {
    const comments = await loadPartyComments(currentPartyDetailId);
    renderPartyComments(comments);
  }
}

async function loadAdminReports() {
  const box = qs("#adminReportList");
  if (!box) return;
  if (currentProfile?.role !== "admin") {
    box.textContent = "관리자만 볼 수 있습니다.";
    box.classList.add("muted");
    return;
  }
  box.textContent = "신고 내역을 불러오는 중...";
  box.classList.add("muted");
  const { data, error } = await supabase.rpc("list_exploration_reports");
  if (error) {
    box.textContent = `신고 내역을 불러오지 못했습니다: ${error.message}`;
    return;
  }
  const reports = data || [];
  if (!reports.length) {
    box.textContent = "검토 대기 중인 신고가 없습니다.";
    return;
  }
  box.classList.remove("muted");
  box.innerHTML = reports.map((report) => `
    <article class="admin-report-item">
      <header>
        <strong>${safeText(report.target_type)} · ${safeText(report.reason)}</strong>
        <span>${formatDate(report.created_at)}</span>
      </header>
      <p class="small muted">신고자: ${safeText(report.reporter_display_name || report.reporter_site_id || report.reporter_user_id || "알 수 없음")}</p>
      <p>${safeText(report.detail || "상세 내용 없음")}</p>
      <div class="report-snapshot">${safeText(report.content_snapshot || "내용 스냅샷 없음")}</div>
      <div class="party-actions">
        <button type="button" class="secondary-action" data-review-report="valid" data-report-id="${safeAttr(report.id)}">옳은 신고</button>
        <button type="button" class="ghost-button" data-review-report="dismiss" data-report-id="${safeAttr(report.id)}">악의/오신고</button>
        <button type="button" class="ghost-button danger" data-review-report="delete" data-report-id="${safeAttr(report.id)}">대상 삭제</button>
      </div>
    </article>
  `).join("");
}

async function reviewReport(reportId, action) {
  const { error } = await supabase.rpc("review_exploration_report", { p_report_id: reportId, p_action: action });
  if (error) throw error;
  showMessage("신고 검토를 저장했습니다.", "success");
  await loadAdminReports();
  await Promise.all([loadPartyPosts(), currentRoom ? loadMessages() : Promise.resolve()]);
}

function openModal(selector) {
  const modal = qs(selector);
  if (!modal) return;
  if (typeof modal.showModal === "function") modal.showModal();
  else modal.setAttribute("open", "");
}

function closeModal(selector) {
  const modal = qs(selector);
  if (!modal) return;
  if (typeof modal.close === "function" && modal.open) modal.close();
  else modal.removeAttribute("open");
}

function switchTab(target) {
  document.querySelectorAll("[data-tab-target]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tabTarget === target);
  });
  document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
    const active = panel.dataset.tabPanel === target;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  if (target === "rooms") loadRoomList();
  if (target === "party") loadPartyPosts();
  if (target === "community") loadCommunityPosts();
  if (target === "mine") loadMyRooms();
  if (target === "admin") loadAdminReports();
}

// Event bindings
qs("#explorationLoginForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const loginId = qs("#explorationLoginId").value.trim();
  const password = qs("#explorationPassword").value;
  const email = authEmailFromLoginId(loginId);

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    showMessage("로그인 실패: 아이디 또는 비밀번호를 확인하세요.", "error");
    return;
  }
  showMessage("탐사 로그인 완료.", "success");
  await loadProfile();
  showOnAirSplash();
  await Promise.all([loadRoomList(), loadPartyPosts(), loadCommunityPosts(), loadMyRooms()]);
});

qs("#refreshProfile")?.addEventListener("click", async () => {
  try {
    await loadProfile();
    showMessage("현재 탐사자 정보를 다시 불러왔습니다.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#refreshRoomList")?.addEventListener("click", async () => {
  try { await loadRoomList(); } catch (error) { showMessage(error.message, "error"); }
});

qs("#refreshMyRooms")?.addEventListener("click", async () => {
  await Promise.all([loadMyRooms(), loadRoomList()]);
});

qs("#refreshInventory")?.addEventListener("click", async () => {
  try {
    await loadInventory();
    showMessage("가방을 다시 불러왔습니다.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
});

document.querySelectorAll("[data-tab-target]").forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tabTarget));
});


qs("#openCreateCommunityModal")?.addEventListener("click", () => openModal("#createCommunityModal"));

qs("#createCommunityForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { error } = await supabase.rpc("create_exploration_community_post", {
      p_title: qs("#communityTitle").value.trim(),
      p_body: qs("#communityBody").value.trim()
    });
    if (error) throw error;
    closeModal("#createCommunityModal");
    qs("#createCommunityForm").reset();
    showMessage("익명 게시글을 올렸습니다.", "success");
    await loadCommunityPosts(1);
  } catch (error) { showMessage(error.message, "error"); }
});

qs("#communityList")?.addEventListener("click", async (event) => {
  const detail = event.target.closest("[data-detail-community]");
  const del = event.target.closest("[data-delete-community-post]");
  const pageBtn = event.target.closest("[data-community-page]");
  if (detail) return openCommunityDetail(detail.dataset.detailCommunity);
  if (del) {
    if (!window.confirm("이 게시글을 삭제할까요?")) return;
    try {
      const { error } = await supabase.rpc("delete_exploration_community_post", { p_post_id: del.dataset.deleteCommunityPost });
      if (error) throw error;
      showMessage("게시글을 삭제했습니다.", "success");
      await loadCommunityPosts();
    } catch (error) { showMessage(error.message, "error"); }
  }
  if (pageBtn) {
    const next = pageBtn.dataset.communityPage === "next" ? communityPage + 1 : communityPage - 1;
    await loadCommunityPosts(next);
  }
});

qs("#communityPagination")?.addEventListener("click", async (event) => {
  const pageBtn = event.target.closest("[data-community-page]");
  if (!pageBtn) return;
  const next = pageBtn.dataset.communityPage === "next" ? communityPage + 1 : communityPage - 1;
  await loadCommunityPosts(next);
});

qs("#communityDetailModal")?.addEventListener("click", async (event) => {
  const reportButton = event.target.closest("[data-report-target]");
  const delPost = event.target.closest("[data-delete-community-post]");
  const delComment = event.target.closest("[data-delete-community-comment]");
  const reply = event.target.closest("[data-reply-community-comment]");
  const toggle = event.target.closest("[data-toggle-community-comments]");
  if (reportButton) return openReportModal(reportButton.dataset.reportTarget, reportButton.dataset.reportId);
  if (reply) {
    qs("#communityParentCommentId").value = reply.dataset.replyCommunityComment;
    const hint = qs("#communityReplyHint");
    if (hint) {
      hint.hidden = false;
      hint.innerHTML = `${safeText(reply.dataset.replyLabel || "댓글")}에게 답글 작성 중 <button type="button" class="mini-button" data-cancel-community-reply="1">취소</button>`;
    }
    qs("#communityCommentBody")?.focus();
    return;
  }
  if (event.target.closest("[data-cancel-community-reply]")) {
    qs("#communityParentCommentId").value = "";
    qs("#communityReplyHint").hidden = true;
    return;
  }
  if (toggle) {
    currentCommunityCommentsExpanded = !currentCommunityCommentsExpanded;
    const comments = await loadCommunityComments(currentCommunityDetailId);
    renderCommunityComments(comments);
    return;
  }
  if (delPost) {
    if (!window.confirm("이 게시글을 삭제할까요?")) return;
    try {
      const { error } = await supabase.rpc("delete_exploration_community_post", { p_post_id: delPost.dataset.deleteCommunityPost });
      if (error) throw error;
      closeModal("#communityDetailModal");
      await loadCommunityPosts();
      showMessage("게시글을 삭제했습니다.", "success");
    } catch (error) { showMessage(error.message, "error"); }
    return;
  }
  if (delComment) {
    if (!window.confirm("이 댓글을 삭제할까요?")) return;
    try {
      const { error } = await supabase.rpc("delete_exploration_community_comment", { p_comment_id: delComment.dataset.deleteCommunityComment });
      if (error) throw error;
      const comments = await loadCommunityComments(currentCommunityDetailId);
      renderCommunityComments(comments);
      showMessage("댓글을 삭제했습니다.", "success");
    } catch (error) { showMessage(error.message, "error"); }
  }
});

qs("#communityCommentForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const body = qs("#communityCommentBody").value.trim();
    if (!body) return;
    const parentId = qs("#communityParentCommentId").value || null;
    const { error } = await supabase.rpc("create_exploration_community_comment", {
      p_post_id: qs("#communityCommentPostId").value,
      p_body: body,
      p_parent_comment_id: parentId
    });
    if (error) throw error;
    qs("#communityCommentBody").value = "";
    qs("#communityParentCommentId").value = "";
    qs("#communityReplyHint").hidden = true;
    const comments = await loadCommunityComments(currentCommunityDetailId);
    renderCommunityComments(comments);
    await loadCommunityPosts(communityPage);
  } catch (error) { showMessage(error.message, "error"); }
});


qs("#openCreateRoomModal")?.addEventListener("click", () => openModal("#createRoomModal"));
qs("#openJoinRoomModal")?.addEventListener("click", () => openModal("#joinRoomModal"));
qs("#openResumeRoomModal")?.addEventListener("click", () => openModal("#resumeRoomModal"));

qs("#logoutButton")?.addEventListener("click", async () => {
  await closeRealtime();
  stopHeartbeat();
  await supabase.auth.signOut();
  location.href = "index.html";
});

qs("#createRoomForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const visibility = qs("#roomVisibility").value;
    const roomPassword = qs("#roomPassword").value.trim();
    if (visibility === "private" && !/^\d{1,8}$/.test(roomPassword)) {
      throw new Error("비공개방 비밀번호는 숫자 1~8자리로 입력하세요.");
    }
    await createRoom({
      scenarioId: qs("#scenarioSelect").value,
      title: qs("#roomTitle").value.trim(),
      maxPlayers: qs("#maxPlayers").value,
      visibility,
      roomPassword
    });
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#joinRoomForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const roomPassword = qs("#joinRoomPassword").value.trim();
    if (roomPassword && !/^\d{1,8}$/.test(roomPassword)) throw new Error("비밀번호는 숫자만 입력하세요.");
    await joinRoomByCode(qs("#inviteCodeInput").value, roomPassword);
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#resumeRoomForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const file = qs("#resumeFileInput").files?.[0];
    if (!file) throw new Error("저장 파일을 선택하세요.");
    const save = await readJsonFile(file);
    if (save.format !== "pollution-exploration-save-v1") throw new Error("지원하지 않는 저장 파일입니다.");
    await createRoom({
      scenarioId: save.scenarioId,
      title: qs("#resumeRoomTitle").value.trim() || `${save.roomTitle || "탐사"} 이어하기`,
      maxPlayers: 3,
      startSectionKey: save.currentSectionKey,
      stateJson: save.stateJson || {},
      visibility: "public",
      roomPassword: ""
    });
  } catch (error) {
    showMessage(error.message, "error");
  }
});


qs("#roomList")?.addEventListener("click", async (event) => {
  const pageButton = event.target.closest("[data-room-page]");
  if (pageButton) {
    roomPage += pageButton.dataset.roomPage === "next" ? 1 : -1;
    renderRoomList();
    return;
  }
  const adminDelete = event.target.closest("[data-admin-delete-room]");
  const button = event.target.closest("[data-join-public-room]");
  try {
    if (adminDelete) {
      const ok = window.confirm("이 탐사방을 관리자 권한으로 삭제할까요? 채팅과 진행 상태도 함께 삭제됩니다.");
      if (!ok) return;
      const { error } = await supabase.rpc("admin_delete_exploration_room", { p_room_id: adminDelete.dataset.adminDeleteRoom });
      if (error) throw error;
      await Promise.all([loadRoomList(), loadMyRooms()]);
      showMessage("관리자 권한으로 탐사방을 삭제했습니다.", "success");
      return;
    }
    if (!button || button.disabled) return;
    await joinPublicRoomById(button.dataset.joinPublicRoom);
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#openCreatePartyModal")?.addEventListener("click", () => openModal("#createPartyModal"));

qs("#createPartyForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { error } = await supabase.rpc("create_exploration_party_post", {
      p_title: qs("#partyTitle").value.trim(),
      p_scenario_id: qs("#partyScenarioSelect").value || null,
      p_play_time: qs("#partyTime").value.trim() || null,
      p_content: qs("#partyContent").value.trim() || null,
      p_recruitment_hours: Number(qs("#partyRecruitmentHours")?.value || 24)
    });
    if (error) throw error;
    closeModal("#createPartyModal");
    qs("#createPartyForm").reset();
    await loadPartyPosts();
    showMessage("익명 모집글을 올렸습니다.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
});


qs("#partyList")?.addEventListener("click", async (event) => {
  const applyButton = event.target.closest("[data-apply-party]");
  const cancelButton = event.target.closest("[data-cancel-party]");
  const editButton = event.target.closest("[data-edit-party]");
  const deleteButton = event.target.closest("[data-delete-party]");
  const roomButton = event.target.closest("[data-party-room]");
  const detailButton = event.target.closest("[data-detail-party]");
  const reportButton = event.target.closest("[data-report-target]");
  try {
    if (reportButton) {
      openReportModal(reportButton.dataset.reportTarget, reportButton.dataset.reportId);
      return;
    }
    if (detailButton) {
      await openPartyDetail(detailButton.dataset.detailParty);
      return;
    }
    if (applyButton) {
      const { error } = await supabase.rpc("apply_exploration_party_post", { p_post_id: applyButton.dataset.applyParty, p_message: null });
      if (error) throw error;
      await loadPartyPosts();
      showMessage("참여 의사를 보냈습니다.", "success");
      return;
    }
    if (cancelButton) {
      const { error } = await supabase.rpc("cancel_exploration_party_application", { p_post_id: cancelButton.dataset.cancelParty });
      if (error) throw error;
      await loadPartyPosts();
      showMessage("참여 의사를 취소했습니다.", "success");
      return;
    }
    if (editButton) {
      const post = partyListCache.find((item) => item.id === editButton.dataset.editParty);
      if (!post) return;
      qs("#editPartyId").value = post.id;
      qs("#editPartyTitle").value = post.title || "";
      qs("#editPartyScenarioSelect").value = post.scenario_id || "";
      qs("#editPartyTime").value = post.play_time || "";
      qs("#editPartyContent").value = post.content || "";
      const hours = post.recruitment_hours || 24;
      if (qs("#editPartyRecruitmentHours")) qs("#editPartyRecruitmentHours").value = String(hours);
      openModal("#editPartyModal");
      return;
    }
    if (deleteButton) {
      const ok = window.confirm("이 익명 모집글을 삭제할까요?");
      if (!ok) return;
      const { error } = await supabase.rpc("delete_exploration_party_post", { p_post_id: deleteButton.dataset.deleteParty });
      if (error) throw error;
      await loadPartyPosts();
      showMessage("모집글을 삭제했습니다.", "success");
      return;
    }
    if (roomButton) {
      const post = partyListCache.find((item) => item.id === roomButton.dataset.partyRoom);
      if (!post) return;
      qs("#partyRoomPostId").value = post.id;
      qs("#partyRoomTitle").value = post.title || "익명 모집 탐사방";
      qs("#partyRoomMaxPlayers").value = String(Math.min(4, Math.max(2, Number(post.applicant_count || 0) + 1)));
      qs("#partyRoomVisibility").value = "private";
      qs("#partyRoomPasswordField").hidden = false;
      openModal("#partyRoomModal");
    }
  } catch (error) {
    showMessage(error.message, "error");
  }
});



qs("#partyCommentForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const postId = qs("#partyCommentPostId").value;
  const body = qs("#partyCommentBody").value.trim();
  if (!postId || !body) return;
  try {
    const { error } = await supabase.rpc("create_exploration_party_comment", { p_post_id: postId, p_body: body });
    if (error) throw error;
    qs("#partyCommentBody").value = "";
    await loadPartyPosts();
    await openPartyDetail(postId);
    showMessage("댓글을 등록했습니다.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#partyCommentList")?.addEventListener("click", async (event) => {
  const toggleButton = event.target.closest("[data-toggle-comments]");
  const deleteButton = event.target.closest("[data-delete-comment]");
  const reportButton = event.target.closest("[data-report-target]");
  if (toggleButton && currentPartyDetailId) {
    currentPartyCommentsExpanded = !currentPartyCommentsExpanded;
    try { renderPartyComments(await loadPartyComments(currentPartyDetailId)); } catch (error) { showMessage(error.message, "error"); }
    return;
  }
  if (reportButton) {
    openReportModal(reportButton.dataset.reportTarget, reportButton.dataset.reportId);
    return;
  }
  if (!deleteButton || !currentPartyDetailId) return;
  const ok = window.confirm("이 댓글을 삭제할까요?");
  if (!ok) return;
  try {
    const { error } = await supabase.rpc("delete_exploration_party_comment", { p_comment_id: deleteButton.dataset.deleteComment });
    if (error) throw error;
    await loadPartyPosts();
    await openPartyDetail(currentPartyDetailId);
    showMessage("댓글을 삭제했습니다.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#editPartyForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { error } = await supabase.rpc("update_exploration_party_post", {
      p_post_id: qs("#editPartyId").value,
      p_title: qs("#editPartyTitle").value.trim(),
      p_scenario_id: qs("#editPartyScenarioSelect").value || null,
      p_play_time: qs("#editPartyTime").value.trim() || null,
      p_content: qs("#editPartyContent").value.trim() || null,
      p_recruitment_hours: Number(qs("#editPartyRecruitmentHours")?.value || 24)
    });
    if (error) throw error;
    closeModal("#editPartyModal");
    await loadPartyPosts();
    showMessage("모집글을 수정했습니다.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#partyRoomForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const visibility = qs("#partyRoomVisibility").value;
    const roomPassword = qs("#partyRoomPassword").value.trim();
    if (visibility === "private" && !/^\d{1,8}$/.test(roomPassword)) {
      throw new Error("비공개방 비밀번호는 숫자 1~8자리로 입력하세요.");
    }
    const { data, error } = await supabase.rpc("create_room_from_exploration_party_post", {
      p_post_id: qs("#partyRoomPostId").value,
      p_title: qs("#partyRoomTitle").value.trim(),
      p_max_players: Number(qs("#partyRoomMaxPlayers").value || 2),
      p_visibility: visibility,
      p_room_password: roomPassword || null
    });
    if (error) throw error;
    closeModal("#partyRoomModal");
    await Promise.all([loadPartyPosts(), loadRoomList(), loadMyRooms()]);
    showMessage(`모집을 완료하고 탐사방을 만들었습니다. 초대코드: ${data?.invite_code || "-"}`, "success");
    await openRoom(data.room_id);
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#partyRoomVisibility")?.addEventListener("change", () => {
  const isPrivate = qs("#partyRoomVisibility").value === "private";
  qs("#partyRoomPasswordField").hidden = !isPrivate;
  qs("#partyRoomPassword").required = isPrivate;
});

qs("#roomVisibility")?.addEventListener("change", () => {
  const isPrivate = qs("#roomVisibility").value === "private";
  qs("#roomPasswordField").hidden = !isPrivate;
  qs("#roomPassword").required = isPrivate;
});

qs("#settingsVisibility")?.addEventListener("change", () => {
  const isPrivate = qs("#settingsVisibility").value === "private";
  qs("#settingsPasswordField").hidden = !isPrivate;
});

["#roomPassword", "#joinRoomPassword", "#settingsRoomPassword", "#partyRoomPassword"].forEach((selector) => {
  qs(selector)?.addEventListener("input", (event) => {
    event.target.value = event.target.value.replace(/\D/g, "");
  });
});

qs("#myRoomsList")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-open-room]");
  if (!button) return;
  try {
    await openRoom(button.dataset.openRoom);
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#copyInviteCode")?.addEventListener("click", async () => {
  if (!currentRoom) return;
  try {
    await navigator.clipboard.writeText(currentRoom.invite_code);
    showMessage("초대코드를 복사했습니다.", "success");
  } catch (_) {
    showMessage(`초대코드: ${currentRoom.invite_code}`, "success");
  }
});

qs("#leaveRoom")?.addEventListener("click", async () => {
  try {
    await leaveCurrentRoom();
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#openRoomSettings")?.addEventListener("click", () => {
  if (!currentRoom) return;
  qs("#settingsRoomTitle").value = currentRoom.title || "";
  qs("#settingsMaxPlayers").value = String(currentRoom.max_players || 2);
  qs("#settingsVisibility").value = currentRoom.visibility || "public";
  qs("#settingsRoomPassword").value = "";
  qs("#settingsPasswordField").hidden = (currentRoom.visibility || "public") !== "private";
  openModal("#roomSettingsModal");
});

qs("#roomSettingsForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const visibility = qs("#settingsVisibility").value;
    const roomPassword = qs("#settingsRoomPassword").value.trim();
    if (visibility === "private" && roomPassword && !/^\d{1,8}$/.test(roomPassword)) {
      throw new Error("비공개방 비밀번호는 숫자 1~8자리로 입력하세요.");
    }
    await updateRoomSettings({
      title: qs("#settingsRoomTitle").value.trim(),
      maxPlayers: qs("#settingsMaxPlayers").value,
      visibility,
      roomPassword
    });
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#downloadSave")?.addEventListener("click", downloadSave);
qs("#downloadChat")?.addEventListener("click", downloadChat);
qs("#clearChat")?.addEventListener("click", clearChat);
qs("#closeRoomExitNotice")?.addEventListener("click", () => {
  qs("#roomExitNoticeModal")?.close();
});

async function enableSoloTestMode() {
  if (!currentRoom || !currentState) return;
  const state = getStateJson();
  const { error } = await supabase.rpc("advance_exploration_room", {
    p_room_id: currentRoom.id,
    p_next_section_key: currentState.current_section_key,
    p_choice_label: "테스트 진행 코드 입력",
    p_state_patch: { soloTestMode: true, soloTestEnabledBy: currentProfile?.id || null }
  });
  if (error) throw error;
  await loadRoomBundle(currentRoom.id, { silent: true });
}

qs("#chatForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = qs("#chatInput");
  const content = input.value.trim();
  if (!content) return;
  input.value = "";
  try {
    if (SOLO_TEST_CODES.has(content.toLowerCase()) || SOLO_TEST_CODES.has(content)) {
      if (currentProfile?.role !== "admin") {
        showMessage("권한이 없습니다.", "error");
        return;
      }
      await enableSoloTestMode();
      showMessage("혼자 테스트 진행을 허용했습니다.", "success");
      return;
    }
    await postChat(content);
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#chatLog")?.addEventListener("click", (event) => {
  const reportButton = event.target.closest("[data-report-target]");
  if (!reportButton) return;
  openReportModal(reportButton.dataset.reportTarget, reportButton.dataset.reportId);
});

qs("#partyDetailBody")?.addEventListener("click", (event) => {
  const reportButton = event.target.closest("[data-report-target]");
  if (!reportButton) return;
  openReportModal(reportButton.dataset.reportTarget, reportButton.dataset.reportId);
});

qs("#reportForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await submitReport({
      targetType: qs("#reportTargetType").value,
      targetId: qs("#reportTargetId").value,
      reason: qs("#reportReason").value,
      detail: qs("#reportDetail").value.trim()
    });
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#refreshAdminReports")?.addEventListener("click", () => loadAdminReports());
qs("#adminReportList")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-review-report]");
  if (!button) return;
  try { await reviewReport(button.dataset.reportId, button.dataset.reviewReport); }
  catch (error) { showMessage(error.message, "error"); }
});

qs("#roomInventoryList")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-room-item]");
  if (!button) return;
  openRoomItemDetail(button.dataset.roomItem);
});



function leaveRoomByPageExit() {
  if (!currentRoom?.id || !currentAccessToken) return;
  const endpoint = `${SUPABASE_URL}/rest/v1/rpc/leave_exploration_room`;
  const payload = JSON.stringify({ p_room_id: currentRoom.id });
  try {
    fetch(endpoint, {
      method: "POST",
      keepalive: true,
      headers: {
        "content-type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "authorization": `Bearer ${currentAccessToken}`
      },
      body: payload
    });
  } catch (_) {
    // 페이지 이탈 시 best-effort 정리라 실패해도 막지 않는다.
  }
}

window.addEventListener("beforeunload", (event) => {
  if (!currentRoom?.id) return;
  event.preventDefault();
  event.returnValue = ROOM_EXIT_NOTICE_TEXT;
});

window.addEventListener("pagehide", () => {
  leaveRoomByPageExit();
});

supabase.auth.onAuthStateChange(async (event, session) => {
  if (event === "SIGNED_OUT" || !session) {
    currentAccessToken = null;
    showLoggedOutView();
    return;
  }
  if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
    try {
      await loadProfile();
      await Promise.all([loadRoomList(), loadPartyPosts(), loadCommunityPosts(), loadMyRooms()]);
    } catch (error) {
      showMessage(error.message, "error");
    }
  }
});

try {
  await loadScenarioList();
  await loadProfile();
  if (currentProfile) {
    showOnAirSplash();
    await Promise.all([loadRoomList(), loadPartyPosts(), loadCommunityPosts(), loadMyRooms()]);
  }
} catch (error) {
  showMessage(error.message, "error");
}
