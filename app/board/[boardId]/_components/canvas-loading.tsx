
import { Loader } from "lucide-react";
import { BoardInfo } from "./info";
import { BoardParticipants } from "./participants";
import { BoardToolbar } from "./toolbar";

export const CanvasLoading = () => {
    return (
        <main className="h-full w-full relative bg-neutral touch-none flex items-center justify-center">
            <Loader className="h-5 w-5 animate-spin animate-spintext-muted-foreground" />
            <BoardInfo.Skeleton />
            <BoardParticipants.Skeleton />
            <BoardToolbar.Skeleton />
        </main>
    )
}