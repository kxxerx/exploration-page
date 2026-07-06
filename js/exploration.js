// exploration-site: v1.1 inventory conditions solo-test
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
let currentAccessToken = null;
const SOLO_TEST_CODES = new Set(["/테스트 재난001", "/테스트 재난 001", "/test disaster001", "/test disaster-001"]);

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
  const basePollution = Number(member?.pollution_snapshot ?? currentProfile?.pollution ?? 0);
  const baseMask = Number(member?.mask_collapse_rate_snapshot ?? currentProfile?.mask_collapse_rate ?? 0);
  return {
    pollution: Number(saved?.pollution ?? basePollution),
    mask_collapse_rate: Number(saved?.mask_collapse_rate ?? baseMask)
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
  let level = "낮음";
  if (pct >= 70) level = "위험";
  else if (pct >= 40) level = "주의";
  return `<div class="metric-bar ${variant}" title="${level}"><span style="width:${pct}%"></span></div><span class="metric-state">${level}</span>`;
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
      logs.push(delta >= 0 ? "오염 반응이 상승했습니다." : "오염 반응이 가라앉았습니다.");
    }
    if (effect.type === "mask_collapse") {
      const delta = Number(effect.amount || 0);
      myMetric.mask_collapse_rate = clampMetric(Number(myMetric.mask_collapse_rate || 0) + delta);
      logs.push("동기화 반응이 변했습니다.");
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
  setVisible("#loginPanel", true);
  setVisible("#profilePanel", false);
  setVisible("#appPanel", false);
  setVisible("#roomPanel", false);
  setVisible("#mainNav", false);
}

function showLoggedInLounge() {
  document.body.classList.remove("in-room");
  setVisible("#loginPanel", false);
  setVisible("#appPanel", true);
  setVisible("#mainNav", true);
  setVisible("#profilePanel", true);
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

  currentProfile = profile;
  applyVisitorModeClass(profile);
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
  box.innerHTML = roomListCache.map((room) => {
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
    const isClosed = post.status === "closed";
    const hasApplied = !!post.has_applied;
    const count = Number(post.applicant_count || 0);
    const comments = Number(post.comment_count || 0);
    const statusBadge = isClosed
      ? `<span class="badge full">모집 완료</span>`
      : `<span class="badge public">모집 중</span>`;
    const ownerButtons = isCreator ? `
      <button type="button" class="ghost-button" data-edit-party="${safeAttr(post.id)}" ${isClosed ? "disabled" : ""}>수정</button>
      <button type="button" class="ghost-button danger" data-delete-party="${safeAttr(post.id)}">삭제</button>
      <button type="button" class="secondary-action" data-party-room="${safeAttr(post.id)}" ${isClosed ? "disabled" : ""}>방 만들기</button>
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
        <div class="party-item-meta">${safeText(scenario?.title || post.scenario_id || "시나리오 미정")} · ${safeText(post.play_time || "시간 미정")} · 신청 ${count}명 · 댓글 ${comments}개</div>
        <p class="party-item-content">${safeText(post.content || "내용 없음")}</p>
        <footer class="party-actions">
          <button type="button" class="ghost-button" data-detail-party="${safeAttr(post.id)}">자세히 보기</button>
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
    <div class="room-meta">${safeText(scenario?.title || post.scenario_id || "시나리오 미정")} · ${safeText(post.play_time || "시간 미정")} · 신청 ${count}명 · 댓글 ${comments}개</div>
    <div class="party-detail-content">${safeText(post.content || "내용 없음")}</div>
    ${isClosed ? `<p class="small muted">모집 완료된 글입니다. 완료 후 2일이 지나면 목록 정리 시 삭제됩니다.</p>` : ""}
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
  box.innerHTML = comments.map((comment) => `
    <article class="comment-item">
      <div class="comment-head">
        <strong>${safeText(comment.anonymous_label || "익명 탐사자")}</strong>
        <span>${formatDate(comment.created_at)}</span>
      </div>
      <p>${safeText(comment.body || "")}</p>
      ${comment.is_mine ? `<button type="button" class="mini-button danger" data-delete-comment="${safeAttr(comment.id)}">댓글 삭제</button>` : ""}
    </article>
  `).join("");
}

async function openPartyDetail(postId) {
  const post = partyListCache.find((item) => item.id === postId);
  if (!post) return;
  currentPartyDetailId = postId;
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

  const choices = (section.choices || []).filter((choice) => !choice.requires || conditionMatches(choice.requires));
  const soloBlocked = isSoloBlocked();
  if (!choices.length) {
    const ending = section.ending ? `<p class="small muted">엔딩 타입: ${safeText(section.ending.type || "-")}. 자동 정산은 아직 연결하지 않았습니다.</p>` : "";
    qs("#choiceList").innerHTML = `<div class="message">선택지가 없습니다. ${ending}</div>`;
    return;
  }

  qs("#choiceList").innerHTML = `
    ${soloBlocked ? `<div class="message subtle">혼자서는 진행할 수 없습니다. 테스트가 필요하면 대화창에 <strong>/테스트 재난001</strong> 을 입력하세요.</div>` : ""}
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
          <span>${isEntity ? "동기화" : "오염"}</span>
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
      </div>
    `;
  }).join("");
  box.scrollTop = box.scrollHeight;
}

async function chooseNext(choice) {
  if (!choice?.next || !currentRoom) return;
  if (isSoloBlocked()) {
    showMessage("혼자서는 진행할 수 없습니다. 테스트가 필요하면 대화창에 /테스트 재난001 을 입력하세요.", "error");
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
  const ok = window.confirm("정말 나가시겠습니까? 파일을 따로 저장하지 않으면 진행 정보는 초기화됩니다. 마지막 참가자가 나가면 탐사방은 삭제됩니다.");
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
  if (target === "mine") loadMyRooms();
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
  await Promise.all([loadRoomList(), loadPartyPosts(), loadMyRooms()]);
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
      p_content: qs("#partyContent").value.trim() || null
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
  try {
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
  const deleteButton = event.target.closest("[data-delete-comment]");
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
      p_content: qs("#editPartyContent").value.trim() || null
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
      await enableSoloTestMode();
      showMessage("혼자 테스트 진행을 허용했습니다.", "success");
      return;
    }
    await postChat(content);
  } catch (error) {
    showMessage(error.message, "error");
  }
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
  event.returnValue = "이 페이지를 벗어나면 탐사방에서 나가며, 마지막 참가자라면 방이 삭제될 수 있습니다. 저장파일을 먼저 내려받으세요.";
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
      await Promise.all([loadRoomList(), loadPartyPosts(), loadMyRooms()]);
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
    await Promise.all([loadRoomList(), loadPartyPosts(), loadMyRooms()]);
  }
} catch (error) {
  showMessage(error.message, "error");
}
