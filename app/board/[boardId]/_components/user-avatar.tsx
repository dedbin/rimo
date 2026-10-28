import { Hint } from "@/components/hint";
import { safeAvatarSrc } from "@/lib/safe-avatar";
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
}: UserAvatarProps) => {
  const image = safeAvatarSrc(src);
  return (
    <Hint label={name ?? "Anonymous"} side="bottom" sideOffset={18}>
      <Avatar className="h-10 w-10 border-2" style={{ borderColor }}>
        {image ? (
          <AvatarImage
            src={image}
            alt={name ?? "avatar"}
            className="h-full w-full object-cover"
          />
        ) : null}
        <AvatarFallback className="bg-muted text-xs font-semibold">
          {fallback ?? name?.slice(0, 2) ?? "?"}
        </AvatarFallback>
      </Avatar>
    </Hint>
  );
};
