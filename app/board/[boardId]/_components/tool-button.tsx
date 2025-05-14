"use client";

import { LucideIcon } from "lucide-react";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";

interface ToolButtonProps {
    label: string;
    icon: LucideIcon;
    onClick: () => void;
    isDisabled?: boolean;
    isActive?: boolean;
}
export const ToolButton = ({ label, icon: Icon, onClick, isDisabled, isActive }: ToolButtonProps) =>{
    return (
        <Hint label={label} side="right" sideOffset={15}>
            <Button
                variant={isActive ? "boardActive" : "board"}
                size="icon"
                onClick={onClick}
                disabled={isDisabled}
            >
                <Icon/>
            </Button>
        </Hint>
    )
}