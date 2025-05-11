import { Button } from "@/components/ui/button";
import Image from "next/image";

export const EmptyBoards = () => {
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
                <Button size="lg">
                    Create board
                </Button>
            </div>
        </div>
    )
}