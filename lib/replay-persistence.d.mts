export interface DesktopReplayPersistenceApi {
  saveReplaySnapshot(snapshot: {
    orders: readonly unknown[];
    trades: readonly unknown[];
  }): Promise<void>;
}

export function persistDesktopReplaySnapshot(
  desktopApi: DesktopReplayPersistenceApi,
  snapshot: {
    orders: readonly unknown[];
    trades: readonly unknown[];
  },
): Promise<void>;
