"use client";
import { Check, X } from "lucide-react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar } from "./user-avatar";
import { useOthers, useSelf } from "@/lib/collaboration/react";
import { connectionIdToColor } from "@/lib/utils";

const MAX_PARTICIPANTS = 2;

interface BoardParticipantsProps {
  followingId?: number | null;
  onFollow?: (connectionId: number) => void;
}

export const BoardParticipants = ({ followingId = null, onFollow }: BoardParticipantsProps) => {
  const users = useOthers();
  const self = useSelf();
  const hasMore = users.length > MAX_PARTICIPANTS;
  const following = users.find((participant) => participant.connectionId === followingId);

  return (
    <div className="relative flex h-12 rounded-md px-1.5 items-center shadow-md bg-white p-4">
      <div className="flex gap-x-2">
        {users.slice(0, MAX_PARTICIPANTS).map(({ connectionId, info, presence }) => (
          <button key={connectionId} type="button" aria-pressed={followingId === connectionId}
            aria-label={`${followingId === connectionId ? "Не следовать за" : "Следовать за"} ${info.name}`}
            disabled={!onFollow || !presence.camera}
            onClick={() => onFollow?.(connectionId)}
            className={`rounded-full outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:cursor-default ${followingId === connectionId ? "ring-2 ring-emerald-500 ring-offset-2" : ""}`}>
            <UserAvatar
            borderColor={connectionIdToColor(connectionId)}
            name={info?.name}
            src={info?.picture}
            fallback={info?.name?.slice(0, 1) || "A"}
          />
          </button>
        ))}

        {self && (
          <UserAvatar
            borderColor={connectionIdToColor(self.connectionId)}
            src={self?.info?.picture}
            name={`${self?.info?.name} (вы)`}
            fallback={self?.info?.name?.slice(0, 1) || "A"}
          />
        )}

        {hasMore && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Другие участники" title="Другие участники"
                className="flex size-10 items-center justify-center rounded-full bg-neutral-100 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-emerald-600">
                +{users.length - MAX_PARTICIPANTS}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" collisionPadding={8} className="w-64 max-w-[calc(100vw-1rem)]"
              aria-label="Другие участники" onKeyDown={(event) => event.stopPropagation()}>
              {users.slice(MAX_PARTICIPANTS).map(({ connectionId, info, presence }) => (
                <DropdownMenuItem key={connectionId} role="menuitemradio" aria-checked={followingId === connectionId}
                  aria-label={`${followingId === connectionId ? "Не следовать за" : "Следовать за"} ${info.name}`}
                  disabled={!onFollow || !presence.camera} onSelect={() => onFollow?.(connectionId)}>
                  <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: connectionIdToColor(connectionId) }} />
                  <span className="flex-1 truncate">{info.name}</span>
                  {followingId === connectionId && <Check aria-hidden="true" className="size-4" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {following && <div role="status" data-following-id={followingId}
        className="absolute right-0 top-full mt-2 flex max-w-[calc(100vw-1rem)] items-center gap-2 rounded-md border border-emerald-200 bg-white px-3 py-2 text-xs shadow-sm">
        <span className="truncate">Следуем за {following.info.name}</span>
        <button type="button" aria-label="Прекратить следование" title="Прекратить следование"
          className="flex size-7 shrink-0 items-center justify-center rounded hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-emerald-600"
          onClick={() => onFollow?.(following.connectionId)}><X aria-hidden="true" className="size-4" /></button>
      </div>}
    </div>
  );
};

export const BoardParticipantsSkeleton = () => (
  <div className="absolute top-2 right-2 flex h-12 rounded-md px-1.5 items-center shadow-md bg-white p-4 gap-2 pointer-events-none">
    <Skeleton className="h-8 w-8 rounded-full" />
    <Skeleton className="h-4 w-20 rounded" />
  </div>
);
