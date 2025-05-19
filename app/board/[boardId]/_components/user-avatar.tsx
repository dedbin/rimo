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

export const UserAvatar = ({
  src,
  name,
  fallback,
  borderColor,
}: UserAvatarProps) => (
  <Hint label={name ?? "Anonymous"} side="bottom" sideOffset={18}>
    <Avatar className="h-10 w-10 border-2" style={{ borderColor }}>
      {src ? (
        <AvatarImage
          src={src}
          alt={name ?? "avatar"}
          className="h-full w-full object-cover"
        />
      ) : null}
      <AvatarFallback className="bg-muted text-xs font-semibold">
        {fallback ?? name?.slice(0, 2) ?? "?"}
      </AvatarFallback>
    </Avatar>
  </Hint>
)