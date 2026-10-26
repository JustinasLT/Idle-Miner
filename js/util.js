"use strict";
const $ = (id) => document.getElementById(id);
const rnd = (a, b) => a + Math.random() * (b - a);
const pct = (x) => (x * 100).toFixed(x >= 0.1 ? 0 : 1) + "%";
const SUFFIX = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"];
function formatMoney(n) {
  if (!(n >= 1000)) return "$" + Math.floor(n || 0);
  const e = Math.min(SUFFIX.length - 1, Math.floor(Math.log10(n) / 3));
  const v = n / Math.pow(10, e * 3);
  return "$" + v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + SUFFIX[e];
}
const formatToken = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1000 ? (n / 1000).toFixed(2) + "K" : n >= 10 ? n.toFixed(2) : n.toFixed(4));
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}
function setText(el, s) { if (el && el._t !== s) { el.textContent = s; el._t = s; } }
function bump(el) {
  if (!el) return;
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
}
// one shared popup (upgrade picker, confirmations)
let modalHook = null;
function openModal(html, cls = "") { $("dyn-box").className = "modal " + cls; $("dyn-box").innerHTML = html; $("dyn-modal").classList.remove("hidden"); }
function closeModal() {
  $("dyn-modal").classList.add("hidden");
  if (modalHook) modalHook();
  modalHook = null;
}
function confirmModal(title, text, yes, fn) {
  openModal(`<h2>${title}</h2><p>${text}</p><div class="modal-actions"><button type="button" class="btn-primary" id="m-yes">${yes}</button><button type="button" class="btn-secondary" id="m-no">Cancel</button></div>`);
  $("m-yes").onclick = () => { closeModal(); fn(); };
  $("m-no").onclick = closeModal;
}
// like confirmModal, but the player has to type a word first (reset / delete)
function typedConfirm(title, text, word, yes, fn) {
  openModal(`<h2>${title}</h2><p>${text}</p><p class="small">Type <b>${word}</b> to continue:</p>
    <input id="tc-in" class="name-in" autocomplete="off" autocapitalize="characters" spellcheck="false" />
    <div class="modal-actions"><button type="button" class="btn-primary danger" id="tc-yes" disabled>${yes}</button><button type="button" class="btn-secondary" id="tc-no">Cancel</button></div>`);
  const inp = $("tc-in"), ok = () => inp.value.trim().toUpperCase() === word;
  inp.oninput = () => { $("tc-yes").disabled = !ok(); };
  $("tc-yes").onclick = () => { if (ok()) { closeModal(); fn(); } };
  $("tc-no").onclick = closeModal;
  inp.focus();
}
