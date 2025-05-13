"use client";

import { use, useEffect, useState } from "react";
import { RenameModal } from "@/components/modals/rename-modal";

export const ModalProvider = () => {
    const [isOpen, setIsOpen] = useState(false);

    useEffect(() => {
        setIsOpen(true);
    }, [])

    if (!isOpen) {
        return null;
    }
    return (
        <>
            <RenameModal />
        </>
    )
}