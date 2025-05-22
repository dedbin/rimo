import { NextResponse } from "next/server";
import { generateCover } from "@/lib/generateCover";

export async function POST() {
  const { id, svg } = generateCover();
  
  const base64 = Buffer.from(svg).toString("base64");
  const imageUrl = `data:image/svg+xml;base64,${base64}`;
  return NextResponse.json({ id, imageUrl });
}
