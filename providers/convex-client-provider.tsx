"use client";

import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { SignInButton, UserButton } from "@clerk/clerk-react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexReactClient, AuthLoading, Authenticated,Unauthenticated } from "convex/react";
import { Loading } from "@/components/auth/loading";
import { RimoNavbar } from "@/components/landing-navbar";
import { RimoHero } from "@/components/landing-hero";
import { RimoContent } from "@/components/landing-content";
import { RimoFooter } from "@/components/landing-footer";
import { ruRU } from '@clerk/localizations';

interface ConvexClientProviderProps {
  children: React.ReactNode;
};

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL!;

const convex = new ConvexReactClient(convexUrl);

export const ConvexClientProvider = ({ children }: ConvexClientProviderProps) => {
    return (
        <ClerkProvider localization={ruRU}>
            <ConvexProviderWithClerk useAuth={useAuth} client={convex}>
                <Authenticated>
                    {children}
                </Authenticated>
                <AuthLoading>
                    <Loading/>
                </AuthLoading>
                <Unauthenticated>
                    <div className="bg-zinc-900">
                    <RimoNavbar/>
                    <RimoHero/>
                    <RimoContent/>
                    <RimoFooter/>
                    </div>
                </Unauthenticated>
            </ConvexProviderWithClerk>
        </ClerkProvider>
    );
};