import { mutation, query } from "./_generated/server";
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
] // todo: make it auto generated
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
});

export const remove = mutation({
    args:{
        id: v.id("boards"),
    },
    handler: async (ctx, args) => { 
        const identity = await ctx.auth.getUserIdentity();

        if (!identity) {
            throw new Error("Unauthorized");
        }
        const userId = identity.subject;

        const existingFavorite = await ctx.db
            .query("useFavorites")
            .withIndex("byUserBoard", (q) => q.eq("userId", userId).eq("boardId", args.id))
            .unique();
        if (existingFavorite) {
            await ctx.db.delete(existingFavorite._id);
        }
        await ctx.db.delete(args.id); 

    }
});

export const update = mutation({
    args:{
        id: v.id("boards"),
        title: v.string(),
    },
    handler: async (ctx, args) => { 
        const title = args.title.trim();    
        const identity = await ctx.auth.getUserIdentity();

        if (title.length === 0 || !title) {
            throw new Error("Title cannot be empty");
        }

        if (title.length > 50) {
            throw new Error("Title cannot be more than 50 characters");
        }


        if (!identity) {
            throw new Error("Unauthorized");
        }


        return await ctx.db.patch(args.id, {
            title: args.title,
        });
    }
});

export const favorite = mutation({
    args:{
        id: v.id("boards"),
        orgId: v.string(),
    },
    handler: async (ctx, args) => { 
        const identity = await ctx.auth.getUserIdentity();

        if (!identity) {
            throw new Error("Unauthorized");
        }
        const board = await ctx.db.get(args.id);
        if (!board) {
            throw new Error("Board not found");
        }
        const userId = identity.subject;

        const existingFavorite = await ctx.db
            .query("useFavorites")
            .withIndex("byUserBoardOrg", (q) => q.eq("userId", userId).eq("boardId", board._id).eq("orgId", args.orgId))
            .first();

        if (existingFavorite) {
            throw new Error("Already favorited");
        }
        const favorite = await ctx.db.insert("useFavorites", {
            boardId: board._id,
            userId: userId,
            orgId: args.orgId,
        })
        return favorite;
    }
});

export const unFavorite = mutation({
    args:{
        id: v.id("boards"),
    },
    handler: async (ctx, args) => { 
        const identity = await ctx.auth.getUserIdentity();

        if (!identity) {
            throw new Error("Unauthorized");
        }
        const board = await ctx.db.get(args.id);
        if (!board) {
            throw new Error("Board not found");
        }
        const userId = identity.subject;

        const existingFavorite = await ctx.db
            .query("useFavorites")
            .withIndex("byUserBoard", (q) => q.eq("userId", userId).eq("boardId", board._id))
            .first();

        if (!existingFavorite) {
            throw new Error("Not favorited");
        }
        const favorite = await ctx.db.delete(existingFavorite._id);

        return favorite;
    }
});

export const get = query({
    args: {
        id: v.id("boards"),
    },
    handler: async (ctx, args) => { 
        return await ctx.db.get(args.id);
    }
});