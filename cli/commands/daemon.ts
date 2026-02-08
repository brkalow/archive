import { parseArgs } from "util";
import { startDaemon, stopDaemon, getDaemonStatus } from "../daemon";
import { getServerUrl } from "../lib/config";

export async function daemon(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "start":
      return daemonStart(args.slice(1));
    case "stop":
      return daemonStop();
    case "status":
      return daemonStatus();
    default:
      console.log(`
Usage: openctl daemon <subcommand> [options]

Subcommands:
  start     Start the daemon
  stop      Stop the running daemon
  status    Show daemon status

Options for 'start':
  --harness <name>       Harness adapter(s) to enable (default: all)
                         Can specify multiple: --harness claude-code --harness cursor
  --watch <paths>        Additional directories to watch
  --server <url>         Server URL (default: from config)
  --idle-timeout <sec>   Seconds before marking session complete (default: 300)
  --opencode-port <port> Start OpenCode-compatible HTTP server on this port
  --verbose              Enable verbose debug logging
      `);
  }
}

async function daemonStart(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      harness: { type: "string", multiple: true },
      watch: { type: "string", multiple: true },
      server: { type: "string" },
      "idle-timeout": { type: "string" },
      "opencode-port": { type: "string" },
      verbose: { type: "boolean" },
    },
  });

  const opencodePort = values["opencode-port"]
    ? parseInt(values["opencode-port"], 10)
    : undefined;

  const options = {
    harnesses: values.harness || [],
    watchPaths: values.watch || [],
    server: getServerUrl(values.server),
    idleTimeout: parseInt(values["idle-timeout"] || "300", 10),
    verbose: values.verbose || false,
    opencodePort,
  };

  console.log("Starting openctl daemon...");
  console.log(`  Server: ${options.server}`);
  console.log(`  Harnesses: ${options.harnesses.length ? options.harnesses.join(", ") : "all"}`);
  console.log(`  Idle timeout: ${options.idleTimeout}s`);
  if (options.opencodePort) {
    console.log(`  OpenCode port: ${options.opencodePort}`);
  }
  console.log();
  console.log("Warning: Session content will be transmitted to the server.");
  console.log("    Ensure no sensitive data (API keys, passwords) is exposed.");
  console.log();

  await startDaemon(options);
}

async function daemonStop(): Promise<void> {
  const stopped = await stopDaemon();
  if (stopped) {
    console.log("Daemon stopped.");
  } else {
    console.log("No daemon running.");
  }
}

async function daemonStatus(): Promise<void> {
  const status = await getDaemonStatus();

  if (!status.running) {
    console.log("Daemon is not running.");
    return;
  }

  console.log("Daemon is running.");
  console.log(`  PID: ${status.pid}`);
  console.log(`  Started: ${status.startedAt}`);
  console.log(`  Active sessions: ${status.activeSessions}`);

  if (status.sessions && status.sessions.length > 0) {
    console.log("\nActive sessions:");
    for (const session of status.sessions) {
      console.log(`  ${session.id}: ${session.title} (${session.messageCount} messages)`);
    }
  }
}
