const DEFAULT_OWNER = "propranolo1";
const DEFAULT_REPO = "CryptoReview";
const UPDATE_SERVER = "https://update.electronjs.org";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_ORIGIN = "https://github.com";

function normalizeVersion(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^v/i, "")
    .split("-", 1)[0];
  if (!/^\d+(?:\.\d+){0,2}$/.test(normalized)) {
    throw new TypeError("GitHub Release 版本号必须使用语义版本格式");
  }
  return normalized.split(".").map(Number).concat([0, 0, 0]).slice(0, 3);
}

export function compareVersions(left, right) {
  const leftParts = normalizeVersion(left);
  const rightParts = normalizeVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

function cleanVersion(value) {
  return normalizeVersion(value).join(".");
}

export function buildUpdateFeedUrl({
  owner = DEFAULT_OWNER,
  repo = DEFAULT_REPO,
  platform,
  arch,
  version,
}) {
  return `${UPDATE_SERVER}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${platform}-${arch}/${cleanVersion(version)}`;
}

function buildReleaseApiUrl(owner, repo) {
  return `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;
}

function buildReleasesUrl(owner, repo) {
  return `${GITHUB_ORIGIN}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;
}

function sanitizeReleaseUrl(value, owner, repo) {
  const fallback = buildReleasesUrl(owner, repo);
  try {
    const url = new URL(String(value ?? ""));
    const expectedPrefix = `/${owner}/${repo}/releases/`;
    if (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname.toLowerCase().startsWith(expectedPrefix.toLowerCase())
    ) {
      return url.href;
    }
  } catch {
    // 非 GitHub Release 地址统一回退到固定公开仓库，避免外部响应注入任意链接。
  }
  return fallback;
}

function cloneStatus(status) {
  return { ...status };
}

export function createUpdateService({
  app,
  autoUpdater,
  fetchImpl,
  owner = DEFAULT_OWNER,
  repo = DEFAULT_REPO,
  platform = process.platform,
  arch = process.arch,
  initialDelayMs = 15_000,
  intervalMs = 6 * 60 * 60 * 1000,
}) {
  if (!app || typeof app.getVersion !== "function") {
    throw new TypeError("更新服务需要 Electron app");
  }
  if (!autoUpdater || typeof autoUpdater.on !== "function") {
    throw new TypeError("更新服务需要 Electron autoUpdater");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("更新服务需要固定网络请求实现");
  }

  const currentVersion = cleanVersion(app.getVersion());
  const canAutoUpdate = Boolean(app.isPackaged) && platform === "win32";
  const releaseUrl = buildReleasesUrl(owner, repo);
  let status = {
    state: "idle",
    currentVersion,
    latestVersion: null,
    available: false,
    canAutoUpdate,
    canInstall: false,
    checkedAt: null,
    releaseUrl,
    message: app.isPackaged
      ? "尚未检查更新"
      : "开发环境只检查版本，不执行安装",
  };
  let activeCheck = null;
  let initialTimer = null;
  let intervalTimer = null;

  const updateStatus = (next) => {
    status = { ...status, ...next };
    return cloneStatus(status);
  };

  const onChecking = () => updateStatus({
    state: "checking",
    message: "正在检查更新",
  });
  const onAvailable = () => updateStatus({
    state: "downloading",
    available: true,
    message: `发现 v${status.latestVersion ?? "新版本"}，正在后台下载`,
  });
  const onNotAvailable = () => updateStatus({
    state: "current",
    available: false,
    canInstall: false,
    latestVersion: status.latestVersion ?? currentVersion,
    message: `当前已是最新版 v${currentVersion}`,
  });
  const onDownloaded = (_event, releaseName) => updateStatus({
    state: "downloaded",
    available: true,
    canInstall: true,
    latestVersion: status.latestVersion ?? cleanVersion(releaseName),
    message: `v${status.latestVersion ?? cleanVersion(releaseName)} 已下载，点击重启更新`,
  });
  const onError = (error) => updateStatus({
    state: "error",
    canInstall: false,
    message: `更新失败：${error instanceof Error ? error.message : String(error)}`,
  });

  autoUpdater.on("checking-for-update", onChecking);
  autoUpdater.on("update-available", onAvailable);
  autoUpdater.on("update-not-available", onNotAvailable);
  autoUpdater.on("update-downloaded", onDownloaded);
  autoUpdater.on("error", onError);

  async function check({ manual = false } = {}) {
    if (activeCheck) return activeCheck;
    updateStatus({ state: "checking", message: "正在检查 GitHub 版本" });

    activeCheck = (async () => {
      try {
        const response = await fetchImpl(buildReleaseApiUrl(owner, repo), {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": `CryptoReview/${currentVersion}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
        if (!response.ok) {
          if (response.status === 404) {
            throw new Error("GitHub 暂无可用 Release");
          }
          throw new Error(`GitHub 版本请求失败（${response.status}）`);
        }
        const release = await response.json();
        const latestVersion = cleanVersion(release?.tag_name);
        const checkedAt = Date.now();
        const safeReleaseUrl = sanitizeReleaseUrl(
          release?.html_url,
          owner,
          repo,
        );

        if (compareVersions(latestVersion, currentVersion) <= 0) {
          return updateStatus({
            state: "current",
            latestVersion,
            available: false,
            canInstall: false,
            checkedAt,
            releaseUrl: safeReleaseUrl,
            message: `当前已是最新版 v${currentVersion}`,
          });
        }

        updateStatus({
          state: canAutoUpdate ? "downloading" : "available",
          latestVersion,
          available: true,
          canInstall: false,
          checkedAt,
          releaseUrl: safeReleaseUrl,
          message: canAutoUpdate
            ? `发现 v${latestVersion}，正在后台下载`
            : `发现 v${latestVersion}，请打开 GitHub Release 下载`,
        });

        if (canAutoUpdate) {
          autoUpdater.setFeedURL({
            url: buildUpdateFeedUrl({
              owner,
              repo,
              platform,
              arch,
              version: currentVersion,
            }),
          });
          await autoUpdater.checkForUpdates();
        }
        return cloneStatus(status);
      } catch (error) {
        const failed = updateStatus({
          state: "error",
          canInstall: false,
          checkedAt: Date.now(),
          message: `${manual ? "检查更新失败" : "自动检查更新失败"}：${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        return failed;
      } finally {
        activeCheck = null;
      }
    })();
    return activeCheck;
  }

  async function install() {
    if (!canAutoUpdate || status.state !== "downloaded") {
      throw new Error("当前没有已经下载完成的更新");
    }
    updateStatus({ state: "installing", message: "正在重启并安装更新" });
    autoUpdater.quitAndInstall();
    return cloneStatus(status);
  }

  function start() {
    if (!app.isPackaged || initialTimer || intervalTimer) return;
    initialTimer = setTimeout(() => {
      initialTimer = null;
      void check();
    }, initialDelayMs);
    intervalTimer = setInterval(() => void check(), intervalMs);
    initialTimer.unref?.();
    intervalTimer.unref?.();
  }

  function dispose() {
    if (initialTimer) clearTimeout(initialTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
    autoUpdater.removeListener("checking-for-update", onChecking);
    autoUpdater.removeListener("update-available", onAvailable);
    autoUpdater.removeListener("update-not-available", onNotAvailable);
    autoUpdater.removeListener("update-downloaded", onDownloaded);
    autoUpdater.removeListener("error", onError);
  }

  return {
    check,
    dispose,
    getStatus: () => cloneStatus(status),
    install,
    start,
  };
}
