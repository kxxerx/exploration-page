// pollution-exploration-standalone: v0.3
import { supabase } from "./supabaseClient.js";

export function qs(selector) {
  return document.querySelector(selector);
}

let messageHideTimer = null;

export function showMessage(message, type = "info") {
  const box = qs("#message");
  if (!box) {
    alert(message);
    return;
  }
  if (messageHideTimer) {
    clearTimeout(messageHideTimer);
    messageHideTimer = null;
  }
  box.textContent = message;
  box.className = `message ${type}`;
  box.style.display = "block";
  messageHideTimer = window.setTimeout(() => {
    box.style.display = "none";
    box.textContent = "";
    messageHideTimer = null;
  }, 10000);
}

export function authEmailFromLoginId(loginId) {
  const value = String(loginId || "").trim().toLowerCase();
  if (value.includes("@")) return value;
  return `${value}@pollution.invalid`;
}

export async function revealMemberLinks() {
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  document.querySelectorAll(".requires-login").forEach((node) => {
    node.hidden = !data.session;
  });
  return data.session;
}

export function applyVisitorModeClass(profile) {
  const isEntity = profile?.visitor_type === "entity";
  const isInfected = profile?.visitor_type === "infected";
  document.documentElement.classList.toggle("entity-mode", isEntity);
  document.body.classList.toggle("entity-mode", isEntity);
  document.documentElement.classList.toggle("infected-mode", isInfected);
  document.body.classList.toggle("infected-mode", isInfected);
}
