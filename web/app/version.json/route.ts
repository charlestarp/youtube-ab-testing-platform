import { readFileSync } from "fs";
import { join } from "path";

// Serves the current build id. Next writes a fresh BUILD_ID on every `next build`,
// so a redeploy changes this value and the client can prompt for a refresh.
export const dynamic = "force-dynamic";

export async function GET() {
  let id = "dev";
  try {
    id = readFileSync(join(process.cwd(), ".next/BUILD_ID"), "utf8").trim();
  } catch {
    /* dev mode / not built */
  }
  return new Response(JSON.stringify({ id }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
