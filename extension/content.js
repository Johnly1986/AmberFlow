// Content script: on PICKER_TRIGGER, extract a compact page state, get laya's
// decision from the background worker, then either click the chosen element or
// render a candidate panel for the human.

function extractState() {
  const main = document.querySelector("main") || document.body;
  const visible = [...document.querySelectorAll("button, a")]
    .filter((el) => el.offsetParent !== null)
    .map((el) => (el.innerText || "").trim())
    .filter(Boolean)
    .slice(0, 20);
  return {
    url: location.href,
    title: document.title,
    main_text: (main.innerText || "").slice(0, 600),
    visible_buttons: visible,
  };
}

function clickBySelector(sel) {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`selector not found: ${sel}`);
  el.click();
  return el;
}

function panel(decision) {
  document.getElementById("laya-panel")?.remove();
  const box = document.createElement("div");
  box.id = "laya-panel";
  Object.assign(box.style, {
    position: "fixed", top: "16px", right: "16px", zIndex: 2147483647,
    background: "#fff", border: "1px solid #ddd", borderRadius: "10px",
    boxShadow: "0 8px 24px rgba(0,0,0,.18)", padding: "12px", width: "280px",
    font: "13px/1.5 system-ui, sans-serif", color: "#111",
  });
  const head = document.createElement("div");
  head.textContent = decision.reason || "laya suggestion";
  head.style.cssText = "font-weight:600;margin-bottom:8px";
  box.appendChild(head);

  for (const c of decision.candidates || []) {
    const row = document.createElement("button");
    row.textContent = `${c.label}  ${(c.probability * 100).toFixed(1)}%`;
    row.style.cssText = "display:block;width:100%;text-align:left;margin:4px 0;padding:6px 8px;" +
      "border:1px solid #e3e3e3;border-radius:6px;background:#fafafa;cursor:pointer";
    row.onmouseenter = () => (row.style.background = "#eef4ff");
    row.onmouseleave = () => (row.style.background = "#fafafa");
    row.onclick = () => {
      try {
        clickBySelector(c.selector);
        box.remove();
      } catch (e) {
        head.textContent = String(e);
      }
    };
    box.appendChild(row);
  }
  const close = document.createElement("button");
  close.textContent = "×";
  close.style.cssText = "position:absolute;top:4px;right:8px;border:0;background:none;" +
    "font-size:16px;cursor:pointer";
  close.onclick = () => box.remove();
  box.appendChild(close);
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 15000);
}

function runPicker() {
  chrome.runtime.sendMessage({ type: "PICKER_STATE", state: extractState() }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      console.warn("[laya] picker server unreachable:", res?.error || chrome.runtime.lastError);
      panel({ reason: "picker server unreachable — is `uvicorn picker_server:app --port 8765` running?", candidates: [] });
      return;
    }
    const d = res.decision;
    if (d.auto_execute) {
      try { clickBySelector(d.selector); } catch (e) { console.warn("[laya]", e); }
    } else {
      panel(d);
    }
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PICKER_TRIGGER") runPicker();
});

// Test hook: DOM events cross isolated worlds, so a page (or a Playwright test)
// can dispatch `document.dispatchEvent(new Event('laya-trigger'))` to run the
// same handler as the Ctrl+Shift+K command.
document.addEventListener("laya-trigger", runPicker);
