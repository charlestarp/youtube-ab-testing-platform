import { type NextRequest } from "next/server";

export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const testId = url.searchParams.get("testId");
  if (!testId) return new Response("testId required", { status: 400 });

  const cookies = request.headers.get("cookie") || "";

  // Forward the raw body to the API
  const res = await fetch(`http://localhost:4700/api/tests/${testId}/variants`, {
    method: "POST",
    headers: {
      "Cookie": cookies,
      "Content-Type": request.headers.get("content-type") || "",
    },
    body: request.body,
    // @ts-expect-error duplex needed for streaming body
    duplex: "half",
  });

  const data = await res.text();
  return new Response(data, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
