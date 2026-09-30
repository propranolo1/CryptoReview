export function getTradeToken(symbol: string): string;
export function groupTradesByToken(trades: readonly { symbol: string }[]): { token: string; count: number }[];
export function filterTradesByToken<T extends { symbol: string }>(trades: readonly T[], token: string | null): T[];
