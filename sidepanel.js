const state = {
  running: false,
  total: 20,
  current: 0,
  results: [],
  errors: [],
  batchId: "",
  accountEmail: "",
  forwardEmail: "",
  lastSavedBatchId: "",
  history: []
};

const els = {
  pageStatus: document.getElementById("pageStatus"),
  scanPage: document.getElementById("scanPage"),
  coordinatorStatus: document.getElementById("coordinatorStatus"),
  globalTasks: document.getElementById("globalTasks"),
  count: document.getElementById("count"),
  runSwitch: document.getElementById("runSwitch"),
  startLabel: document.getElementById("startLabel"),
  delaySeconds: document.getElementById("delaySeconds"),
  saveSettings: document.getElementById("saveSettings"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  progressText: document.getElementById("progressText"),
  countText: document.getElementById("countText"),
  progressBar: document.getElementById("progressBar"),
  message: document.getElementById("message"),
  results: document.getElementById("results"),
  copyCurrent: document.getElementById("copyCurrent"),
  clearCurrent: document.getElementById("clearCurrent"),
  history: document.getElementById("history"),
  clearHistory: document.getElementById("clearHistory"),
  sharedHistory: document.getElementById("sharedHistory")
};

init();

function init() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.source === "hme-content" && message.event === "state") {
      applyContentState(message.payload);
    }
  });

  els.scanPage.addEventListener("click", () => scanPage());
  els.runSwitch.addEventListener("change", () => render());
  els.start.addEventListener("click", () => startBatch());
  els.stop.addEventListener("click", () => sendCommand("stop"));
  els.saveSettings.addEventListener("click", saveSettings);
  els.copyCurrent.addEventListener("click", () => copyText(state.results.join("\n")));
  els.clearCurrent.addEventListener("click", clearCurrent);
  els.clearHistory.addEventListener("click", clearHistory);

  chrome.storage.local.get(["hmeCurrent", "hmeHistory", "hmeSettings"], (data) => {
    const current = data.hmeCurrent || {};
    const settings = data.hmeSettings || {};
    els.count.value = clampInt(settings.count, 1, 50, 20);
    els.startLabel.value = clampInt(settings.startLabel, 0, 999999, 1);
    els.delaySeconds.value = clampNumber(settings.delaySeconds, 0, 300, 1.2);
    state.results = Array.isArray(current.results) ? current.results : [];
    state.running = Boolean(current.running);
    state.total = Number(current.total || settings.count || els.count.value || 20);
    state.current = Number(current.current || state.results.length || 0);
    state.batchId = current.batchId || "";
    state.accountEmail = current.accountEmail || "";
    state.forwardEmail = current.forwardEmail || "";
    state.history = Array.isArray(data.hmeHistory) ? data.hmeHistory : [];
    render();
    scanPage();
  });
}

async function startBatch() {
  if (!els.runSwitch.checked) {
    render("请先打开运行开关");
    return;
  }

  const count = clampInt(els.count.value, 1, 50, 20);
  const startLabel = clampInt(els.startLabel.value, 0, 999999, 1);
  const delayMs = Math.round(clampNumber(els.delaySeconds.value, 0, 300, 1.2) * 1000);

  const scanResponse = await sendCommand("scan");
  if (!scanResponse?.ok || !scanResponse.data?.ready) {
    render(scanResponse?.error || "请先打开隐藏邮件地址列表");
    return;
  }
  const scan = scanResponse.data;
  if (!scan.accountEmail || !scan.forwardEmail) {
    render("没有读取到 Apple 登录账号或转发邮箱");
    return;
  }

  Object.assign(state, {
    running: true,
    accountEmail: scan.accountEmail,
    forwardEmail: scan.forwardEmail,
    total: count,
    current: 0,
    results: [],
    errors: [],
    batchId: "",
    lastSavedBatchId: ""
  });
  render("正在发送开始指令");

  const response = await sendCommand("start", { count, startLabel, delayMs });
  if (!response?.ok) {
    state.running = false;
    render(response?.error || "启动失败");
  }
}

