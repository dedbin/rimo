
import Link from "next/link";
import { GithubIcon  } from "lucide-react";
import { Send } from 'lucide-react';

export const RimoFooter = () => (
  <div>
    <div className="flex justify-center">
      <hr className="border-t border-emerald-500 w-full max-w-screen-md mx-auto" />
    </div>
    <h3 className="text-4xl font-extrabold text-white text-center mb-10 pt-32">
      Следите за нами
    </h3>
    <div className="flex justify-center gap-4 text-white pt-4">
      <Link href="https://github.com/dedbin/rimo">
        < GithubIcon className="w-8 h-8" />
        <p className="text-zinc-400 text-sm font-medium pl-1">rimo</p>
      </Link>
      <Link href="https://t.me/argtg_not_arctg">
        < Send className="w-8 h-8 " />
        <p className="text-zinc-400 text-sm font-medium pl-1">goga</p>
      </Link>
    </div>
    
    <p className="text-white text-center py-10">Создано с ❤️, Rimo</p>
  </div>
);