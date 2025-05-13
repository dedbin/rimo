"use client";
import { Skeleton } from "@/components/ui/skeleton";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import Image  from "next/image";
import { Poppins } from "next/font/google";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useQuery } from "convex/react";
import { Hint } from "@/components/hint";
import { useRenameModal } from "@/store/use-rename-modal";
import { Actions } from "@/components/actions";
import { Menu } from "lucide-react";
import { BoardCopyLinkAction } from "@/components/copy-link";

const font = Poppins({
    subsets: ['latin'],
    weight: ['600'],
});

interface BoardInfoProps {
    boardId: string
}

const TabSeparator = () => {
    return (
        <div className="text-neutral-300 px-1.5">
            |
        </div>
    )
}

export const BoardInfo = ({boardId}: BoardInfoProps) => {
    const { handleOpen } = useRenameModal();

    const data = useQuery(api.board.get, {id: boardId as Id<"boards">});
    
    if (!data){
        return <BoardInfoSkeleton/>
    }

    return (
        <div className="absolute flex top-2 left-2 h-12 rounded-md px-1.5 items-center shadow-md bg-white p-4">
            <Hint
                label="go home"
                side="bottom"
                sideOffset={10}
            >
                <Button asChild variant="board" className="px-2">
                    <Link href="/">
                        <div className="flex items-center">
                        <Image 
                            src="/logo.svg"
                            alt="logo"
                            width={40} 
                            height={40} 
                            className="w-8 h-8 rounded-full"
                        />
                        <span className={cn("font-semibold text-xl ml-2 text-black", font.className)}>
                            rimo
                        </span>
                        </div>
                    </Link>
                </Button>
            </Hint>
            <TabSeparator/>
            <Hint label="edit title" side="bottom" sideOffset={10}>
                <Button variant="board" className="px-2 text-base font-normal" onClick={() => handleOpen(data._id, data.title)}>
                    {data.title}
                </Button>
            </Hint>
            <TabSeparator/>
            <BoardCopyLinkAction boardId={data._id} />
        </div>
    );
};

export const BoardInfoSkeleton = () => {
    return (
        <div className="absolute flex top-2 left-2 h-12 rounded-md px-1.5 items-center shadow-md bg-white p-4 gap-3 w-[300px]">
            <Skeleton className="h-6 w-6 rounded" /> 
            <Skeleton className="h-4 w-40 rounded" /> 
        </div>
    );
};
