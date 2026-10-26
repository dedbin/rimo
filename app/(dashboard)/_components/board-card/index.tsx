"use client";

import Image from "next/image";
import Link from "next/link";
import { Overlay } from "./overlay";
import { formatDistanceToNow } from "date-fns";
import { authClient } from "@/lib/auth-client";
import type { BoardSummary } from "@/types/service";
import { Footer } from "./footer";
import { Skeleton } from "@/components/ui/skeleton";
import { Actions } from "@/components/actions";
import { MoreHorizontal } from "lucide-react";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { boardApi } from "@/lib/api-client";
import { toast } from "sonner";

export const BoardCard = ({
  id,
  title,
  imageUrl,
  authorName,
  ownerId,
  createdAt,
  role,
  isFavorite,
}: BoardSummary) => {
  const timeAgo = formatDistanceToNow(new Date(createdAt), { addSuffix: true });
  const { data: session } = authClient.useSession();
  const authorLabel = session?.user.id === ownerId ? "Вы" : authorName;

  const { mutate: toggleFavorite, pending: favoritePending } = useApiMutation(boardApi.favorite);

  const handleToggleFavorite = () => {
    void toggleFavorite({ id, favorite: !isFavorite })
      .catch(() => toast.error("Не удалось изменить избранное"));
  };
  return (
    <Link href={`/board/${id}`} className="block">
      <div className="
        group aspect-[100/130] border rounded-lg flex flex-col overflow-hidden
        transform transition-transform duration-200 ease-out hover:scale-105
      ">
        <div className="relative flex-1 bg-amber-50">
          <Image
            src={imageUrl}
            alt={title}
            fill
            className="object-cover"
          />
          <Overlay />
          <Actions
            id={id}
            title={title}
            canManage={role === "owner"}
            side="right"
          >
            <button 
              aria-label="Действия с доской"
              className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity px-3 py-2 outline-none "
            >
              <MoreHorizontal className="text-white opacity-75 hover:opacity-100 transition-opacity" />
            </button>
          </Actions>
        </div>
        <Footer
            isFavorite={isFavorite}
            title={title}
            authorLabel={authorLabel}
            timeAgo={timeAgo}
            onClick = {handleToggleFavorite}
            disabled={favoritePending}
        />
      </div>
    </Link>
  );
};

BoardCard.Skeleton = function BoardCardSkeleton() {
    return (
        <div className="
        group aspect-[100/130] rounded-lg transform transition-transform duration-200 ease-out hover:scale-105
        ">
            <Skeleton className="h-full w-full rounded-lg" />
        </div>
    )
}
