import { Hint } from "@/components/hint";
import {
    Avatar,
    AvatarFallback,
    AvatarImage
} from "@/components/ui/avatar";

interface UserAvatarProps{
    src?: string,
    name?: string,
    fallback?: string
    borderColor?: string
}

export const UserAvatar = ({ src, name, fallback, borderColor }: UserAvatarProps) => (
    <Hint label={name||"Anonymous"} side="bottom" sideOffset={18}>
        <Avatar className="h-10 w-10 border-2" style={{ borderColor }}>
            <AvatarImage src={src} sizes="(max-width: 800px) 100vw, 800px" /> {/* TODO: debug this (no img) */}
            <AvatarFallback className="bg-muted text-xs font-semibold">{fallback}</AvatarFallback>
        </Avatar>       
    </Hint>
);