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
            <AvatarImage src={src}  />
            <AvatarFallback className="bg-muted text-xs font-semibold">{fallback}</AvatarFallback>
        </Avatar>       
    </Hint>
);