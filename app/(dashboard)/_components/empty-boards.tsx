"use client";
import { Button } from "@/components/ui/button";
import Image from "next/image";
import { api } from "@/convex/_generated/api";
import { useOrganization } from "@clerk/nextjs";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

export const EmptyBoards = () => {
    const { organization } = useOrganization();
    const { mutate: createBoard, pending } = useApiMutation(api.board.create);

    const onClick = () => {
        if (!organization) {
            return;
        }

        createBoard({
            title: "Untitled board",
            orgId: organization.id,
        })
        .then((id) => {
            toast.success("Board created"); // todo: navigate to board
        })
        .catch((error) => {
            console.error("error creating board:", error);
            toast.error("failed to create board");
        });
    };

    return (
        <div className="flex flex-col items-center justify-center h-full">
            <Image src="/empty-boards.svg" alt="empty" width={200} height={200} />
            <h2 className="text-2xl font-semibold text-center mt-6">
                Create your first board
            </h2>
            <p className="text-muted-foreground text-sm text-center mt-2">
                Create a board to get started with rimo
            </p>
            <div className="mt-6">
                <Button disabled={pending} onClick={onClick} size="lg">
                    {pending ? (
                        <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Creating...
                        </>
                    ) : (
                        "Create board"
                    )}
                </Button>
            </div>
        </div>
    );
};
