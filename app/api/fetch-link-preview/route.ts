import { NextRequest, NextResponse } from "next/server";

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "No URL" }, { status: 400 });
  }

  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || url.length > 2048) {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }
    // Keep link cards usable without letting board content initiate server-side requests.
    return NextResponse.json({ title: parsed.hostname, description: parsed.href });
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }
}
