"use client";

import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { cn } from "@/lib/utils";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";

interface NewBoardButtonProps {
  orgId: string;
}

export const NewBoardButton = ({ orgId }: NewBoardButtonProps) => {
    const { mutate: createBoard, pending } = useApiMutation(api.board.create); 
    const router = useRouter();
    const onClick = () => {
        createBoard({
            orgId: orgId,
            title: "Untitled board",
        })
        .then((id) => {
            toast.success("Board created");
            router.push(`/board/${id}`);
        })
        .catch((error) => {
            console.error("error creating board:", error);
            toast.error("failed to create board");
        });
    }
    return (
        <button
            disabled={pending}
            onClick={onClick}
            className={cn(
                "group col-span-1 aspect-[100/130] bg-gradient-to-br from-green-500 via-green-600 to-green-700 rounded-lg flex flex-col items-center justify-center py-6 transform transition duration-200  ease-out hover:scale-105 hover:shadow-xl focus:outline-none focus:ring-4 focus:ring-green-300 focus:ring-offset-2",
                pending && "cursor-not-allowed opacity-75"
            )}
        >
            <Plus
            className="h-12 w-12 text-white stroke-2 transition-transform duration-200 ease-out group-hover:rotate-45"
            />
            <p className="text-white text-sm font-semibold mt-2 select-none">
            New board
            </p>
        </button>
    );
};
