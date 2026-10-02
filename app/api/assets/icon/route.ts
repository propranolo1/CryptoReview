import { assetIconResponse, createAssetIconService } from "@/lib/asset-icons.mjs";

// 网页模式使用进程内缓存；桌面模式由本地服务提供持久化图片缓存。
const service = createAssetIconService();

export async function GET(request: Request) {
  return assetIconResponse(request, service);
}
