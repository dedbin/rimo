"use client";

import Image from "next/image";
import Link from "next/link";
import { Overlay } from "./overlay";
import { formatDistanceToNow } from "date-fns";
import { useAuth } from "@clerk/nextjs";
import { Footer } from "./footer";
import { Skeleton } from "@/components/ui/skeleton";

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
        </div>
        <Footer
            isFavorite={isFavorite}
            title={title}
            authorLabel={authorLabel}
            timeAgo={timeAgo}
            onClick = {() => {}}
            disabled={false}
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
