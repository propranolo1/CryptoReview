const API_ROOT = "https://www.binance.com/bapi/asset/v1/private/future/smart-money/profile/";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// 只接收目标主页的两种只读响应；不读取 Cookie、登录接口响应或请求头。
export function parseSmartMoneyRequest(input, topTraderId) {
  try {
    const url = new URL(input);
    const kind = url.pathname === new URL(`${API_ROOT}query-positions`).pathname
      ? "positions"
      : url.pathname === new URL(`${API_ROOT}query-order-history`).pathname
        ? "order-history" : null;
    const page = Number(url.searchParams.get("page"));
    const rows = Number(url.searchParams.get("rows"));
    if (url.origin !== "https://www.binance.com" || !kind ||
        url.username || url.password || url.searchParams.get("topTraderId") !== topTraderId ||
        url.searchParams.get("marketType") !== "UM" ||
        !Number.isInteger(page) || page < 1 || page > 100 ||
        !Number.isInteger(rows) || rows < 1 || rows > 100) return null;
    return { kind, page, rows };
  } catch { return null; }
}

export function createSmartMoneyPageAction(kind, page) {
  if (!["positions", "order-history"].includes(kind) || !Number.isInteger(page) || page < 1 || page > 100) {
    throw new TypeError("聪明钱页面操作参数无效");
  }
  return `(() => {
    const kind = ${JSON.stringify(kind)};
    const page = ${page};
    const tab = document.getElementById(kind === "positions" ? "bn-tab-POSITIONS" : "bn-tab-LATEST_RECORDS");
    if (!tab) return { acted: false };
    if (page === 1) {
      tab.click();
      document.getElementById("bn-tab-UM")?.click();
      return { acted: true };
    }
    const labels = kind === "positions" ? ["下一页", "Next", "Next page"] : ["展开", "加载更多", "Expand", "Show more", "Load more"];
    const buttons = [...document.querySelectorAll("button")];
    const button = buttons.find(item => !item.disabled && item.getClientRects().length > 0 &&
      labels.includes((item.textContent || item.getAttribute("aria-label") || "").trim()));
    if (!button) return { acted: false };
    button.click();
    return { acted: true };
  })()`;
}

