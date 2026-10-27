// Standalone mock for processes that cannot import it (Edge Functions under `supabase functions serve`).
// Usage: npx tsx src/mock/cli.ts [--port 4010] [--host 127.0.0.1] [--fixtures test/fixtures/claude]
// Prints the base URL to set as the Claude base URL in the function's environment.
import { startMockClaude } from "./server.ts";

function arg(name: string, fallback: string | undefined): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const mock = await startMockClaude({
  port: Number(arg("port", "0")),
  host: arg("host", "127.0.0.1"),
  fixturesDir: arg("fixtures", undefined),
});
console.log(`mock Claude listening at ${mock.url}`);

const stop = () => {
  void mock.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
