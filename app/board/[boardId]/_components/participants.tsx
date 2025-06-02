"use client";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar } from "./user-avatar";
import { useOthers, useSelf } from "@liveblocks/react";
import { connectionIdToColor } from "@/lib/utils";

const MAX_PARTICIPANTS = 2;

export const BoardParticipants = () => {
  const users = useOthers();
  const self = useSelf();
  const hasMore = users.length > MAX_PARTICIPANTS;

  return (
    <div className="flex h-12 rounded-md px-1.5 items-center shadow-md bg-white p-4">
      <div className="flex gap-x-2">
        {users.slice(0, MAX_PARTICIPANTS).map(({ connectionId, info }) => (
          <UserAvatar
            key={connectionId}
            borderColor={connectionIdToColor(connectionId)}
            name={info?.name}
            src={info?.picture}
            fallback={info?.name?.slice(0, 1) || "A"}
          />
        ))}

        {self && (
          <UserAvatar
            borderColor={connectionIdToColor(self.connectionId)}
            src={self?.info?.picture}
            name={`${self?.info?.name} (You)`}
            fallback={self?.info?.name?.slice(0, 1) || "A"}
          />
        )}

        {hasMore && (
          <UserAvatar
            name={`${users.length - MAX_PARTICIPANTS} more`}
            fallback={`+${users.length - MAX_PARTICIPANTS}`}
          />
        )}
      </div>
    </div>
  );
};

export const BoardParticipantsSkeleton = () => (
  <div className="absolute top-2 right-2 flex h-12 rounded-md px-1.5 items-center shadow-md bg-white p-4 gap-2 pointer-events-none">
    <Skeleton className="h-8 w-8 rounded-full" />
    <Skeleton className="h-4 w-20 rounded" />
  </div>
);