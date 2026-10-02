export type AssetIconRecord = { token: string; src: string; updatedAt: number };
export function normalizeIconToken(value: unknown): string;
export function isValidIconRecord(record: unknown, token: string): record is AssetIconRecord;
export type AssetIconService = {
  readonly cacheSize: number;
  settled(): Promise<void>;
  getIcon(value: unknown): Promise<AssetIconRecord | null>;
};
export function createAssetIconService(options?: {
  fetchImpl?: typeof fetch; now?: () => number; maxEntries?: number;
  readCache?: (token: string) => Promise<unknown>;
  writeCache?: (record: AssetIconRecord) => Promise<void>;
}): AssetIconService;
export function assetIconResponse(request: Request, service: AssetIconService): Promise<Response>;
