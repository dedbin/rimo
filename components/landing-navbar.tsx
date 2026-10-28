"use client";

import Link from "next/link";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import React from "react";
import { AuthButton } from "@/components/auth/auth-button";
import { UserButton } from "@/components/auth/user-button";
import { authClient } from "@/lib/auth-client";
import { usePointerGlow } from "@/hooks/use-pointer-glow";

export const RimoNavbar = () => {
  const { data: session } = authClient.useSession();
  const isSignedIn = !!session;
  usePointerGlow();
  return (
    <nav className="p-4 bg-transparent flex items-center justify-between">
      <Link href="/" className="flex items-center">
        <div className="relative h-10 w-10 mr-4 text-green-500">
          <Image
            src="/logo.svg"
            alt="Логотип Rimo"
            fill
            priority
            className="object-contain [filter:invert(52%)_sepia(93%)_saturate(4276%)_hue-rotate(136deg)_brightness(102%)_contrast(94%)]"
          />
        </div>
        <h1 className={cn("text-2xl font-bold text-white")}>Rimo</h1>
      </Link>
      <div className="flex items-center gap-x-2 sm:gap-x-4">
        {isSignedIn ? (
          <>
            <Link href="/">
              <Button className="rounded-full">Мои доски</Button>
            </Link>
            <UserButton />
          </>
        ) : (
          <>
          <AuthButton initialMode="sign-up">
            <Button variant="ghost" className="rounded-full px-3 text-white hover:bg-white/10 hover:text-white">
              Регистрация
            </Button>
          </AuthButton>
          <AuthButton>
            <Button
              data-glow
              className="rounded-full px-4 py-3 text-sm sm:px-8 sm:text-lg"
            >
              <span>Войти</span>
            </Button>
          </AuthButton>
          </>
        )}
      </div>
    </nav>
  );
};
