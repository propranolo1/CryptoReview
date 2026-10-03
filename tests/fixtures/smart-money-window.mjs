import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
const ID = "5146419622540980737";
const API = "https://www.binance.com/bapi/asset/v1/private/future/smart-money/profile/";
const tick = () => new Promise((resolve) => setImmediate(resolve));

export class NativeWindow extends EventEmitter {
  static current;
  static windows = [];
  static onLoad = null;
  static onDrive = null;
  constructor(options) {
    super();
    NativeWindow.current = this;
    NativeWindow.windows.push(this);
    this.options = options;
    this.destroyed = false;
    this.visible = options.show;
    this.url = "";
    this.webContents = new EventEmitter();
    this.webContents.getURL = () => this.url;
    this.webContents.setWindowOpenHandler = (handler) => { this.openHandler = handler; };
    this.webContents.executeJavaScriptInIsolatedWorld = async (_world, [{ code }]) => {
      assert.doesNotMatch(code, /\bfetch\s*\(|document\.cookie|localStorage/);
      return NativeWindow.onDrive?.(this, code) ?? { acted: false };
    };
    const debuggerApi = new EventEmitter();
    debuggerApi.attached = false;
    debuggerApi.attach = () => { debuggerApi.attached = true; };
    debuggerApi.isAttached = () => debuggerApi.attached;
    debuggerApi.detach = () => { debuggerApi.attached = false; };
    this.bodies = new Map();
    this.bodyReads = [];
    debuggerApi.sendCommand = async (method, parameters) => {
      if (method === "Network.getResponseBody") {
        this.bodyReads.push(parameters.requestId);
        return { body: this.bodies.get(parameters.requestId), base64Encoded: false };
      }
      return {};
    };
    this.webContents.debugger = debuggerApi;
  }
  async loadURL(url) {
    this.url = url;
    this.webContents.emit("did-finish-load");
    await tick();
    await NativeWindow.onLoad?.(this);
  }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  setTitle(value) { this.title = value; }
  setMenu() {}
  isDestroyed() { return this.destroyed; }
  close() { this.destroy(); }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
  respond(kind, payload, { status = 200, page = 1, rows = 10, id = ID, origin = API, requestId = `${kind}-${page}-${Math.random()}` } = {}) {
    const url = `${origin}query-${kind}?topTraderId=${id}&marketType=UM&page=${page}&rows=${rows}`;
    this.bodies.set(requestId, JSON.stringify(payload));
    const api = this.webContents.debugger;
    api.emit("message", {}, "Network.requestWillBeSent", { requestId, request: { url, method: "GET" } });
    api.emit("message", {}, "Network.responseReceived", { requestId, type: "XHR", response: { url, status, mimeType: "application/json" } });
    api.emit("message", {}, "Network.loadingFinished", { requestId, encodedDataLength: 256 });
  }
}
