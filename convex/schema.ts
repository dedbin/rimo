import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
    boards: defineTable({
        title: v.string(),
        orgId: v.string(),
        authorId: v.string(),
        authorName: v.string(),
        imageUrl: v.string(),
    })
    .index("byOrg", ["orgId"])
    .searchIndex("search_title", {
        searchField: "title",
        filterFields: ["orgId"],
    }),
    useFavorites: defineTable({
        boardId: v.id("boards"),
        userId: v.string(),
        orgId: v.string(),
    })
    .index("byBoard", ["boardId"])
    .index("byOrg", ["orgId"])
    .index("byUser", ["userId"])
    .index("byUserOrg", ["userId", "orgId"])
    .index("byUserBoard", ["userId", "boardId"])
    .index("byUserBoardOrg", ["userId", "boardId", "orgId"]),
    images: defineTable({
        sha256: v.string(),
        storageId: v.id("_storage"),
    }).index("bySha", ["sha256"]),
})