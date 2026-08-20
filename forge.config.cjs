module.exports = {
  packagerConfig: {
    asar: true,
    name: "CryptoReview",
    executableName: "CryptoReview",
    appBundleId: "com.cryptoreview.desktop",
    appCategoryType: "public.app-category.finance",
    ignore: [
      /^\/(?:\.agents|\.git|\.openai|\.vinext|\.wrangler|\.next|out)(?:\/|$)/,
      /^\/(?:app|build|db|drizzle|examples|public|tests|worker)(?:\/|$)/,
      /^\/lib\/(?!exchange-sync\.mjs$)/,
      /^\/node_modules(?:\/|$)/,
      /^\/(?:\.env(?:\..*)?|.*\.(?:db|sqlite|sqlite3|csv|tsv|xlsx?|log|jpe?g|png|webp|gif|mp4|webm))$/i,
      /^\/(?:AI_README\.md|README\.md|drizzle\.config\.ts|eslint\.config\.mjs|next\.config\.ts|postcss\.config\.mjs|tsconfig\.json|tsconfig\.tsbuildinfo|vite\.config\.ts|worker-configuration\.d\.ts)$/,
    ],
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "CryptoReview",
        authors: "xin",
        description: "Binance 与 OKX U 本位合约本地交易复盘桌面应用",
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ],
};