export function createSmartMoneyPageSource({ window, topTraderId, timeoutMs, driveIntervalMs = 400 }) {
  const contents = window.webContents;
  const debuggerApi = contents.debugger;
  if (!debuggerApi?.attach || !debuggerApi?.sendCommand) {
    throw new Error("当前桌面环境无法读取 Binance 官网数据，请重新打开软件后重试。");
  }
  const pendingRequests = new Map();
  const responses = new Map();
  const waiters = new Map();
  let stopped = false;
  let authenticationPending = false;
  let driving = false;
  let wanted = null;
  let actionDone = false;
  let lastFailure = null;
  let pageError = null;
  let loadGeneration = 0;
  let cancelOpen = null;
  const keyFor = (value) => `${value.kind}:${value.page}`;
  const onProfile = () => {
    try {
      const url = new URL(contents.getURL());
      return url.origin === "https://www.binance.com" &&
        new RegExp(`^/[a-zA-Z-]+/smart-money/profile/${topTraderId}/?$`).test(url.pathname);
    } catch { return false; }
  };
  const publish = (meta, response) => {
    if (stopped || !onProfile()) return;
    const needsLogin = response.payload?.success === false &&
      (String(response.payload.code) === "100001005" || /login|log in|unauthor|登录/i.test(String(response.payload.message ?? "")));
    if (response.status === 401 || needsLogin) {
      authenticationPending = true;
      lastFailure = { status: 401, ok: false, payload: null };
      // 官网可能会自动续期并重试，不能在首个 401 时提前结束。
      return;
    }
    if (response.ok && response.payload?.success !== false) {
      authenticationPending = false;
      lastFailure = null;
    }
    const key = keyFor(meta);
    responses.set(key, { ...response, rows: meta.rows });
    waiters.get(key)?.();
  };
  const fail = () => {
    pageError = new Error("Binance 官网数据读取失败，请保留登录窗口并稍后重试。");
    for (const wake of waiters.values()) wake();
  };
  const onMessage = (_event, method, parameters) => {
    if (stopped) return;
    if (method === "Network.requestWillBeSent") {
      pendingRequests.delete(parameters.requestId);
      const meta = parseSmartMoneyRequest(parameters.request?.url, topTraderId);
      if (meta && parameters.request.method === "GET" && pendingRequests.size < 256 && onProfile()) {
        pendingRequests.set(parameters.requestId, meta);
      }
    } else if (method === "Network.responseReceived") {
      const meta = pendingRequests.get(parameters.requestId);
      const responseMeta = parseSmartMoneyRequest(parameters.response?.url, topTraderId);
      if (!meta || !responseMeta || keyFor(meta) !== keyFor(responseMeta) || meta.rows !== responseMeta.rows) {
        pendingRequests.delete(parameters.requestId);
        return;
      }
      meta.status = parameters.response.status;
    } else if (method === "Network.loadingFailed") {
      if (pendingRequests.delete(parameters.requestId)) fail();
    } else if (method === "Network.loadingFinished") {
      const meta = pendingRequests.get(parameters.requestId);
      pendingRequests.delete(parameters.requestId);
      if (!meta || !Number.isInteger(meta.status)) return;
      if (parameters.encodedDataLength > MAX_BODY_BYTES) { fail(); return; }
      if (meta.status !== 200) {
        publish(meta, { status: meta.status, ok: false, payload: null });
        return;
      }
      void debuggerApi.sendCommand("Network.getResponseBody", { requestId: parameters.requestId })
        .then((result) => {
          if (stopped) return;
          if (typeof result.body !== "string" || result.body.length > MAX_BODY_BYTES * 2) throw new Error();
          const body = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
          if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error();
          publish(meta, { status: meta.status, ok: true, payload: JSON.parse(body) });
        }).catch(() => { if (!stopped) fail(); });
    }
  };
  const onLoad = () => { loadGeneration += 1; actionDone = false; };
  const drive = async () => {
    if (stopped || driving || !wanted || actionDone || authenticationPending || !onProfile()) return;
    if (responses.has(keyFor(wanted))) return;
    const requested = wanted;
    const generation = loadGeneration;
    driving = true;
    try {
      const action = await contents.executeJavaScriptInIsolatedWorld(1001, [{
        code: createSmartMoneyPageAction(requested.kind, requested.page),
      }]);
      if (action?.acted && wanted === requested && generation === loadGeneration) actionDone = true;
    } catch {
      // 官网跳转期间暂时没有 DOM，等待页面恢复，不回退为自定义私有请求。
    } finally { driving = false; }
  };
  debuggerApi.attach("1.3");
  debuggerApi.on("message", onMessage);
  debuggerApi.on("detach", fail);
  contents.on("did-finish-load", onLoad);
  const enabled = debuggerApi.sendCommand("Network.enable", {
    maxResourceBufferSize: MAX_BODY_BYTES,
    maxTotalBufferSize: MAX_BODY_BYTES * 4,
  });
  const interval = setInterval(() => void drive(), driveIntervalMs);

  return {
    async open(url) {
      if (stopped) throw new Error("Binance 登录窗口已关闭，本次同步已取消。");
      let timer;
      const interrupted = new Promise((_resolve, reject) => {
        cancelOpen = () => reject(new Error("Binance 登录窗口已关闭，本次同步已取消。"));
        timer = setTimeout(() => reject(new Error("Binance 登录页面加载超时，请稍后重试。")), timeoutMs);
      });
      try {
        const loaded = Promise.all([enabled, Promise.resolve().then(() => {
          if (!stopped) return window.loadURL(url);
        })]).catch(() => { throw new Error("Binance 登录页面打开失败，请稍后重试。"); });
        await Promise.race([loaded, interrupted]);
      } finally {
        clearTimeout(timer);
        cancelOpen = null;
      }
    },
    async readPage(kind, page) {
      const requested = { kind, page };
      const key = keyFor(requested);
      wanted = requested;
      actionDone = false;
      if (responses.has(key)) return responses.get(key);
      return new Promise((resolve, reject) => {
        let timer;
        const finish = () => {
          const response = responses.get(key);
          if (!stopped && !pageError && !response) return;
          clearTimeout(timer);
          waiters.delete(key);
          if (stopped) reject(new Error("Binance 登录窗口已关闭，本次同步已取消。"));
          else if (pageError) reject(pageError);
          else resolve(response);
        };
        waiters.set(key, finish);
        timer = setTimeout(() => {
          waiters.delete(key);
          if (lastFailure?.status === 401 || !onProfile()) resolve({ status: 401, ok: false, payload: null });
          else reject(new Error("Binance 官网尚未返回完整数据，请在登录窗口确认登录或稍后重试。"));
        }, timeoutMs);
        finish();
        void drive();
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cancelOpen?.();
      clearInterval(interval);
      contents.removeListener("did-finish-load", onLoad);
      debuggerApi.removeListener("message", onMessage);
      debuggerApi.removeListener("detach", fail);
      if (debuggerApi.isAttached()) debuggerApi.detach();
      pendingRequests.clear();
      responses.clear();
      for (const wake of waiters.values()) wake();
      waiters.clear();
    },
  };
}