async function scanPage() {
  const response = await sendCommand("scan");
  if (!response?.ok) {
    els.pageStatus.textContent = response?.error || "页面检测失败";
    return;
  }

  const scan = response.data || {};
  state.accountEmail = scan.accountEmail || state.accountEmail;
  state.forwardEmail = scan.forwardEmail || state.forwardEmail;
  const pageName = {
    list: "列表页",
    create: "创建页",
    detail: "详情页",
    privacy: "隐私页",
    login: "登录页",
    unknown: "未知页面"
  }[scan.page || "unknown"];

  if (scan.ready) {
    const forwarding = state.forwardEmail ? ` · 转发至 ${state.forwardEmail}` : "";
    els.pageStatus.textContent = `${pageName}，可开始${state.accountEmail ? ` · ${state.accountEmail}` : ""}${forwarding}`;
  } else if (state.accountEmail) {
    els.pageStatus.textContent = `${pageName} · ${state.accountEmail} · 请打开隐藏邮件地址列表`;
  } else {
    els.pageStatus.textContent = `${pageName}，请回到隐藏邮件地址列表`;
  }

  els.countText.textContent = scan.count == null ? "列表数量：未知" : `列表数量：${scan.count}`;
}

function applyContentState(payload) {
  state.running = Boolean(payload.running);
  state.total = Number(payload.total || state.total || 20);
  state.current = Number(payload.current || 0);
  state.results = Array.isArray(payload.results) ? payload.results : state.results;
  state.errors = Array.isArray(payload.errors) ? payload.errors : [];
  state.batchId = payload.batchId || state.batchId;
  state.accountEmail = payload.accountEmail || payload.scan?.accountEmail || state.accountEmail;
  state.forwardEmail = payload.forwardEmail || payload.scan?.forwardEmail || state.forwardEmail;

  if (payload.scan?.count != null) {
    els.countText.textContent = `列表数量：${payload.scan.count}`;
  }

  render(payload.message || "");
  persistCurrent();

  if (["complete", "stopped", "error", "limit"].includes(payload.status) && state.results.length > 0) {
    saveHistory(payload.status);
  }
}

function render(message = "") {
  const total = Math.max(1, Number(state.total || els.count.value || 20));
  const current = Math.min(total, Number(state.current || state.results.length || 0));
  const percent = Math.round((current / total) * 100);

  els.progressText.textContent = `${current} / ${total}`;
  els.progressBar.style.width = `${percent}%`;
  els.results.value = state.results.join("\n");
  els.message.textContent = message || (state.running ? "运行中" : "等待开始");
  els.start.disabled = state.running || !els.runSwitch.checked;
  els.stop.disabled = !state.running;
  els.copyCurrent.disabled = state.results.length === 0;
  els.clearCurrent.disabled = state.running || state.results.length === 0;
  els.saveSettings.disabled = state.running;

  renderHistory();
}

function renderHistory() {
  if (!state.history.length) {
    els.history.innerHTML = '<div class="history-item"><small>暂无历史批次</small></div>';
    return;
  }

  els.history.innerHTML = "";
  for (const batch of state.history.slice(0, 10)) {
    const item = document.createElement("div");
    item.className = "history-item";

    const title = document.createElement("strong");
    title.textContent = batch.accountEmail || "未记录账号";

    const meta = document.createElement("small");
    const statusText = statusLabel(batch.status, true);
    const forwarding = batch.forwardEmail ? `转发至 ${batch.forwardEmail} · ` : "";
    meta.textContent = `${forwarding}${batch.createdAt} · ${batch.results.length} 个 · ${statusText}`;

    const copy = document.createElement("button");
    copy.className = "secondary";
    copy.textContent = "复制本批";
    copy.addEventListener("click", () => copyText(batch.results.join("\n")));

    item.append(title, meta, copy);
    els.history.appendChild(item);
  }
}

function persistCurrent() {
  chrome.storage.local.set({
    hmeCurrent: {
      batchId: state.batchId,
      accountEmail: state.accountEmail,
      forwardEmail: state.forwardEmail,
      total: state.total,
      current: state.current,
      running: state.running,
      results: state.results,
      updatedAt: new Date().toISOString()
    }
  });
}

function saveHistory(status) {
  if (!state.batchId || state.lastSavedBatchId === state.batchId) {
    return;
  }
  state.lastSavedBatchId = state.batchId;
  const batch = {
    id: state.batchId,
    accountEmail: state.accountEmail || "",
    forwardEmail: state.forwardEmail || "",
    status,
    createdAt: new Date().toLocaleString(),
    results: [...state.results]
  };
  state.history = [batch, ...state.history.filter((item) => item.id !== batch.id)].slice(0, 30);
  chrome.storage.local.set({ hmeHistory: state.history }, renderHistory);
}

function clearCurrent() {
  Object.assign(state, { current: 0, results: [], errors: [], batchId: "" });
  chrome.storage.local.remove("hmeCurrent", () => render("已清空本批次"));
}

