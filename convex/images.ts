import { query, mutation, action } from "./_generated/server";
import { v } from "convex/values";

export const getBySha = query({
  args: { sha256: v.string() },
  handler: async (ctx, { sha256 }) => {
    const existing = await ctx.db
      .query("images")
      .withIndex("bySha", q => q.eq("sha256", sha256))
      .unique();
    if (!existing) return null;
    const url = await ctx.storage.getUrl(existing.storageId);
    return { id: existing._id, storageId: existing.storageId, url };
  },
});

export const generateUploadUrl = action({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const saveImage = mutation({
  args: { sha256: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("images", {
      sha256: args.sha256,
      storageId: args.storageId,
    });
    const url = await ctx.storage.getUrl(args.storageId);
    return { id, url };
  },
});