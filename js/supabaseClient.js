import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

let configModule = null;
try {
  configModule = await import("./config.js");
} catch (error) {
  const message = "js/config.js를 찾지 못했습니다. 배포 전용 ZIP을 올릴 때 기존 저장소의 js/config.js가 유지됐는지 확인해 주세요.";
  const box = document.querySelector("#message");
  if (box) {
    box.textContent = message;
    box.className = "message error";
    box.style.display = "block";
  }
  document.querySelector("#appPanel")?.removeAttribute("hidden");
  document.querySelector("#loginPanel")?.removeAttribute("hidden");
  throw new Error(message);
}

export const SUPABASE_URL = configModule.SUPABASE_URL;
export const SUPABASE_ANON_KEY = configModule.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  const message = "Supabase URL 또는 anon key가 비어 있습니다. js/config.js 값을 확인해 주세요.";
  const box = document.querySelector("#message");
  if (box) {
    box.textContent = message;
    box.className = "message error";
    box.style.display = "block";
  }
  document.querySelector("#appPanel")?.removeAttribute("hidden");
  document.querySelector("#loginPanel")?.removeAttribute("hidden");
  throw new Error(message);
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
