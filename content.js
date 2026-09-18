(() => {
  if (window.__hmeSidebarAssistantLoaded) {
    return;
  }
  window.__hmeSidebarAssistantLoaded = true;

  // 只用于“找地址”的宽松邮箱匹配：页面上出现的所有邮箱都要能看到，
  // 不能只匹配 @icloud.com，否则转发邮箱/账号邮箱会被漏掉而造成误判。
  const EMAIL_ANY_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const DEFAULT_DELAY_MS = 1200;
  const DEFAULT_TIMEOUT_MS = 90000;
  const HEARTBEAT_INTERVAL_MS = 30000;
  // 新地址出现后，若同时出现多个“新地址”，先宽容这段时间再判定为异常
  const AMBIGUOUS_GRACE_MS = 5000;

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
        // 批次结束自检：结果里出现重复 = 识别出错的强烈信号，必须显式告警而不是静默保存
        const duplicates = state.results.filter((email, index) => state.results.indexOf(email) !== index);
        if (duplicates.length) {
          emit(
            `完成，但 ${state.results.length} 个结果里有 ${duplicates.length} 个重复（如 ${duplicates[0]}），疑似识别错误，请核对后再使用`,
            "error"
          );
        } else if (state.results.length !== total) {
          emit(`完成，本批次新增 ${state.results.length} 个，少于预期的 ${total} 个，请核对`, "error");
        } else {
          emit(`完成，本批次新增 ${state.results.length} 个`, "complete");
        }
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
    // 点击“创建新地址”之前先给页面上的邮箱拍一次快照，
    // 之后只有“快照里没有的新地址”才可能是本次生成的地址。
    const before = collectEmails();

    const plusButton = await waitFor(() => findCreateNewButton(), "没有找到“创建新地址”按钮");
    clickElement(plusButton);

    const candidateEmail = await readNewCandidate(before);
    if (blockedEmails().has(candidateEmail)) {
      throw new Error(`本次读取到的新地址与转发邮箱/账号邮箱相同（${candidateEmail}），已停止以免记错数据`);
    }

    const labelInput = await waitFor(() => findLabelInput(), "没有找到标签输入框");
    setInputValue(labelInput, label);

    const createButton = await waitFor(() => {
      const button = findCreateEmailButton();
      return button && !isDisabled(button) ? button : null;
    }, "创建按钮没有变为可点击");
    clickElement(createButton);

    await confirmCreatedAddress(candidateEmail);

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
    const currentAddress = readVisibleAddress();
    const accountEmail = getLoggedInAccountEmail();
    let page = "unknown";

    if (isLoginPage()) {
      page = "login";
    } else if (findCreateNewButton()) {
      page = "list";
    } else if (text.includes("创建新地址")) {
      page = "create";
    } else if (currentAddress && isDetailPageShape()) {
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
      currentEmail: currentAddress,
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

  function isDetailPageShape() {
    const textareas = Array.from(document.querySelectorAll("textarea")).filter(isVisible);
    const hasBottomRightSubmit = visibleButtons().some((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width >= 120 && rect.height <= 60 && rect.y > 650 && rect.x > window.innerWidth / 2;
    });

    return textareas.length === 0 && !hasBottomRightSubmit;
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

  // 收集页面上所有邮箱：innerText + 所有 input/textarea 的 value。
  // 关键点：innerText 不含输入框的值，而新生成的地址正是渲染在输入框里的，
  // 少了这一步页面上就只剩“转发邮箱”一个可见地址，整批都会被记成它。
  function collectEmails() {
    const parts = [pageText()];
    Array.from(document.querySelectorAll("input, textarea")).forEach((element) => {
      const value = element.value || element.getAttribute("value") || "";
      if (value) {
        parts.push(value);
      }
    });
    return new Set((parts.join("\n").match(EMAIL_ANY_RE) || []).map((email) => email.toLowerCase()));
  }

  // “转发到”（forwardToEmail）单选组里的地址全是别人的地址，绝不能当成新生成的地址
  function getForwardOptionEmails() {
    const found = new Set();
    Array.from(document.querySelectorAll('input[type="radio"]')).forEach((input) => {
      const value = normalize(input.value).toLowerCase();
      if (value.includes("@")) {
        found.add(value);
      }

      const label = input.closest("label") || input.labels?.[0] || input.parentElement;
      const text = normalize(label?.textContent || "");
      if (text.length <= 200) {
        (text.match(EMAIL_ANY_RE) || []).forEach((email) => found.add(email.toLowerCase()));
      }
    });
    return found;
  }

  // 绝不可能等于本次生成地址的集合：账号邮箱、当前转发的目标邮箱、转发候选、本批已收集的结果
  function blockedEmails() {
    return new Set(
      [state.accountEmail, state.forwardEmail, ...getForwardOptionEmails(), ...state.results]
        .filter(Boolean)
        .map((email) => String(email).toLowerCase())
    );
  }

  // 只在“同时出现多个新地址”时用来排除干扰：读含“转发/forward”字样的小块文本里的地址。
  // 只在候选多于一个时参与筛选，因此不会把唯一候选误排除。
  function getForwardContextEmails() {
    const found = new Set();
    Array.from(document.querySelectorAll("label, li, p, span, div")).forEach((element) => {
      if (element.children.length > 3 || !isVisible(element)) {
        return;
      }
      const text = normalize(element.textContent);
      if (!text || text.length > 200) {
        return;
      }
      if (!text.includes("转发") && !/forward/i.test(text)) {
        return;
      }
      (text.match(EMAIL_ANY_RE) || []).forEach((email) => found.add(email.toLowerCase()));
    });
    return found;
  }

  // 当前页面上唯一一个“不是转发邮箱/账号邮箱/历史结果”的地址，即本页正在展示的地址
  function readVisibleAddress() {
    const blocked = blockedEmails();
    const emails = Array.from(collectEmails()).filter((email) => !blocked.has(email));
    if (emails.length === 1) {
      return emails[0];
    }

    const forwardContext = getForwardContextEmails();
    const narrowed = emails.filter((email) => !forwardContext.has(email));
    return narrowed.length === 1 ? narrowed[0] : "";
  }

  // 找到“本次新出现的地址”：与点击前的快照求差，并剔除转发邮箱/账号邮箱/历史结果
  async function readNewCandidate(before) {
    const startedAt = Date.now();
    let ambiguousSince = 0;
    let lastSeen = "";

    while (Date.now() - startedAt < DEFAULT_TIMEOUT_MS) {
      throwIfCreationLimitReached();
      if (state.stopRequested && !state.running) {
        throw new Error("任务已停止");
      }

      const blocked = blockedEmails();
      const fresh = Array.from(collectEmails()).filter(
        (email) => !before.has(email) && !blocked.has(email)
      );
      lastSeen = fresh.join("、");

      if (fresh.length === 1) {
        return fresh[0];
      }

      if (fresh.length > 1) {
        const forwardContext = getForwardContextEmails();
        const narrowed = fresh.filter((email) => !forwardContext.has(email));
        if (narrowed.length === 1) {
          return narrowed[0];
        }

        ambiguousSince = ambiguousSince || Date.now();
        if (Date.now() - ambiguousSince > AMBIGUOUS_GRACE_MS) {
          throw new Error(
            `创建页同时出现 ${fresh.length} 个新地址（${fresh.join("、")}），无法确认本次生成的地址，已停止以免记错数据`
          );
        }
      } else {
        ambiguousSince = 0;
      }

      await sleep(200);
    }

    throw new Error(`没有读取到新生成的邮箱地址（本次新出现的地址：${lastSeen || "无"}）`);
  }

  // 提交后独立核对：详情页实际展示的地址必须等于本次生成的地址，否则失败退出而不是记错
  async function confirmCreatedAddress(candidateEmail) {
    const startedAt = Date.now();
    let lastSeen = "";
    let mismatchCount = 0;

    while (Date.now() - startedAt < DEFAULT_TIMEOUT_MS) {
      throwIfCreationLimitReached();
      if (state.stopRequested && !state.running) {
        throw new Error("任务已停止");
      }

      if (isDetailPageShape()) {
        const shown = readVisibleAddress();
        if (shown === candidateEmail) {
          return;
        }
        if (shown) {
          lastSeen = shown;
          mismatchCount += 1;
          if (mismatchCount >= 3) {
            throw new Error(
              `详情页展示的地址（${shown}）与本次生成的地址（${candidateEmail}）不一致，已停止以免记错数据`
            );
          }
        }
      }

      await sleep(300);
    }

    throw new Error(`提交后没有进入已创建详情页（最后读到的地址：${lastSeen || "无"}）`);
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
