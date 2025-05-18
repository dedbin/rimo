"use client";

import Link from "next/link";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import React, { useState } from "react";
import { SignInButton, UserButton, useAuth } from "@clerk/clerk-react";

export const RimoNavbar = () => {
  const { isSignedIn } = useAuth();

  const [coords, setCoords] = useState({ x: "50%", y: "50%" });

  const handleMouseMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setCoords({ x: `${x}%`, y: `${y}%` });
  };

  return (
    <nav className="p-4 bg-transparent flex items-center justify-between">
      <Link href="/" className="flex items-center">
        <div className="relative h-10 w-10 mr-4 text-green-500">
          <Image
            src="/logo.svg" 
            alt="Логотип Rimo"
            fill
              className="object-contain
             [filter:invert(52%)_sepia(93%)_saturate(4276%)_hue-rotate(136deg)_brightness(102%)_contrast(94%)]"


          />
        </div>
        <h1 className={cn("text-2xl font-bold text-white")}>Rimo</h1>
      </Link>
      <div className="flex items-center gap-x-4">
        {isSignedIn ? (
          <>
            <Link href="/boards">
              <Button className="rounded-full">Мои доски</Button>
            </Link>
            <UserButton />
          </>
        ) : (
          <SignInButton>
            <Button
              className="relative overflow-hidden rounded-full px-8 py-3 text-lg"
              onMouseMove={handleMouseMove}
              style={{
                // градиентный блик, следующий за курсором
                background: `radial-gradient(circle at ${coords.x} ${coords.y}, rgba(255,255,255,0.1), transparent 30%)`,
                transition: "background 0.2s ease-out"
              }}
            >
              <span className="relative z-10">Войти</span>
            </Button>
          </SignInButton>
        )}
      </div>
    </nav>
  );
};
