import { Loader } from "lucide-react";
import { BoardInfoSkeleton } from "./info";
import { BoardParticipantsSkeleton } from "./participants";
import { BoardToolbarSkeleton } from "./toolbar";
import { ZoomControlsSkeleton } from "./zoom-controls";

export const CanvasLoading = () => {
    return (
        <main className="h-full w-full relative bg-neutral touch-none flex items-center justify-center">
            <Loader className="h-5 w-5 animate-spin animate-spintext-muted-foreground" />
            <BoardInfoSkeleton />
            <BoardParticipantsSkeleton />
            <BoardToolbarSkeleton />
            <ZoomControlsSkeleton />
        </main>
    )
}