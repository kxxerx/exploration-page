// exploration-site: v1.17.23 persistent-vip-card-flags
// 기존 기념품샵의 Supabase Auth/site_id 로그인 구조를 그대로 사용합니다.
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabaseClient.js";
import { qs, showMessage, authEmailFromLoginId, revealMemberLinks, applyVisitorModeClass } from "./common.js";

try {
  await revealMemberLinks();
} catch (error) {
  console.warn("초기 세션 링크 확인 실패", error);
}

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

function communityOrgOnlyLabel(row = {}) {
  const raw = String(row.organization_label || row.affiliation_label || "").trim();
  const code = row.organization_code;
  if (raw.includes("■■")) return "■■";
  if (code && ORG_LABELS[code]) {
    return code === "entity" ? "■■" : ORG_LABELS[code];
  }
  if (raw.includes("초자연 재난관리국")) return "초자연 재난관리국";
  if (raw.includes("백일몽 주식회사")) return "백일몽 주식회사";
  if (raw.includes("괴이")) return "■■";
  if (raw.includes("무소속")) return "무소속";
  if (raw.includes("기타")) return "기타";
  return raw || "소속 미상";
}

let currentProfile = null;
let scenarioList = [];
let scenarioCache = new Map();
let currentRoom = null;
let currentMembers = [];
let currentState = null;
let currentMessages = [];
let chatUserPinnedToBottom = true;
let lastRenderedMessageLastId = null;
let renderedChoices = [];
let choiceClickInProgress = false;
let currentInventory = [];
let roomListCache = [];
let partyListCache = [];
let partyPage = 1;
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
let notificationMode = "party";
let notificationPage = 1;
const ROOM_PAGE_SIZE = 10;
const PARTY_PAGE_SIZE = 10;
const COMMUNITY_PAGE_SIZE = 10;
const COMMENT_PREVIEW_LIMIT = 5;
let currentAccessToken = null;
const SOLO_TEST_CODES = new Set(["/테스트 재난001", "/테스트 재난 001", "/test disaster001", "/test disaster-001"]);
const ROOM_EXIT_NOTICE_TEXT = "라이브 룸에서 나가시겠습니까? 진행 내역을 보존하려면 파일을 내려받는 것을 권장합니다. 마지막 참가자가 나가면 방이 영구적으로 삭제될 수 있습니다.";
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


function getLastHangulSyllable(value) {
  const chars = Array.from(String(value || '').trim()).reverse();
  return chars.find((char) => {
    const code = char.charCodeAt(0);
    return code >= 0xac00 && code <= 0xd7a3;
  }) || '';
}

function hasFinalConsonant(value) {
  const last = getLastHangulSyllable(value);
  if (!last) return false;
  return ((last.charCodeAt(0) - 0xac00) % 28) !== 0;
}

function josa(value, withBatchim, withoutBatchim) {
  return hasFinalConsonant(value) ? withBatchim : withoutBatchim;
}

function withJosa(value, withBatchim, withoutBatchim) {
  const text = String(value ?? '');
  return `${text}${josa(text, withBatchim, withoutBatchim)}`;
}

function formatKoreanParticles(value) {
  return String(value ?? '')
    .replace(/([^\s\"'“”‘’()\[\]{}<>:;,.!?]+)이\(가\)/g, (_, word) => withJosa(word, '이', '가'))
    .replace(/([^\s\"'“”‘’()\[\]{}<>:;,.!?]+)을\(를\)/g, (_, word) => withJosa(word, '을', '를'));
}

function getActorDisplayName(name) {
  const base = String(name || currentProfile?.display_name || getMyMemberSnapshot()?.display_name_snapshot || "탐사자").trim() || "탐사자";
  return base.endsWith("님") ? base : `${base}님`;
}

function normalizeSystemMessageTemplate(template = "") {
  let text = String(template || "").trim();
  text = text.replace(/마스코트 골든/g, "마스코트 골튼").replace(/골든 리조트/g, "골튼 리조트");
  text = text.replace(/\{actor\}이\s*다음과 같이 행동했습니다\.\s*:\s*\[?낡고 이상한 동전\]?을\(를\)\s*획득한다\.?/g, "{actor}이 낡고 이상한 동전을 주웠습니다.");
  text = text.replace(/\{actor\}이\s*다음과 같이 행동했습니다\.\s*:\s*\[?([^\]\n]+)\]?을\(를\)\s*획득한다\.?/g, "{actor}이 $1을(를) 얻었습니다.");
  text = text.replace(/\{actor\}이\s*다음과 같이 행동했습니다\.\s*:\s*(.+?)\s*$/g, "{actor}이 $1");
  return text;
}

function formatSystemMessageTemplate(template, actorName) {
  const content = formatKoreanParticles(normalizeSystemMessageTemplate(template).replaceAll("{actor}", getActorDisplayName(actorName)));
  return normalizeDisplayedSystemMessage(content);
}


function stripChoiceMetaLabel(label = "") {
  return String(label || "")
    .replace(/\[[^\]]+\s*전용\]\s*/g, "")
    .replace(/^\s*\[[^\]]+\]\s*/g, "")
    .replace(/[.。\s]+$/g, "")
    .trim();
}

function naturalizeChoiceAction(label = "") {
  let text = stripChoiceMetaLabel(label)
    .replace(/마스코트 골든/g, "마스코트 골튼")
    .replace(/골든 리조트/g, "골튼 리조트")
    .trim();
  if (!text) return "행동했습니다.";
  const compact = text.replace(/\s+/g, "");
  if (compact === "테스트진행코드입력") return "테스트 진행 코드를 입력했습니다.";
  if (compact === "녹슨입간판걷어차기" || compact === "녹슨입간판을걷어찬다") return "녹슨 입간판을 걷어찼습니다.";
  if (compact === "쓰레기수거함을뒤진다" || compact === "쓰레기통을뒤진다") return "쓰레기 수거함을 뒤졌습니다.";
  if (compact === "쓰레기통을걷어찬다") return "쓰레기통을 걷어찼습니다.";

  let match = text.match(/^\[?(.+?)\]?을\(를\)\s*획득한다$/);
  if (match) return formatKoreanParticles(`${match[1]}을(를) 얻었습니다.`);
  match = text.match(/^\[?(.+?)\]?을\(를\)\s*주운다$/);
  if (match) return formatKoreanParticles(`${match[1]}을(를) 주웠습니다.`);

  if (/을\s*산다$/.test(text)) return text.replace(/을\s*산다$/, "을 샀습니다.");
  if (/를\s*산다$/.test(text)) return text.replace(/를\s*산다$/, "를 샀습니다.");
  if (/으로\s*향한다$/.test(text)) return text.replace(/으로\s*향한다$/, "으로 향했습니다.");
  if (/로\s*향한다$/.test(text)) return text.replace(/로\s*향한다$/, "로 향했습니다.");
  if (/으로\s*들어간다$/.test(text)) return text.replace(/으로\s*들어간다$/, "으로 들어갔습니다.");
  if (/로\s*들어간다$/.test(text)) return text.replace(/로\s*들어간다$/, "로 들어갔습니다.");
  if (/으로\s*진입한다$/.test(text)) return text.replace(/으로\s*진입한다$/, "으로 진입했습니다.");
  if (/로\s*진입한다$/.test(text)) return text.replace(/로\s*진입한다$/, "로 진입했습니다.");
  if (/사용한다$/.test(text)) return text.replace(/사용한다$/, "사용했습니다.");
  if (/도망간다$/.test(text)) return text.replace(/도망간다$/, "도망쳤습니다.");
  if (/시도한다$/.test(text)) return text.replace(/시도한다$/, "시도했습니다.");
  if (/살핀다$/.test(text)) return text.replace(/살핀다$/, "살폈습니다.");
  if (/뒤진다$/.test(text)) return text.replace(/뒤진다$/, "뒤졌습니다.");
  if (/걷어찬다$/.test(text)) return text.replace(/걷어찬다$/, "걷어찼습니다.");
  if (/획득한다$/.test(text)) return text.replace(/획득한다$/, "얻었습니다.");
  if (/한다$/.test(text)) return text.replace(/한다$/, "했습니다.");
  return /[.!?]$/.test(text) ? text : `${text}했습니다.`;
}

function normalizeActorHonorific(actor = "") {
  const base = String(actor || "")
    .trim()
    .replace(/\s+님$/g, "")
    .replace(/님$/g, "")
    .trim();
  return base ? `${base}님` : "탐사자님";
}

function normalizeKnownMemberHonorifics(content = "") {
  let text = String(content || "");
  const names = [
    ...(Array.isArray(currentMembers) ? currentMembers.map((member) => member.display_name_snapshot) : []),
    currentProfile?.display_name,
    getMyMemberSnapshot()?.display_name_snapshot
  ]
    .filter(Boolean)
    .map((name) => String(name).trim().replace(/\s+님$/g, "").replace(/님$/g, ""))
    .filter((name, index, arr) => name && arr.indexOf(name) === index)
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`^${escaped}\\s*(?:님)?\\s*[이가]\\s+`), `${name}님이 `);
  }
  return text.replace(/(.+?)\s+님이/g, "$1님이");
}

