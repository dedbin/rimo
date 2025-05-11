import { Calendar } from "@/components/ui/calendar";
import { UserButton } from "@clerk/nextjs";
import Image from "next/image";

export default function Home() {
  return (
    <div  className="flex flex-col gap-y-4">
      Только для зареганных пользователей
    <div>
      <UserButton/>
    </div>
    </div>
  );
}
 