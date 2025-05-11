import Image from "next/image";

export const EmptyFavorites = () => {
    return (
        <div className="flex flex-col items-center justify-center h-full">
            <Image src="/empty-favorites.svg" alt="empty" width={200} height={200} /> 
            <h2 className="text-2xl font-semibold text-center mt-6">
                No favorite boards 
            </h2>
            <p className="text-muted-foreground text-sm text-center mt-2">
                Try adding some boards to your favorites
            </p>
        </div>
    )
}