function normalizeDisplayedSystemMessage(content = "") {
  let text = String(content || "")
    .replace(/마스코트 골든/g, "마스코트 골튼")
    .replace(/골든 리조트/g, "골튼 리조트")
    .trim();
  let match = text.match(/^(.+?)(?:\s*님)?\s*[이가]\s*선택했습니다\s*\.?\s*[:：]\s*(.+)$/);
  if (match) return formatKoreanParticles(`${normalizeActorHonorific(match[1])}이 ${naturalizeChoiceAction(match[2])}`);
  match = text.match(/^(.+?)(?:\s*님)?\s*[이가]\s*다음과 같이 행동했습니다\s*\.?\s*[:：]\s*(.+)$/);
  if (match) return formatKoreanParticles(`${normalizeActorHonorific(match[1])}이 ${naturalizeChoiceAction(match[2])}`);
  match = text.match(/^(.+?)(?:\s*님)?\s*[이가]\s*아래의 행동을 제안했습니다\s*\.?\s*[:：]\s*(.+)$/);
  if (match) return formatKoreanParticles(`${normalizeActorHonorific(match[1])}이 ${naturalizeChoiceAction(match[2])}`);
  match = text.match(/^모든 참가자가 제안을 수락했습니다\s*[:：]\s*(.+)$/);
  if (match) return formatKoreanParticles(`모든 참가자가 ${naturalizeChoiceAction(match[1]).replace(/했습니다\.$/, "하기로 했습니다.")}`);
  match = text.match(/^(.+?)(?:\s*님)?\s*[이가]\s+(.+(?:한다|간다|산다|입력|걷어차기|획득한다))\.?$/);
  if (match) return formatKoreanParticles(`${normalizeActorHonorific(match[1])}이 ${naturalizeChoiceAction(match[2])}`);
  text = normalizeKnownMemberHonorifics(text);
  match = text.match(/^(.+?)(?:\s*님)?\s*[이가]\s+(.+(?:했습니다|했습니다\.|했습니다|했습니다|했습니다|했습니다|했습니다|입장했습니다|퇴장했습니다|수락했습니다|거절했습니다|제안했습니다|주웠습니다|얻었습니다|샀습니다|들어갔습니다|향했습니다|도망쳤습니다|진입했습니다|사용했습니다|안내됩니다|따라갔습니다|따라가지 않기로 했습니다)\.?)$/);
  if (match) {
    const actor = String(match[1] || "").trim();
    const action = String(match[2] || "").trim();
    if (actor && !/^(모든 참가자|전체 참가자|시스템|관리자|방장|누군가)$/.test(actor)) {
      text = `${normalizeActorHonorific(actor)}이 ${action}`;
    }
  }
  // v1.17.28: last-mile honorific cleanup. If any remaining system/popup line starts with
  // "이름이/이름가 + action", force it to "이름님이 + action" unless it is a collective/system actor.
  match = text.match(/^(.+?)(?:\s*님)?\s*[이가]\s+(.+)$/);
  if (match) {
    const actor = String(match[1] || "").trim();
    const action = String(match[2] || "").trim();
    const looksLikeAction = /(했습니다|했습니다\.|합니다|했습니다|했습니다|했습니다|했습니다|했습니다|했습니다|했습니다|주웠습니다|얻었습니다|샀습니다|들어갔습니다|향했습니다|도망쳤습니다|진입했습니다|사용했습니다|수락했습니다|거절했습니다|퇴장했습니다|입장했습니다|안내됩니다|반응했습니다|따라갔습니다|따라가지 않기로 했습니다|진행을 제안했습니다)\.?$/.test(action);
    if (actor && looksLikeAction && !/^(모든 참가자|전체 참가자|시스템|관리자|방장|누군가)$/.test(actor)) {
      text = `${normalizeActorHonorific(actor)}이 ${action}`;
    }
  }
  return formatKoreanParticles(text);
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

function formatDateLong(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("ko-KR", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatDateOnlyLong(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
}

function formatDateTimeLocal(date) {
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateInput(date) {
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseLocalDateValue(value) {
  if (!value) return null;
  const parts = String(value).split("-").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const date = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseRecruitmentStartValue(value) {
  return parseLocalDateValue(value) || parseLocalDateTimeValue(value);
}

function parseLocalDateTimeValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addMonths(date, amount) {
  const next = new Date(date.getTime());
  const originalDay = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + Number(amount || 0));
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(originalDay, lastDay));
  return next;
}

function endOfDayAfterDays(startDate, days) {
  const base = startDate instanceof Date && !Number.isNaN(startDate.getTime()) ? startDate : new Date();
  const span = Math.min(7, Math.max(1, Number(days || 7)));
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + span, 23, 59, 0, 0);
}

// 모듈 스코프 밖에서 남아 있는 구형 이벤트가 호출해도 죽지 않게 전역에 노출한다.
globalThis.endOfDayAfterDays = endOfDayAfterDays;

function shiftDateTimeInput(inputId, months) {
  const input = qs(`#${inputId}`);
  if (!input) return;
  const base = parseLocalDateTimeValue(input.value) || new Date();
  input.value = formatDateTimeLocal(addMonths(base, months));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function remainingPeriodText(startValue, deadlineValue) {
  const now = Date.now();
  const start = new Date(startValue || 0).getTime();
  const deadline = new Date(deadlineValue || 0).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(deadline)) return "기간 확인 불가";
  if (now < start) return `${remainingTimeText(startValue)} 후 시작`;
  return remainingTimeText(deadlineValue);
}

function getPartyComputedStatus(post) {
  const now = Date.now();
  const start = new Date(post.recruitment_start_at || post.created_at || 0).getTime();
  const deadline = new Date(post.recruitment_deadline || 0).getTime();
  const count = Number(post.applicant_count || 0);
  const capacity = Number(post.recruitment_capacity || 0);
  const complete = !!post.room_id || (capacity > 0 && count >= capacity);
  if (complete) return { key: "complete", label: "모집 완료", closed: true, badgeClass: "full" };
  if (Number.isFinite(deadline) && deadline <= now) return { key: "ended", label: "모집 종료", closed: true, badgeClass: "full" };
  if (post.status === "closed") return { key: "complete", label: "모집 완료", closed: true, badgeClass: "full" };
  if (Number.isFinite(start) && start > now) return { key: "scheduled", label: "모집 예정", closed: true, badgeClass: "private" };
  return { key: "open", label: "모집 중", closed: false, badgeClass: "public" };
}

function remainingTimeText(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "남은 시간 확인 불가";
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return "마감됨";
  const totalMinutes = Math.ceil(diff / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}일`);
  if (hours) parts.push(`${hours}시간`);
  if (!days && minutes) parts.push(`${minutes}분`);
  return `${parts.join(" ") || "1분 미만"} 남음`;
}

function getPartyScheduleHtml(post) {
  const recruitmentStart = post.recruitment_start_at || post.created_at;
  const startText = formatDateOnlyLong(recruitmentStart);
  const deadline = formatDateOnlyLong(post.recruitment_deadline);
  const remaining = post.recruitment_deadline ? remainingPeriodText(recruitmentStart, post.recruitment_deadline) : "남은 시간 확인 불가";
  const explorationStart = post.exploration_starts_at || null;
  const playText = explorationStart ? `${formatDateLong(explorationStart)}부터` : (post.play_time || "미정");
  return `
    <dl class="party-schedule">
      <div><dt>모집 기간</dt><dd>${safeText(startText)} ~ ${safeText(deadline)} <span class="party-remaining">(${safeText(remaining)})</span></dd></div>
      <div><dt>탐사 일자</dt><dd>${safeText(playText)}</dd></div>
    </dl>`;
}

function getDurationInput(prefix = "party") {
  return qs(`#${prefix}RecruitmentDurationDays`);
}

function computeDeadlineFromDuration(prefix = "party") {
  const start = parseRecruitmentStartValue(qs(`#${prefix}RecruitmentStartAt`)?.value) || new Date();
  const duration = Math.min(7, Math.max(1, Number(getDurationInput(prefix)?.value || 7)));
  return endOfDayAfterDays(start, duration);
}

function setupPartyDateInputs(prefix = "party", post = null) {
  const startInput = qs(`#${prefix}RecruitmentStartAt`);
  const deadlineInput = qs(`#${prefix}RecruitmentDeadline`);
  const playInput = qs(`#${prefix}PlayStartAt`);
  const durationInput = getDurationInput(prefix);
  const capacityInput = qs(`#${prefix}RecruitmentCapacity`);
  const now = new Date();
  const defaultStart = post?.recruitment_start_at ? new Date(post.recruitment_start_at) : now;
  const defaultDeadline = post?.recruitment_deadline ? new Date(post.recruitment_deadline) : endOfDayAfterDays(defaultStart, 7);
  const startDay = new Date(defaultStart.getFullYear(), defaultStart.getMonth(), defaultStart.getDate()).getTime();
  const deadlineDay = new Date(defaultDeadline.getFullYear(), defaultDeadline.getMonth(), defaultDeadline.getDate()).getTime();
  const inferredDuration = Math.min(7, Math.max(1, Math.round((deadlineDay - startDay) / 86400000) || 7));
  const normalizedDeadline = endOfDayAfterDays(defaultStart, inferredDuration);
  const defaultPlay = post?.exploration_starts_at ? new Date(post.exploration_starts_at) : new Date(normalizedDeadline.getTime() + 60 * 60 * 1000);
  if (startInput) {
    startInput.removeAttribute("min");
    startInput.removeAttribute("max");
    startInput.value = formatDateInput(defaultStart);
    startInput.dataset.lastValue = startInput.value;
  }
  if (durationInput) durationInput.value = String(inferredDuration);
  if (deadlineInput) {
    deadlineInput.value = formatDateTimeLocal(normalizedDeadline);
  }
  if (playInput) {
    playInput.removeAttribute("min");
    playInput.removeAttribute("max");
    playInput.step = "60";
    playInput.value = formatDateTimeLocal(defaultPlay);
  }
  if (capacityInput) {
    capacityInput.value = String(Math.min(3, Math.max(2, Number(post?.recruitment_capacity || 2))));
  }
}

function syncPartyDateLimits(prefix = "party", changedField = "") {
  const startInput = qs(`#${prefix}RecruitmentStartAt`);
  const deadlineInput = qs(`#${prefix}RecruitmentDeadline`);
  const playInput = qs(`#${prefix}PlayStartAt`);
  if (!deadlineInput) return;
  deadlineInput.value = formatDateTimeLocal(computeDeadlineFromDuration(prefix));
  if (startInput) startInput.dataset.lastValue = startInput.value;
  // 탐사 일자는 사용자가 정한 값을 유지한다. 비어 있을 때만 기본값을 채운다.
  if (playInput && !playInput.value) {
    playInput.value = formatDateTimeLocal(new Date(computeDeadlineFromDuration(prefix).getTime() + 60 * 60 * 1000));
  }
}

function validatePartyDateInputs(prefix = "party") {
  const recruitmentStart = parseRecruitmentStartValue(qs(`#${prefix}RecruitmentStartAt`)?.value);
  const deadline = computeDeadlineFromDuration(prefix);
  const playStart = parseLocalDateTimeValue(qs(`#${prefix}PlayStartAt`)?.value);
  const capacity = Number(qs(`#${prefix}RecruitmentCapacity`)?.value || 2);
  if (!recruitmentStart) throw new Error("모집 시작 일자를 입력하세요.");
  if (!deadline) throw new Error("모집 기간을 선택하세요.");
  if (!playStart) throw new Error("탐사 일자를 입력하세요.");
  const duration = Number(getDurationInput(prefix)?.value || 7);
  if (!Number.isInteger(duration) || duration < 1 || duration > 7) throw new Error("모집 기간은 1~7일 중에서 선택하세요.");
  if (!Number.isInteger(capacity) || capacity < 2 || capacity > 3) throw new Error("모집 인원은 2~3명만 지정할 수 있습니다.");
  return { recruitmentStartIso: recruitmentStart.toISOString(), deadlineIso: deadline.toISOString(), startIso: playStart.toISOString(), capacity };
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

function getMyUserId() {
  return currentProfile?.id ? String(currentProfile.id) : "";
}

function getMemberInventoriesMap() {
  const inv = getStateJson().memberInventories || {};
  return inv && typeof inv === "object" ? inv : {};
}

function getMyScenarioInventoryMap() {
  const userId = getMyUserId();
  const all = getMemberInventoriesMap();
  const mine = userId ? all[userId] : null;
  return mine && typeof mine === "object" ? mine : {};
}

function getSharedScenarioInventoryMap() {
  const room = getRoomInventoryMap();
  return Object.fromEntries(Object.entries(room).filter(([, item]) => item?.shared === true || item?.scope === "room"));
}

function getCombinedScenarioInventoryMap() {
  return { ...getSharedScenarioInventoryMap(), ...getMyScenarioInventoryMap() };
}

function getMemberChoiceFlagsMap() {
  const flags = getStateJson().memberChoiceFlags || {};
  return flags && typeof flags === "object" ? flags : {};
}

function getMyChoiceFlagsMap() {
  const userId = getMyUserId();
  const all = getMemberChoiceFlagsMap();
  const mine = userId ? all[userId] : null;
  return mine && typeof mine === "object" ? mine : {};
}

function getChoiceFlagKeys(choice = {}) {
  const flags = choice?.setState?.flags;
  if (!flags || typeof flags !== "object") return [];
  return Object.keys(flags).filter((key) => flags[key] === true);
}

function isPersonalInstantChoice(choice = {}, sectionKey = "") {
  const sameSection = !!choice?.next && String(choice.next) === String(sectionKey || currentState?.current_section_key || "");
  const hasFlag = getChoiceFlagKeys(choice).length > 0;
  const hasItemEffect = (choice.effects || []).some((effect) => effect?.type === "add_item");
  // noConsensus는 "합의 없이 바로 섹션 이동"이라는 뜻이지, "섹션 이동 없는 즉시 선택지"가 아니다.
  // 이전 버전에서 noConsensus를 instant처럼 취급해서 s5_2 -> s5_2_a 이동이 씹혔다.
  return !!(choice.instant || (sameSection && (hasFlag || hasItemEffect)));
}

function isGlobalInstantChoice(choice = {}) {
  return choice.onceScope === "room" || choice.globalOnce === true || choice.sharedOnce === true;
}

function isChoiceDynamicallyDisabled(choice = {}) {
  if (choice.disabled) return true;
  if (choice.disabledWhen && conditionMatches(choice.disabledWhen)) return true;
  return false;
}

function getChoiceDisabledReason(choice = {}) {
  if (choice.disabledReason) return choice.disabledReason;
  if (choice.disabledWhen && conditionMatches(choice.disabledWhen)) return "이미 선택할 수 없는 상태입니다.";
  return "아직 선택할 수 없습니다.";
}

function isChoiceAlreadyTakenByMe(choice = {}) {
  if (isGlobalInstantChoice(choice)) return false;
  const myFlags = getMyChoiceFlagsMap();
  return getChoiceFlagKeys(choice).some((key) => !!myFlags[key]);
}

function choiceConditionMatches(choice = {}, sectionKey = "") {
  if (!isPersonalInstantChoice(choice, sectionKey)) {
    return !choice.requires || conditionMatches(choice.requires);
  }
  if (isGlobalInstantChoice(choice)) {
    return !choice.requires || conditionMatches(choice.requires);
  }
  if (isChoiceAlreadyTakenByMe(choice) && !choice.showWhenTaken) return false;
  const requires = { ...(choice.requires || {}) };
  delete requires.not_state_flag;
  delete requires.not_state_flags;
  return conditionMatches(requires);
}

function getCurrentMemberOrganizationCode() {
  const member = getMyMemberSnapshot();
  return String(member?.organization_code_snapshot || currentProfile?.organization_code || "").toLowerCase();
}

function isPersonalDefaultItemVisible(itemId) {
  const id = normalizeItemId(itemId);
  const org = getCurrentMemberOrganizationCode();
  const personalDefaults = {
    disaster_agency: new Set(["glass_pistol", "obang_compass"]),
    baekildream: new Set(["dream_collector"])
  };
  const isDefaultEquipment = Object.values(personalDefaults).some((set) => set.has(id));
  if (!isDefaultEquipment) return true;
  return personalDefaults[org]?.has(id) || false;
}

function getShopItemId(row) {
  return normalizeItemId(row?.items?.id || row?.item_id || row?.id);
}

function getShopItemName(row) {
  return row?.items?.name || row?.name || "상점 아이템";
}

function getShopItemCategory(row) {
  const item = row?.items || {};
  return String(item.category || row?.category || "").toLowerCase();
}

function isShopInventoryRowVisible(row) {
  const category = getShopItemCategory(row);
  const visitorType = String(currentProfile?.visitor_type || "human").toLowerCase();
  const isEntity = visitorType === "entity" || String(currentProfile?.organization_code || "").toLowerCase() === "entity";
  return isEntity ? category === "special" : category === "cleanse";
}

function getVisibleShopInventory() {
  return (currentInventory || []).filter((row) => Number(row.quantity || 0) > 0 && isShopInventoryRowVisible(row));
}

function getShopItemMeta(itemId) {
  const rawId = String(itemId || "").replace(/^shop:/, "");
  const row = getVisibleShopInventory().find((entry) => getShopItemId(entry) === rawId);
  if (!row) return null;
  return {
    id: rawId,
    name: getShopItemName(row),
    type: "shop",
    detail: row?.items?.description || "상점에서 구입한 소지품입니다. 탐사 중 사용할 수 있는지는 진행 조건과 방 설정에 따라 달라집니다.",
    quantity: Number(row.quantity || 0)
  };
}

function hasShopItem(itemId) {
  const id = normalizeItemId(String(itemId || "").replace(/^shop:/, ""));
  return !!id && getVisibleShopInventory().some((row) => getShopItemId(row) === id);
}

function hasRoomItem(itemId) {
  const id = normalizeItemId(itemId);
  const combinedInventory = getCombinedScenarioInventoryMap();
  return !!id && (Number(combinedInventory[id]?.quantity || 0) > 0 || hasShopItem(id));
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
    .replace(new RegExp("\\n?\\[?\\s*획득\\s*\\/\\s*변화\\s*\\]?\\s*[:：][\\s\\S]*?(?=\\n\\n|$)", "g"), "")
    .replace(new RegExp("\\n?획득\\s*\\/\\s*변화\\s*[:：][^\\n]*", "g"), "")
    .trim();
}

function renderStoryText(text = "") {
  let html = safeText(cleanEffectText(text));
  const effects = [
    ["지직 지지직", "story-fx story-fx-electric"],
    ["지지지직", "story-fx story-fx-electric"],
    ["드 림 랜 드", "story-fx story-fx-dreamland"],
    ["금일 영업 안내", "story-fx story-fx-red-sign"],
    ["삐이이이", "story-fx story-fx-wind"],
    ["즐거운... 드림랜드... 입니다, 손님...", "story-fx story-fx-rotten"],
    ["끼이익", "story-fx story-fx-screech"],
    ["딸랑딸랑", "story-fx story-fx-bell"],
    ["어서오세요, 손님. 찾으시는 물건이 있으신가요?", "story-fx story-fx-uncanny"],
    ["고맙습니다, 손님! 저희 골튼 리조트의 기념품샵을 이용해주셨으니 특별한 공간으로 안내드리겠습니다!", "story-fx story-fx-uncanny story-fx-red"],
    ["[마스코트 골튼의 기념품샵]", "story-fx story-fx-golden-shop"],
    ["구매해 주셔서 감사합니다, 손님!", "story-fx story-fx-uncanny story-fx-red"],
    ["저희 골튼 드림랜드 파라다이스의 정식 일원이 되신 것을 진심으로 환영합니다!", "story-fx story-fx-uncanny story-fx-red"],
    ["고객님께 안전한 쇼핑, 쾌적한 서비스를 제공하기 위해 출입문을 잠시 통제하는 점 양해바랍니다!", "story-fx story-fx-uncanny story-fx-red"],
    ["구매해주신 답례로 [VIP실]에서 계속 쇼핑을 즐기실 수 있도록 안내드리고 있습니다! 사랑합니다, 고객님!", "story-fx story-fx-uncanny story-fx-red"],
    ["쿵!", "story-fx story-fx-bang"],
    ["손님, 왜 가려고 하세요? 좀 더 둘러보세요.", "story-fx story-fx-red-sign"],
    ["환영합니다, 고객님! 지금부터 고객님을 위한 특별한 VIP 서비스를 시작합니다!", "story-fx story-fx-uncanny story-fx-red"],
    ["[VIP 명단]", "story-fx story-fx-vip-list"],
    ["치직, 치이이이익—", "story-fx story-fx-glitch"],
    ["이, 이럴 리가. 이럴 리가!", "story-fx story-fx-uncanny story-fx-red"],
    ["[VIP 멤버십 카드]", "story-fx story-fx-vip-card"]
  ];
  for (const [phrase, className] of effects) {
    const escaped = safeText(phrase);
    html = html.split(escaped).join(`<span class="${className}">${escaped}</span>`);
  }
  return html
    .split("\n")
    .map((line) => {
      const isFxLine = line.includes('class="story-fx');
      const isBlank = !line.trim();
      return `<div class="story-line ${isFxLine ? "story-line-fx" : ""} ${isBlank ? "story-line-blank" : ""}">${isBlank ? "&nbsp;" : line}</div>`;
    })
    .join("");
}

function cleanChoiceLabel(label = "") {
  return String(label)
    .replace(/^\[(?:백일몽|재난관리국|초자연 재난관리국) 전용\]\s*/g, "")
    .replace(/^\[만약 현재 누적 오염도가 [^\]]+\]\s*/g, "")
    .replace(/\s*\(오염도 [^)]+\)/g, "")
    .replace(/\s*\(효과: [^)]+\)/g, "")
    .trim();
}

function clampMetric(value) {
  return Math.max(0, Math.min(100, Number(value || 0)));
}

function isEntityProfile(profile = currentProfile) {
  return String(profile?.visitor_type || "").toLowerCase() === "entity" || String(profile?.organization_code || "").toLowerCase() === "entity";
}

function hasEntityLifeMask(profile = currentProfile) {
  return !isEntityProfile(profile) || !!profile?.current_life_item_id;
}

async function requireEntityLifeMask() {
  if (hasEntityLifeMask()) return true;
  await themedAlert("초자연적 힘을 가진 존재가 있는 세계에는 접근할 수 없습니다. 접근하길 원한다면 초자연적 힘을 가진 존재를 속일 수 있는 가면을 착용하십시오.", "접근 불가");
  return false;
}

function buildMetricBar(value, variant = "pollution") {
  const pct = clampMetric(value);
  return `<div class="metric-bar ${variant}" title="${pct}%"><span style="width:${pct}%"></span></div>`;
}

function isSoloBlocked() {
  const activeCount = currentMembers.filter((member) => !member.left_at).length;
  return activeCount < 2 && !getStateJson().soloTestMode;
}

function memberUsesEntityMetric(member) {
  const visitorType = String(member?.visitor_type_snapshot || "").toLowerCase();
  const org = String(member?.organization_code_snapshot || "").toLowerCase();
  return visitorType === "entity" || org === "entity";
}

function getEffectTargetMembers() {
  const activeMembers = getActiveRoomMembers();
  if (activeMembers.length) return activeMembers;
  const mine = getMyMemberSnapshot();
  return mine ? [mine] : [];
}

function buildStatePatchForEffects(effects = [], options = {}) {
  const state = getStateJson();
  const inventory = { ...(state.roomInventory || {}) };
  const memberInventories = { ...(state.memberInventories || {}) };
  const metrics = { ...(state.memberMetrics || {}) };
  const allTargetMembers = getEffectTargetMembers();
  const selfMember = getMyMemberSnapshot();
  const logs = [];

  for (const effect of effects || []) {
    const targetMembers = effect.scope === "self" && selfMember ? [selfMember] : allTargetMembers;
    if (effect.type === "add_item" && effect.itemId) {
      const itemId = normalizeItemId(effect.itemId);
      const meta = getItemMeta(itemId);
      const quantity = Number(effect.quantity || 1);
      const roomScoped = effect.scope === "room" || effect.scope === "party" || effect.shared === true;
      if (!roomScoped && currentProfile?.id) {
        const userId = String(currentProfile.id);
        const mine = { ...(memberInventories[userId] || {}) };
        mine[itemId] = {
          itemId,
          name: meta.name || itemId,
          type: meta.type || "item",
          quantity: Number(mine[itemId]?.quantity || 0) + quantity,
          acquiredAt: new Date().toISOString(),
          personal: true,
          ownerId: userId
        };
        memberInventories[userId] = mine;
      } else {
        inventory[itemId] = {
          itemId,
          name: meta.name || itemId,
          type: meta.type || "item",
          quantity: Number(inventory[itemId]?.quantity || 0) + quantity,
          acquiredAt: new Date().toISOString(),
          shared: true,
          scope: "room"
        };
      }
    }
    if (effect.type === "remove_item" && effect.itemId) {
      const itemId = normalizeItemId(effect.itemId);
      const quantity = Math.max(1, Number(effect.quantity || 1));
      const roomScoped = effect.scope === "room" || effect.scope === "party" || effect.shared === true;
      if (!roomScoped && currentProfile?.id) {
        const userId = String(currentProfile.id);
        const mine = { ...(memberInventories[userId] || {}) };
        const currentQty = Number(mine[itemId]?.quantity || 0);
        if (currentQty <= quantity) delete mine[itemId];
        else mine[itemId] = { ...mine[itemId], quantity: currentQty - quantity };
        memberInventories[userId] = mine;
      } else if (inventory[itemId]) {
        const currentQty = Number(inventory[itemId]?.quantity || 0);
        if (currentQty <= quantity) delete inventory[itemId];
        else inventory[itemId] = { ...inventory[itemId], quantity: currentQty - quantity };
      }
    }
    if (effect.type === "collector_grade") {
      const delta = Number(effect.amount || 1);
      targetMembers.forEach((member) => {
        if (!member?.user_id) return;
        const metric = { ...getMemberMetric(member), ...(metrics[member.user_id] || {}) };
        metric.collector_grade_bonus = Number(metric.collector_grade_bonus || 0) + delta;
        metrics[member.user_id] = metric;
      });
    }
    if (effect.type === "pollution") {
      targetMembers.forEach((member) => {
        if (!member?.user_id) return;
        const org = String(member.organization_code_snapshot || "").toLowerCase();
        const delta = org === "disaster_agency" && effect.disasterAgencyAmount != null
          ? Number(effect.disasterAgencyAmount)
          : Number(effect.amount || 0);
        const metric = { ...getMemberMetric(member), ...(metrics[member.user_id] || {}) };
        if (memberUsesEntityMetric(member)) {
          metric.mask_collapse_rate = clampMetric(Number(metric.mask_collapse_rate || 0) + delta);
        } else {
          metric.pollution = clampMetric(Number(metric.pollution || 0) + delta);
        }
        metrics[member.user_id] = metric;
      });
    }
    if (effect.type === "mask_collapse") {
      const delta = Number(effect.amount || 0);
      targetMembers.forEach((member) => {
        if (!member?.user_id) return;
        const metric = { ...getMemberMetric(member), ...(metrics[member.user_id] || {}) };
        metric.mask_collapse_rate = clampMetric(Number(metric.mask_collapse_rate || 0) + delta);
        metrics[member.user_id] = metric;
      });
    }
  }

  const patch = { roomInventory: inventory, memberInventories, memberMetrics: metrics };
  if (logs.length) patch.lastEffectLog = logs;
  return patch;
}

function buildPersonalInstantChoicePatch(choice = {}) {
  const state = getStateJson();
  const userId = getMyUserId();
  const effectPatch = buildStatePatchForEffects(choice.effects || [], { personalItems: true });
  let patch = mergePatches(effectPatch);
  const flagKeys = getChoiceFlagKeys(choice);

  if (isGlobalInstantChoice(choice)) {
    const flags = { ...(state.flags || {}) };
    flagKeys.forEach((key) => { flags[key] = true; });
    patch = mergePatches(patch, { flags });
  } else {
    const memberChoiceFlags = { ...(state.memberChoiceFlags || {}) };
    if (userId) {
      const mine = { ...(memberChoiceFlags[userId] || {}) };
      flagKeys.forEach((key) => { mine[key] = true; });
      memberChoiceFlags[userId] = mine;
    }
    patch = mergePatches(patch, { memberChoiceFlags });
  }

  if (choice.setRoomState?.flags && typeof choice.setRoomState.flags === "object") {
    const flags = { ...(state.flags || {}) };
    Object.entries(choice.setRoomState.flags).forEach(([key, value]) => { flags[key] = value; });
    patch = mergePatches(patch, { flags });
  }

  if (choice.systemMessage) {
    const actor = getMyMemberSnapshot()?.display_name_snapshot || currentProfile?.display_name || "탐사자";
    patch.lastEffectLog = [...(patch.lastEffectLog || []), formatSystemMessageTemplate(choice.systemMessage, actor)];
  }
  return patch;
}

function mergePatches(...patches) {
  const merged = {};
  for (const patch of patches.filter(Boolean)) {
    for (const [key, value] of Object.entries(patch)) {
      if (["roomInventory", "memberMetrics", "flags"].includes(key) && value && typeof value === "object" && !Array.isArray(value)) {
        merged[key] = { ...(merged[key] || {}), ...value };
      } else if (key === "lastEffectLog" && Array.isArray(value)) {
        merged[key] = [...(merged[key] || []), ...value];
      } else if (["memberInventories", "memberChoiceFlags"].includes(key) && value && typeof value === "object" && !Array.isArray(value)) {
        merged[key] = { ...(merged[key] || {}), ...value };
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
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
function forceRoomMode() {
  document.body.classList.add("in-room");
  const app = qs("#appPanel");
  const login = qs("#loginPanel");
  const room = qs("#roomPanel");
  if (app) { app.hidden = true; app.style.display = "none"; }
  if (login) { login.hidden = true; login.style.display = "none"; }
  if (room) { room.hidden = false; room.style.display = "block"; }
}

function forceLoungeMode() {
  if (currentRoom) return forceRoomMode();
  document.body.classList.remove("in-room");
  qs("#appPanel") && (qs("#appPanel").style.display = "");
  qs("#roomPanel") && (qs("#roomPanel").style.display = "");
  const app = qs("#appPanel");
  const room = qs("#roomPanel");
  if (app) app.style.display = "";
  if (room) room.style.display = "";
}


function showOnAirSplash() {
  const node = qs("#onAirSplash");
  if (!node) return Promise.resolve();
  node.classList.remove("is-visible");
  // restart animation
  void node.offsetWidth;
  node.classList.add("is-visible");
  return new Promise((resolve) => {
    window.setTimeout(() => {
      node.classList.remove("is-visible");
      resolve();
    }, 4600);
  });
}

function showLoggedOutView() {
  currentProfile = null;
  document.body.classList.remove("in-room");
  document.body.classList.add("is-logged-out");
  setVisible("#loginPanel", false);
  setVisible("#sideLoginPanel", true);
  setVisible("#profilePanel", false);
  setVisible("#appPanel", true);
  setVisible("#roomPanel", false);
  setVisible("#mainNav", true);
  setVisible("#notificationBell", false);
  setVisible("#adminDeskButton", false);
  document.querySelectorAll(".requires-login").forEach((node) => { node.hidden = true; });
  qs("#roomList") && (qs("#roomList").textContent = "방 목록은 회원만 보실 수 있습니다.");
  qs("#partyList") && (qs("#partyList").textContent = "파티 모집글은 회원만 보실 수 있습니다.");
  qs("#communityList") && (qs("#communityList").textContent = "익명 게시판은 회원만 보실 수 있습니다.");
  qs("#myRoomsList") && (qs("#myRoomsList").textContent = "내 탐사방은 로그인 후 보입니다.");
}

function showLoggedInLounge() {
  if (currentRoom) return;
  document.body.classList.remove("is-logged-out");
  forceLoungeMode();
  setVisible("#loginPanel", false);
  setVisible("#sideLoginPanel", false);
  setVisible("#appPanel", true);
  setVisible("#mainNav", true);
  setVisible("#profilePanel", true);
  document.querySelectorAll(".requires-login").forEach((node) => { node.hidden = false; });
  setVisible("#notificationBell", true);
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
      current_life_item_id,
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

  profile.role = String(profile.role || "user").trim().toLowerCase();
  currentProfile = profile;
  applyVisitorModeClass(profile);
  const isAdmin = profile.role === "admin";
  const adminNav = qs("#adminNavButton");
  if (adminNav) adminNav.hidden = true;
  const adminDesk = qs("#adminDeskButton");
  if (adminDesk) adminDesk.hidden = !isAdmin;
  if (isAdmin) {
    document.querySelectorAll(".requires-admin").forEach((node) => { node.hidden = false; });
  } else {
    document.querySelectorAll(".requires-admin").forEach((node) => { node.hidden = true; });
  }
  renderProfile(profile);
  ensureMyContentPanel();
  await loadInventory();
  updateNotificationBadge().catch(() => {});
  startCleanupTimer();
  showLoggedInLounge();
  return profile;
}

function renderProfile(profile) {
  const displayName = profile.display_name || "익명";
  const bandName = profile.band_nickname || "-";
  const currency = Number(profile.currency || 0);
  const isLoggedIn = !!profile?.id;
  qs("#profileCard").innerHTML = `
    <div class="profile-name-row">
      <div>
        <div class="profile-name">${safeText(displayName)}</div>
        <p class="profile-sub">${safeText(bandName)}</p>
      </div>
      ${isLoggedIn ? `
        <button id="notificationBell" class="profile-bell" type="button" aria-label="알림 열기" title="알림">
          <span class="bell-icon" aria-hidden="true">◔</span>
          <span id="notificationBadge" class="notification-badge" hidden>0</span>
        </button>` : ""}
    </div>
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
    .select("quantity, updated_at, items(id, name, description, item_kind, category, effect_type, effect_value)")
    .eq("user_id", currentProfile.id)
    .gt("quantity", 0)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) {
    box.textContent = `가방을 불러오지 못했습니다: ${error.message}`;
    return;
  }

  currentInventory = data || [];
  const visibleInventory = getVisibleShopInventory();
  if (!visibleInventory.length) {
    box.textContent = "가방에 표시할 아이템이 없습니다.";
    return;
  }

  box.classList.remove("muted");
  box.innerHTML = visibleInventory.slice(0, 8).map((row) => {
    return `
      <div class="inventory-item">
        <strong>${safeText(getShopItemName(row) || "이름 없는 아이템")}</strong>
        <span>× ${Number(row.quantity || 0)}</span>
      </div>
    `;
  }).join("");
}


async function loadScenarioList() {
  const response = await fetch(`scenarios/scenario-list.json?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("시나리오 목록을 불러오지 못했습니다.");
  const list = await response.json();
  scenarioList = list.filter((scenario) => scenario.status === "published" || scenario.status === "active");
  renderScenarioSelect();
}

function renderScenarioSelect() {
  const selects = [qs("#scenarioSelect"), qs("#partyScenarioSelect"), qs("#editPartyScenarioSelect")].filter(Boolean);
  selects.forEach((select) => {
    select.innerHTML = "";
    scenarioList.forEach((scenario) => {
      const option = document.createElement("option");
      option.value = scenario.id;
      option.textContent = `${scenario.title}`;
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
  const sortedRooms = [...roomListCache].sort((a, b) => {
    const roomRank = (room) => {
      const isPrivate = room.visibility === "private";
      const isFull = Number(room.current_players || 0) >= Number(room.max_players || 0);
      const isEnded = room.status === "ended";
      if (!isPrivate && !isFull && !isEnded) return 0;
      if (!isFull && !isEnded) return 1;
      return 2;
    };
    const rankDiff = roomRank(a) - roomRank(b);
    if (rankDiff !== 0) return rankDiff;
    return String(a.title || "").localeCompare(String(b.title || ""), "ko-KR", { numeric: true, sensitivity: "base" });
  });
  const totalPages = Math.max(1, Math.ceil(sortedRooms.length / ROOM_PAGE_SIZE));
  roomPage = Math.min(Math.max(1, roomPage), totalPages);
  const start = (roomPage - 1) * ROOM_PAGE_SIZE;
  const pagedRooms = sortedRooms.slice(start, start + ROOM_PAGE_SIZE);
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
  partyPage = Math.min(Math.max(1, partyPage), Math.max(1, Math.ceil(partyListCache.length / PARTY_PAGE_SIZE)));
  renderPartyPosts();
}

function sortPartyPostsForDisplay(posts = []) {
  const statusRank = { open: 0, scheduled: 1, ended: 2, complete: 3 };
  return [...posts].sort((a, b) => {
    const aStatus = getPartyComputedStatus(a);
    const bStatus = getPartyComputedStatus(b);
    const rankDiff = (statusRank[aStatus.key] ?? 9) - (statusRank[bStatus.key] ?? 9);
    if (rankDiff !== 0) return rankDiff;
    const aCreated = new Date(a.created_at || a.recruitment_start_at || 0).getTime();
    const bCreated = new Date(b.created_at || b.recruitment_start_at || 0).getTime();
    return (Number.isFinite(bCreated) ? bCreated : 0) - (Number.isFinite(aCreated) ? aCreated : 0);
  });
}

function renderPartyPosts() {
  const box = qs("#partyList");
  if (!box) return;
  if (!partyListCache.length) {
    box.textContent = "아직 올라온 익명 모집글이 없습니다.";
    box.classList.add("muted");
    return;
  }
  const postsForDisplay = sortPartyPostsForDisplay(partyListCache);
  const totalPages = Math.max(1, Math.ceil(postsForDisplay.length / PARTY_PAGE_SIZE));
  partyPage = Math.min(Math.max(1, partyPage), totalPages);
  const start = (partyPage - 1) * PARTY_PAGE_SIZE;
  const pagedPosts = postsForDisplay.slice(start, start + PARTY_PAGE_SIZE);
  box.classList.remove("muted");
  const listHtml = pagedPosts.map((post) => {
    const scenario = scenarioList.find((item) => item.id === post.scenario_id);
    const isCreator = !!post.is_creator;
    const isAdmin = currentProfile?.role === "admin";
    const computedStatus = getPartyComputedStatus(post);
    const isClosed = computedStatus.closed;
    const isFinal = computedStatus.key === "ended" || computedStatus.key === "complete";
    const canEnterRecruitment = computedStatus.key === "open";
    const hasApplied = !!post.has_applied;
    const count = Number(post.applicant_count || 0);
    const capacity = Number(post.recruitment_capacity || 4);
    const comments = Number(post.comment_count || 0);
    const statusBadge = `<span class="badge ${safeAttr(computedStatus.badgeClass)}">${safeText(computedStatus.label)}</span>`;
    const ownerButtons = (isCreator || isAdmin) ? `
      ${isCreator ? `<button type="button" class="ghost-button" data-edit-party="${safeAttr(post.id)}" ${isFinal ? "disabled" : ""}>수정</button>` : ""}
      <button type="button" class="ghost-button danger" data-delete-party="${safeAttr(post.id)}">삭제</button>
      ${isCreator ? `<button type="button" class="secondary-action" data-party-room="${safeAttr(post.id)}" ${!canEnterRecruitment ? "disabled" : ""}>방 만들기</button>` : ""}
    ` : "";
    const applicantButtons = !isCreator && canEnterRecruitment ? (
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
        <div class="party-item-meta">${safeText(scenario?.title || post.scenario_id || "시나리오 미정")} · 신청 ${count}/${capacity}명 · 댓글 ${comments}개</div>
        ${getPartyScheduleHtml(post)}
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
  const pagerHtml = totalPages > 1 ? `
    <div class="pager party-pager">
      <button type="button" class="ghost-button" data-party-page="prev" ${partyPage <= 1 ? "disabled" : ""}>이전</button>
      <span>${partyPage} / ${totalPages}</span>
      <button type="button" class="ghost-button" data-party-page="next" ${partyPage >= totalPages ? "disabled" : ""}>다음</button>
    </div>` : "";
  box.innerHTML = listHtml + pagerHtml;
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
  const computedStatus = getPartyComputedStatus(post);
  const isClosed = computedStatus.closed;
  const count = Number(post.applicant_count || 0);
  const capacity = Number(post.recruitment_capacity || 4);
  const comments = Number(post.comment_count || 0);
  detail.innerHTML = `
    <div class="detail-mini-actions">
      <button type="button" class="icon-danger-button" data-report-target="party_post" data-report-id="${safeAttr(post.id)}" title="신고" aria-label="모집글 신고">🚨</button>
    </div>
    <p class="kicker">Anonymous Board</p>
    <h2>${safeText(post.title || "익명 모집")}</h2>
    <div class="room-meta">${safeText(scenario?.title || post.scenario_id || "시나리오 미정")} · ${safeText(computedStatus.label)} · 신청 ${count}/${capacity}명 · 댓글 ${comments}개</div>
    ${getPartyScheduleHtml(post)}
    <div class="party-detail-content">${safeText(post.content || "내용 없음")}</div>
    ${isClosed ? `<p class="small muted party-status-note">현재 ${safeText(computedStatus.label)} 상태입니다. 모집 종료/완료 후 2일이 지나면 목록 정리 시 삭제됩니다.</p>` : ""}
  `;
}

function renderPartyComments(comments = []) {
  comments = [...(comments || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
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
  box.innerHTML = foldHtml + itemsHtml;
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
  ensureCommunityPanel();
  const box = qs("#communityList");
  if (!box) return;
  if (!currentProfile) { box.textContent = "익명 게시판은 회원만 보실 수 있습니다."; box.classList.add("muted"); return; }
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
    box.textContent = "현재 게시물이 없습니다.";
    box.classList.add("muted");
    if (pager) {
      pager.hidden = false;
      pager.innerHTML = `<button type="button" class="ghost-button" data-community-page="prev" disabled>이전</button><span>1 / 1</span><button type="button" class="ghost-button" data-community-page="next" disabled>다음</button>`;
    }
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
        ${safeText(post.anonymous_alias || "익명 탐사자")} · ${safeText(communityOrgOnlyLabel(post))} · ${formatDate(post.created_at)} · 댓글 ${Number(post.comment_count || 0)}개
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
    pager.hidden = false;
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
    <div class="detail-mini-actions">
      <button type="button" class="icon-danger-button" data-report-target="community_post" data-report-id="${safeAttr(post.id)}" title="신고" aria-label="게시글 신고">🚨</button>
      ${post.is_mine ? `<button type="button" class="icon-danger-button" data-delete-community-post="${safeAttr(post.id)}" title="삭제" aria-label="게시글 삭제">삭제</button>` : ""}
    </div>
    <p class="kicker">Anonymous Lounge</p>
    <h2>${safeText(post.title || "익명 게시글")}</h2>
    <div class="room-meta">${safeText(post.anonymous_alias || "익명 탐사자")} · ${safeText(communityOrgOnlyLabel(post))} · ${formatDate(post.created_at)} · 댓글 ${Number(post.comment_count || 0)}개</div>
    <div class="community-detail-content">${safeText(post.body || "")}</div>
  `;
}

function updateCommunityCommentCount(postId, count) {
  const meta = qs("#communityDetailBody .room-meta");
  if (meta) meta.textContent = meta.textContent.replace(/댓글\s*\d+개/g, `댓글 ${Number(count || 0)}개`);
  communityListCache = communityListCache.map((post) => String(post.id) === String(postId) ? { ...post, comment_count: count } : post);
  renderCommunityPosts();
}

async function loadCommunityComments(postId) {
  const { data, error } = await supabase.rpc("list_exploration_community_comments", { p_post_id: postId });
  if (error) throw error;
  return data || [];
}

function renderCommunityComments(comments = []) {
  comments = [...(comments || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
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


let myContentPage = 1;
const MY_CONTENT_PAGE_SIZE = 10;
let myContentSelection = new Set();
let myContentCache = [];

function ensureMyContentPanel() {
  const stage = qs(".broadcast-stage");
  if (stage && !qs("#tabMyContent")) {
    const section = document.createElement("section");
    section.id = "tabMyContent";
    section.className = "tab-panel";
    section.dataset.tabPanel = "myContent";
    section.hidden = true;
    section.innerHTML = `
      <div class="list-toolbar my-content-toolbar">
        <strong>내가 쓴 글/댓글</strong>
        <div class="mini-actions">
          <button id="refreshMyContent" type="button" class="icon-button" aria-label="새로고침" title="새로고침">↻</button>
          <button id="deleteSelectedMyContent" type="button" class="ghost-button danger">선택 삭제</button>
          <button id="deleteAllMyContent" type="button" class="ghost-button danger">전체 삭제</button>
        </div>
      </div>
      <div id="myContentList" class="community-list muted">작성 내역을 불러오는 중...</div>
      <div id="myContentPagination" class="pagination-row"></div>`;
    stage.appendChild(section);
  }
  const desk = qs(".action-card");
  if (desk && !qs("#myContentDeskButton")) {
    const btn = document.createElement("button");
    btn.id = "myContentDeskButton";
    btn.type = "button";
    btn.className = "ghost-button full";
    btn.textContent = "내가 쓴 글/댓글";
    desk.appendChild(btn);
  }
}

async function loadMyContent(page = myContentPage) {
  ensureMyContentPanel();
  const box = qs("#myContentList");
  const pager = qs("#myContentPagination");
  if (!box) return;
  if (!currentProfile) { box.textContent = "로그인 후 볼 수 있습니다."; box.classList.add("muted"); return; }
  myContentPage = Math.max(1, Number(page || 1));
  box.textContent = "작성 내역을 불러오는 중...";
  box.classList.add("muted");
  const { data, error } = await supabase.rpc("list_my_exploration_content", { p_page: myContentPage, p_limit: MY_CONTENT_PAGE_SIZE });
  if (error) { box.textContent = `작성 내역을 불러오지 못했습니다: ${error.message}`; return; }
  myContentCache = data || [];
  myContentSelection.clear();
  renderMyContent();
}

function myContentLabel(kind) {
  if (kind === "party_post") return "파티 모집글";
  if (kind === "party_comment") return "파티 댓글";
  if (kind === "community_post") return "익명 게시글";
  if (kind === "community_comment") return "익명 댓글";
  return "작성 내역";
}

function renderMyContent() {
  const box = qs("#myContentList");
  const pager = qs("#myContentPagination");
  if (!box) return;
  if (!myContentCache.length) {
    box.textContent = "작성한 글이나 댓글이 없습니다.";
    box.classList.add("muted");
    if (pager) pager.innerHTML = `<button type="button" class="ghost-button" data-my-content-page="prev" disabled>이전</button><span>1 / 1</span><button type="button" class="ghost-button" data-my-content-page="next" disabled>다음</button>`;
    return;
  }
  const totalCount = Number(myContentCache[0]?.total_count || myContentCache.length || 0);
  const totalPages = Math.max(1, Math.ceil(totalCount / MY_CONTENT_PAGE_SIZE));
  box.classList.remove("muted");
  box.innerHTML = myContentCache.map((item) => `
    <article class="my-content-item">
      <label class="my-content-check"><input type="checkbox" data-my-content-select="${safeAttr(item.kind)}:${safeAttr(item.item_id)}"></label>
      <div class="my-content-body">
        <div class="community-item-head"><strong>${safeText(item.title || myContentLabel(item.kind))}</strong><span class="badge public">${safeText(myContentLabel(item.kind))}</span></div>
        <div class="community-item-meta">${formatDate(item.created_at)} · ${safeText(item.status || "")}</div>
        <p>${safeText(item.body || "내용 없음").slice(0, 240)}${String(item.body || "").length > 240 ? "..." : ""}</p>
        <div class="community-actions">
          ${item.link_type === "party_post" && item.link_id ? `<button type="button" class="ghost-button" data-detail-party="${safeAttr(item.link_id)}">열기</button>` : ""}
          ${item.link_type === "community_post" && item.link_id ? `<button type="button" class="ghost-button" data-detail-community="${safeAttr(item.link_id)}">열기</button>` : ""}
          <button type="button" class="ghost-button danger" data-delete-my-content="${safeAttr(item.kind)}:${safeAttr(item.item_id)}">삭제</button>
        </div>
      </div>
    </article>
  `).join("");
  if (pager) pager.innerHTML = `
    <button type="button" class="ghost-button" data-my-content-page="prev" ${myContentPage <= 1 ? "disabled" : ""}>이전</button>
    <span>${myContentPage} / ${totalPages}</span>
    <button type="button" class="ghost-button" data-my-content-page="next" ${myContentPage >= totalPages ? "disabled" : ""}>다음</button>`;
}

async function deleteMyContentItems(items) {
  if (!items?.length) return showMessage("삭제할 항목을 선택해 주세요.", "error");
  if (!(await themedConfirm(`${items.length}개 항목을 삭제할까요?`, "삭제 확인"))) return;
  const payload = items.map((raw) => {
    const [kind, ...rest] = String(raw).split(":");
    return { kind, id: rest.join(":") };
  });
  const { error } = await supabase.rpc("delete_my_exploration_content", { p_items: payload });
  if (error) { showMessage(error.message, "error"); return; }
  showMessage("작성 내역을 삭제했습니다.", "success");
  await loadMyContent(myContentPage);
}


async function loadScenario(scenarioId) {
  if (scenarioCache.has(scenarioId)) return scenarioCache.get(scenarioId);
  const meta = scenarioList.find((item) => item.id === scenarioId);
  if (!meta) throw new Error("시나리오 정보를 찾을 수 없습니다.");
  const scenarioPath = String(meta.file || "").startsWith("scenarios/") ? String(meta.file) : `scenarios/${meta.file}`;
  const response = await fetch(`${scenarioPath}?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("시나리오 파일을 불러오지 못했습니다.");
  const scenario = await response.json();
  scenarioCache.set(scenarioId, scenario);
  return scenario;
}

async function ensureScenarioDefaultItems(scenario) {
  if (!currentRoom?.id || !currentState || !currentProfile?.id || !scenario?.defaultItemsByOrganization) return;
  const member = getMyMemberSnapshot();
  const org = member?.organization_code_snapshot || currentProfile?.organization_code;
  const itemIds = scenario.defaultItemsByOrganization?.[org] || [];
  if (!itemIds.length) return;
  const state = getStateJson();
  const allInventories = { ...(state.memberInventories || {}) };
  const userId = String(currentProfile.id);
  const currentInventory = { ...(allInventories[userId] || {}) };
  const additions = {};
  itemIds.forEach((itemId) => {
    const cleanId = normalizeItemId(itemId);
    if (!currentInventory[cleanId]) {
      const meta = getItemMeta(cleanId);
      additions[cleanId] = {
        itemId: cleanId,
        name: meta.name || cleanId,
        type: meta.type || "item",
        quantity: 1,
        acquiredAt: new Date().toISOString(),
        personal: true,
        ownerId: userId
      };
    }
  });
  if (!Object.keys(additions).length) return;
  try {
    const mergedMine = { ...(currentInventory || {}), ...additions };
    const mergedInventories = { ...allInventories, [userId]: mergedMine };
    const { error } = await supabase.rpc("patch_exploration_room_state", {
      p_room_id: currentRoom.id,
      p_state_patch: { memberInventories: mergedInventories }
    });
    if (error) throw error;
    const state = getStateJson();
    currentState = {
      ...currentState,
      state_json: {
        ...state,
        memberInventories: mergedInventories
      }
    };
  } catch (error) {
    console.warn("기본 지급 아이템 적용 실패", error);
  }
}

async function createRoom({ scenarioId, title, maxPlayers, visibility = "public", roomPassword = "", startSectionKey = null, stateJson = {} }) {
  if (!(await requireEntityLifeMask())) return;
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
  if (!(await requireEntityLifeMask())) return;
  const { data, error } = await supabase.rpc("join_exploration_room", {
    p_invite_code: inviteCode.trim().toUpperCase(),
    p_room_password: roomPassword || null
  });
  if (error) throw error;
  closeModal("#joinRoomModal");
  showMessage("탐사방에 입장했습니다.", "success");
  await openRoom(data.room_id);
  await logRoomSystemMessageToRoom(data.room_id, `${getActorDisplayName(getCurrentActorNameForLog())}이 입장했습니다.`);
  await Promise.all([loadMyRooms(), loadRoomList()]);
}

async function joinPublicRoomById(roomId) {
  if (!(await requireEntityLifeMask())) return;
  const { data, error } = await supabase.rpc("join_exploration_room_by_id", { p_room_id: roomId });
  if (error) throw error;
  showMessage("탐사방에 입장했습니다.", "success");
  await openRoom(data.room_id);
  await logRoomSystemMessageToRoom(data.room_id, `${getActorDisplayName(getCurrentActorNameForLog())}이 입장했습니다.`);
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

async function openRoom(roomId, options = {}) {
  if (!(await requireEntityLifeMask())) return;
  const { showSplash = true } = options;
  forceRoomMode();
  if (showSplash) await showOnAirSplash();
  await closeRealtime();
  forceRoomMode();
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
  forceRoomMode();
  await loadScenario(room.scenario_id);
  await Promise.all([loadMembers(), loadRoomState(), loadMessages()]);
  await restorePersistentExplorationFlags();
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

async function restorePersistentExplorationFlags() {
  if (!currentRoom?.id || !currentProfile?.id) return;
  try {
    const { data, error } = await supabase.rpc("restore_exploration_persistent_flags", { p_room_id: currentRoom.id });
    if (error) throw error;
    if (data?.restored) {
      await loadRoomState();
      showMessage("이전 탐사의 흔적이 소지창에 복원되었습니다.", "info");
    }
  } catch (error) {
    // v1.17.23 SQL을 아직 적용하지 않은 경우에도 탐사방 로딩 자체는 막지 않는다.
    console.warn("지속 플래그 복원 실패", error);
  }
}

function getMyMemberSnapshot() {
  if (!currentProfile) return null;
  return currentMembers.find((member) => member.user_id === currentProfile.id) || null;
}

function conditionMatches(condition = {}) {
  const member = getMyMemberSnapshot();
  const metric = getMyMetric();
  const state = getStateJson();
  const flags = state.flags || {};
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
    if (key === "state_flag") return !!flags?.[expected];
    if (key === "not_state_flag") return !flags?.[expected];
    if (key === "state_flags") return (expected || []).every((flag) => !!flags?.[flag]);
    if (key === "not_state_flags") return (expected || []).every((flag) => !flags?.[flag]);
    if (key === "member_choice_flag") return !!getMyChoiceFlagsMap()?.[expected];
    if (key === "not_member_choice_flag") return !getMyChoiceFlagsMap()?.[expected];
    if (key === "member_choice_flags") return (expected || []).every((flag) => !!getMyChoiceFlagsMap()?.[flag]);
    if (key === "not_member_choice_flags") return (expected || []).every((flag) => !getMyChoiceFlagsMap()?.[flag]);
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
  await ensureScenarioDefaultItems(scenario);
  const sectionKey = currentState.current_section_key || scenario.startSection;
  const section = scenario.sections?.[sectionKey];
  const isHost = currentRoom.host_user_id === currentProfile?.id;
  document.querySelectorAll("#roomPanel .host-only").forEach((node) => { node.hidden = !isHost; });

  qs("#roomTitleView").textContent = currentRoom.title;
  qs("#roomMetaView").textContent = `${scenario.title} · ${currentRoom.visibility === "private" ? "비공개" : "공개"} · 초대코드 ${currentRoom.invite_code} · ${currentRoom.status} · 최대 ${currentRoom.max_players}명`;
  qs("#scenarioTitle").textContent = `${scenario.title}`;
  const imageNode = qs("#scenarioImage");
  if (!section) {
    qs("#sectionTitle").hidden = false;
    qs("#sectionTitle").textContent = "섹션 오류";
    qs("#storyText").textContent = `시나리오 파일에서 '${sectionKey}' 섹션을 찾지 못했습니다.`;
    qs("#choiceList").innerHTML = "";
    if (imageNode) {
      imageNode.hidden = true;
      imageNode.classList.remove("scenario-image-placeholder");
      imageNode.innerHTML = "";
      imageNode.style.backgroundImage = "";
    }
    return;
  }

  const imageUrl = section.image || section.imageUrl || scenario.coverImage || "";
  const visualPrompt = section.imagePrompt || section.visualPrompt || "";
  if (imageNode && imageUrl) {
    imageNode.hidden = false;
    imageNode.classList.remove("scenario-image-placeholder");
    imageNode.innerHTML = "";
    imageNode.style.backgroundImage = `linear-gradient(135deg, rgba(158,29,41,.18), rgba(232,179,90,.08)), url('${String(imageUrl).replaceAll("'", "%27")}')`;
  } else if (imageNode && visualPrompt) {
    imageNode.hidden = false;
    imageNode.classList.add("scenario-image-placeholder");
    imageNode.style.backgroundImage = "";
    imageNode.innerHTML = `<span>${safeText(section.imageLabel || "장면 이미지 준비 중")}</span>`;
  } else if (imageNode) {
    imageNode.hidden = true;
    imageNode.classList.remove("scenario-image-placeholder");
    imageNode.innerHTML = "";
    imageNode.style.backgroundImage = "";
  }

  qs("#sectionTitle").textContent = "";
  qs("#sectionTitle").hidden = true;
  const privateBlocks = (section.visibilityBlocks || [])
    .filter((block) => conditionMatches(block.condition || {}))
    .map((block) => `<div class="story-private">${safeText(block.text || "")}</div>`)
    .join("");
  qs("#storyText").innerHTML = `${renderStoryText(section.commonText || "")}${privateBlocks}`;
  const effectBox = qs("#sectionEffectLog");
  if (effectBox) {
    effectBox.hidden = true;
    effectBox.innerHTML = "";
  }
  renderRoomInventory();
  updateChatPlaceholder();

  const choices = (section.choices || []).filter((choice) => choiceConditionMatches(choice, sectionKey));
  renderedChoices = choices;
  const soloBlocked = isSoloBlocked();
  if (!choices.length) {
    const ending = section.ending ? buildEndingNotice(section.ending) : "";
    qs("#choiceList").innerHTML = `<div class="message">선택지가 없습니다. ${ending}</div>`;
    await refreshChoiceProposalUi();
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
    ${choices.map((choice, index) => {
      const disabled = isChoiceDynamicallyDisabled(choice) || soloBlocked;
      const reason = soloBlocked ? "혼자서는 진행할 수 없습니다." : getChoiceDisabledReason(choice);
      const disabledTitle = disabled ? ` title="${safeAttr(reason)}" aria-disabled="true" disabled` : "";
      return `
      <button type="button" class="choice-button ${choice.requires ? "private-choice" : ""} ${isPersonalInstantChoice(choice, sectionKey) ? "instant-choice" : ""} ${disabled ? "disabled-choice" : ""}" data-choice-index="${index}" data-solo-blocked="${soloBlocked ? "1" : "0"}"${disabledTitle}>
        ${safeText(cleanChoiceLabel(choice.label))}
      </button>
    `;
    }).join("")}
  `;

  qs("#choiceList").querySelectorAll("[data-choice-index]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        if (button.disabled) return;
        const choice = choices[Number(button.dataset.choiceIndex)];
        await chooseNext(choice);
      } catch (error) {
        console.error("선택지 처리 실패", error);
        showMessage(`선택지를 처리하지 못했습니다: ${error.message}`, "error");
      }
    });
  });
  await refreshChoiceProposalUi();
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
  const inventory = getCombinedScenarioInventoryMap();
  const scenarioEntries = Object.values(inventory).filter((item) => Number(item.quantity || 0) > 0 && isPersonalDefaultItemVisible(item.itemId));
  const shopEntries = getVisibleShopInventory().map((row) => ({
    itemId: `shop:${getShopItemId(row)}`,
    name: getShopItemName(row),
    type: "shop",
    quantity: Number(row.quantity || 0)
  })).filter((item) => item.itemId !== "shop:");
  const entries = [...scenarioEntries, ...shopEntries];
  if (!entries.length) {
    box.innerHTML = `<div class="inventory-empty">아직 획득한 단서나 아이템이 없습니다.</div>`;
    box.classList.add("muted");
    return;
  }
  box.classList.remove("muted");
  box.innerHTML = entries.map((item) => {
    const meta = String(item.itemId || "").startsWith("shop:") ? getShopItemMeta(item.itemId) : getItemMeta(item.itemId);
    const label = meta?.type === "clue" ? "단서" : (meta?.type === "shop" ? "소지품" : "아이템");
    return `
      <button type="button" class="room-inventory-item" data-room-item="${safeAttr(item.itemId)}">
        <strong>${safeText(meta?.name || item.name || item.itemId)}</strong>
        <span>${safeText(label)} · ×${Number(item.quantity || meta?.quantity || 1)}</span>
      </button>
    `;
  }).join("");
}

function renderDetailText(text = "") {
  return safeText(text || "아직 상세 설명이 등록되지 않았습니다.").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
}

function openRoomItemDetail(itemId) {
  const target = qs("#inventoryDetailBody");
  if (!target) throw new Error("아이템 상세 모달을 찾지 못했습니다.");
  const isShopItem = String(itemId || "").startsWith("shop:");
  const meta = isShopItem ? getShopItemMeta(itemId) : getItemMeta(itemId);
  const cleanItemId = String(itemId || "").replace(/^shop:/, "");
  const itemName = String(meta?.name || "").replace(/\s+/g, "");
  const noUseItem = cleanItemId === "dream_collector" || cleanItemId === "strange_old_coin" || cleanItemId === "glass_pistol" || cleanItemId === "dreamland_map" || cleanItemId === "vip_membership_card" || itemName === "꿈결수집기" || itemName === "낡고이상한동전" || itemName === "유리손포" || itemName === "유리손포도" || itemName === "드림랜드안내팜플렛(지도)" || itemName === "VIP멤버십카드";
  const canUse = !noUseItem && meta?.type !== "clue" && meta?.usable !== false && meta?.noUse !== true && meta?.equipmentOnly !== true;
  const isVipCard = cleanItemId === "vip_membership_card" || itemName === "VIP멤버십카드";
  const adminVipActions = isVipCard && currentProfile?.role === "admin"
    ? `<div class="modal-actions item-use-actions"><button type="button" class="ghost-button danger" data-admin-clear-vip-card="1">저주받은 VIP 카드 삭제</button></div>`
    : "";
  target.innerHTML = `
    <p class="kicker">${safeText(meta?.type === "clue" ? "Clue" : (meta?.type === "shop" ? "Bag Item" : "Item"))}</p>
    <h2>${safeText(meta?.name || itemId)}</h2>
    <div class="party-detail-content item-detail-text">${renderDetailText(meta?.detail || "아직 상세 설명이 등록되지 않았습니다.")}</div>
    ${canUse ? `<div class="modal-actions item-use-actions"><button type="button" class="primary-action" data-use-room-item="${safeAttr(itemId)}">사용</button></div>` : ""}
    ${adminVipActions}
  `;
  openModal("#inventoryDetailModal");
}

function findItemUseRule(itemId) {
  const scenario = getScenario();
  const sectionKey = currentState?.current_section_key || "";
  const cleanId = String(itemId || "").replace(/^shop:/, "");
  const rules = scenario?.itemUseRules || scenario?.itemUses || {};
  const direct = rules?.[cleanId];
  if (!direct) return null;
  if (direct.sections && direct.sections[sectionKey]) return direct.sections[sectionKey];
  if (Array.isArray(direct.allowedSections) && direct.allowedSections.includes(sectionKey)) return direct;
  if (!direct.sections && !direct.allowedSections) return direct;
  return null;
}

async function useRoomInventoryItem(itemId) {
  if (!currentRoom?.id) return showMessage("탐사방 안에서만 사용할 수 있습니다.", "error");
  const isShopItem = String(itemId || "").startsWith("shop:");
  const meta = isShopItem ? getShopItemMeta(itemId) : getItemMeta(itemId);
  if (meta?.type === "clue") return showMessage("단서는 사용할 수 없습니다. 내용을 확인하는 용도입니다.", "error");

  if (isShopItem) {
    const rawId = String(itemId || "").replace(/^shop:/, "");
    const { data, error } = await supabase.rpc("use_exploration_shop_item", { p_room_id: currentRoom.id, p_item_id: rawId });
    if (error) { showMessage(error.message, "error"); return; }
    closeModal("#inventoryDetailModal");
    showMessage(data?.message || "아이템을 사용했습니다.", "success");
    await Promise.all([loadInventory(), loadRoomBundle(currentRoom.id, { silent: true })]);
    return;
  }

  const rule = findItemUseRule(itemId);
  const name = meta?.name || itemId;
  if (!rule) {
    const fallback = String(name).includes("오방사계반") ? "오방사계반이 사방으로 돌고 있습니다." : `${withJosa(name, "이", "가")} 지금은 반응하지 않습니다.`;
    await themedAlert(fallback, "아이템 사용");
    return;
  }

  await themedAlert(rule.message || `${withJosa(name, "이", "가")} 반응했습니다.`, "아이템 사용");
  try {
    await supabase.rpc("log_exploration_system_message", {
      p_room_id: currentRoom.id,
      p_content: `${withJosa(getActorDisplayName(currentProfile?.display_name || "탐사자"), "이", "가")} ${withJosa(name, "을", "를")} 사용했습니다.`
    });
  } catch (error) {
    console.warn("아이템 사용 로그 기록 실패", error);
  }
  const useEffects = [...(rule.effects || [])];
  if (rule.consume === true) {
    useEffects.push({ type: "remove_item", itemId: String(itemId || "").replace(/^shop:/, ""), scope: "self" });
  }
  if (rule.setState || useEffects.length) {
    const effectPatch = buildStatePatchForEffects(useEffects);
    const patch = mergePatches(rule.setState || {}, effectPatch);
    const { error } = await supabase.rpc("patch_exploration_room_state", { p_room_id: currentRoom.id, p_state_patch: patch });
    if (error) showMessage(error.message, "error");
    else await loadRoomBundle(currentRoom.id, { silent: true });
  }
  if (rule.closeAfterUse !== false || rule.consume === true) {
    closeModal("#inventoryDetailModal");
  }
}

async function adminClearVipMembershipCard() {
  if (!currentRoom?.id) return showMessage("탐사방 안에서만 삭제할 수 있습니다.", "error");
  if (currentProfile?.role !== "admin") return showMessage("관리자만 삭제할 수 있습니다.", "error");
  const confirmed = await themedConfirm("현재 파티 조합에 연결된 저주받은 VIP 카드 기록을 삭제할까요? 현재 탐사방 소지창에서도 제거됩니다.", "VIP 카드 삭제");
  if (!confirmed) return;
  try {
    const { data, error } = await supabase.rpc("admin_clear_exploration_vip_membership_flags", { p_room_id: currentRoom.id });
    if (error) throw error;
    closeModal("#inventoryDetailModal");
    showMessage(`VIP 카드 기록을 삭제했습니다. 비활성화 ${Number(data?.cleared_flags || 0)}건, 현재 방 제거 ${data?.room_inventory_cleared ? "완료" : "처리 없음"}.`, "success");
    await loadRoomBundle(currentRoom.id, { silent: true });
  } catch (error) {
    showMessage(`VIP 카드를 삭제하지 못했습니다: ${error.message}`, "error");
  }
}

function isChatNearBottom(box) {
  if (!box) return true;
  return box.scrollHeight - box.scrollTop - box.clientHeight < 48;
}

function ensureNewChatButton() {
  let button = qs("#newChatJumpButton");
  if (button) return button;
  const box = qs("#chatLog");
  const parent = box?.parentElement;
  if (!parent) return null;
  button = document.createElement("button");
  button.id = "newChatJumpButton";
  button.type = "button";
  button.className = "new-chat-jump";
  button.textContent = "새 채팅";
  button.hidden = true;
  button.addEventListener("click", () => {
    const chatBox = qs("#chatLog");
    if (!chatBox) return;
    chatUserPinnedToBottom = true;
    chatBox.scrollTop = chatBox.scrollHeight;
    button.hidden = true;
  });
  parent.insertBefore(button, qs("#chatForm") || null);
  return button;
}

function renderMessages() {
  const box = qs("#chatLog");
  if (!box) return;
  const wasNearBottom = isChatNearBottom(box);
  const previousScrollTop = box.scrollTop;
  const previousLastId = lastRenderedMessageLastId;
  const nextLastId = currentMessages.length ? String(currentMessages[currentMessages.length - 1]?.id || "") : null;
  const hasNewMessage = !!nextLastId && nextLastId !== previousLastId;
  if (!currentMessages.length) {
    box.textContent = "아직 채팅이 없습니다.";
    box.classList.add("muted");
    lastRenderedMessageLastId = null;
    ensureNewChatButton()?.setAttribute("hidden", "");
    return;
  }
  box.classList.remove("muted");
  box.innerHTML = currentMessages.map((message) => {
    const systemClass = message.message_type === "system" ? " system" : "";
    const sender = message.message_type === "system" ? "시스템" : (message.sender_display_name || "익명");
    return `
      <div class="chat-message${systemClass}">
        <strong>${safeText(sender)} · ${formatDate(message.created_at)}</strong>
        <div>${safeText(normalizeDisplayedSystemMessage(message.content || ""))}</div>
        ${message.message_type === "system" ? "" : `<button type="button" class="mini-button danger" data-report-target="room_message" data-report-id="${safeAttr(message.id)}">신고</button>`}
      </div>
    `;
  }).join("");
  const jumpButton = ensureNewChatButton();
  if (wasNearBottom) {
    box.scrollTop = box.scrollHeight;
    if (jumpButton) jumpButton.hidden = true;
    chatUserPinnedToBottom = true;
  } else {
    box.scrollTop = previousScrollTop;
    if (hasNewMessage && jumpButton) jumpButton.hidden = false;
  }
  lastRenderedMessageLastId = nextLastId;
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
    if (String(resultCode).toUpperCase() === "DLBAD001") {
      try {
        const { data: flagData, error: flagError } = await supabase.rpc("grant_exploration_vip_membership_flag", {
          p_room_id: currentRoom.id,
          p_scenario_id: currentRoom.scenario_id,
          p_source_section_key: sectionKey || null
        });
        if (flagError) throw flagError;
        if (flagData?.granted_count || flagData?.existing_count) {
          await restorePersistentExplorationFlags();
        }
      } catch (flagError) {
        showMessage(`VIP 카드 지속 기록은 아직 적용되지 않았습니다: ${flagError.message}`, "error");
      }
    }
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

function getActiveRoomMembers() {
  return (currentMembers || []).filter((member) => !member.left_at);
}

function buildChoiceAdvancePayload(choice) {
  const scenario = getScenario();
  const nextSection = scenario?.sections?.[choice.next];
  const effectPatch = buildStatePatchForEffects([...(choice.effects || []), ...((nextSection?.effects) || [])]);
  return {
    nextSectionKey: choice.next,
    choiceLabel: cleanChoiceLabel(choice.label || ""),
    statePatch: mergePatches(choice.setState || {}, effectPatch),
    proposalMode: choice.proposalMode || "",
    proposalMessage: choice.proposalMessage || "",
    systemMessage: choice.systemMessage || ""
  };
}

function getPendingChoiceProposal() {
  const proposal = getStateJson().pendingChoiceProposal;
  return proposal && typeof proposal === "object" ? proposal : null;
}

function ensureChoiceProposalModal() {
  let modal = qs("#choiceProposalModal");
  if (modal) return modal;
  modal = document.createElement("dialog");
  modal.id = "choiceProposalModal";
  modal.className = "modal-card";
  modal.innerHTML = `
    <h2>진행 제안</h2>
    <div id="choiceProposalBody" class="party-detail-content"></div>
    <div class="modal-actions">
      <button type="button" class="primary-action" data-choice-proposal-response="accept">수락</button>
      <button type="button" class="ghost-button" data-choice-proposal-response="reject">거절</button>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

function renderChoiceProposalNotice() {
  const proposal = getPendingChoiceProposal();
  const oldNotice = qs("#choiceProposalNotice");
  if (oldNotice) oldNotice.remove();
  const choiceList = qs("#choiceList");
  if (!proposal || !choiceList) return;
  const accepted = Array.isArray(proposal.accept_ids) ? proposal.accept_ids.length : 0;
  const required = Number(proposal.required_count || getActiveRoomMembers().length || 0);
  const notice = document.createElement("div");
  notice.id = "choiceProposalNotice";
  notice.className = "message subtle choice-proposal-notice";
  const proposerName = getActorDisplayName(proposal.proposer_name || "누군가");
  notice.textContent = `${getActorDisplayName(proposerName)}님이 진행을 제안했습니다. (${accepted}/${required} 수락)`;
  choiceList.prepend(notice);
}

function renderChoiceProposalModal() {
  const proposal = getPendingChoiceProposal();
  const modal = ensureChoiceProposalModal();
  if (!proposal || !currentProfile?.id || !currentRoom?.id) {
    if (modal.open) closeModal("#choiceProposalModal");
    return;
  }
  const myId = String(currentProfile.id);
  const accepted = Array.isArray(proposal.accept_ids) ? proposal.accept_ids.map(String) : [];
  const rejected = Array.isArray(proposal.reject_ids) ? proposal.reject_ids.map(String) : [];
  const isMine = String(proposal.proposer_id || "") === myId;
  if (isMine || accepted.includes(myId) || rejected.includes(myId)) {
    if (modal.open) closeModal("#choiceProposalModal");
    return;
  }
  const body = qs("#choiceProposalBody");
  const titleNode = qs("#choiceProposalModal h2");
  const isDanger = proposal.proposal_mode === "danger_escape";
  modal.classList.toggle("choice-proposal-danger-modal", isDanger);
  if (titleNode) titleNode.hidden = isDanger;
  if (body) {
    const proposerName = proposal.proposer_name || "누군가";
    const proposerText = getActorDisplayName(proposerName);
    if (isDanger) {
      const message = formatSystemMessageTemplate(proposal.proposal_message || "{actor}님이 혼자 직원 전용 출입구로 도망쳤습니다! 따라가시겠습니까?", proposerName);
      body.innerHTML = `
        <div class="choice-proposal-danger-title"><span class="danger-siren" aria-hidden="true">🚨</span><span>돌발상황</span><span class="danger-siren" aria-hidden="true">🚨</span></div>
        <div class="choice-proposal-danger">${safeText(message)}</div>`;
    } else {
      body.innerHTML = `
        <p><strong>${safeText(proposerText)}이</strong> 아래의 진행을 제안합니다.</p>
        <div class="choice-proposal-choice">${safeText(proposal.choice_label || "다음 행동")}</div>
        <p class="small muted">수락하시겠습니까? 모든 참가자가 동의하면 다음으로 넘어가며, 한 명이라도 거절할 경우 다음으로 넘어가지 않습니다.</p>`;
    }
  }
  openModal("#choiceProposalModal");
}

async function refreshChoiceProposalUi() {
  renderChoiceProposalNotice();
  renderChoiceProposalModal();
}


async function logRoomSystemMessage(content) {
  if (!currentRoom?.id || !content) return;
  const normalizedContent = normalizeDisplayedSystemMessage(content);
  try {
    const { error } = await supabase.rpc("log_exploration_system_message", {
      p_room_id: currentRoom.id,
      p_content: normalizedContent
    });
    if (error) throw error;
  } catch (error) {
    console.warn("시스템 메시지 기록 실패", error);
  }
}

async function logRoomSystemMessageToRoom(roomId, content) {
  if (!roomId || !content) return;
  const normalizedContent = normalizeDisplayedSystemMessage(content);
  try {
    const { error } = await supabase.rpc("log_exploration_system_message", {
      p_room_id: roomId,
      p_content: normalizedContent
    });
    if (error) throw error;
  } catch (error) {
    console.warn("시스템 메시지 기록 실패", error);
  }
}

function getCurrentActorNameForLog() {
  return getMyMemberSnapshot()?.display_name_snapshot || currentProfile?.display_name || "탐사자";
}

function buildActorSystemMessage(verbText) {
  return `${getActorDisplayName(getCurrentActorNameForLog())}이 ${verbText}`;
}

function buildLocalChoiceProposal(payload) {
  const activeMembers = getActiveRoomMembers();
  return {
    id: `local_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    room_id: currentRoom?.id || "",
    proposer_id: currentProfile?.id || "",
    proposer_name: getMyMemberSnapshot()?.display_name_snapshot || currentProfile?.display_name || "탐사자",
    choice_label: payload.choiceLabel || "다음 행동",
    next_section_key: payload.nextSectionKey,
    state_patch: payload.statePatch || {},
    proposal_mode: payload.proposalMode || "",
    proposal_message: payload.proposalMessage || "",
    system_message: payload.systemMessage || "",
    accept_ids: currentProfile?.id ? [String(currentProfile.id)] : [],
    reject_ids: [],
    required_count: activeMembers.length || 1,
    created_at: new Date().toISOString(),
    local_fallback: true
  };
}

async function patchRoomStateLocally(statePatch) {
  if (!currentRoom?.id) throw new Error("탐사방 정보를 찾을 수 없습니다.");
  const { error } = await supabase.rpc("patch_exploration_room_state", {
    p_room_id: currentRoom.id,
    p_state_patch: statePatch || {}
  });
  if (error) throw error;
}

function isMissingRpcError(error) {
  const msg = String(error?.message || "");
  return msg.includes("Could not find the function") || msg.includes("function") || msg.includes("schema cache") || msg.includes("PGRST202");
}

async function proposeChoiceFallback(payload, originalError = null) {
  const proposal = buildLocalChoiceProposal(payload);
  await patchRoomStateLocally({ pendingChoiceProposal: proposal });
  if (proposal.proposal_mode === "danger_escape") {
    const actor = proposal.proposer_name || "탐사자";
    await logRoomSystemMessage(proposal.system_message ? formatSystemMessageTemplate(proposal.system_message, actor) : `${getActorDisplayName(actor)}님이 아직 잠기지 않은 직원 전용 출입구로 홀로 도망을 시도합니다!`);
  } else {
    await logRoomSystemMessage(`${getActorDisplayName(proposal.proposer_name)}님이 진행을 제안했습니다.`);
  }
  if (originalError) console.warn("진행 제안 RPC 실패, 프론트 폴백 사용", originalError);
}

async function respondChoiceProposalFallback(accept, originalError = null) {
  const proposal = getPendingChoiceProposal();
  if (!proposal || !currentRoom?.id || !currentProfile?.id) return;
  const myId = String(currentProfile.id);
  const acceptIds = new Set((Array.isArray(proposal.accept_ids) ? proposal.accept_ids : []).map(String));
  const rejectIds = new Set((Array.isArray(proposal.reject_ids) ? proposal.reject_ids : []).map(String));
  const myName = getMyMemberSnapshot()?.display_name_snapshot || currentProfile?.display_name || "탐사자";
  if (accept) {
    acceptIds.add(myId);
    rejectIds.delete(myId);
    await logRoomSystemMessage(`${withJosa(getActorDisplayName(myName), "이", "가")} 제안을 수락했습니다.`);
    const activeIds = getActiveRoomMembers().map((member) => String(member.user_id));
    const allAccepted = activeIds.length > 0 && activeIds.every((id) => acceptIds.has(id));
    if (allAccepted) {
      const patch = mergePatches(proposal.state_patch || {}, { pendingChoiceProposal: null });
      const { error } = await supabase.rpc("advance_exploration_room", {
        p_room_id: currentRoom.id,
        p_next_section_key: proposal.next_section_key,
        p_choice_label: proposal.choice_label || proposal.next_section_key,
        p_state_patch: patch
      });
      if (error) throw error;
      if (proposal.proposal_mode === "danger_escape") {
        await logRoomSystemMessage("모든 참가자가 그 뒤를 따라 도망치는 것에 성공했습니다.");
      } else {
        await logRoomSystemMessage(`모든 참가자가 제안을 수락했습니다: ${proposal.choice_label || "다음 진행"}`);
      }
    } else {
      const updated = { ...proposal, accept_ids: Array.from(acceptIds), reject_ids: Array.from(rejectIds), required_count: activeIds.length };
      await patchRoomStateLocally({ pendingChoiceProposal: updated });
    }
  } else {
    rejectIds.add(myId);
    if (proposal.proposal_mode === "danger_escape") {
      const patch = mergePatches({ pendingChoiceProposal: null });
      const { error } = await supabase.rpc("advance_exploration_room", {
        p_room_id: currentRoom.id,
        p_next_section_key: "s5_2_a",
        p_choice_label: "VIP손님 전용 휴게실로 안내된다",
        p_state_patch: patch
      });
      if (error) throw error;
      await logRoomSystemMessage(`${getActorDisplayName(proposal.proposer_name || "탐사자")}님의 도주는 실패로 돌아갔습니다.`);
      await logRoomSystemMessage("모든 참가자가 VIP실로 강제로 안내됩니다.");
    } else {
      await patchRoomStateLocally({ pendingChoiceProposal: null });
      await logRoomSystemMessage(`${withJosa(getActorDisplayName(myName), "이", "가")} 제안을 거절했습니다.`);
    }
  }
  if (originalError) console.warn("진행 제안 응답 RPC 실패, 프론트 폴백 사용", originalError);
}

async function proposeChoice(choice) {
  if (!choice?.next || !currentRoom) return;
  const payload = buildChoiceAdvancePayload(choice);
  if (payload.proposalMode === "danger_escape") {
    try {
      await proposeChoiceFallback(payload);
      showMessage("돌발상황 제안을 보냈습니다. 다른 참가자의 선택을 기다립니다.", "success");
      await loadRoomBundle(currentRoom.id, { silent: true });
    } catch (fallbackError) {
      showMessage(`진행 제안을 보내지 못했습니다: ${fallbackError.message}`, "error");
    }
    return;
  }
  try {
    const { error } = await supabase.rpc("propose_exploration_choice", {
      p_room_id: currentRoom.id,
      p_next_section_key: payload.nextSectionKey,
      p_choice_label: payload.choiceLabel,
      p_state_patch: payload.statePatch
    });
    if (error) throw error;
  } catch (error) {
    if (!isMissingRpcError(error)) {
      showMessage(`진행 제안을 보내지 못했습니다: ${error.message}`, "error");
      return;
    }
    try {
      await proposeChoiceFallback(payload, error);
    } catch (fallbackError) {
      showMessage(`진행 제안을 보내지 못했습니다: ${fallbackError.message}`, "error");
      return;
    }
  }
  showMessage("진행 제안을 보냈습니다. 다른 참가자의 수락을 기다립니다.", "success");
  await loadRoomBundle(currentRoom.id, { silent: true });
}

async function respondDangerChoiceProposal(proposal, accept) {
  if (!proposal || !currentRoom?.id || !currentProfile?.id) return;
  const proposerName = getActorDisplayName(proposal.proposer_name || "탐사자");
  const nextKey = accept ? (proposal.next_section_key || "s8_2") : "s5_2_a";
  const choiceLabel = accept ? "직원 전용 출입구로 따라간다" : "VIP손님 전용 휴게실로 안내된다";
  const patch = mergePatches(proposal.state_patch || {}, { pendingChoiceProposal: null });
  const { error } = await supabase.rpc("advance_exploration_room", {
    p_room_id: currentRoom.id,
    p_next_section_key: nextKey,
    p_choice_label: choiceLabel,
    p_state_patch: patch
  });
  if (error) throw error;
  if (accept) {
    await logRoomSystemMessage("모든 참가자가 그 뒤를 따라 도망치는 것에 성공했습니다.");
  } else {
    await logRoomSystemMessage(`${proposerName}님의 도주는 실패로 돌아갔습니다.`);
    await logRoomSystemMessage("모든 참가자가 VIP실로 강제로 안내됩니다.");
  }
}

async function respondChoiceProposal(accept) {
  const proposal = getPendingChoiceProposal();
  if (!proposal || !currentRoom?.id) return;
  if (proposal.proposal_mode === "danger_escape") {
    try {
      await respondDangerChoiceProposal(proposal, !!accept);
      closeModal("#choiceProposalModal");
      showMessage(accept ? "돌발상황을 따라가기로 했습니다." : "거절했습니다. VIP실로 안내됩니다.", accept ? "success" : "info");
      await loadRoomBundle(currentRoom.id, { silent: true });
    } catch (error) {
      showMessage(`제안을 처리하지 못했습니다: ${error.message}`, "error");
    }
    return;
  }
  try {
    const { error } = await supabase.rpc("respond_exploration_choice", {
      p_room_id: currentRoom.id,
      p_proposal_id: proposal.id,
      p_accept: !!accept
    });
    if (error) throw error;
  } catch (error) {
    if (!isMissingRpcError(error)) {
      showMessage(`제안을 처리하지 못했습니다: ${error.message}`, "error");
      return;
    }
    try {
      await respondChoiceProposalFallback(accept, error);
    } catch (fallbackError) {
      showMessage(`제안을 처리하지 못했습니다: ${fallbackError.message}`, "error");
      return;
    }
  }
  closeModal("#choiceProposalModal");
  showMessage(accept ? "제안을 수락했습니다." : "제안을 거절했습니다.", accept ? "success" : "info");
  await loadRoomBundle(currentRoom.id, { silent: true });
}

async function chooseNext(choice) {
  if (choiceClickInProgress) return;
  if (!choice || !currentRoom) return;
  choiceClickInProgress = true;
  try {
  if (isChoiceDynamicallyDisabled(choice)) {
    showMessage(getChoiceDisabledReason(choice), "info");
    return;
  }
  if (isSoloBlocked()) {
    showMessage(currentProfile?.role === "admin" ? "혼자서는 진행할 수 없습니다. 관리자 테스트 코드를 입력하면 진행할 수 있습니다." : "혼자서는 진행할 수 없습니다.", "error");
    return;
  }
  const sectionKey = currentState?.current_section_key || "";
  if (isPersonalInstantChoice(choice, sectionKey)) {
    if (isChoiceAlreadyTakenByMe(choice) && !choice.showWhenTaken) return;
    const statePatch = buildPersonalInstantChoicePatch(choice);
    const { error } = await supabase.rpc("patch_exploration_room_state", {
      p_room_id: currentRoom.id,
      p_state_patch: statePatch
    });
    if (error) {
      showMessage(error.message, "error");
      return;
    }
    choiceClickInProgress = false;
    if (choice.popupMessage) {
      const popupText = formatSystemMessageTemplate(choice.popupMessage, getMyMemberSnapshot()?.display_name_snapshot || currentProfile?.display_name || "탐사자");
      showMessage(popupText, "info");
      await themedAlert(popupText, choice.popupTitle || "아이템 획득");
    }
    if (choice.systemMessage) {
      const actor = getMyMemberSnapshot()?.display_name_snapshot || currentProfile?.display_name || "탐사자";
      logRoomSystemMessage(formatSystemMessageTemplate(choice.systemMessage, actor));
    }
    await loadRoomBundle(currentRoom.id, { silent: true });
    return;
  }
  if (!choice?.next) return;
  const payload = buildChoiceAdvancePayload(choice);
  const shouldPropose = getActiveRoomMembers().length > 1 && !choice.noConsensus && !choice.instant;
  if (shouldPropose) {
    return proposeChoice(choice);
  }
  let statePatch = payload.statePatch || {};
  if (choice.systemMessage) {
    const actor = getMyMemberSnapshot()?.display_name_snapshot || currentProfile?.display_name || "탐사자";
    statePatch = mergePatches(statePatch, { lastEffectLog: [formatSystemMessageTemplate(choice.systemMessage, actor)] });
  }
  if (choice.autoPopupMessage) {
    const actor = getMyMemberSnapshot()?.display_name_snapshot || currentProfile?.display_name || "탐사자";
    showTimedScenarioPopup(formatSystemMessageTemplate(choice.autoPopupMessage, actor), {
      variant: choice.autoPopupVariant || "",
      durationMs: choice.autoPopupDurationMs || 15000
    });
  }
  const { error } = await supabase.rpc("advance_exploration_room", {
    p_room_id: currentRoom.id,
    p_next_section_key: payload.nextSectionKey,
    p_choice_label: payload.choiceLabel,
    p_state_patch: statePatch
  });
  if (error) {
    showMessage(error.message, "error");
    return;
  }
  await loadRoomBundle(currentRoom.id, { silent: true });
  } finally {
    choiceClickInProgress = false;
  }
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
    return `[${formatDate(message.created_at)}] ${sender}: ${normalizeDisplayedSystemMessage(message.content || "")}`;
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
  if (!currentRoom) return false;
  const ok = await themedConfirm(ROOM_EXIT_NOTICE_TEXT, "라이브 룸에서 나가시겠습니까?");
  if (!ok) return false;
  const roomId = currentRoom.id;
  await logRoomSystemMessageToRoom(roomId, `${getActorDisplayName(getCurrentActorNameForLog())}이 퇴장했습니다.`);
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
  return true;
}

async function clearChat() {
  if (!currentRoom) return false;
  const ok = await themedConfirm("현재 방 채팅 로그를 DB에서 삭제할까요? 다운로드하지 않은 로그는 사라집니다.", "채팅 초기화");
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
    ensureReportModal();
  }
  const typeInput = qs("#reportTargetType");
  const idInput = qs("#reportTargetId");
  const rInput = qs("#reportReason");
  const dInput = qs("#reportDetail");
  if (!typeInput || !idInput || !rInput || !dInput) {
    showMessage("신고 창을 열 수 없습니다. 배포 파일을 다시 덮어써 주세요.", "error");
    return;
  }
  typeInput.value = targetType;
  idInput.value = targetId;
  rInput.value = targetType === "room_message" ? "troll" : "abuse";
  dInput.value = "";
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
  if (targetType === "community_post") await loadCommunityPosts();
  if (targetType === "community_comment" && currentCommunityDetailId) {
    const comments = await loadCommunityComments(currentCommunityDetailId);
    renderCommunityComments(comments);
  }
  if (targetType === "party_comment" && currentPartyDetailId) {
    const comments = await loadPartyComments(currentPartyDetailId);
    renderPartyComments(comments);
  }
}

async function loadAdminReports() {
  ensureAdminPanel();
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
      <p class="small muted">신고자: ${safeText(report.reporter_band_nickname || "밴드닉 미등록")} · 아이디 ${safeText(report.reporter_site_id || "알 수 없음")}</p>
      <p class="small muted">신고 대상자: ${safeText(report.target_author_band_nickname || "밴드닉 미등록")} · 아이디 ${safeText(report.target_author_site_id || "알 수 없음")}</p>
      <p>${safeText(report.detail || "상세 내용 없음")}</p>
      <div class="report-snapshot">${safeText(report.content_snapshot || "내용 스냅샷 없음")}</div>
      <div class="party-actions">
        <button type="button" class="secondary-action" data-review-report="accepted" data-report-id="${safeAttr(report.id)}">신고 접수</button>
        <button type="button" class="ghost-button" data-review-report="false_report" data-report-id="${safeAttr(report.id)}">오신고</button>
        <button type="button" class="ghost-button danger" data-review-report="malicious_report" data-report-id="${safeAttr(report.id)}">악의적 신고</button>
      </div>
    </article>
  `).join("");
}

function reportActionLabel(action) {
  if (["false_report", "dismiss_false", "misreport"].includes(action)) return "오신고";
  if (["malicious_report", "dismiss_malicious", "malicious"].includes(action)) return "악의적 신고";
  return "신고 접수";
}

function openReportReviewModal(reportId, action) {
  ensureReportReviewModal();
  const idInput = qs("#reviewReportId");
  const actionInput = qs("#reviewReportAction");
  const noteInput = qs("#reviewReportNote");
  const title = qs("#reviewReportTitle");
  if (idInput) idInput.value = reportId || "";
  if (actionInput) actionInput.value = action || "valid";
  if (noteInput) noteInput.value = "";
  if (title) title.textContent = `신고 검토: ${reportActionLabel(action)}`;
  openModal("#reportReviewModal");
}

async function reviewReport(reportId, action, note = "") {
  const { error } = await supabase.rpc("review_exploration_report", {
    p_action: action,
    p_admin_note: note || null,
    p_report_id: reportId
  });
  if (error) throw error;
  closeModal("#reportReviewModal");
  showMessage("신고 검토를 저장했습니다.", "success");
  await loadAdminReports();
  await updateNotificationBadge();
  await Promise.all([loadPartyPosts(), currentRoom ? loadMessages() : Promise.resolve()]);
}


function setGuidePage(page = 1) {
  const pages = Array.from(document.querySelectorAll("[data-guide-page]"));
  if (!pages.length) return;
  const total = pages.length;
  const nextPage = Math.min(total, Math.max(1, Number(page) || 1));
  pages.forEach((el) => {
    el.hidden = Number(el.dataset.guidePage) !== nextPage;
  });
  const now = qs("#guidePageNow");
  const totalEl = qs("#guidePageTotal");
  if (now) now.textContent = String(nextPage);
  if (totalEl) totalEl.textContent = String(total);
}

function shiftGuidePage(delta = 1) {
  const current = Number(qs("#guidePageNow")?.textContent || 1);
  setGuidePage(current + Number(delta || 0));
}

function initHelpGuide() {
  const widget = qs("#helpGuideWidget");
  const button = qs("#openHelpGuide");
  const bubble = qs("#helpGuideBubble");
  if (!widget || !button) return;
  widget.hidden = false;
  let seen = false;
  try {
    seen = localStorage.getItem("pollution_exploration_help_seen") === "1";
  } catch (error) {
    seen = false;
  }
  if (bubble) bubble.hidden = seen;
  button.addEventListener("click", () => {
    try { localStorage.setItem("pollution_exploration_help_seen", "1"); } catch (error) {}
    if (bubble) bubble.hidden = true;
    setGuidePage(1);
    openModal("#helpGuideModal");
  });
  qs("[data-guide-prev]")?.addEventListener("click", () => shiftGuidePage(-1));
  qs("[data-guide-next]")?.addEventListener("click", () => shiftGuidePage(1));
  setGuidePage(1);
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

function showTimedScenarioPopup(message, options = {}) {
  const text = String(message || "").trim();
  if (!text) return;
  const duration = Number(options.durationMs || 15000);
  const old = qs("#timedScenarioPopup");
  if (old) old.remove();
  const node = document.createElement("div");
  node.id = "timedScenarioPopup";
  node.className = `timed-scenario-popup ${options.variant === "shop-warning" ? "shop-warning" : ""}`;
  node.innerHTML = `<div class="timed-scenario-popup-inner">${safeText(text)}</div>`;
  document.body.appendChild(node);
  window.setTimeout(() => node.classList.add("is-closing"), Math.max(0, duration - 650));
  window.setTimeout(() => node.remove(), duration);
}

function ensureThemedConfirmModal() {
  let modal = qs("#themedConfirmModal");
  if (modal) return modal;
  modal = document.createElement("dialog");
  modal.id = "themedConfirmModal";
  modal.className = "modal-card confirm-modal";
  modal.innerHTML = `
    <h2 id="themedConfirmTitle">확인</h2>
    <div id="themedConfirmMessage" class="confirm-message"></div>
    <div class="modal-actions confirm-actions">
      <button id="themedConfirmOk" type="button" class="primary-action">확인</button>
      <button id="themedConfirmCancel" type="button" class="ghost-button">취소</button>
    </div>`;
  document.body.appendChild(modal);
  return modal;
}

function themedConfirm(message, title = "확인") {
  const modal = ensureThemedConfirmModal();
  const titleNode = qs("#themedConfirmTitle");
  const messageNode = qs("#themedConfirmMessage");
  const okButton = qs("#themedConfirmOk");
  const cancelButton = qs("#themedConfirmCancel");
  if (titleNode) titleNode.textContent = title;
  if (messageNode) messageNode.innerHTML = safeText(message).replace(/\n/g, "<br>");
  return new Promise((resolve) => {
    const cleanup = (result) => {
      okButton?.removeEventListener("click", onOk);
      cancelButton?.removeEventListener("click", onCancel);
      modal.removeEventListener("cancel", onCancel);
      modal.removeEventListener("close", onClose);
      if (modal.open) closeModal("#themedConfirmModal");
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = (event) => { event?.preventDefault?.(); cleanup(false); };
    const onClose = () => cleanup(false);
    okButton?.addEventListener("click", onOk, { once: true });
    cancelButton?.addEventListener("click", onCancel, { once: true });
    modal.addEventListener("cancel", onCancel, { once: true });
    modal.addEventListener("close", onClose, { once: true });
    openModal("#themedConfirmModal");
  });
}

function themedAlert(message, title = "안내") {
  return themedConfirm(message, title);
}


function ensureCommunityPanel() {
  const stage = qs(".broadcast-stage");
  if (!stage) return;
  if (!qs('[data-tab-target="community"]')) {
    const nav = qs("#mainNav");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-tab";
    btn.dataset.tabTarget = "community";
    btn.textContent = "익명 게시판";
    nav?.insertBefore(btn, qs('[data-tab-target="mine"]') || null);
  }
  if (!qs("#tabCommunity")) {
    const panel = document.createElement("section");
    panel.id = "tabCommunity";
    panel.className = "tab-panel";
    panel.dataset.tabPanel = "community";
    panel.hidden = true;
    panel.innerHTML = `
      <div class="list-toolbar community-toolbar">
        <button id="openCreateCommunityModal" type="button" class="write-button">익명 글쓰기</button>
      </div>
      <div id="communityList" class="community-list muted">아직 올라온 익명 게시글이 없습니다.</div>
      <div id="communityPagination" class="pagination-row"></div>`;
    stage.insertBefore(panel, qs("#tabMine") || null);
  }
}

function ensureAdminPanel() {
  const stage = qs(".broadcast-stage");
  if (!stage) return;
  if (!qs("#tabAdmin")) {
    const panel = document.createElement("section");
    panel.id = "tabAdmin";
    panel.className = "tab-panel";
    panel.dataset.tabPanel = "admin";
    panel.hidden = true;
    panel.innerHTML = `
      <div class="list-toolbar admin-toolbar">
        <strong>관리자 검토함</strong>
        <button id="refreshAdminReports" type="button" class="icon-button" aria-label="신고 내역 새로고침" title="새로고침">↻</button>
      </div>
      <div id="adminReportList" class="admin-report-list muted">검토 대기 중인 신고를 불러오는 중...</div>`;
    stage.appendChild(panel);
  }
}

function switchTab(target) {
  if (currentRoom) { forceRoomMode(); return; }
  ensureCommunityPanel();
  ensureAdminPanel();
  ensureDynamicShell();
  const normalizedTarget = target || "rooms";
  document.body.classList.toggle("wide-stage", normalizedTarget === "myContent" || normalizedTarget === "admin");
  document.querySelectorAll("[data-tab-target]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tabTarget === normalizedTarget);
  });
  document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
    const active = panel.dataset.tabPanel === normalizedTarget;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
    panel.style.display = active ? "" : "none";
  });
  if (normalizedTarget === "rooms") loadRoomList();
  if (normalizedTarget === "party") loadPartyPosts();
  if (normalizedTarget === "community") loadCommunityPosts(communityPage || 1);
  if (normalizedTarget === "mine") loadMyRooms();
  if (normalizedTarget === "myContent") loadMyContent(myContentPage || 1);
  if (normalizedTarget === "admin") loadAdminReports();
  if (normalizedTarget === "myContent" || normalizedTarget === "admin") {
    requestAnimationFrame(() => qs(".broadcast-stage")?.scrollIntoView({ block: "start" }));
  }
}


function ensureReportModal() {
  if (qs("#reportModal")) return;
  const modal = document.createElement("dialog");
  modal.id = "reportModal";
  modal.className = "modal-card";
  modal.innerHTML = `
    <form method="dialog" class="modal-close-form"><button class="mini-button" aria-label="닫기">닫기</button></form>
    <h2>신고하기</h2>
    <form id="reportForm" class="stacked-form">
      <input id="reportTargetType" type="hidden">
      <input id="reportTargetId" type="hidden">
      <label>신고 사유
        <select id="reportReason" required>
          <option value="abuse">욕설/비방</option>
          <option value="sexual">성적 발언</option>
          <option value="ad">광고/도배</option>
          <option value="troll">진행 방해</option>
          <option value="other">기타</option>
        </select>
      </label>
      <label>상세 내용
        <textarea id="reportDetail" rows="4" maxlength="500"></textarea>
      </label>
      <button type="submit" class="primary-action">신고 제출</button>
    </form>`;
  document.body.appendChild(modal);
}


function ensureReportReviewModal() {
  if (qs("#reportReviewModal")) return;
  const modal = document.createElement("dialog");
  modal.id = "reportReviewModal";
  modal.className = "modal-card";
  modal.innerHTML = `
    <form method="dialog" class="modal-close-form"><button class="mini-button" aria-label="닫기">닫기</button></form>
    <h2 id="reviewReportTitle">신고 검토</h2>
    <form id="reportReviewForm" class="stacked-form">
      <input id="reviewReportId" type="hidden">
      <input id="reviewReportAction" type="hidden">
      <label>관리자 처리 사유
        <textarea id="reviewReportNote" rows="5" maxlength="800" required placeholder="신고자에게 보일 처리 사유를 입력합니다. 예: 맥락상 규정 위반으로 보기 어려워 반려합니다."></textarea>
      </label>
      <p class="small muted">이 사유는 신고한 이용자가 알림창의 신고 처리 알림에서 확인할 수 있습니다.</p>
      <button type="submit" class="primary-action">검토 저장</button>
    </form>`;
  document.body.appendChild(modal);
}

function ensureCommunityCreateModal() {
  if (qs("#createCommunityModal")) return;
  const modal = document.createElement("dialog");
  modal.id = "createCommunityModal";
  modal.className = "modal-card";
  modal.innerHTML = `
    <form method="dialog" class="modal-close-form"><button class="mini-button" aria-label="닫기">닫기</button></form>
    <h2>익명 게시글 작성</h2>
    <form id="createCommunityForm" class="stacked-form">
      <label>제목
        <input id="communityTitle" type="text" maxlength="90" required>
      </label>
      <label>내용
        <textarea id="communityBody" rows="7" maxlength="2000" required></textarea>
      </label>
      <p class="small muted">화면에는 익명 별명과 소속만 표시됩니다. 신고 검토를 위해 내부 기록에는 작성자 정보가 남습니다.</p>
      <button type="submit" class="primary-action">게시</button>
    </form>`;
  document.body.appendChild(modal);
}

function ensureCommunityDetailModal() {
  if (qs("#communityDetailModal")) return;
  const modal = document.createElement("dialog");
  modal.id = "communityDetailModal";
  modal.className = "modal-card wide-modal";
  modal.innerHTML = `
    <form method="dialog" class="modal-close-form"><button class="mini-button" aria-label="닫기">닫기</button></form>
    <div id="communityDetailBody" class="community-detail-body"></div>
    <section class="comment-panel community-comment-panel">
      <div id="communityCommentList" class="comment-list community-comment-list muted">댓글을 불러오는 중...</div>
      <form id="communityCommentForm" class="comment-form">
        <input id="communityCommentPostId" type="hidden">
        <input id="communityParentCommentId" type="hidden">
        <textarea id="communityCommentBody" rows="3" maxlength="800" placeholder="익명으로 댓글을 남깁니다."></textarea>
        <div class="community-reply-hint" id="communityReplyHint" hidden></div>
        <button type="submit" class="primary-action">댓글 등록</button>
      </form>
    </section>`;
  document.body.appendChild(modal);
}

function ensureDynamicShell() {
  ensureMyContentPanel();
  ensureReportModal();
  ensureReportReviewModal();
  ensureCommunityCreateModal();
  ensureCommunityDetailModal();
  ensureCommunityPanel();
  ensureAdminPanel();
  const nav = qs("#mainNav");
  if (nav) {
    qs('[data-tab-target="notifications"]')?.remove();
    if (!qs('[data-tab-target="community"]')) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nav-tab";
      btn.dataset.tabTarget = "community";
      btn.textContent = "익명 게시판";
      const mine = qs('[data-tab-target="mine"]');
      nav.insertBefore(btn, mine || null);
      btn.addEventListener("click", () => switchTab("community"));
    }
  }
  ensureNotificationCenter();
  ensureAdminDeskButton();
}

function ensureNotificationCenter() {
  // 알림 버튼은 헤더 메뉴가 아니라 캐릭터 카드 안에 둔다.
  // renderProfile()에서 현재 로그인 캐릭터 이름 옆에 생성한다.
  qs(".site-header #notificationBell")?.remove();
  if (!qs("#notificationCenterModal")) {
    const modal = document.createElement("dialog");
    modal.id = "notificationCenterModal";
    modal.className = "modal-card notification-modal";
    modal.innerHTML = `
      <form method="dialog" class="modal-close-form"><button class="mini-button" aria-label="닫기">닫기</button></form>
      <h2>알림</h2>
      <div class="notification-toolbar">
        <div class="segmented-tabs" role="tablist">
          <button type="button" class="mini-button is-active" data-notification-mode="party">파티글 알림</button>
          <button type="button" class="mini-button" data-notification-mode="community">게시판 알림</button>
          <button type="button" class="mini-button" data-notification-mode="reports">신고 접수</button>
        </div>
        <button id="refreshNotifications" type="button" class="icon-button" aria-label="알림 새로고침" title="새로고침">↻</button>
      </div>
      <div id="notificationList" class="notification-list muted">알림을 불러오는 중...</div>`;
    document.body.appendChild(modal);
  }
}


function ensureAdminDeskButton() {
  ensureMyContentPanel();
  const desk = qs(".action-card");
  if (desk && !qs("#adminDeskButton")) {
    const btn = document.createElement("button");
    btn.id = "adminDeskButton";
    btn.type = "button";
    btn.className = "ghost-button full requires-admin";
    btn.hidden = currentProfile?.role !== "admin";
    btn.textContent = "관리자 검토함";
    desk.appendChild(btn);
  }
}


function notificationReadKey(mode) {
  const uid = currentProfile?.id || "guest";
  return `exploration_notification_read_${uid}_${mode || "party"}`;
}

function getNotificationReadAt(mode) {
  return Number(localStorage.getItem(notificationReadKey(mode)) || 0);
}

function markNotificationsRead(mode) {
  localStorage.setItem(notificationReadKey(mode), String(Date.now()));
  updateNotificationBadge().catch(() => {});
}

async function fetchNotificationItems(mode) {
  let rpc = "list_exploration_party_notifications";
  if (mode === "community") rpc = "list_exploration_community_notifications";
  if (mode === "reports") rpc = "list_my_exploration_report_results";
  const { data, error } = await supabase.rpc(rpc, { p_limit: 30 });
  if (error) throw error;
  return data || [];
}

async function updateNotificationBadge() {
  const bell = qs("#notificationBell");
  const badge = qs("#notificationBadge");
  if (!bell || !badge || !currentProfile) return;
  try {
    const [partyItems, communityItems, reportItems] = await Promise.all([fetchNotificationItems("party"), fetchNotificationItems("community"), fetchNotificationItems("reports")]);
    const countNew = (items, mode) => {
      const readAt = getNotificationReadAt(mode);
      return items.filter((item) => new Date(item.created_at).getTime() > readAt).length;
    };
    const count = countNew(partyItems, "party") + countNew(communityItems, "community") + countNew(reportItems, "reports");
    badge.hidden = count <= 0;
    badge.textContent = count > 99 ? "99+" : String(count);
    bell.classList.toggle("has-unread", count > 0);
  } catch (_) {
    badge.hidden = true;
    bell.classList.remove("has-unread");
  }
}

async function openNotificationCenter(mode = notificationMode) {
  ensureNotificationCenter();
  notificationMode = mode || "party";
  openModal("#notificationCenterModal");
  await loadNotifications(notificationMode);
  markNotificationsRead(notificationMode);
}

async function loadNotifications(mode = notificationMode) {
  const box = qs("#notificationList");
  if (!box || !currentProfile) return;
  notificationMode = mode || "party";
  document.querySelectorAll("[data-notification-mode]").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.notificationMode === notificationMode));
  box.textContent = "알림을 불러오는 중...";
  box.classList.add("muted");
  let items = [];
  try {
    items = await fetchNotificationItems(notificationMode);
  } catch (error) {
    box.textContent = `알림을 불러오지 못했습니다: ${error.message}`;
    return;
  }
  const readAt = getNotificationReadAt(notificationMode);
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const visibleItems = items.filter((item) => {
    const itemTime = new Date(item.created_at).getTime();
    if (!Number.isFinite(itemTime)) return true;
    const isRead = readAt && itemTime <= readAt;
    return !(isRead && nowMs - itemTime > twoDaysMs);
  });
  if (!visibleItems.length) {
    box.textContent = notificationMode === "community" ? "익명 게시판 알림이 없습니다." : (notificationMode === "reports" ? "신고 처리 알림이 없습니다." : "파티글 알림이 없습니다.");
    return;
  }
  box.classList.remove("muted");
  box.innerHTML = visibleItems.map((item) => `
    <article class="notification-item">
      <div>
        <strong>${safeText(item.title || "알림")}</strong>
        <p>${safeText(item.body || "")}</p>
        <span class="small muted">${formatDate(item.created_at)}</span>
      </div>
      ${item.link_type === "party_post" ? `<button type="button" class="ghost-button" data-detail-party="${safeAttr(item.link_id)}" data-notification-open="1">열기</button>` : ""}
      ${item.link_type === "community_post" ? `<button type="button" class="ghost-button" data-detail-community="${safeAttr(item.link_id)}" data-notification-open="1">열기</button>` : ""}
    </article>`).join("");
}

ensureDynamicShell();


async function switchTabAndOpenParty(postId) {
  if (currentRoom) return;
  switchTab("party");
  if (!partyListCache.some((post) => post.id === postId)) await loadPartyPosts();
  await openPartyDetail(postId);
}

async function switchTabAndOpenCommunity(postId) {
  if (currentRoom) return;
  switchTab("community");
  if (!communityListCache.some((post) => post.id === postId)) await loadCommunityPosts(1);
  await openCommunityDetail(postId);
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
  await Promise.all([loadRoomList(), loadPartyPosts(), loadCommunityPosts(), loadMyRooms(), loadNotifications().catch(() => {})]);
  updateNotificationBadge().catch(() => {});
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

qs(".brand-home")?.addEventListener("click", async (event) => {
  if (!currentRoom) return;
  event.preventDefault();
  const href = event.currentTarget?.getAttribute("href") || "index.html";
  const left = await leaveCurrentRoom();
  if (left) window.location.href = href;
});

initHelpGuide();

qs("#chatLog")?.addEventListener("scroll", () => {
  const box = qs("#chatLog");
  chatUserPinnedToBottom = isChatNearBottom(box);
  if (chatUserPinnedToBottom) {
    const button = qs("#newChatJumpButton");
    if (button) button.hidden = true;
  }
});

document.addEventListener("click", async (event) => {
  const delegatedRoomItem = event.target.closest("[data-room-item]");
  if (delegatedRoomItem && delegatedRoomItem.closest("#roomInventoryList")) {
    event.preventDefault();
    try {
      openRoomItemDetail(delegatedRoomItem.dataset.roomItem);
    } catch (error) {
      console.error("아이템 상세 표시 실패", error);
      showMessage(`아이템 설명을 불러오지 못했습니다: ${error.message}`, "error");
    }
    return;
  }
  const delegatedChoiceButton = event.target.closest("[data-choice-index]");
  if (delegatedChoiceButton && delegatedChoiceButton.closest("#choiceList")) {
    event.preventDefault();
    if (delegatedChoiceButton.disabled) return;
    try {
      const choice = renderedChoices[Number(delegatedChoiceButton.dataset.choiceIndex)];
      await chooseNext(choice);
    } catch (error) {
      console.error("선택지 처리 실패", error);
      showMessage(`선택지를 처리하지 못했습니다: ${error.message}`, "error");
    }
    return;
  }
  const bell = event.target.closest("#notificationBell");
  if (bell) { await openNotificationCenter(notificationMode); return; }
  const adminDesk = event.target.closest("#adminDeskButton");
  if (adminDesk) { switchTab("admin"); return; }
  const myContentDesk = event.target.closest("#myContentDeskButton");
  if (myContentDesk) { switchTab("myContent"); await loadMyContent(1); return; }
  const navTab = event.target.closest("[data-tab-target]");
  if (navTab) {
    if (currentRoom) {
      event.preventDefault();
      const left = await leaveCurrentRoom();
      if (left) switchTab(navTab.dataset.tabTarget);
      return;
    }
    switchTab(navTab.dataset.tabTarget);
    return;
  }
  const modeBtn = event.target.closest("[data-notification-mode]");
  if (modeBtn) { await loadNotifications(modeBtn.dataset.notificationMode); markNotificationsRead(modeBtn.dataset.notificationMode); return; }
  const refresh = event.target.closest("#refreshNotifications");
  if (refresh) { await loadNotifications(notificationMode); markNotificationsRead(notificationMode); return; }
  const detailParty = event.target.closest("[data-detail-party]");
  if (detailParty) {
    if (detailParty.closest("#notificationCenterModal")) closeModal("#notificationCenterModal");
    if (detailParty.closest("#partyDetailModal")) closeModal("#partyDetailModal");
    await switchTabAndOpenParty(detailParty.dataset.detailParty);
    return;
  }
  const detailCommunity = event.target.closest("[data-detail-community]");
  if (detailCommunity) {
    if (detailCommunity.closest("#notificationCenterModal")) closeModal("#notificationCenterModal");
    await switchTabAndOpenCommunity(detailCommunity.dataset.detailCommunity);
    return;
  }
  const openCommunity = event.target.closest("#openCreateCommunityModal");
  if (openCommunity) { ensureCommunityCreateModal(); openModal("#createCommunityModal"); return; }
  const myPageBtn = event.target.closest("[data-my-content-page]");
  if (myPageBtn) { await loadMyContent(myPageBtn.dataset.myContentPage === "next" ? myContentPage + 1 : myContentPage - 1); return; }
  const myDeleteBtn = event.target.closest("[data-delete-my-content]");
  if (myDeleteBtn) { await deleteMyContentItems([myDeleteBtn.dataset.deleteMyContent]); return; }
  const mySelect = event.target.closest("[data-my-content-select]");
  if (mySelect) {
    if (mySelect.checked) myContentSelection.add(mySelect.dataset.myContentSelect);
    else myContentSelection.delete(mySelect.dataset.myContentSelect);
    return;
  }
  const myDeleteSelected = event.target.closest("#deleteSelectedMyContent");
  if (myDeleteSelected) { await deleteMyContentItems([...myContentSelection]); return; }
  const myDeleteAll = event.target.closest("#deleteAllMyContent");
  if (myDeleteAll) { await deleteMyContentItems(myContentCache.map((item) => `${item.kind}:${item.item_id}`)); return; }
  const myRefresh = event.target.closest("#refreshMyContent");
  if (myRefresh) { await loadMyContent(myContentPage); return; }
  const adminClearVipButton = event.target.closest("[data-admin-clear-vip-card]");
  if (adminClearVipButton) { await adminClearVipMembershipCard(); return; }
  const useRoomItemButton = event.target.closest("[data-use-room-item]");
  if (useRoomItemButton) { await useRoomInventoryItem(useRoomItemButton.dataset.useRoomItem); return; }
  const choiceProposalResponse = event.target.closest("[data-choice-proposal-response]");
  if (choiceProposalResponse) { await respondChoiceProposal(choiceProposalResponse.dataset.choiceProposalResponse === "accept"); return; }
  const reportButton = event.target.closest("[data-report-target]");
  if (reportButton) { openReportModal(reportButton.dataset.reportTarget, reportButton.dataset.reportId); return; }
});


// adminDeskButton is handled by delegated document click listener.

qs("#openCreateCommunityModal")?.addEventListener("click", () => { ensureCommunityCreateModal(); openModal("#createCommunityModal"); });

async function handleCreateCommunitySubmit(event) {
  event.preventDefault();
  event.stopPropagation();
  const titleInput = qs("#communityTitle");
  const bodyInput = qs("#communityBody");
  try {
    const { error } = await supabase.rpc("create_exploration_community_post", {
      p_title: titleInput?.value.trim() || "",
      p_body: bodyInput?.value.trim() || ""
    });
    if (error) throw error;
    closeModal("#createCommunityModal");
    qs("#createCommunityForm")?.reset();
    showMessage("익명 게시글을 올렸습니다.", "success");
    await switchTab("community");
    await loadCommunityPosts(1);
    await updateNotificationBadge();
  } catch (error) { showMessage(error.message, "error"); }
}

qs("#createCommunityForm")?.addEventListener("submit", handleCreateCommunitySubmit);
document.addEventListener("submit", async (event) => {
  if (!event.target.closest("#createCommunityForm")) return;
  if (event.__communityHandled) return;
  event.__communityHandled = true;
  await handleCreateCommunitySubmit(event);
});

qs("#communityList")?.addEventListener("click", async (event) => {
  const detail = event.target.closest("[data-detail-community]");
  const del = event.target.closest("[data-delete-community-post]");
  const pageBtn = event.target.closest("[data-community-page]");
  if (detail) return openCommunityDetail(detail.dataset.detailCommunity);
  if (del) {
    if (!(await themedConfirm("이 게시글을 삭제할까요?", "삭제 확인"))) return;
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
    if (!(await themedConfirm("이 게시글을 삭제할까요?", "삭제 확인"))) return;
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
    if (!(await themedConfirm("이 댓글을 삭제할까요?", "삭제 확인"))) return;
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
    const postId = qs("#communityCommentPostId").value;
    const { error } = await supabase.rpc("create_exploration_community_comment", {
      p_post_id: postId,
      p_body: body,
      p_parent_comment_id: parentId
    });
    if (error) throw error;
    qs("#communityCommentBody").value = "";
    qs("#communityParentCommentId").value = "";
    qs("#communityReplyHint").hidden = true;
    const comments = await loadCommunityComments(currentCommunityDetailId);
    renderCommunityComments(comments);
    updateCommunityCommentCount(postId, comments.length);
    await loadCommunityPosts(communityPage);
    await loadNotifications("community");
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
    const visibility = qs("#resumeRoomVisibility")?.value || "private";
    const roomPassword = qs("#resumeRoomPassword")?.value.trim() || "";
    if (visibility === "private" && !/^\d{1,8}$/.test(roomPassword)) {
      throw new Error("비공개방 비밀번호는 숫자 1~8자리로 입력하세요.");
    }
    await createRoom({
      scenarioId: save.scenarioId,
      title: qs("#resumeRoomTitle").value.trim() || `${save.roomTitle || "탐사"} 이어하기`,
      maxPlayers: 3,
      startSectionKey: save.currentSectionKey,
      stateJson: save.stateJson || {},
      visibility,
      roomPassword
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
      const ok = await themedConfirm("이 탐사방을 관리자 권한으로 삭제할까요? 채팅과 진행 상태도 함께 삭제됩니다.", "관리자 삭제");
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

qs("#openCreatePartyModal")?.addEventListener("click", () => {
  setupPartyDateInputs("party");
  openModal("#createPartyModal");
});

["partyRecruitmentStartAt", "partyRecruitmentDurationDays"].forEach((id) => {
  qs(`#${id}`)?.addEventListener("change", () => syncPartyDateLimits("party"));
});
["editPartyRecruitmentStartAt", "editPartyRecruitmentDurationDays"].forEach((id) => {
  qs(`#${id}`)?.addEventListener("change", () => syncPartyDateLimits("editParty"));
});

document.addEventListener("click", (event) => {
  const shiftButton = event.target.closest("[data-shift-datetime]");
  if (!shiftButton) return;
  shiftDateTimeInput(shiftButton.dataset.shiftDatetime, Number(shiftButton.dataset.shiftMonths || 0));
});

qs("#createPartyForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const partyDates = validatePartyDateInputs("party");
    const { error } = await supabase.rpc("create_exploration_party_post", {
      p_title: qs("#partyTitle").value.trim(),
      p_scenario_id: qs("#partyScenarioSelect").value || null,
      p_play_time: null,
      p_content: qs("#partyContent").value.trim() || null,
      p_recruitment_start_at: partyDates.recruitmentStartIso,
      p_recruitment_deadline: partyDates.deadlineIso,
      p_exploration_starts_at: partyDates.startIso,
      p_recruitment_capacity: partyDates.capacity
    });
    if (error) throw error;
    closeModal("#createPartyModal");
    qs("#createPartyForm").reset();
    await loadPartyPosts();
    await loadNotifications("party");
    showMessage("익명 모집글을 올렸습니다.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
});


qs("#partyList")?.addEventListener("click", async (event) => {
  const pageButton = event.target.closest("[data-party-page]");
  if (pageButton) {
    partyPage += pageButton.dataset.partyPage === "next" ? 1 : -1;
    renderPartyPosts();
    return;
  }
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
      qs("#editPartyContent").value = post.content || "";
      qs("#editPartyRecruitmentCapacity").value = String(Math.min(3, Math.max(2, Number(post.recruitment_capacity || 2))));
      setupPartyDateInputs("editParty", post);
      openModal("#editPartyModal");
      return;
    }
    if (deleteButton) {
      const ok = await themedConfirm("이 익명 모집글을 삭제할까요?", "삭제 확인");
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
      qs("#partyRoomMaxPlayers").value = String(Math.min(3, Math.max(2, Number(post.recruitment_capacity || post.applicant_count || 2))));
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
  const ok = await themedConfirm("이 댓글을 삭제할까요?", "삭제 확인");
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
    const partyDates = validatePartyDateInputs("editParty");
    const { error } = await supabase.rpc("update_exploration_party_post", {
      p_post_id: qs("#editPartyId").value,
      p_title: qs("#editPartyTitle").value.trim(),
      p_scenario_id: qs("#editPartyScenarioSelect").value || null,
      p_play_time: null,
      p_content: qs("#editPartyContent").value.trim() || null,
      p_recruitment_start_at: partyDates.recruitmentStartIso,
      p_recruitment_deadline: partyDates.deadlineIso,
      p_exploration_starts_at: partyDates.startIso,
      p_recruitment_capacity: partyDates.capacity
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
    if (!(await requireEntityLifeMask())) return;
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

qs("#resumeRoomVisibility")?.addEventListener("change", () => {
  const isPrivate = qs("#resumeRoomVisibility").value === "private";
  qs("#resumeRoomPasswordField").hidden = !isPrivate;
  qs("#resumeRoomPassword").required = isPrivate;
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

document.addEventListener("submit", async (event) => {
  if (!event.target.closest("#reportForm")) return;
  event.preventDefault();
  try {
    await submitReport({
      targetType: qs("#reportTargetType")?.value,
      targetId: qs("#reportTargetId")?.value,
      reason: qs("#reportReason")?.value,
      detail: qs("#reportDetail")?.value.trim()
    });
  } catch (error) {
    showMessage(error.message, "error");
  }
});


document.addEventListener("submit", async (event) => {
  if (!event.target.closest("#reportReviewForm")) return;
  event.preventDefault();
  try {
    const note = qs("#reviewReportNote")?.value.trim() || "";
    if (!note) throw new Error("관리자 처리 사유를 입력해 주세요.");
    await reviewReport(qs("#reviewReportId")?.value, qs("#reviewReportAction")?.value, note);
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#refreshAdminReports")?.addEventListener("click", () => loadAdminReports());

document.addEventListener("click", async (event) => {
  const reviewButton = event.target.closest("[data-review-report]");
  if (!reviewButton) return;
  openReportReviewModal(reviewButton.dataset.reportId, reviewButton.dataset.reviewReport);
});

qs("#refreshRoomInventory")?.addEventListener("click", async () => {
  try {
    await loadInventory();
    renderRoomInventory();
    showMessage("탐사 인벤토리를 다시 불러왔습니다.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
});

qs("#roomInventoryList")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-room-item]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  try {
    openRoomItemDetail(button.dataset.roomItem);
  } catch (error) {
    console.error("아이템 상세 표시 실패", error);
    showMessage(`아이템 설명을 불러오지 못했습니다: ${error.message}`, "error");
  }
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
      await Promise.all([loadRoomList(), loadPartyPosts(), loadCommunityPosts(), loadMyRooms(), loadNotifications().catch(() => {})]);
  updateNotificationBadge().catch(() => {});
    } catch (error) {
      showMessage(error.message, "error");
    }
  }
});

try {
  await loadScenarioList();
  await loadProfile();
  if (currentProfile) {
    await Promise.all([loadRoomList(), loadPartyPosts(), loadCommunityPosts(), loadMyRooms(), loadNotifications().catch(() => {})]);
  updateNotificationBadge().catch(() => {});
  }
} catch (error) {
  showLoggedOutView();
  showMessage(error.message || "초기 화면을 불러오지 못했습니다.", "error");
}
