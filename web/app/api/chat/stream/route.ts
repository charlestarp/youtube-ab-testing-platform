import { NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
  const body = await request.text();
  const cookies = request.headers.get('cookie') || '';

  const res = await fetch('http://localhost:4700/api/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookies,
    },
    body,
  });

  // Stream the response through
  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
