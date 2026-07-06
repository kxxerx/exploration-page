// exploration-site: v0.2
// 기존 기념품샵의 Supabase Auth/site_id 로그인 구조를 그대로 사용합니다.
import { supabase } from "./supabaseClient.js";
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
let realtimeChannel = null;
let fallbackPollTimer = null;

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
  return data.session;
}

async function loadProfile() {
  const session = await getSession();
  if (!session) {
    currentProfile = null;
    setVisible("#loginPanel", true);
    setVisible("#profilePanel", false);
    setVisible("#lobbyPanel", false);
    setVisible("#roomPanel", false);
    return null;
  }

  setVisible("#loginPanel", false);
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
    setVisible("#loginPanel", true);
    return null;
  }

  currentProfile = profile;
  applyVisitorModeClass(profile);
  if (profile.role === "admin") {
    document.querySelectorAll(".requires-admin").forEach((node) => { node.hidden = false; });
  }
  renderProfile(profile);
  setVisible("#profilePanel", true);
  setVisible("#lobbyPanel", true);
  return profile;
}

function renderProfile(profile) {
  const organization = ORG_LABELS[profile.organization_code] || profile.organization_code || "무소속";
  const department = DEPT_LABELS[profile.department_code] || profile.department_code || "없음";
  const visitor = VISITOR_LABELS[profile.visitor_type] || profile.visitor_type || "일반";
  const affiliation = profile.affiliation_label || `${organization} / ${department}`;
  qs("#profileCard").innerHTML = `
    <div class="profile-mini-grid">
      <p><strong>캐릭터명</strong><br>${safeText(profile.display_name || "익명")}</p>
      <p><strong>밴드 닉네임</strong><br>${safeText(profile.band_nickname || "-")}</p>
      <p><strong>캐릭터 키</strong><br>${safeText(profile.character_key || "-")}</p>
      <p><strong>방문객 상태</strong><br>${safeText(visitor)}</p>
      <p><strong>기관</strong><br>${safeText(organization)}</p>
      <p><strong>팀/부서</strong><br>${safeText(department)}</p>
      <p><strong>표시 소속명</strong><br>${safeText(affiliation)}</p>
      <p><strong>유쾌주화</strong><br>${Number(profile.currency || 0)}</p>
      <p><strong>상태 수치</strong><br>${safeText(metricLabel(profile))}</p>
    </div>
  `;
}

