(() => {
  if (window.__hmeSidebarAssistantLoaded) {
    return;
  }
  window.__hmeSidebarAssistantLoaded = true;

  const EMAIL_RE = /[A-Z0-9._%+-]+@icloud\.com/gi;
  const DEFAULT_DELAY_MS = 1200;
  const DEFAULT_TIMEOUT_MS = 90000;
  const HEARTBEAT_INTERVAL_MS = 30000;

  class LimitReachedError extends Error {
    constructor(message) {
      super(message);
      this.name = "LimitReachedError";
    }
  }

  let heartbeatTimer = null;

  const state = {
    running: false,
    stopRequested: false,
    batchId: "",
    accountEmail: "",
    forwardEmail: "",
    total: 0,
    startLabel: 1,
    delayMs: DEFAULT_DELAY_MS,
    current: 0,
    results: [],
    errors: [],
    message: ""
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.source !== "hme-background") {
      return false;
    }

    if (message.command === "scan") {
      sendResponse({ ok: true, data: scanPage() });
      return false;
    }

    if (message.command === "stop") {
      state.stopRequested = true;
      emit("正在停止，当前步骤完成后会停下");
      sendResponse({ ok: true });
      return false;
    }

    if (message.command === "start") {
      if (state.running) {
        sendResponse({ ok: false, error: "已有任务正在运行" });
        return false;
      }

      runBatch(message.options || {}).catch(() => {});
      sendResponse({ ok: true });
      return false;
    }

    sendResponse({ ok: false, error: "未知命令" });
    return false;
  });

  async function runBatch(options) {
    const total = clampInt(options.count, 1, 50, 20);
    const startLabel = clampInt(options.startLabel, 0, 999999, 1);
    const delayMs = clampInt(options.delayMs, 0, 300000, DEFAULT_DELAY_MS);

    Object.assign(state, {
      running: true,
      stopRequested: false,
      batchId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      accountEmail: getLoggedInAccountEmail(),
      forwardEmail: getSelectedForwardEmail(),
      total,
      startLabel,
      delayMs,
      current: 0,
      results: [],
      errors: [],
      message: ""
    });

    startHeartbeat();
    emit("任务开始");

    try {
      if (!state.accountEmail) {
        throw new Error("没有读取到 Apple 登录账号");
      }
      if (!state.forwardEmail) {
        throw new Error("没有读取到当前选中的转发邮箱");
      }
      await ensureListPage();

      for (let index = 0; index < total; index += 1) {
        if (state.stopRequested) {
          emit("已停止", "stopped");
          break;
        }

        const label = String(startLabel + index);
        state.current = index + 1;
        emit(`正在创建第 ${state.current} / ${total} 个，标签 ${label}`);

        const email = await createOne(label);
        state.results.push(email);
        emit(`已创建：${email}`, "running", email);

        await ensureListPage();

        if (index < total - 1 && delayMs > 0) {
          await sleep(delayMs);
        }
      }

      state.running = false;
      stopHeartbeat();
      if (state.stopRequested) {
        emit("任务已停止", "stopped");
      } else {
        emit(`完成，本批次新增 ${state.results.length} 个`, "complete");
      }
    } catch (error) {
      state.running = false;
      stopHeartbeat();
      state.current = state.results.length;
      const message = error.message || String(error);
      state.errors.push({ message });
      emit(message, error instanceof LimitReachedError ? "limit" : "error");
    }
  }

  async function createOne(label) {
    const plusButton = await waitFor(() => findCreateNewButton(), "没有找到“创建新地址”按钮");
    clickElement(plusButton);

    const candidateEmail = await waitFor(() => {
      const emails = getVisibleIcloudEmails();
      return emails.length === 1 ? emails[0] : "";
    }, "没有读取到新生成的邮箱地址");

    const labelInput = await waitFor(() => findLabelInput(), "没有找到标签输入框");
    setInputValue(labelInput, label);

    const createButton = await waitFor(() => {
      const button = findCreateEmailButton();
      return button && !isDisabled(button) ? button : null;
    }, "创建按钮没有变为可点击");
    clickElement(createButton);

    await waitFor(() => {
      const text = pageText();
      return text.includes(candidateEmail) && isDetailPage(candidateEmail);
    }, "提交后没有进入已创建详情页");

    return candidateEmail;
  }

  async function ensureListPage() {
    if (isLoginPage()) {
      throw new Error("Apple 页面需要重新登录");
    }

    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (findCreateNewButton()) {
        return;
      }

      const back = findBackButton();
      if (back && !isDisabled(back)) {
        clickElement(back);
        await sleep(2500);
        continue;
      }

      await sleep(1000);
    }

    await waitFor(() => findCreateNewButton(), "请先停留在隐藏邮件地址列表页");
  }

  function scanPage() {
    const text = pageText();
    const countMatch = text.match(/(\d+)\s*个使用中/);
    const emails = getVisibleIcloudEmails();
    const accountEmail = getLoggedInAccountEmail();
    let page = "unknown";

    if (isLoginPage()) {
      page = "login";
    } else if (findCreateNewButton()) {
      page = "list";
    } else if (text.includes("创建新地址")) {
      page = "create";
    } else if (emails.length === 1 && isDetailPage(emails[0])) {
      page = "detail";
    } else if (location.pathname.includes("/section/privacy")) {
      page = "privacy";
    }

    return {
      page,
      ready: page === "list",
      count: countMatch ? Number(countMatch[1]) : null,
      accountEmail,
      forwardEmail: getSelectedForwardEmail(),
      currentEmail: emails.length === 1 ? emails[0] : "",
      running: state.running,
      results: [...state.results],
      errors: [...state.errors]
    };
  }

  function emit(message, status = state.running ? "running" : "idle", lastEmail = "") {
    state.message = message;
    const payload = {
      source: "hme-content",
      event: "state",
      payload: {
        batchId: state.batchId,
        accountEmail: state.accountEmail || getLoggedInAccountEmail(),
        forwardEmail: state.forwardEmail || getSelectedForwardEmail(),
        running: state.running,
        status,
        total: state.total,
        current: state.current,
        startLabel: state.startLabel,
        results: [...state.results],
        errors: [...state.errors],
        lastEmail,
        message,
        scan: scanPage(),
        updatedAt: new Date().toISOString()
      }
    };

    try {
      const maybePromise = chrome.runtime.sendMessage(payload);
      if (maybePromise?.catch) {
        maybePromise.catch(() => {});
      }
    } catch {
      // Progress updates are best effort; the page automation should keep running.
    }
  }

  function findCreateNewButton() {
    const iconButtons = visibleButtons()
      .filter((button) => normalize(button.innerText).includes("创建新地址"));
    if (iconButtons.length) {
      return iconButtons[0];
    }

    const listTools = visibleButtons()
      .filter((button) => String(button.className).includes("button-icon"))
      .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
    return listTools[1] || null;
  }

  function findButtonByText(text) {
    return visibleButtons().find((button) => normalize(button.innerText).includes(text)) || null;
  }

  function findCreateEmailButton() {
    const byText = findButtonByText("创建电子邮件地址");
    if (byText) {
      return byText;
    }

    return visibleButtons()
      .filter((button) => !isDisabled(button))
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width >= 120 && rect.height <= 60 && rect.y > 650 && rect.x > window.innerWidth / 2;
      })
      .sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x)[0] || null;
  }

  function findBackButton() {
    const byText = findButtonByText("返回");
    if (byText) {
      return byText;
    }

    return visibleButtons()
      .filter((button) => !isDisabled(button))
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        const className = String(button.className || "");
        return (
          rect.width >= 120 &&
          rect.height <= 60 &&
          rect.y > 650 &&
          rect.x < window.innerWidth / 2 &&
          !className.includes("button-bare")
        );
      })
      .sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0] || null;
  }

  function isDetailPage(email) {
    const textareas = Array.from(document.querySelectorAll("textarea")).filter(isVisible);
    const hasBottomRightSubmit = visibleButtons().some((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width >= 120 && rect.height <= 60 && rect.y > 650 && rect.x > window.innerWidth / 2;
    });

    return pageText().includes(email) && textareas.length === 0 && !hasBottomRightSubmit;
  }

  function isLoginPage() {
    return location.pathname.includes("/sign-in") || pageText().includes("登录以管理你的账户");
  }

  function findLabelInput() {
    const inputs = Array.from(document.querySelectorAll("input"))
      .filter((input) => isVisible(input) && !isDisabled(input))
      .filter((input) => {
        const type = (input.getAttribute("type") || "text").toLowerCase();
        return type === "text" || type === "";
      })
      .filter((input) => {
        const placeholder = normalize(input.getAttribute("placeholder") || "");
        const aria = normalize(input.getAttribute("aria-label") || "");
        return !placeholder.includes("搜索") && !aria.includes("搜索");
      })
      .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);

    return inputs[0] || null;
  }

  function visibleButtons() {
    return Array.from(document.querySelectorAll("button")).filter(isVisible);
  }

  function getVisibleIcloudEmails() {
    return Array.from(new Set((pageText().match(EMAIL_RE) || []).map((email) => email.toLowerCase())));
  }

  function getLoggedInAccountEmail() {
    const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
    const profileRightEdge = window.innerWidth * 0.35;
    const candidates = Array.from(document.querySelectorAll("span, p, div"))
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = normalize(element.textContent);
        const match = text.match(emailPattern);
        const inDialog = Boolean(element.closest('[role="dialog"], [aria-modal="true"]'));

        if (
          !match ||
          inDialog ||
          rect.left >= profileRightEdge ||
          rect.top < 100 ||
          rect.top > 500 ||
          text.length > 240
        ) {
          return null;
        }

        let score = 1000 - text.length;
        if (element.children.length === 0) score += 200;
        if (rect.width <= 400) score += 100;
        if (element.closest("button")) score -= 400;

        return { email: match[0].toLowerCase(), score, top: rect.top };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.top - b.top);

    return candidates[0]?.email || "";
  }

  function getSelectedForwardEmail() {
    const selected =
      document.querySelector('input[type="radio"][name="forwardToEmail"]:checked') ||
      Array.from(document.querySelectorAll('input[type="radio"]:checked')).find((input) =>
        String(input.value || "").includes("@")
      );
    if (!selected) {
      return "";
    }

    const value = normalize(selected.value);
    if (value.includes("@")) {
      return value.toLowerCase();
    }

    const labelText = normalize(
      selected.labels?.[0]?.textContent || selected.closest("label")?.textContent || ""
    );
    const match = labelText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match?.[0]?.toLowerCase() || "";
  }

  function pageText() {
    return document.body?.innerText || "";
  }

  function clickElement(element) {
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
  }

  function setInputValue(input, value) {
    input.scrollIntoView({ block: "center", inline: "center" });
    input.focus();
    const prototype = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function waitFor(predicate, errorMessage, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const startedAt = Date.now();
    let lastValue = null;
    while (Date.now() - startedAt < timeoutMs) {
      throwIfCreationLimitReached();
      if (state.stopRequested && !state.running) {
        throw new Error("任务已停止");
      }
      lastValue = predicate();
      if (lastValue) {
        return lastValue;
      }
      await sleep(300);
    }
    throw new Error(errorMessage);
  }

  function throwIfCreationLimitReached() {
    const text = normalize(pageText()).toLowerCase();
    const chineseLimit = text.includes("上限") && (
      text.includes("电子邮件地址") ||
      text.includes("隐藏邮件地址") ||
      text.includes("郵件地址")
    );
    const englishLimit = (text.includes("reached the limit") || text.includes("maximum number")) &&
      text.includes("email address");

    if (chineseLimit || englishLimit) {
      throw new LimitReachedError(`Apple 已达到创建上限，本批次已保留 ${state.results.length} 个邮箱`);
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = window.setInterval(() => {
      if (state.running) {
        emit(state.message || "任务运行中", "running");
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  }

  function isDisabled(element) {
    return element.disabled || element.getAttribute("aria-disabled") === "true";
  }

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function clampInt(value, min, max, fallback) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, number));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
