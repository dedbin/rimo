"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { EmptyBoards } from "./empty-boards";
import { EmptyFavorites } from "./empty-favorites";
import { EmptySearch } from "./empty-search";
import { BoardCard } from "./board-card";
import { NewBoardButton } from "./new-board-button";
import { useTranslation } from "@/hooks/use-translation";

interface BoardListProps {
    orgId: string;
    query: {
        search?: string;
        favorites?: string;
    };
};

export const BoardList = ({ orgId, query }: BoardListProps) => {
    const data = useQuery(api.boards.getBoards, { orgId, ...query }); 
    const { t } = useTranslation();

    if (data === undefined) {
        // Loading state
        return (
            <div className="flex-1 h-[calc(100%-80px)] p-6">
                <h2 className="text-2xl font-semibold mb-4">
                    {query.favorites
                    ? t("boardList.favoriteBoards")
                    : t("boardList.teamBoards")}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4 mt-8 pb-10">
                    <NewBoardButton orgId={orgId}/>
                    <BoardCard.Skeleton/>
                    <BoardCard.Skeleton/>
                    <BoardCard.Skeleton/>
                    <BoardCard.Skeleton/>
                </div>
            </div>
        );
    };

    if (!data?.length && query.search) {
        return (
            <EmptySearch />
        );
    };

    if (!data?.length && query.favorites) {
        return (
            <EmptyFavorites/>
        );
    };

    if (!data?.length) {
        return (
            <EmptyBoards/>
        );
    };
    
    return (
        <div className="flex-1 h-[calc(100%-80px)] p-6">
            <h2 className="text-2xl font-semibold mb-4">
             {query.favorites
               ? t("boardList.favoriteBoards")
               : t("boardList.teamBoards")}
           </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4 mt-8 pb-10">
                <NewBoardButton orgId={orgId}/>
                {data?.map((board) => (
                    <BoardCard
                        key={board._id}
                        id={board._id}
                        title={board.title}
                        imageUrl={board.imageUrl}
                        authorName={board.authorName}
                        authorId={board.authorId}
                        createdAt={board._creationTime}
                        orgId={board.orgId}
                        isFavorite={board.isFavorite} 
                    />
                ))}
            </div>
        </div>
    );
};