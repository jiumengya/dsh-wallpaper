// Preload probe: capture why the process exits. Loaded via `node --import`.
import { writeSync } from "node:fs";

const tag = (s) => { try { writeSync(2, "[trace-exit] " + s + "\n"); } catch { /* fd gone */ } };

const origExit = process.exit;
process.exit = function (code) {
  tag("process.exit(" + code + ") called from:\n" + new Error().stack);
  return origExit.call(process, code);
};

const desc = Object.getOwnPropertyDescriptor(process, "exitCode") ?? {};
Object.defineProperty(process, "exitCode", {
  get() { return desc.get ? desc.get.call(process) : undefined; },
  set(v) {
    tag("exitCode set to " + v + " from:\n" + new Error().stack);
    if (desc.set) desc.set.call(process, v);
  },
  configurable: true,
});

process.on("exit", (code) => tag("exit event code=" + code + " from:\n" + new Error().stack));
process.on("beforeExit", (code) => tag("beforeExit code=" + code + " from:\n" + new Error().stack));
process.on("uncaughtExceptionMonitor", (err) => tag("uncaughtExceptionMonitor: " + (err?.stack ?? String(err))));
