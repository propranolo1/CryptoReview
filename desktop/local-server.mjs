import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(MODULE_DIRECTORY, "..");
const DEFAULT_OUTBOUND_FETCH = globalThis.fetch.bind(globalThis);
const OUTBOUND_FETCH_CONTEXT = new AsyncLocalStorage();
let workerFetchBridgeInstalled = false;

function fetchFromCurrentDesktopSession(input, init) {
  const fetchImpl = OUTBOUND_FETCH_CONTEXT.getStore() ?? DEFAULT_OUTBOUND_FETCH;
  return fetchImpl(input, init);
}

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function decodePathname(rawPathname) {
  let decoded = rawPathname;

  for (let index = 0; index < 4; index += 1) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) {
      break;
    }
    decoded = next;
  }

  if (decoded.includes("\0")) {
    throw new Error("invalid_path");
  }

  const segments = decoded.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error("path_traversal");
  }

  return decoded;
}

function getSafeAssetPath(clientRoot, requestUrl) {
  const rawPathname = requestUrl.split(/[?#]/, 1)[0] || "/";
  const decodedPathname = decodePathname(rawPathname);
  const relativePath = decodedPathname
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
  const assetPath = path.resolve(clientRoot, ...relativePath.split("/"));
  const relative = path.relative(clientRoot, assetPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("path_traversal");
  }

  return assetPath;
}

async function createAssetResponse(clientRoot, request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  let assetPath;
  try {
    assetPath = getSafeAssetPath(clientRoot, new URL(request.url).pathname);
  } catch {
    return new Response("Bad Request", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  try {
    const assetStat = await stat(assetPath);
    if (!assetStat.isFile()) {
      return new Response("Not Found", { status: 404 });
    }

    const headers = new Headers({
      "Content-Length": String(assetStat.size),
      "Content-Type":
        CONTENT_TYPES.get(path.extname(assetPath).toLowerCase()) ??
        "application/octet-stream",
    });

    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }

    return new Response(await readFile(assetPath), { status: 200, headers });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return new Response("Not Found", { status: 404 });
    }
    throw error;
  }
}

function createFetchRequest(request, origin) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const init = {
    method: request.method,
    headers,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request;
    init.duplex = "half";
  }

  const incomingUrl = new URL(request.url ?? "/", origin);
  headers.set("host", new URL(origin).host);
  return new Request(
    new URL(`${incomingUrl.pathname}${incomingUrl.search}`, origin),
    init,
  );
}

async function sendFetchResponse(response, nodeResponse, requestMethod) {
  nodeResponse.statusCode = response.status;
  nodeResponse.statusMessage = response.statusText;

  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") {
      nodeResponse.setHeader(name, value);
    }
  }

  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) {
    nodeResponse.setHeader("set-cookie", cookies);
  }

  if (requestMethod === "HEAD" || response.body === null) {
    nodeResponse.end();
    return;
  }

  nodeResponse.end(Buffer.from(await response.arrayBuffer()));
}

function listen(server, host) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(0, host);
  });
}

/**
 * 启动仅监听本机回环地址的 vinext 桌面服务。
 */
export async function startLocalServer(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? DEFAULT_PROJECT_ROOT);
  const clientRoot = path.resolve(
    options.clientRoot ?? path.join(projectRoot, "dist", "client"),
  );
  const serverEntry = path.resolve(
    options.serverEntry ?? path.join(projectRoot, "dist", "server", "index.js"),
  );
  const host = DEFAULT_HOST;
  const fetchImpl = options.fetchImpl ?? DEFAULT_OUTBOUND_FETCH;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("桌面本地服务网络实现不可用");
  }

  // vinext 的服务端路由在模块加载时捕获全局 fetch。先安装一个按请求上下文
  // 转发的桥接层，使桌面版行情请求与订单同步共用 Electron 网络会话与系统代理。
  if (!workerFetchBridgeInstalled) {
    globalThis.fetch = fetchFromCurrentDesktopSession;
    workerFetchBridgeInstalled = true;
  }
  const workerModule = await import(pathToFileURL(serverEntry).href);
  const worker = workerModule.default;
  if (!worker || typeof worker.fetch !== "function") {
    throw new TypeError("dist/server/index.js 没有导出可用的 vinext Worker");
  }

  let origin = null;
  const pendingTasks = new Set();
  const executionContext = {
    waitUntil(promise) {
      const task = Promise.resolve(promise).finally(() => pendingTasks.delete(task));
      pendingTasks.add(task);
    },
    passThroughOnException() {},
  };
  const env = {
    ASSETS: {
      fetch(request) {
        return createAssetResponse(clientRoot, request);
      },
    },
  };

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = request.url ?? "/";
      try {
        decodePathname(requestUrl.split(/[?#]/, 1)[0] || "/");
      } catch {
        await sendFetchResponse(
          new Response("Bad Request", {
            status: 400,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          }),
          response,
          request.method,
        );
        return;
      }

      const fetchRequest = createFetchRequest(request, origin);
      const staticResponse = await createAssetResponse(clientRoot, fetchRequest);
      const fetchResponse = staticResponse.ok
        ? staticResponse
        : await OUTBOUND_FETCH_CONTEXT.run(
            fetchImpl,
            () => worker.fetch(fetchRequest, env, executionContext),
          );
      await sendFetchResponse(fetchResponse, response, request.method);
    } catch (error) {
      console.error("桌面本地服务请求失败", error);
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      response.end("Internal Server Error");
    }
  });

  await listen(server, host);
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("无法获取桌面本地服务端口");
  }
  origin = `http://${host}:${address.port}`;

  let closePromise = null;
  return {
    origin,
    close() {
      closePromise ??= new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          Promise.allSettled([...pendingTasks]).then(() => resolve());
        });
      });
      return closePromise;
    },
  };
}