function clearHistory() {
  state.history = [];
  chrome.storage.local.remove("hmeHistory", renderHistory);
}

function saveSettings() {
  const settings = {
    count: clampInt(els.count.value, 1, 50, 20),
    startLabel: clampInt(els.startLabel.value, 0, 999999, 1),
    delaySeconds: clampNumber(els.delaySeconds.value, 0, 300, 1.2)
  };

  els.count.value = settings.count;
  els.startLabel.value = settings.startLabel;
  els.delaySeconds.value = settings.delaySeconds;
  chrome.storage.local.set({ hmeSettings: settings }, () => render("配置已保存"));
}

function renderGlobalTasks(clients) {
  if (!clients.length) {
    els.globalTasks.innerHTML = '<div class="history-item"><small>暂无已连接浏览器</small></div>';
    return;
  }

  els.globalTasks.innerHTML = "";
  for (const client of clients.slice(0, 10)) {
    const item = document.createElement("div");
    item.className = "global-task";

    const head = document.createElement("div");
    head.className = "task-head";
    const name = document.createElement("strong");
    name.textContent = client.browserName || "未知浏览器";
    const status = document.createElement("small");
    status.textContent = statusLabel(client.status, client.online);
    head.append(name, status);

    const account = document.createElement("div");
    account.className = "task-account";
    account.textContent = client.accountEmail || "尚未读取账号";

    const meta = document.createElement("div");
    meta.className = "task-meta";
    const forwarding = client.forwardEmail ? `转发至：${client.forwardEmail} · ` : "";
    meta.textContent = `${forwarding}${client.current || 0} / ${client.total || 0}`;

    const progress = document.createElement("div");
    progress.className = "task-progress";
    const bar = document.createElement("span");
    const total = Math.max(1, Number(client.total || 0));
    bar.style.width = `${Math.min(100, Math.round((Number(client.current || 0) / total) * 100))}%`;
    progress.appendChild(bar);

    const message = document.createElement("div");
    message.className = "task-message";
    message.textContent = client.message || client.updatedAt || "等待任务";

    item.append(head, account, meta, progress, message);
    if (Array.isArray(client.results) && client.results.length) {
      const copy = document.createElement("button");
      copy.className = "secondary task-copy";
      copy.textContent = `复制 ${client.results.length} 个`;
      copy.addEventListener("click", () => copyText(client.results.join("\n")));
      item.appendChild(copy);
    }
    els.globalTasks.appendChild(item);
  }
}

function renderSharedHistory(batches) {
  if (!batches.length) {
    els.sharedHistory.innerHTML = '<div class="history-item"><small>暂无共享历史</small></div>';
    return;
  }

  els.sharedHistory.innerHTML = "";
  for (const batch of batches.slice(0, 20)) {
    const item = document.createElement("div");
    item.className = "history-item";
    const title = document.createElement("strong");
    title.textContent = `${batch.browserName || "未知浏览器"} · ${batch.accountEmail || "未记录账号"}`;
    const meta = document.createElement("small");
    const forwarding = batch.forwardEmail ? `转发至 ${batch.forwardEmail} · ` : "";
    meta.textContent = `${forwarding}${formatDate(batch.updatedAt)} · ${batch.results?.length || 0} 个 · ${statusLabel(batch.status, true)}`;
    item.append(title, meta);
    if (Array.isArray(batch.results) && batch.results.length) {
      const copy = document.createElement("button");
      copy.className = "secondary";
      copy.textContent = "复制本批";
      copy.addEventListener("click", () => copyText(batch.results.join("\n")));
      item.appendChild(copy);
    }
    els.sharedHistory.appendChild(item);
  }
}

function statusLabel(status, online) {
  if (!online) return "离线";
  return {
    claimed: "准备启动",
    running: "运行中",
    complete: "已完成",
    stopped: "已停止",
    error: "失败",
    limit: "已达上限",
    offline: "离线",
    idle: "空闲"
  }[status] || status || "空闲";
}

function formatDate(value) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function sendCommand(command, options = {}) {
  try {
    return await chrome.runtime.sendMessage({
      source: "hme-sidepanel",
      command,
      options
    });
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

async function copyText(text) {
  if (!text) {
    render("没有可复制的邮箱");
    return;
  }
  await navigator.clipboard.writeText(text);
  render("已复制到剪贴板");
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function clampNumber(value, min, max, fallback) {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}
