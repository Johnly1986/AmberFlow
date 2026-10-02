// Service worker: relay page state from the content script to the local laya
// server. The fetch must live here -- host_permissions grant CORS only to the
// extension's own contexts, not to the page origin the content script runs in.
const SERVER = "http://127.0.0.1:8765";

chrome.commands.onCommand.addListener((command) => {
  if (command !== "trigger-picker") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: "PICKER_TRIGGER" });
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "PICKER_STATE") return false;
  fetch(`${SERVER}/pick`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: msg.state }),
  })
    .then((r) => {
      if (!r.ok) throw new Error(`server ${r.status}`);
      return r.json();
    })
    .then((decision) => sendResponse({ ok: true, decision }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // keep the message channel open for the async response
});
