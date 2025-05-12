import { mutation } from "./_generated/server";
import { v } from "convex/values";

const images = [
    "/avatars/avatar_0.svg",
    "/avatars/avatar_1.svg",
    "/avatars/avatar_2.svg",
    "/avatars/avatar_3.svg",
    "/avatars/avatar_4.svg",
    "/avatars/avatar_5.svg",
    "/avatars/avatar_6.svg",
    "/avatars/avatar_7.svg",
    "/avatars/avatar_8.svg",
    "/avatars/avatar_9.svg",
]

export const create = mutation({
    args:{
        orgId: v.string(),
        title: v.string(),
    },
    handler: async (ctx, args) => { 
        const identity = await ctx.auth.getUserIdentity();

        if (!identity) {
            throw new Error("Unauthorized");
        }

        const randomIndex = Math.floor(Math.random() * images.length);
        const imageUrl = images[randomIndex];

        const board = await ctx.db.insert("boards", {
                title: args.title,
                orgId: args.orgId,
                authorId: identity.subject,
                authorName: identity.name!,
                imageUrl: imageUrl,
        });
        
        return board;
     }
})
