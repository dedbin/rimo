import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface BoardCardFooterProps {
    isFavorite: boolean;
    title: string;
    authorLabel: string;
    timeAgo: string;
    disabled: boolean;
    onClick: () => void;
};

export const Footer = ({
    isFavorite,
    title,
    authorLabel,
    timeAgo,
    disabled,
    onClick,
}: BoardCardFooterProps) => {
    const handleClick = (e: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
    }

    return (
        <div className="relative bg-white p-3">
            <p className="text-[13px] truncate max-w-[calc(100%-20px)]">
                {title}
            </p>
            <p className="opacity-0 group-hover:opacity-100 transition-opacity text-[11px] text-muted-foreground truncate"> 
                {authorLabel} • {timeAgo}
            </p>
            <button
                onClick={handleClick}
                disabled={disabled}
                className={cn(
                    "opacity-0 group-hover:opacity-100 transition-opacity absolute top-3 right-3 hover:text-green-500 cursor-pointer",
                    disabled && "cursor-not-allowed opacity-75" 
                )}
                >
                    <Star className={cn("h-4 w-4", isFavorite && "text-green-500 fill-green-500")}/>
                </button>
        </div>
    );
};