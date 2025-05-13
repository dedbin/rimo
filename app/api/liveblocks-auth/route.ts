import { Liveblocks } from "@liveblocks/node";
import { ConvexHttpClient } from "convex/browser";
import { auth, currentUser } from "@clerk/nextjs/server";

import { api } from "@/convex/_generated/api";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

const liveblocks = new Liveblocks({
  secret: process.env.NEXT_PUBLIC_LIVEBLOCKS_SECRET_KEY!,
});

export async function POST(request: Request) {
  // Get the current user from Clerk
  const authtorization = await auth();
  // Get the current user from your database
  const user = await currentUser();

  if (!user || !authtorization) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { room } = await request.json();
  const board = await convex.query(api.board.get, { id: room });

  if (!board) {
    return new Response("Board not found", { status: 404 });
  }  
  if (board.orgId !== authtorization.orgId) {
    return new Response("Access to this board is forbidden", { status: 403 });
  }

  const userInfo = {
    name: user.firstName || "Anonymous",
    imageUrl: user.imageUrl!,
  };

  const session = liveblocks.prepareSession(
    user.id,
    { userInfo } 
  );

  if (room) {
    session.allow(room, session.FULL_ACCESS);
  }
  // Authorize the user and return the result
  const { status, body } = await session.authorize();

  return new Response(body, { status });
}