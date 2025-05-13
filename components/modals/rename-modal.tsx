"use client";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogClose,
    DialogTitle,
    DialogTrigger,
    DialogFooter
} from "@/components/ui/dialog";
import { useRenameModal } from "@/store/use-rename-modal";
import { useEffect, useState } from "react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";

interface ConfirmModalProps {
    children: React.ReactNode;
    onConfirm: () => void;
    disabled?: boolean;
    header: string;
    description?: string;
};

export const RenameModal = () => {
    const { mutate: renameBoard, pending } = useApiMutation(api.board.update);


    const {
        isOpen,
        values,
        handleClose,
    } = useRenameModal();
    const [title, setTitle] = useState(values.title);

    useEffect(() => {
        setTitle(values.title);
    }, [values.title])

    const onSubmit: React.FormEventHandler<HTMLFormElement> = (e) => {
        e.preventDefault();
        renameBoard({ id: values.id, title })
        .then(() => {
            toast.success("Board renamed")
            handleClose();
        })
        .catch((err) => {
            toast.error("Failed to rename board")
        })
    }

    return (
        <Dialog open={isOpen} onOpenChange={handleClose}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Rename Board</DialogTitle>
                    <DialogDescription>
                        Rename your board to something more meaningful.
                    </DialogDescription>
                    <form onSubmit={onSubmit} className="space-y-4">
                        <Input
                            disabled={pending}
                            required
                            maxLength={50}
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="Enter board name"
                        />
                        <DialogFooter>
                            <DialogClose asChild>
                                <Button type="button" variant={"outline"}>
                                    Cancel
                                </Button>                                
                            </DialogClose>
                            <Button disabled={pending} type="submit" variant={"default"}>
                                Save
                            </Button>
                        </DialogFooter>                       
                    </form>
                </DialogHeader>
            </DialogContent>
        </Dialog>
    );
};