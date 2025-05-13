"use client";

import Image from "next/image";
import Link from "next/link";
import { Overlay } from "./overlay";
import { formatDistanceToNow } from "date-fns";
import { useAuth } from "@clerk/nextjs";
import { Footer } from "./footer";
import { Skeleton } from "@/components/ui/skeleton";
import { Actions } from "@/components/actions";
import { MoreHorizontal } from "lucide-react";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";

interface BoardCardProps {
  id: string;
  title: string;
  imageUrl: string;
  authorName: string;
  authorId: string;
  createdAt: number;
  orgId: string;
  isFavorite: boolean;
}

export const BoardCard = ({
  id,
  title,
  imageUrl,
  authorName,
  authorId,
  createdAt,
  orgId,
  isFavorite,
}: BoardCardProps) => {
  const timeAgo = formatDistanceToNow(new Date(createdAt), { addSuffix: true });
  const {userId} = useAuth();
  const authorLabel = userId === authorId ? "You" : authorName; 

  const { mutate: toggleFavorite, pending: favoritePending } = useApiMutation(api.board.favorite);
  const { mutate: untoggleFavorite, pending: unfavoritePending } = useApiMutation(api.board.unFavorite);

  const handleToggleFavorite = () => {
    if (isFavorite) {
      untoggleFavorite({ id })
      .catch((error) => {toast.error("Failed to unfavorite");});
    } else {
      toggleFavorite({ id, orgId })
      .catch((error) => {toast.error("Failed to favorite");});
    }
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
            side="right"
          >
            <button 
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
            disabled={favoritePending || unfavoritePending}
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
