export type AssetIconLoader = {
  load(symbol: string): Promise<string | null>;
  reportFailure(symbol: string, src: string): void;
};
export function createAssetIconLoader(options?: {
  fetchImpl?: typeof fetch; now?: () => number; maxConcurrent?: number;
}): AssetIconLoader;
