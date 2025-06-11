import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import crypto from "crypto";

export async function POST(req: NextRequest) {
  const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const validTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (!validTypes.includes(file.type)) {
      return NextResponse.json(
        { error: "Invalid file type. Only JPEG, PNG, GIF, and WebP are supported" },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");

    const existing = await convex.query(api.images.getBySha, { sha256: hash });
    if (existing) {
      return NextResponse.json({ url: existing.url });
    }


    const uploadUrl = await convex.action(api.images.generateUploadUrl, {});
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: buffer,
    });

    if (!uploadRes.ok) {
      console.error("Convex upload failed", await uploadRes.text());
      return NextResponse.json({ error: "Error uploading file" }, { status: 500 });
    }

    const { storageId } = await uploadRes.json();
    const { url } = await convex.mutation(api.images.saveImage, {
      sha256: hash,
      storageId,
    });

    return NextResponse.json({ url });
  } catch (error) {
    console.error("Error uploading file:", error);
    return NextResponse.json({ error: "Error uploading file" }, { status: 500 });
  }
}
