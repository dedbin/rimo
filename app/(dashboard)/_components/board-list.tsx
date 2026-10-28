"use client";

import { useBoards } from "@/hooks/use-boards";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { EmptyBoards } from "./empty-boards";
import { EmptyFavorites } from "./empty-favorites";
import { EmptySearch } from "./empty-search";
import { BoardCard } from "./board-card";
import { NewBoardButton } from "./new-board-button";
import { useTranslation } from "@/hooks/use-translation";

interface BoardListProps {
    query: {
        search?: string;
        favorites?: string;
    };
};

export const BoardList = ({ query }: BoardListProps) => {
    const { boards: data, error, mutate } = useBoards(query);
    const { data: session } = authClient.useSession();
    const canCreate = !!session && !session.user.isAnonymous;
    const { t } = useTranslation();

    if (error) return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p role="alert">Не удалось загрузить доски.</p>
        <Button onClick={() => void mutate()}>Повторить</Button>
      </div>
    );

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
                    {canCreate && <NewBoardButton />}
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
                {canCreate && <NewBoardButton />}
                {data?.map((board) => (
                    <BoardCard
                        key={board.id}
                        {...board}
                    />
                ))}
            </div>
        </div>
    );
};