async function loadScenarioList() {
  const response = await fetch(`scenarios/scenario-list.json?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("시나리오 목록을 불러오지 못했습니다.");
  const list = await response.json();
  scenarioList = list.filter((scenario) => scenario.status === "published");
  renderScenarioSelect();
}

function renderScenarioSelect() {
  const select = qs("#scenarioSelect");
  select.innerHTML = "";
  scenarioList.forEach((scenario) => {
    const option = document.createElement("option");
    option.value = scenario.id;
    option.textContent = `${scenario.title}${scenario.version ? ` · v${scenario.version}` : ""}`;
    select.appendChild(option);
  });
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

async function createRoom({ scenarioId, title, maxPlayers, startSectionKey = null, stateJson = {} }) {
  const scenario = await loadScenario(scenarioId);
  const startKey = startSectionKey || scenario.startSection || "intro";
  const { data, error } = await supabase.rpc("create_exploration_room", {
    p_scenario_id: scenarioId,
    p_title: title || `${scenario.title} 탐사방`,
    p_max_players: Number(maxPlayers || 2),
    p_start_section_key: startKey,
    p_state_json: stateJson || {}
  });
  if (error) throw error;
  showMessage(`방을 만들었습니다. 초대코드: ${data.invite_code}`, "success");
  await openRoom(data.room_id);
  await loadMyRooms();
}

async function joinRoomByCode(inviteCode) {
  const { data, error } = await supabase.rpc("join_exploration_room", {
    p_invite_code: inviteCode.trim().toUpperCase()
  });
  if (error) throw error;
  showMessage("탐사방에 입장했습니다.", "success");
  await openRoom(data.room_id);
  await loadMyRooms();
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
    .select("id, scenario_id, title, invite_code, max_players, status, host_user_id, created_at")
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
  await closeRealtime();
  setVisible("#lobbyPanel", false);
  setVisible("#roomPanel", true);
  await loadRoomBundle(roomId);
  setupRealtime(roomId);
}

async function loadRoomBundle(roomId, options = {}) {
  const { silent = false } = options;
  const { data: room, error: roomError } = await supabase
    .from("exploration_rooms")
    .select("id, scenario_id, title, host_user_id, invite_code, max_players, status, created_at, started_at, ended_at")
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
  const context = {
    character_key: member?.character_key_snapshot ?? currentProfile?.character_key,
    organization_code: member?.organization_code_snapshot ?? currentProfile?.organization_code,
    department_code: member?.department_code_snapshot ?? currentProfile?.department_code,
    affiliation_label: member?.affiliation_label_snapshot ?? currentProfile?.affiliation_label,
    visitor_type: member?.visitor_type_snapshot ?? currentProfile?.visitor_type,
    pollution: member?.pollution_snapshot ?? currentProfile?.pollution ?? 0,
    mask_collapse_rate: member?.mask_collapse_rate_snapshot ?? currentProfile?.mask_collapse_rate ?? 0
  };

  return Object.entries(condition).every(([key, expected]) => {
    if (key === "min_pollution") return Number(context.pollution || 0) >= Number(expected);
    if (key === "max_pollution") return Number(context.pollution || 0) <= Number(expected);
    if (key === "min_mask_collapse_rate") return Number(context.mask_collapse_rate || 0) >= Number(expected);
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
  qs("#roomMetaView").textContent = `${scenario.title} · 초대코드 ${currentRoom.invite_code} · ${currentRoom.status} · 최대 ${currentRoom.max_players}명`;
  qs("#scenarioTitle").textContent = `${scenario.title} · ${sectionKey}`;
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
  qs("#storyText").innerHTML = `${safeText(section.commonText || "")}${privateBlocks}`;

  const choices = (section.choices || []).filter((choice) => !choice.requires || conditionMatches(choice.requires));
  if (!choices.length) {
    const ending = section.ending ? `<p class="small muted">엔딩 타입: ${safeText(section.ending.type || "-")}. 자동 정산은 아직 연결하지 않았습니다.</p>` : "";
    qs("#choiceList").innerHTML = `<div class="message">선택지가 없습니다. ${ending}</div>`;
    return;
  }

  qs("#choiceList").innerHTML = choices.map((choice, index) => `
    <button type="button" class="choice-button ${choice.requires ? "private-choice" : ""}" data-choice-index="${index}">
      ${safeText(choice.label)}
      ${choice.note ? `<span class="choice-note">${safeText(choice.note)}</span>` : ""}
    </button>
  `).join("");

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
  box.innerHTML = currentMembers.map((member) => `
    <div class="member-item">
      <strong>${safeText(member.display_name_snapshot || "익명")}</strong>
      <span class="small muted">${safeText(member.affiliation_label_snapshot || "소속 미지정")} · ${safeText(member.role)}</span><br>
      <span class="small muted">${safeText(VISITOR_LABELS[member.visitor_type_snapshot] || member.visitor_type_snapshot || "일반")}</span>
    </div>
  `).join("");
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
      <div class="chat-line${systemClass}">
        <span class="meta">${safeText(sender)} · ${formatDate(message.created_at)}</span>
        ${safeText(message.content || "")}
      </div>
    `;
  }).join("");
  box.scrollTop = box.scrollHeight;
}

async function chooseNext(choice) {
  if (!choice?.next || !currentRoom) return;
  const { error } = await supabase.rpc("advance_exploration_room", {
    p_room_id: currentRoom.id,
    p_next_section_key: choice.next,
    p_choice_label: choice.label || null,
    p_state_patch: choice.setState || {}
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

async function clearChat() {
  if (!currentRoom) return;
  const ok = window.confirm("현재 방 채팅 로그를 DB에서 삭제할까요? 다운로드하지 않은 로그는 사라집니다. 인간은 왜 항상 중요한 걸 지우고 후회하는가.");
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
  await loadMyRooms();
});

qs("#refreshProfile")?.addEventListener("click", async () => {
  try {
    await loadProfile();
    showMessage("현재 탐사자 정보를 다시 불러왔습니다.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#refreshLobby")?.addEventListener("click", async () => {
  await loadMyRooms();
});

qs("#logoutButton")?.addEventListener("click", async () => {
  await closeRealtime();
  await supabase.auth.signOut();
  location.href = "index.html";
});

qs("#createRoomForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await createRoom({
      scenarioId: qs("#scenarioSelect").value,
      title: qs("#roomTitle").value.trim(),
      maxPlayers: qs("#maxPlayers").value
    });
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#joinRoomForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await joinRoomByCode(qs("#inviteCodeInput").value);
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
      stateJson: save.stateJson || {}
    });
  } catch (error) {
    showMessage(error.message, "error");
  }
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
  await closeRealtime();
  currentRoom = null;
  currentMembers = [];
  currentState = null;
  currentMessages = [];
  setVisible("#roomPanel", false);
  setVisible("#lobbyPanel", true);
  await loadMyRooms();
});

qs("#downloadSave")?.addEventListener("click", downloadSave);
qs("#downloadChat")?.addEventListener("click", downloadChat);
qs("#clearChat")?.addEventListener("click", clearChat);

qs("#chatForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = qs("#chatInput");
  const content = input.value.trim();
  if (!content) return;
  input.value = "";
  try {
    await postChat(content);
  } catch (error) {
    showMessage(error.message, "error");
  }
});

try {
  await loadScenarioList();
  await loadProfile();
  if (currentProfile) await loadMyRooms();
} catch (error) {
  showMessage(error.message, "error");
}
