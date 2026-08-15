import { spawn } from "node:child_process";
import path from "node:path";

export function getSquirrelStartupPlan({
  argv = process.argv,
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  if (platform !== "win32") return null;
  const event = argv[1];
  const executableName = path.basename(execPath);
  const updateExe = path.resolve(path.dirname(execPath), "..", "Update.exe");

  if (event === "--squirrel-install" || event === "--squirrel-updated") {
    return { command: updateExe, args: [`--createShortcut=${executableName}`] };
  }
  if (event === "--squirrel-uninstall") {
    return { command: updateExe, args: [`--removeShortcut=${executableName}`] };
  }
  if (event === "--squirrel-obsolete") {
    return { command: null, args: [] };
  }
  return null;
}

export function handleSquirrelStartup({ app, ...options }) {
  const plan = getSquirrelStartupPlan(options);
  if (!plan) return false;
  if (!plan.command) {
    app.quit();
    return true;
  }
  const child = spawn(plan.command, plan.args, {
    detached: true,
    stdio: "ignore",
  });
  child.once("error", () => app.quit());
  child.once("close", () => app.quit());
  child.unref();
  return true;
}
