const APPLE_ACCOUNT_PATTERN = /^https:\/\/account\.apple\.com\//;
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.source === "hme-content" && message.event === "state") {
    reportContentState(message.payload || {}).catch(() => {});
    return false;
  }

  if (message?.source !== "hme-sidepanel") {
    return false;
  }

  handleSidepanelMessage(message)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });

  return true;
});

async function handleSidepanelMessage(message) {
  switch (message.command) {
    default:
      return forwardToActiveAppleTab(message);
  }
}

async function reportContentState(payload) {
  await persistContentState(payload);
}

async function persistContentState(payload) {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const current = {
    batchId: payload.batchId || "",
    accountEmail: payload.accountEmail || payload.scan?.accountEmail || "",
    forwardEmail: payload.forwardEmail || payload.scan?.forwardEmail || "",
    total: Number(payload.total || 0),
    current: Number(payload.current || results.length || 0),
    running: Boolean(payload.running),
    results,
    updatedAt: payload.updatedAt || new Date().toISOString()
  };
  await chrome.storage.local.set({ hmeCurrent: current });

  const terminal = ["complete", "stopped", "error", "limit"].includes(payload.status);
  if (!terminal || !current.batchId || results.length === 0) {
    return;
  }

  const stored = await chrome.storage.local.get("hmeHistory");
  const history = Array.isArray(stored.hmeHistory) ? stored.hmeHistory : [];
  const batch = {
    id: current.batchId,
    accountEmail: current.accountEmail,
    forwardEmail: current.forwardEmail,
    status: payload.status,
    createdAt: new Date().toLocaleString(),
    results: [...results]
  };
  const nextHistory = [batch, ...history.filter((item) => item.id !== batch.id)].slice(0, 30);
  await chrome.storage.local.set({ hmeHistory: nextHistory });
}

async function forwardToActiveAppleTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("没有找到当前活动标签页");
  }
  if (!APPLE_ACCOUNT_PATTERN.test(tab.url || "")) {
    throw new Error("请先切到 account.apple.com 的隐私邮箱页面");
  }

  const payload = {
    source: "hme-background",
    command: message.command,
    options: message.options || {}
  };

  try {
    return await chrome.tabs.sendMessage(tab.id, payload);
  } catch (firstError) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    try {
      return await chrome.tabs.sendMessage(tab.id, payload);
    } catch {
      throw firstError;
    }
  }
}
