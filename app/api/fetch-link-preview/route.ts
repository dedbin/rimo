import { NextRequest, NextResponse } from "next/server";
import { getLinkPreview } from "link-preview-js";

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "No URL" }, { status: 400 });
  }

  try {
    const data = await getLinkPreview(url);

    const title = "title" in data ? data.title : undefined;
    const description = "description" in data ? data.description : undefined;
    const image = "images" in data && data.images?.length ? data.images[0] : undefined;
    const favicon = "favicons" in data && data.favicons?.length ? data.favicons[0] : undefined;

    return NextResponse.json({
      title,
      description,
      image,
      favicon,
    });
  } catch (error) {
    console.error("Link preview fetch failed:", error);
    return NextResponse.json({ error: "Failed to fetch link preview" }, { status: 500 });
  }
}
